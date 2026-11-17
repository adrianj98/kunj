// container.caches: named volumes shared by every branch container of a repository on one Docker
// daemon (docs/specs/cloud-machines.md, "The cache volume"). kunj knows nothing about what goes in
// them: a repository's own scripts read KUNJ_CACHE_DIR / KUNJ_CACHE_<NAME> and keep there whatever
// is expensive to fetch again (a database dump, a package cache). No branch label, so prune never
// takes one for an orphan, and `ct remove` leaves it alone.

import { createHash } from 'crypto';
import * as path from 'path';
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
