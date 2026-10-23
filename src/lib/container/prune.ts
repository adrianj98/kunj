// `kunj ct prune`: what kunj left behind in Docker for one repository, and its removal.
//
// Removes branch containers whose branch is gone from origin (or that have been stopped longer than
// container.pruneAfterDays) when their remove guard is clean; orphans (helpers, services and
// networks labelled for a branch that has no main container; such volumes only with --force);
// snapshot images of another blueprint hash; and kunj-sandbox / kunj-nethelper tags of other
// versions. Every rule fails safe: origin unreachable -> no branch is gone, a branch the clone never
// saw on origin -> not gone, hash unknown -> every snapshot is kept, an image in use or a guard that
// cannot run -> kept. The guard runs again at removal time.

import { execFile } from 'child_process';
import { ContainerBackend, ContainerInfo, LabelledObject } from './backend';
import { ContainerNames, LABEL } from './names';
import { RemoveGuard, describeGuard } from './env';
import { inspectForRemove, removeContainer } from './lifecycle';
import { NETHELPER_IMAGE, SANDBOX_IMAGE } from './image';
import { SNAPSHOT_REPO } from './blueprint';
import { forwardsFile, updateForwards } from './autoforward';
import { nonInteractiveEnv } from './seed';

export interface PrunePlan {
  containers: Array<{
    branch: string;
    names: ContainerNames;
    reason: 'branch-gone' | 'age';
    /** The container's image, for the container-delete hooks */
    image: string;
    /** The recorded user the guard runs as */
    user: string;
    guard?: RemoveGuard;
    /** Why it stays despite the reason: the guard's problems, or why the guard could not run */
    kept?: string;
  }>;
  orphans: PruneOrphan[];
  /** Image tags to remove */
  images: string[];
  /** The images' size (each image once, whatever its number of tags) */
  bytes: number;
  /** What the plan could not decide, e.g. origin unreachable */
  warnings: string[];
}

export interface PruneOrphan {
  kind: 'container' | 'volume' | 'network';
  name: string;
  /** Why it stays: a volume can hold unpushed work and has no guard, so it goes only with --force */
  kept?: string;
}

export const KEPT_VOLUME = 'volume without a container; use --force to remove';

export interface PruneContext {
  repoId: string;
  repoName: string;
  /** Where `git ls-remote --heads origin` runs */
  cwd: string;
  kunjVersion: string;
  now?: Date;
  /** Stopped containers created longer ago than this are removed; unset or 0 = off */
  pruneAfterDays?: number;
  /** Skip the remove guard, and remove volumes without a container */
  force: boolean;
  /** Branch names on origin; null (or none) when origin cannot be reached. Default: one git ls-remote in cwd. */
  remoteBranches?: () => Promise<string[] | null>;
  /** The blueprint hash a snapshot would have now; null (or no function) keeps every snapshot. */
  currentBlueprintHash?: () => Promise<string | null>;
  /** The kunj image tags of this version (default: the sandbox and network helper tags) */
  currentImages?: string[];
  /** Look for superseded kunj images (default true; they are not per repository, so --all asks once) */
  kunjImages?: boolean;
}

export interface ApplyContext {
  repoId: string;
  kunjVersion: string;
  /** false: removeContainer runs the guard again, so work done since the plan is never lost */
  force: boolean;
  /** Runs pre-/post-container-delete; a throwing pre hook skips that container */
  hook?: (name: 'pre-container-delete' | 'post-container-delete', values: { branch: string; container: string; image: string }) => Promise<void>;
  forwardsFile?: string;
}

const LS_REMOTE_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KUNJ_IMAGE_REPOS = ['kunj-sandbox', 'kunj-nethelper'];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseLsRemoteHeads(output: string): string[] {
  return output
    .split('\n')
    .map(l => l.split('\t')[1]?.trim())
    .filter((ref): ref is string => !!ref && ref.startsWith('refs/heads/'))
    .map(ref => ref.slice('refs/heads/'.length));
}

/** Origin's branches, or null when origin cannot be reached (no prompt, bounded by a timeout). */
export function lsRemoteHeads(cwd: string): Promise<string[] | null> {
  return new Promise(resolve => {
    execFile('git', ['ls-remote', '--heads', 'origin'], { cwd, env: nonInteractiveEnv(), timeout: LS_REMOTE_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : parseLsRemoteHeads(String(stdout))));
  });
}

/** The names that go with a branch container, from its own name (survives a renamed repository). */
export function namesOfContainer(container: string): ContainerNames {
  return {
    container,
    helper: `${container}-net-helper`,
    workspaceVolume: `${container}-ws`,
    homeVolume: `${container}-home`,
    network: `${container}-net`,
  };
}

