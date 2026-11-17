// `kunj machine prune` (docs/specs/cloud-machines.md, "Prune"): which of a repository's machines can
// go. A machine holds one branch, so one whose branch is gone from origin, or that holds no container,
// only costs money. Pure planning: the caller gives the machines, origin's branches and a way to look
// inside a running machine; nothing here talks to a cloud. No machine is ever woken to be checked.

import type { MachineJson } from '../json-types';
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
  reason: 'branch-gone' | 'no-container' | 'image-builder';
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
        if (!gone) return undefined;
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

export function machineRemovals(plan: MachinePrunePlan): MachinePruneItem[] {
  return plan.machines.filter(m => !m.kept);
}
