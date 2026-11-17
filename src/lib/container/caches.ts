// container.caches: named volumes shared by every branch container of a repository on one Docker
// daemon (docs/specs/cloud-machines.md, "The cache volume"). kunj knows nothing about what goes in
// them: a repository's own scripts read KUNJ_CACHE_DIR / KUNJ_CACHE_<NAME> and keep there whatever
// is expensive to fetch again (a database dump, a package cache). No branch label, so prune never
// takes one for an orphan, and `ct remove` leaves it alone.

import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import { Writable } from 'stream';
import type { ContainerBackend } from './backend';
import { ContainerError } from './errors';
import { LABEL, dockerSafe } from './names';

export interface CacheMount {
  name: string;
  /** Absolute path in the container */
  path: string;
  volume: string;
}

export const CACHE_ROLE = 'cache';
export const CACHE_LABEL = 'kunj.cache';

const NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
// The container's own ground: mounting a shared volume there would replace the checkout or the system
const RESERVED = ['/', '/workspace', '/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/tmp', '/run', '/var/lib/docker', '/opt/kunj'];

function bad(message: string): never {
  throw new ContainerError(`container.caches: ${message}`, 'bad-config');
}

export function cacheVolumeName(repoName: string, repoId: string, name: string): string {
  const hash = createHash('sha1').update(repoId).digest('hex').slice(0, 6);
  return `kunj-${dockerSafe(repoName).slice(0, 30).replace(/[-.]+$/, '')}-cache-${name}-${hash}`;
}

/** The caches of container.caches for this repository, validated; [] when there are none. */
export function parseCaches(value: unknown, repo: { name: string; id: string }): CacheMount[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad('expected a list of { "name": …, "path": … }.');
  const out: CacheMount[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) bad('each cache is { "name": …, "path": … }.');
    const { name, path: p } = item as { name?: unknown; path?: unknown };
    if (typeof name !== 'string' || !NAME.test(name)) bad(`name ${JSON.stringify(name)} must be lowercase letters, digits and dashes (at most 32).`);
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 200 || /[\0\n,:]/.test(p)) bad(`path ${JSON.stringify(p)} of ${name} must be an absolute path in the container.`);
    const clean = path.posix.normalize(p).replace(/\/+$/, '') || '/';
    if (clean !== p.replace(/\/+$/, '')) bad(`path ${p} of ${name} must not contain . or .. segments.`);
    if (RESERVED.includes(clean) || clean.startsWith('/workspace/') || clean.startsWith('/proc/') || clean.startsWith('/sys/') || clean.startsWith('/dev/')) {
      bad(`path ${p} of ${name} is the container's own; use a directory of its own, such as /cache.`);
    }
    if (out.some(c => c.name === name)) bad(`two caches are named ${name}.`);
    if (out.some(c => c.path === clean)) bad(`two caches use ${clean}.`);
    out.push({ name, path: clean, volume: cacheVolumeName(repo.name, repo.id, name) });
  }
  return out;
}

export function cacheLabels(repoId: string, name: string, kunjVersion: string): Record<string, string> {
  return { [LABEL.repo]: repoId, [LABEL.role]: CACHE_ROLE, [CACHE_LABEL]: name, [LABEL.version]: kunjVersion };
}

/** KUNJ_CACHE_DIR (the first cache) and KUNJ_CACHE_<NAME> for each. */
export function cacheEnv(caches: CacheMount[]): Record<string, string> {
  const env: Record<string, string> = {};
  if (caches[0]) env.KUNJ_CACHE_DIR = caches[0].path;
  for (const c of caches) env[`KUNJ_CACHE_${c.name.toUpperCase().replace(/-/g, '_')}`] = c.path;
  return env;
}

// ---- the cache store ------------------------------------------------------------------------------
// A coordinator with machine.cache keeps each cache in a bucket too, because a cloud machine holds
// one branch: its volume is otherwise only what the machine image held. The copy runs in a container
// on the machine (rclone, with the machine's own cloud credential), never in the branch container,
// whose firewall keeps it from the credential.

export const CACHE_SYNC_ROLE = 'cache-sync';

export type CacheSyncDirection = 'pull' | 'push';

export interface CacheSyncResult {
  name: string;
  /** pulled/pushed: copied; empty: nothing was ever pushed, so the volume is left as it is */
  action: 'pulled' | 'pushed' | 'empty' | 'failed';
  message?: string;
}

/** What syncCaches needs to know about the store: the CacheSync a coordinator hands out. */
export interface CacheStore {
  image: string;
  env: Record<string, string>;
  remote: string;
  display: string;
}

const REMOTE = /^:[a-z0-9]+:[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function collect(): { stream: NodeJS.WritableStream; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      // The end of a long rclone log is what says why it failed
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      while (size > 65536 && chunks.length > 1) size -= (chunks.shift() as Buffer).length;
      done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString() };
}

const lastLine = (text: string): string => text.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? '';