export function isMainContainer(c: ContainerInfo): boolean {
  const role = c.labels[LABEL.role];
  return role ? role === 'main' : !c.name.endsWith('-net-helper');
}

const ownerKey = (labels: Record<string, string>): string | null =>
  labels[LABEL.repo] && labels[LABEL.branch] !== undefined ? `${labels[LABEL.repo]}\n${labels[LABEL.branch]}` : null;

/**
 * Containers, volumes and networks labelled for a repository and branch that has no main container
 * (e.g. one removed with `docker rm`). The labels decide, never the name.
 */
export function findOrphans(containers: ContainerInfo[], volumes: LabelledObject[], networks: LabelledObject[]): PruneOrphan[] {
  const owners = new Set(containers.filter(isMainContainer).map(c => ownerKey(c.labels)).filter(Boolean));
  const orphaned = (labels: Record<string, string>) => {
    const key = ownerKey(labels);
    return key !== null && !owners.has(key);
  };
  return [
    ...containers.filter(c => !isMainContainer(c) && orphaned(c.labels)).map(c => ({ kind: 'container' as const, name: c.name })),
    ...volumes.filter(v => orphaned(v.labels)).map(v => ({ kind: 'volume' as const, name: v.name })),
    ...networks.filter(v => orphaned(v.labels)).map(v => ({ kind: 'network' as const, name: v.name })),
  ];
}

function recordedUser(c: ContainerInfo): string {
  try {
    return JSON.parse(c.labels[LABEL.options] ?? '{}').user ?? '';
  } catch {
    return '';
  }
}

// Docker's Created has nanoseconds; Date.parse wants at most milliseconds
function createdTime(createdAt: string): number {
  return Date.parse(createdAt.replace(/(\.\d{3})\d+/, '$1'));
}

export async function planPrune(backend: ContainerBackend, ctx: PruneContext): Promise<PrunePlan> {
  const plan: PrunePlan = { containers: [], orphans: [], images: [], bytes: 0, warnings: [] };
  // Every container: an image is in use whichever repository's container runs it
  const everything = await backend.list({});
  const containers = everything.filter(c => c.labels[LABEL.repo] === ctx.repoId);
  const mains = containers.filter(isMainContainer);

  // 1. Branch containers: branch gone from origin, or stopped for too long. An empty answer is
  // treated as unreachable: a repository always has a branch, so it means something went wrong.
  const answer = await (ctx.remoteBranches ?? (() => lsRemoteHeads(ctx.cwd)))();
  const remote = answer && answer.length ? new Set(answer) : null;
  if (!remote) plan.warnings.push('origin is unreachable, so no container is removed because its branch is gone');
  const now = (ctx.now ?? new Date()).getTime();
  const days = ctx.pruneAfterDays ?? 0;
  for (const c of mains) {
    const branch = c.labels[LABEL.branch] ?? '';
    // A snapshot build's temporary container (`<branch>:snapshot`) is not a branch
    if (branch.endsWith(':snapshot')) continue;
    const missing = !!remote && !remote.has(branch);
    const old = days > 0 && c.state !== 'running' && now - createdTime(c.createdAt) > days * DAY_MS;
    if (!missing && !old) continue;

    const names = namesOfContainer(c.name);
    const user = recordedUser(c);
    // Missing from origin is not enough: a branch made with `start -c` and never pushed was never
    // there. The guard's exec says whether the clone has origin's ref for it, so it runs even with --force.
    let guard: RemoveGuard | undefined;
    let guardError: string | undefined;
    if (missing || !ctx.force) {
      try {
        guard = await inspectForRemove(backend, names, { user, kunjVersion: ctx.kunjVersion });
      } catch (err) {
        guardError = message(err);
      }
    }
    const gone = missing && !!guard?.originBranches?.includes(branch);
    if (missing && !guard) plan.warnings.push(`${c.name} could not be inspected, so it is not treated as gone: ${guardError}`);
    if (!gone && !old) continue;

    const entry: PrunePlan['containers'][number] = { branch, names, reason: gone ? 'branch-gone' : 'age', image: c.image, user };
    if (guard) entry.guard = guard;
    if (!ctx.force) {
      const problems = guard ? describeGuard(guard) : [guardError ?? 'the container could not be inspected'];
      if (problems.length) entry.kept = problems.join('; ');
    }
    plan.containers.push(entry);
  }

  // 2. Orphans
  const [volumes, networks] = await Promise.all([
    backend.listVolumes({ [LABEL.repo]: ctx.repoId }),
    backend.listNetworks({ [LABEL.repo]: ctx.repoId }),
  ]);
  plan.orphans = findOrphans(containers, volumes, networks).map(o =>
    o.kind === 'volume' && !ctx.force ? { ...o, kept: KEPT_VOLUME } : o);

  // 3. Images nobody uses: snapshots of another hash, kunj images of another version
  const inUse = new Set(everything.map(c => c.image));
  const sized = new Map<string, number>();
  const take = (tag: string, id: string, size: number) => {
    plan.images.push(tag);
    sized.set(id, size);
  };
  const prefix = `${SNAPSHOT_REPO(ctx.repoName)}:`;
  const snapshots = (await backend.listImages({ [LABEL.repo]: ctx.repoId })).filter(i => i.tag.startsWith(prefix));
  if (snapshots.length) {
    const hash = ctx.currentBlueprintHash ? await ctx.currentBlueprintHash().catch(() => null) : null;
    if (hash) {
      for (const i of snapshots) if (i.labels[LABEL.blueprintHash] !== hash && !inUse.has(i.tag)) take(i.tag, i.id, i.size);
    }
  }
  const current = new Set(ctx.currentImages ?? [SANDBOX_IMAGE(ctx.kunjVersion), NETHELPER_IMAGE(ctx.kunjVersion)]);
  const kunjImages = ctx.kunjImages === false ? [] : await backend.listImages({}, { references: KUNJ_IMAGE_REPOS });
  for (const i of kunjImages) {
    if (!current.has(i.tag) && !inUse.has(i.tag)) take(i.tag, i.id, i.size);
  }
  plan.bytes = [...sized.values()].reduce((a, b) => a + b, 0);
  return plan;
}

