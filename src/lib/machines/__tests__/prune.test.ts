import type { MachineJson } from '../../json-types';
import { IMAGE_BUILD_BRANCH } from '../provider';
import { machineRemovals, planMachinePrune } from '../prune';

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
