// `kunj ct blueprint snapshot`: provision a temporary container from the blueprint, copy its
// workspace to the seed directory and commit it as kunj-blueprint-<repo>:<hash>. The temporary
// container is an ordinary start without secrets, keep files or hooks, and is always removed.
import { ContainerBackend, ImageInfo } from './backend';
import {
  ResolvedBlueprint,
  SEED_DIR,
  SNAPSHOT_REPO,
  blueprintHash,
  blueprintLabels,
  blueprintRef,
  lockfileIds,
  snapshotTag,
} from './blueprint';
import { StartOptions, StartResult, baseImageTag, removeContainer, startContainer } from './lifecycle';
import { LABEL, containerNames } from './names';
import { orderTools, resolvePresets } from './presets';
import { SEED_COPYING, SEED_FRESH, SEED_MARKER_EXCLUDE } from './seed';
import { getGlobalKunjDir } from '../config';
import { KunjConfig } from '../../types';

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

export async function snapshotBlueprint(backend: ContainerBackend, opts: SnapshotOptions): Promise<SnapshotResult> {
  const bp = opts.blueprint.blueprint;
  const ref = blueprintRef(opts.blueprint, opts.branch);
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
  const hash = blueprintHash({
    text: opts.blueprint.text,
    lockfiles: await lockfileIds(bp.lockfiles, ref, opts.cwd),
    baseImage: base,
    presetHashes: presets.map(p => p.hash),
  });
  const tag = snapshotTag(opts.repo.name, hash);

  if (!opts.rebuild && (await backend.imageExists(tag))) {
    const found = (await backend.listImages({ [LABEL.repo]: opts.repo.id })).find(i => i.tag === tag);
    const ref = found?.labels[LABEL.blueprintRef] ?? '';
    return { tag, hash, ref, base, sizeBytes: found?.size ?? 0, tools: [], reused: true };
  }

  // A run killed before its cleanup (Ctrl-C during setup) leaves the temporary container and its
  // volumes; a kept workspace volume would skip the clone and snapshot an old checkout
  const names = containerNames(opts.repo.name, opts.repo.id, snapshotNamesFor(opts.branch));
  await removeContainer(backend, names, { force: true, keepVolumes: false, user: '', kunjVersion: opts.kunjVersion, warn: opts.warn });

  let result: StartResult | undefined;
  let sha = '';
  let tools: SnapshotResult['tools'] = [];
  try {
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
  };
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