export async function applyPrune(
  backend: ContainerBackend,
  plan: PrunePlan,
  ctx: ApplyContext
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      removed.push(name);
    } catch (err) {
      failed.push(`${name}: ${message(err)}`);
    }
  };

  for (const c of plan.containers.filter(c => !c.kept)) {
    const values = { branch: c.branch, container: c.names.container, image: c.image };
    await attempt(c.names.container, async () => {
      // Checked again: the agent may have committed since the plan (or while the prompt waited).
      // Before the pre hook, as `remove` does, so the hook only runs for a container that goes.
      if (!ctx.force) {
        const problems = describeGuard(await inspectForRemove(backend, c.names, { user: c.user, kunjVersion: ctx.kunjVersion }));
        if (problems.length) throw new Error(`kept, it now holds work origin does not have: ${problems.join('; ')}`);
      }
      await ctx.hook?.('pre-container-delete', values);
      await removeContainer(backend, c.names, {
        user: c.user,
        kunjVersion: ctx.kunjVersion,
        force: true,
        keepVolumes: false,
        owner: { repoId: ctx.repoId, branch: c.branch },
      });
      await ctx.hook?.('post-container-delete', values);
    });
  }
  // Containers before their volumes and networks, which are in use until they are gone
  for (const kind of ['container', 'volume', 'network'] as const) {
    for (const o of plan.orphans.filter(o => o.kind === kind && !o.kept)) {
      const ids = kind === 'container' ? { containers: [o.name] } : kind === 'volume' ? { volumes: [o.name] } : { networks: [o.name] };
      await attempt(o.name, () => backend.remove(ids));
    }
  }
  for (const tag of plan.images) await attempt(tag, () => backend.removeImage(tag));

  // Registry entries of containers that no longer exist
  try {
    const existing = new Set((await backend.list({})).map(c => c.name));
    updateForwards(records => records.filter(r => existing.has(r.container)), ctx.forwardsFile ?? forwardsFile());
  } catch (err) {
    failed.push(`forward registry: ${message(err)}`);
  }
  return { removed, failed };
}

/** What applying the plan would remove (kept entries are not counted). */
export function removalCount(plan: PrunePlan): number {
  return plan.containers.filter(c => !c.kept).length + plan.orphans.filter(o => !o.kept).length + plan.images.length;
}

/** One plan of several repositories' (`prune --all`), for the JSON output. */
export function mergePlans(plans: PrunePlan[]): PrunePlan {
  if (plans.length === 1) return plans[0];
  return {
    containers: plans.flatMap(p => p.containers),
    orphans: plans.flatMap(p => p.orphans),
    images: plans.flatMap(p => p.images),
    bytes: plans.reduce((sum, p) => sum + p.bytes, 0),
    warnings: plans.flatMap(p => p.warnings),
  };
}
