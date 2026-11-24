import type { MachineJson } from '../../json-types';
import { IMAGE_BUILD_BRANCH } from '../provider';
import { machineRemovals, planImagePrune, planMachinePrune } from '../prune';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const machine = (branch: string, over: Partial<MachineJson> = {}): MachineJson => ({
  name: `kunj-app-${branch.replace(/[^a-z0-9]/g, '-')}-abc123`,
  state: 'running',
  repo: 'github.com/acme/app',
  branch,
  size: 'e2-standard-2',
  createdAt: '2026-11-17T09:00:00Z',
  paired: true,
  ...over,
});
const clean = async () => ({ container: true, problems: [] });

describe('planMachinePrune', () => {
  it('removes a machine whose branch is gone from origin, after looking inside', async () => {
    const seen: string[] = [];
    const plan = await planMachinePrune({
      machines: [machine('gone'), machine('kept'), machine('dirty')],
      heads: ['kept', 'main'],
      force: false,
      now: NOW,
      inspect: async m => {
        seen.push(m.branch);
        return m.branch === 'dirty' ? { container: true, problems: ['uncommitted changes'] } : { container: true, problems: [] };
      },
    });
    expect(plan.machines).toEqual([
      { name: machine('dirty').name, branch: 'dirty', state: 'running', reason: 'branch-gone', kept: 'uncommitted changes' },
      { name: machine('gone').name, branch: 'gone', state: 'running', reason: 'branch-gone' },
    ]);
    expect(machineRemovals(plan).map(m => m.branch)).toEqual(['gone']);
    expect(seen.sort()).toEqual(['dirty', 'gone', 'kept']);
  });

  it('never wakes a sleeping machine: it stays unless forced', async () => {
    const inspect = jest.fn(clean);
    const machines = [machine('gone', { state: 'suspended' }), machine('here', { state: 'suspended' })];
    const plan = await planMachinePrune({ machines, heads: ['here'], force: false, now: NOW, inspect });
    expect(plan.machines).toHaveLength(1);
    expect(plan.machines[0].kept).toContain('suspended');
    expect(machineRemovals(await planMachinePrune({ machines, heads: ['here'], force: true, now: NOW, inspect })).map(m => m.branch)).toEqual(['gone']);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('lists a machine asleep past machine.deleteAfterDays, never deletes it (not even with --force), and never wakes it', async () => {
    const DAY = 24 * 60 * 60_000;
    const inspect = jest.fn(clean);
    const old = new Date(NOW - 8 * DAY).toISOString();
    const recent = new Date(NOW - 2 * DAY).toISOString();
    const machines = [
      machine('long', { state: 'suspended', sleptAt: old }),
      machine('stopped', { state: 'stopped', sleptAt: old }),
      machine('recent', { state: 'suspended', sleptAt: recent }),
      machine('unknown', { state: 'suspended' }),
    ];
    for (const force of [false, true]) {
      const plan = await planMachinePrune({ machines, heads: ['long', 'stopped', 'recent', 'unknown'], force, now: NOW, deleteAfterDays: 7, inspect });
      expect(plan.machines.map(m => [m.branch, m.reason])).toEqual([['long', 'asleep-long'], ['stopped', 'asleep-long']]);
      expect(plan.machines[0].kept).toContain('asleep 8 days');
      expect(plan.machines[0].kept).toContain('kunj machine delete long');
      expect(machineRemovals(plan)).toEqual([]);
    }
    const off = await planMachinePrune({ machines, heads: ['long', 'stopped', 'recent', 'unknown'], force: false, now: NOW, inspect });
    expect(off.machines).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('removes a running machine with no container, once a start has had its time', async () => {
    const empty = async () => ({ container: false, problems: [] });
    const plan = await planMachinePrune({ machines: [machine('old'), machine('new', { createdAt: '2026-11-17T11:55:00Z' })], heads: ['old', 'new'], force: false, now: NOW, inspect: empty });
    expect(plan.machines).toEqual([{ name: machine('old').name, branch: 'old', state: 'running', reason: 'no-container' }]);
  });

  it('removes nothing for a deleted branch when origin cannot be asked, or when a machine does not answer', async () => {
    const offline = await planMachinePrune({ machines: [machine('gone')], heads: null, force: false, now: NOW, inspect: clean });
    expect(offline.machines).toEqual([]);
    expect(offline.warnings[0]).toContain('origin is unreachable');
    const silent = await planMachinePrune({ machines: [machine('gone'), machine('here')], heads: ['here'], force: false, now: NOW, inspect: async () => Promise.reject(new Error('no answer')) });
    expect(silent.machines).toEqual([{ name: machine('gone').name, branch: 'gone', state: 'running', reason: 'branch-gone', kept: 'it could not be checked: no answer' }]);
  });

  it('removes an image builder only when a build must have died', async () => {
    const builder = (createdAt: string) => machine(IMAGE_BUILD_BRANCH, { createdAt, name: 'kunj-app-builder' });
    const plan = await planMachinePrune({ machines: [builder('2026-11-17T11:30:00Z')], heads: ['main'], force: true, now: NOW, inspect: clean });
    expect(plan.machines).toEqual([]);
    const old = await planMachinePrune({ machines: [builder('2026-11-17T08:00:00Z')], heads: ['main'], force: false, now: NOW, inspect: clean });
    expect(old.machines).toEqual([{ name: 'kunj-app-builder', branch: IMAGE_BUILD_BRANCH, state: 'running', reason: 'image-builder' }]);
  });
});

describe('planImagePrune', () => {
  const DAY = 24 * 60 * 60_000;
  const image = (name: string, repo: string, ageDays: number) => ({ name, repo, createdAt: new Date(NOW - ageDays * DAY).toISOString() });

  it('lists images older than 14 days of a repository with no machine, and keeps a pinned or booted one', () => {
    const images = [
      image('old-unused', 'github.com/acme/gone', 20),
      image('young', 'github.com/acme/gone', 13),
      image('old-busy-repo', 'github.com/acme/app', 30),
      image('pinned', 'github.com/acme/gone', 40),
      image('booted', 'github.com/acme/other', 40),
      { name: 'no-date', repo: 'github.com/acme/gone', createdAt: '' },
      image('no-repo', '', 40),
    ];
    const machines = [
      machine('main'),
      // a machine of another repository that booted 'booted' (created today)
      machine('x', { repo: 'github.com/acme/third', image: 'booted', createdAt: new Date(NOW - 3600_000).toISOString() }),
    ];
    const plan = planImagePrune({ images, machines, pinned: 'pinned', now: NOW });
    expect(plan.map(i => [i.name, i.kept ?? null])).toEqual([
      ['old-unused', null],
      ['pinned', 'machine.image names it'],
      ['booted', `machine ${machines[1].name} booted from it`],
    ]);
    expect(plan.every(i => i.reason === 'unused')).toBe(true);
  });

  it('keeps every image of a repository with a machine in any state, an image build included', () => {
    const images = [image('a', 'github.com/acme/app', 60)];
    for (const m of [machine('x', { state: 'stopped' }), machine(IMAGE_BUILD_BRANCH)]) {
      expect(planImagePrune({ images, machines: [m], now: NOW })).toEqual([]);
    }
    expect(planImagePrune({ images, machines: [], now: NOW }).map(i => i.name)).toEqual(['a']);
  });
});