/**
 * Makes each cache volume equal to the store (pull) or the store equal to the volume (push). A pull
 * from a store nothing was pushed to leaves the volume alone. One cache failing does not stop the
 * others; nothing here throws for a failed copy.
 */
export async function syncCaches(
  backend: ContainerBackend,
  store: CacheStore,
  caches: CacheMount[],
  direction: CacheSyncDirection,
  opts: { repoId: string; kunjVersion: string; log?: (line: string) => void; /** push: also when the volume is empty, which empties the store */ force?: boolean },
): Promise<CacheSyncResult[]> {
  if (!caches.length) return [];
  if (!REMOTE.test(store.remote) || store.remote.includes('..')) throw new ContainerError(`The cache store ${store.display} is not one kunj can copy to.`, 'bad-config');
  const name = `kunj-cache-sync-${randomBytes(4).toString('hex')}`;
  const id = await backend.run({
    name,
    image: store.image,
    labels: { [LABEL.repo]: opts.repoId, [LABEL.role]: CACHE_SYNC_ROLE, [LABEL.version]: opts.kunjVersion },
    env: { ...store.env },
    network: 'bridge',
    workdir: '',
    volumes: caches.map(c => ({ name: c.volume, path: `/caches/${c.name}` })),
    publish: [],
    entrypoint: ['sleep'],
    command: ['86400'],
  });
  const results: CacheSyncResult[] = [];
  try {
    for (const c of caches) {
      const local = `/caches/${c.name}`;
      const remote = `${store.remote}/${c.volume}`;
      const run = async (argv: string[]) => {
        const err = collect();
        const r = await backend.exec(id, ['rclone', ...argv], { stderr: err.stream, user: 'root' });
        return { ...r, stderr: err.text() };
      };
      try {
        if (direction === 'pull') {
          // A folder nothing was pushed to: rclone exits 3 (directory not found) or lists nothing
          const listed = await run(['lsf', '--max-depth', '1', remote]);
          if (listed.exitCode === 3 || (listed.exitCode === 0 && !listed.stdout.trim())) {
            // "Not found" is also what a bucket that does not exist says: the store's own root must list
            const root = await run(['lsf', '--max-depth', '1', store.remote.replace(/^(:[a-z0-9]+:[^/]+).*$/, '$1')]);
            if (root.exitCode !== 0) results.push({ name: c.name, action: 'failed', message: lastLine(root.stderr) || `${store.display} cannot be listed` });
            else results.push({ name: c.name, action: 'empty' });
            continue;
          }
          if (listed.exitCode !== 0) {
            results.push({ name: c.name, action: 'failed', message: lastLine(listed.stderr) || `rclone exit ${listed.exitCode}` });
            continue;
          }
        }
        if (direction === 'push' && !opts.force) {
          // A push mirrors: from a volume that was never filled (a failed pull, a new machine) it
          // would delete what the other machines pushed
          const mine = await run(['lsf', '--max-depth', '1', local]);
          if (mine.exitCode === 0 && !mine.stdout.trim()) {
            results.push({ name: c.name, action: 'failed', message: 'this cache is empty here, so nothing was pushed (--force empties the store too)' });
            continue;
          }
        }
        opts.log?.(`${direction === 'pull' ? 'pulling' : 'pushing'} cache ${c.name} ${direction === 'pull' ? 'from' : 'to'} ${store.display}`);
        const [from, to] = direction === 'pull' ? [remote, local] : [local, remote];
        const r = await run(['sync', from, to, '--links', '--transfers', '8', '--retries', '2']);
        if (r.exitCode !== 0) {
          results.push({ name: c.name, action: 'failed', message: lastLine(r.stderr) || `rclone exit ${r.exitCode}` });
          continue;
        }
        // What rclone wrote is root's: handed to whoever owns the cache (the sandbox user, once a
        // container has started with it). An object store keeps no file modes: the names of the executable files travel beside the
        // data (<volume>.exec, NUL-separated) and get their bit back after a pull. Best effort.
        const script = direction === 'pull' ? 'cd "$1" && chown -R "$(stat -c %u:%g .)" . ; rclone cat "$2" 2>/dev/null | xargs -0 -r chmod +x' : 'cd "$1" && find . -type f -perm -u+x -print0 | rclone rcat "$2"';
        const modes = await backend.exec(id, ['sh', '-c', script, 'sh', local, `${remote}.exec`], { user: 'root' }).catch(() => ({ exitCode: 1 }));
        if (modes.exitCode !== 0 && direction === 'push') opts.log?.(`cache ${c.name}: the list of executable files was not stored; they come back without the executable bit`);
        results.push({ name: c.name, action: direction === 'pull' ? 'pulled' : 'pushed' });
      } catch (err) {
        results.push({ name: c.name, action: 'failed', message: (err as Error).message });
      }
    }
  } finally {
    await backend.remove({ containers: [id] }).catch(() => {});
  }
  return results;
}
