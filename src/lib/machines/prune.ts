// `kunj machine prune` (docs/specs/cloud-machines.md, "Prune"): which of a repository's machines can
// go. A machine holds one branch, so one whose branch is gone from origin, or that holds no container,
// only costs money. Pure planning: the caller gives the machines, origin's branches and a way to look
// inside a running machine; nothing here talks to a cloud. No machine is ever woken to be checked.

import type { MachineImageJson, MachineJson } from '../json-types';
import { IMAGE_BUILD_BRANCH } from './provider';

/** How long a machine without a container is not an orphan: a start is still putting one on it. */
export const MACHINE_ORPHAN_GRACE_MS = 10 * 60_000;
/** An image build takes about 8 minutes; a builder older than this was left behind by one that died. */
export const BUILDER_GRACE_MS = 2 * 60 * 60_000;

export interface MachineInside {
  /** Whether the branch's container exists on the machine */
  container: boolean;
  /** What the remove guard found in it (unpushed commits, stashes, uncommitted changes); [] when clean */
  problems: string[];
}

export interface MachinePruneItem {
  name: string;
  branch: string;
  state: MachineJson['state'];
  reason: 'branch-gone' | 'no-container' | 'image-builder' | 'asleep-long';
  /** Why it stays despite the reason; absent when it will be deleted */
  kept?: string;
}

export interface MachinePrunePlan {
  machines: MachinePruneItem[];
  warnings: string[];
}

export interface MachinePruneInput {
  machines: MachineJson[];
  /** Origin's branches; null when origin could not be asked (then no branch counts as gone) */
  heads: string[] | null;
  force: boolean;
  now?: number;
  /** machine.deleteAfterDays: a machine asleep longer is listed (always kept: it cannot be checked asleep); 0: never */
  deleteAfterDays?: number;
  /** Looks inside a running machine; throws when its serve does not answer */
  inspect(machine: MachineJson): Promise<MachineInside>;
}

export async function planMachinePrune(input: MachinePruneInput): Promise<MachinePrunePlan> {
  const now = input.now ?? Date.now();
  const warnings: string[] = [];
  if (input.heads === null) warnings.push('origin is unreachable, so no machine is removed for a deleted branch');
  const age = (m: MachineJson) => now - (Date.parse(m.createdAt) || now);
  const items = await Promise.all(
    input.machines.map(async (m): Promise<MachinePruneItem | undefined> => {
      const item = (reason: MachinePruneItem['reason'], kept?: string): MachinePruneItem => ({ name: m.name, branch: m.branch, state: m.state, reason, ...(kept ? { kept } : {}) });
      if (m.branch === IMAGE_BUILD_BRANCH) return age(m) > BUILDER_GRACE_MS ? item('image-builder') : undefined;
      const gone = input.heads !== null && !input.heads.includes(m.branch);
      const awake = m.state === 'running' && m.paired;
      if (!awake) {
        // Asleep, or not answering: what is on its disk cannot be seen, and it is not woken to look
        if (!gone) return asleepLong(m, now, input.deleteAfterDays ?? 0);
        return item('branch-gone', input.force ? undefined : `it is ${m.state === 'running' ? 'not paired' : m.state}, so its work cannot be checked (wake it with kunj machine resume, or use --force)`);
      }
      let inside: MachineInside;
      try {
        inside = await input.inspect(m);
      } catch (err) {
        return gone ? item('branch-gone', input.force ? undefined : `it could not be checked: ${(err as Error).message}`) : undefined;
      }
      if (gone) return item('branch-gone', inside.problems.length && !input.force ? inside.problems.join('; ') : undefined);
      if (!inside.container && age(m) > MACHINE_ORPHAN_GRACE_MS) return item('no-container');
      return undefined;
    }),
  );
  return { machines: items.filter((i): i is MachinePruneItem => !!i).sort((a, b) => a.branch.localeCompare(b.branch)), warnings };
}

const DAY_MS = 24 * 60 * 60_000;

/** A machine asleep past machine.deleteAfterDays, listed and kept: --force does not delete it either. */
function asleepLong(m: MachineJson, now: number, afterDays: number): MachinePruneItem | undefined {
  if (!(afterDays > 0) || (m.state !== 'suspended' && m.state !== 'stopped')) return undefined;
  const since = Date.parse(m.sleptAt ?? '');
  if (Number.isNaN(since) || now - since < afterDays * DAY_MS) return undefined;
  const slept = Math.floor((now - since) / DAY_MS);
  return {
    name: m.name,
    branch: m.branch,
    state: m.state,
    reason: 'asleep-long',
    kept: `its work cannot be checked while it sleeps: once ${m.branch} is pushed, kunj machine delete ${m.branch} (asleep ${slept} day${slept === 1 ? '' : 's'})`,
  };
}

export function machineRemovals(plan: MachinePrunePlan): MachinePruneItem[] {
  return plan.machines.filter(m => !m.kept);
}

/** A golden image this old, of a repository with no machine, is unused: kunj machine prune lists it. */
export const IMAGE_UNUSED_AFTER_DAYS = 14;

export interface ImagePruneItem {
  name: string;
  repo: string;
  createdAt: string;
  reason: 'unused';
  /** Why it stays despite the reason; absent when it will be deleted */
  kept?: string;
}

export interface ImagePruneInput {
  /** The repository the command runs for: other repositories' images are listed, never removed */
  repo?: string;
  images: MachineImageJson[];
  /** Every machine the coordinator has, of every repository (a machine of any repository may boot any image) */
  machines: MachineJson[];
  /** machine.image: an image named there is never pruned */
  pinned?: string;
  now?: number;
}

/**
 * Golden images nobody will boot: older than IMAGE_UNUSED_AFTER_DAYS and of a repository with no
 * machine at all (an image build in progress is a machine of the repository). Kept when machine.image
 * names it, or when any machine booted from it (and so when one was created from it in the last day).
 */
export function planImagePrune(input: ImagePruneInput): ImagePruneItem[] {
  const now = input.now ?? Date.now();
  const busyRepos = new Set(input.machines.map(m => m.repo));
  const items: ImagePruneItem[] = [];
  for (const image of input.images) {
    const made = Date.parse(image.createdAt);
    // An image whose age is unknown is not known to be old
    if (Number.isNaN(made) || now - made < IMAGE_UNUSED_AFTER_DAYS * DAY_MS) continue;
    if (!image.repo || busyRepos.has(image.repo)) continue;
    const item: ImagePruneItem = { name: image.name, repo: image.repo, createdAt: image.createdAt, reason: 'unused' };
    const booted = input.machines.filter(m => m.image === image.name);
    if (input.pinned && input.pinned === image.name) item.kept = 'machine.image names it';
    // another repository's machine.image (its own config) may name it: only listed, removed from there
    else if (input.repo && image.repo !== input.repo) item.kept = 'another repository: prune it from there (its machine.image may name it)';
    else if (booted.length) item.kept = `machine ${booted[0].name} booted from it`;
    items.push(item);
  }
  return items.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
}
