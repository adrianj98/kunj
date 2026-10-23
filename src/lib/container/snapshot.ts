// `kunj ct blueprint snapshot`: provision a temporary container from the blueprint, copy its
// workspace to the seed directory and commit it as kunj-blueprint-<repo>:<hash>. The temporary
// container is an ordinary start without secrets, keep files or hooks, and is always removed.
// It clones a git bundle the host made with its own credentials, so it never needs a token.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { ContainerBackend, ImageInfo } from './backend';
import {
  ResolvedBlueprint,
  SEED_DIR,
  SNAPSHOT_REPO,
  blueprintLabels,
  computeBlueprintHash,
  snapshotTag,
} from './blueprint';
import { StartOptions, StartResult, baseImageTag, removeContainer, startContainer } from './lifecycle';
import { LABEL, containerNames } from './names';
import { orderTools, resolvePresets } from './presets';
import { SEED_COPYING, SEED_FRESH, SEED_MARKER_EXCLUDE, nonInteractiveEnv } from './seed';
import { getGlobalKunjDir } from '../config';
import { KunjConfig } from '../../types';

const execFileAsync = promisify(execFile);

/** Written by presets through kunj_env (src/container/presets/_lib.sh), one KEY=VALUE per line. */
export const PRESET_ENV_FILE = '/etc/kunj/env';

export interface SnapshotOptions {
  /** The branch the snapshot is cloned from: the default branch or --base */
  branch: string;
  blueprint: ResolvedBlueprint;
  config: KunjConfig;
  repo: StartOptions['repo'];
  kunjVersion: string;
  cwd: string;
  jsonMode: boolean;
  rebuild: boolean;
  warn: (m: string) => void;
  log: (m: string) => void;
  /** Clone from origin inside the container instead of a host-made bundle (origin must then be public) */
  noBundle?: boolean;
}

export interface SnapshotResult {
  tag: string;
  hash: string;
  /** The commit snapshotted, as checked out in the container (the image's kunj.blueprint.ref label) */
  ref: string;
  base: string;
  sizeBytes: number;
  tools: Array<{ name: string; version: string }>;
  reused: boolean;
  /** Whether the container cloned a bundle the host made rather than origin */
  viaBundle: boolean;
}

/** The copy into the seed directory, without the seed markers (each start writes its own). */
export const SEED_COPY_SCRIPT =
  `mkdir -p /opt/kunj && rm -rf ${SEED_DIR} && cp -a /workspace ${SEED_DIR}` +
  ` && rm -f ${SEED_DIR}/${SEED_MARKER_EXCLUDE} ${SEED_DIR}/${SEED_FRESH} ${SEED_DIR}/${SEED_COPYING}` +
  ` && chown -R "$(stat -c %u:%g /workspace)" ${SEED_DIR}`;

/** KEY=VALUE lines as Dockerfile ENV instructions; `$` is escaped so values stay literal, as in the login shell. */
export function envChanges(text: string, warn: (m: string) => void): string[] {
  const changes: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warn(`Ignoring malformed line in ${PRESET_ENV_FILE}: ${line}`);
      continue;
    }
    changes.push(`ENV ${key}=${JSON.stringify(line.slice(eq + 1)).replace(/\$/g, '\\$')}`);
  }
  return changes;
}

function snapshotsOf(images: ImageInfo[], repoName: string): ImageInfo[] {
  const prefix = `${SNAPSHOT_REPO(repoName)}:`;
  return images.filter(i => i.tag.startsWith(prefix));
}

/** First line: the workspace's HEAD (empty when unreadable); the rest: the presets' env file. Run as
 * root, so git is told the sandbox user's checkout is safe. */
export const SNAPSHOT_READ_SCRIPT =
  `git -c safe.directory=/workspace -C /workspace rev-parse HEAD 2>/dev/null || echo; cat ${PRESET_ENV_FILE} 2>/dev/null || true`;

/** `<branch>:snapshot`: ':' is invalid in a git ref, so no real branch's container shares these names. */
export function snapshotNamesFor(branch: string): string {
  return `${branch}:snapshot`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Where startContainer puts the bundle; removed again once the clone is done. */
export const BUNDLE_CONTAINER_PATH = '/tmp/kunj-origin.bundle';
const BUNDLE_FETCH_TIMEOUT_MS = 60000;

async function hostGit(args: string[], cwd: string, timeout = 0): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: nonInteractiveEnv(), timeout });
    return stdout.trim();
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(`git ${args[0]} failed: ${stderr || message(err)}`);
  }
}

/**
 * Fetch `branch` from origin with the host's credentials and bundle it as the one ref
 * refs/heads/<branch>, so the snapshot container clones it without a token. `git bundle create`
 * cannot rename a ref, so the ref is set in a scratch repository that borrows the host's objects.
 */
export async function makeBranchBundle(branch: string, cwd: string): Promise<{ path: string; cleanup: () => void }> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  // Only the fetch is timed: bundling a large history may take a while
  await hostGit(['fetch', 'origin', `+refs/heads/${branch}:${remoteRef}`], cwd, BUNDLE_FETCH_TIMEOUT_MS);
  const sha = await hostGit(['rev-parse', '--verify', `${remoteRef}^{commit}`], cwd);
  const objects = path.resolve(cwd, await hostGit(['rev-parse', '--git-path', 'objects'], cwd));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-bundle-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const scratch = path.join(dir, 'scratch.git');
    await hostGit(['init', '-q', '--bare', scratch], dir);
    fs.writeFileSync(path.join(scratch, 'objects', 'info', 'alternates'), `${objects}\n`);
    await hostGit(['--git-dir', scratch, 'update-ref', `refs/heads/${branch}`, sha], dir);
    const file = path.join(dir, 'origin.bundle');
    await hostGit(['--git-dir', scratch, 'bundle', 'create', '-q', file, `refs/heads/${branch}`], dir);
    fs.rmSync(scratch, { recursive: true, force: true });
    return { path: file, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export interface SnapshotPlan {
  startOptions: StartOptions;
  base: string;
  hash: string;
  tag: string;
}

/** The temporary start and the hash a snapshot of `opts.branch` would have; `status` and `list`
 * use it too, so every command computes the hash the same way. */
export async function planSnapshot(opts: Omit<SnapshotOptions, 'rebuild' | 'log'>): Promise<SnapshotPlan> {
  const bp = opts.blueprint.blueprint;
  const presets = await resolvePresets(orderTools(bp.tools), { repoRoot: opts.repo.root, globalKunjDir: getGlobalKunjDir() });

  // No secrets, keep files, copied files, ports or agent: the image must not hold anything private
  const config: KunjConfig = {
    ...opts.config,
    container: { ...opts.config.container, env: [], keepFiles: false, files: [], publish: [], agentCommand: '' },
  };
  const startOptions: StartOptions = {
    branch: opts.branch,
    create: false,
    publish: [],
    rebuild: true,
    config,
    repo: opts.repo,
    kunjVersion: opts.kunjVersion,
    hostEnv: {},
    cwd: opts.cwd,
    jsonMode: opts.jsonMode,
    skipHooks: true,
    keepOnError: false,
    confirmPush: async () => false,
    warn: opts.warn,
    defaultBranch: async () => opts.branch,
    noSnapshot: true,
    blueprint: opts.blueprint,
    namesFor: snapshotNamesFor(opts.branch),
    ignoreForwardPorts: true,
    presets,
  };

  // Same base image and lockfile ref as a start, so the two hashes agree
  const base = await baseImageTag(startOptions);
  const hash = await computeBlueprintHash({ resolved: opts.blueprint, defaultBranch: opts.branch, cwd: opts.cwd, baseImage: base, presets });
  return { startOptions, base, hash, tag: snapshotTag(opts.repo.name, hash) };
}

export async function snapshotBlueprint(backend: ContainerBackend, opts: SnapshotOptions): Promise<SnapshotResult> {
  const { startOptions, base, hash, tag } = await planSnapshot(opts);

  if (!opts.rebuild && (await backend.imageExists(tag))) {
    const found = (await backend.listImages({ [LABEL.repo]: opts.repo.id })).find(i => i.tag === tag);
    const ref = found?.labels[LABEL.blueprintRef] ?? '';
    return { tag, hash, ref, base, sizeBytes: found?.size ?? 0, tools: [], reused: true, viaBundle: false };
  }

  let bundle: { path: string; cleanup: () => void } | undefined;
  if (!opts.noBundle) {
    opts.log(`Fetching ${opts.branch} from origin for the snapshot…`);
    bundle = await makeBranchBundle(opts.branch, opts.cwd);
    startOptions.bundle = { hostPath: bundle.path, containerPath: BUNDLE_CONTAINER_PATH };
  }

  // A run killed before its cleanup (Ctrl-C during setup) leaves the temporary container and its
  // volumes; a kept workspace volume would skip the clone and snapshot an old checkout
  const names = containerNames(opts.repo.name, opts.repo.id, snapshotNamesFor(opts.branch));
  let result: StartResult | undefined;
  let sha = '';
  let tools: SnapshotResult['tools'] = [];
  try {
    await removeContainer(backend, names, { force: true, keepVolumes: false, user: '', kunjVersion: opts.kunjVersion, warn: opts.warn });
    result = await startContainer(backend, startOptions);
    tools = result.blueprint?.tools ?? [];
    const id = result.containerId;
    const copy = await backend.exec(id, ['sh', '-c', SEED_COPY_SCRIPT], { user: 'root' });
    if (copy.exitCode !== 0) throw new Error(`Copying the workspace to ${SEED_DIR} failed (exit ${copy.exitCode})`);
    const read = await backend.exec(id, ['sh', '-c', SNAPSHOT_READ_SCRIPT], { user: 'root' });
    const nl = read.stdout.indexOf('\n');
    sha = (nl === -1 ? read.stdout : read.stdout.slice(0, nl)).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('Could not read the commit checked out in the snapshot container');
    const changes = envChanges(nl === -1 ? '' : read.stdout.slice(nl + 1), opts.warn);
    const labels = blueprintLabels({ repoId: opts.repo.id, hash, ref: sha, base, user: result.user });
    opts.log('Committing snapshot…');
    await backend.commitContainer(id, tag, labels, changes);
  } finally {
    bundle?.cleanup();
    // startContainer rolls itself back when it throws; anything after it is undone here
    if (result) {
      await removeContainer(backend, result.names, {
        force: true,
        keepVolumes: false,
        user: result.user,
        kunjVersion: opts.kunjVersion,
        warn: opts.warn,
      }).catch(err => opts.warn(`Could not remove the temporary snapshot container: ${message(err)}`));
    }
  }

  // One snapshot per repository
  const images = snapshotsOf(await backend.listImages({ [LABEL.repo]: opts.repo.id }), opts.repo.name);
  for (const old of images.filter(i => i.labels[LABEL.blueprintHash] !== hash)) {
    await backend.removeImage(old.tag).catch(err => opts.warn(`Could not remove the old snapshot ${old.tag}: ${message(err)}`));
  }
  return {
    tag,
    hash,
    ref: sha,
    base,
    sizeBytes: images.find(i => i.tag === tag)?.size ?? 0,
    tools,
    reused: false,
    viaBundle: !!bundle,
  };
}

export const FIRST_SNAPSHOT_PROGRESS = 'Building blueprint snapshot (first use; this runs setup once)…';
export const STALE_SNAPSHOT_PROGRESS = 'Blueprint changed; rebuilding the snapshot…';

export interface EnsureSnapshotResult {
  /** The snapshot built now; null when none was built */
  result: SnapshotResult | null;
  built: boolean;
  /** Why the build failed; the start falls back to the older snapshot, else tools and setup in the container */
  failed?: string;
  /** An older snapshot of the repository exists (known once the plan is made) */
  stale?: boolean;
}

/**
 * What `start` runs before a new container: build the snapshot when there is none for the current
 * hash (or, with `stale: 'rebuild'`, when only an older one exists). Never throws: a failed build
 * is returned in `failed`, so a start does not fail only because a snapshot could not be made.
 */
export async function ensureSnapshot(
  backend: ContainerBackend,
  opts: Omit<SnapshotOptions, 'rebuild'> & { stale: 'rebuild' | 'keep' }
): Promise<EnsureSnapshotResult> {
  let stale: boolean | undefined;
  try {
    const { tag } = await planSnapshot(opts);
    if (await backend.imageExists(tag)) return { result: null, built: false };
    stale = snapshotsOf(await backend.listImages({ [LABEL.repo]: opts.repo.id }), opts.repo.name).length > 0;
    if (stale && opts.stale === 'keep') return { result: null, built: false, stale };
    opts.log(stale ? STALE_SNAPSHOT_PROGRESS : FIRST_SNAPSHOT_PROGRESS);
    const result = await snapshotBlueprint(backend, { ...opts, rebuild: false });
    return { result, built: true, stale };
  } catch (err) {
    return { result: null, built: false, failed: message(err), ...(stale !== undefined ? { stale } : {}) };
  }
}

export async function snapshotStatus(
  backend: ContainerBackend,
  repoName: string,
  repoId: string,
  hash: string
): Promise<{ current: ImageInfo | null; others: ImageInfo[] }> {
  const images = snapshotsOf(await backend.listImages({ [LABEL.repo]: repoId }), repoName);
  const current = images.find(i => i.labels[LABEL.blueprintHash] === hash) ?? null;
  return { current, others: images.filter(i => i !== current) };
}

/** Removes every snapshot of the repository; returns the tags removed (a failure warns and the rest still go). */
export async function removeSnapshots(
  backend: ContainerBackend,
  repoName: string,
  repoId: string,
  warn: (m: string) => void = () => {}
): Promise<string[]> {
  const removed: string[] = [];
  for (const i of snapshotsOf(await backend.listImages({ [LABEL.repo]: repoId }), repoName)) {
    try {
      await backend.removeImage(i.tag);
      removed.push(i.tag);
    } catch (err) {
      warn(`Could not remove ${i.tag}: ${message(err)}`);
    }
  }
  return removed;
}
