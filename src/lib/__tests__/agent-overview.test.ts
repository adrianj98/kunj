import { OVERVIEW_METRICS as m, activePlans, buildOverview, layoutFamily, loopLevels, loopSpan, markerLabel, overviewFamilies, overviewSummary, planPlace, planStatus, planTitleText, subagentLabel } from '../agent-overview';
import type { AgentPlanItemJson, AgentPlanStepJson, AgentPlanSubagentJson } from '../json-types';

const step = (id: number, status: AgentPlanStepJson['status'] = 'pending'): AgentPlanStepJson => ({ id: String(id), subject: `step ${id}`, status });
const plan = (session: string, over: Partial<AgentPlanItemJson> = {}): AgentPlanItemJson => ({
  session, id: null, branch: session, worktree: `/r/${session}`, title: null, running: true, state: 'running',
  steps: [], current: null, markers: [], subagents: [], updatedAt: null, ...over,
});
const sub = (over: Partial<AgentPlanSubagentJson> = {}): AgentPlanSubagentJson => ({ id: 's', type: 't', task: null, fromStep: 0, toStep: 1, running: false, steps: [], ...over });
const one = (p: AgentPlanItemJson) => layoutFamily({ lanes: [{ plan: p, parent: null }] }).lanes[0];
const done = step(1, 'completed');

describe('which agents, in which order', () => {
  it('an ended session is left out, an unknown one kept', () => {
    expect(activePlans([plan('a'), plan('b', { running: false }), plan('c', { running: null })]).map(p => p.session)).toEqual(['a', 'c']);
  });

  it('a child follows its parent; one whose parent is not listed is a root', () => {
    const families = overviewFamilies([plan('p'), plan('z'), plan('c', { parent: { session: 'p', step: 1 } }), plan('o', { parent: { session: 'gone', step: 2 } })]);
    expect(families.map(f => f.lanes.map(l => [l.plan.session, l.parent]))).toEqual([[['p', null], ['c', 0]], [['z', null]], [['o', null]]]);
  });

  it('grandchildren stay in the family and a cycle loses nobody', () => {
    const family = overviewFamilies([plan('d', { parent: { session: 'a', step: 1 } }), plan('c', { parent: { session: 'b', step: 0 } }), plan('b', { parent: { session: 'a', step: 0 } }), plan('a')]);
    expect(family).toHaveLength(1);
    expect(family[0].lanes.map(l => [l.plan.session, l.parent])).toEqual([['a', null], ['d', 0], ['b', 0], ['c', 2]]);
    const cycle = overviewFamilies([plan('x', { parent: { session: 'y', step: null } }), plan('y', { parent: { session: 'x', step: null } })]);
    expect(cycle.flatMap(f => f.lanes.map(l => l.plan.session)).sort()).toEqual(['x', 'y']);
    expect(overviewFamilies([plan('me', { parent: { session: 'me', step: null } })])).toHaveLength(1);
  });
});

describe('text', () => {
  it('status, title, place and summary', () => {
    expect(planStatus(plan('a', { state: 'waiting' }))).toBe('Waiting for input');
    expect(planStatus(plan('a'))).toBe('Working');
    expect(planStatus(plan('a', { steps: [done, step(2, 'in_progress'), step(3)], current: 1 }))).toBe('Step 2 of 3');
    expect(planStatus(plan('a', { steps: [done] }))).toBe('All 1 step done');
    expect(planTitleText(plan('feat/x'))).toBe('feat/x');
    expect(planTitleText(plan('feat/x', { title: '  Do the thing ' }))).toBe('Do the thing');
    expect(planPlace(plan('feat/x', { id: 'two' }), false)).toBe('feat/x · worktree · agent two');
    expect(planPlace(plan('feat/x', { id: 'two' }), true)).toBe('handoff · agent two · feat/x');
    expect(planPlace(plan('feat/x', { container: 'c' }), false)).toBe('feat/x · container');
    expect(overviewSummary(2, 1)).toBe('2 agents · 1 waiting for you');
    expect(overviewSummary(1, 0)).toBe('1 agent');
    expect(overviewSummary(0, 0)).toBe('No agents running');
  });

  it('marker and subagent labels; a marker that is not drawn has none', () => {
    const at = 'x';
    expect(markerLabel({ type: 'branch', afterStep: 0, from: 'main', to: 'feat/x', at })).toBe('main → feat/x');
    expect(markerLabel({ type: 'worktree', afterStep: null, from: '/r', to: '/r/.git/kunj/worktrees/b/', at })).toBe('r → b');
    expect(markerLabel({ type: 'fork', afterStep: 1, at })).toBe('fork');
    expect(markerLabel({ type: 'compact', afterStep: 1, at })).toBeNull();
    expect(markerLabel({ type: 'something-new' as any, afterStep: 1, at })).toBeNull();
    expect(subagentLabel(sub({ type: 'Explore' }))).toBe('subagent · Explore · done');
    expect(subagentLabel(sub({ task: 'find callers', running: true }))).toBe('subagent · find callers');
  });
});

describe('geometry', () => {
  it('stops are evenly spaced and the line is done up to the current stop', () => {
    const p = plan('a', { title: 'T', steps: [done, step(2, 'completed'), step(3, 'in_progress'), step(4)], current: 2 });
    const layout = layoutFamily({ lanes: [{ plan: p, parent: null }] });
    const lane = layout.lanes[0];
    expect(lane.stops.map(s => s.x)).toEqual([56, 172, 288, 404]);
    expect(lane.stops.map(s => s.kind)).toEqual(['done', 'done', 'current', 'todo']);
    expect(lane.stops[2].label).toBe('step 3');
    expect(lane).toMatchObject({ y: 40, top: 0, height: m.laneHeight, line: { fromX: 56, toX: 404, doneToX: 288 }, labelBeside: false, child: false,
      title: 'T', place: 'a · worktree', status: 'Step 3 of 4', waiting: false, session: 'a', id: null, branch: 'a', worktree: '/r/a' });
    expect(lane).not.toHaveProperty('elbow');
    expect(lane).not.toHaveProperty('container');
    expect(layout.height).toBe(m.laneHeight);
    expect(layout.width).toBe(m.labelWidth + 404 + m.trailing);
  });

  it('tasks finished out of order do not read as all done', () => {
    const lane = one(plan('a', { steps: [done, step(2), step(3, 'completed')], current: 1 }));
    expect(lane.status).toBe('Step 2 of 3');
    expect(lane.line!.doneToX).toBe(172);
    expect(lane.stops.map(s => s.kind)).toEqual(['done', 'current', 'done']);
  });

  it('a finished line is done to its end and a fresh one not at all', () => {
    expect(one(plan('a', { steps: [done, step(2, 'completed')] })).line!.doneToX).toBe(172);
    expect(one(plan('a', { steps: [step(1, 'in_progress'), step(2)], current: 0 })).line!.doneToX).toBeNull();
  });

  it('an agent with no task list is one stop with its text beside, and no line', () => {
    const layout = layoutFamily({ lanes: [{ plan: plan('a', { container: 'c1' }), parent: null }] });
    const lane = layout.lanes[0];
    expect(lane.stops).toEqual([{ x: 56, y: 40, kind: 'current', label: 'No task list yet' }]);
    expect(lane.labelBeside).toBe(true);
    expect(lane).not.toHaveProperty('line');
    expect(lane.container).toBe('c1');
    expect(layout.width).toBeGreaterThan(m.labelWidth + 56 + m.trailing);
  });

  it('a child starts half a stop after the stop it branched from; a step its parent no longer has is clamped', () => {
    const parent = plan('p', { steps: [done, step(2, 'in_progress'), step(3)], current: 1 });
    const child = plan('c', { steps: [step(1, 'in_progress'), step(2)], current: 0, parent: { session: 'p', step: 1 } });
    const layout = layoutFamily(overviewFamilies([parent, child])[0]);
    const lane = layout.lanes[1];
    expect(lane.child).toBe(true);
    expect(lane.place).toBe('handoff · c');
    expect(lane.top).toBe(layout.lanes[0].height);
    expect(lane.elbow).toEqual({ fromX: 172, fromY: 40, toX: 230, toY: lane.top + 40 });
    expect(lane.stops.map(s => s.x)).toEqual([230, 346]);
    expect(layout.height).toBe(layout.lanes[0].height + lane.height);
    const far = plan('c', { steps: [step(1)], parent: { session: 'p', step: 9 } });
    expect(layoutFamily(overviewFamilies([parent, far])[0]).lanes[1].elbow!.fromX).toBe(288);
  });

  it('a loop spans its steps, is at least one stop wide and makes the lane taller', () => {
    const ended = sub({ id: 's1', steps: [step(5, 'completed'), step(6, 'completed')] });
    const running = sub({ id: 's2', fromStep: 2, toStep: null, running: true, steps: [step(7, 'completed'), step(8, 'in_progress'), step(9)] });
    const lane = one(plan('a', { steps: [done, step(2, 'completed'), step(3, 'in_progress'), step(4)], current: 2, subagents: [ended, running] }));
    expect(lane.loops[0]).toMatchObject({ fromX: 56, toX: 172, lineY: 40, y: 40 + m.loopDrop, doneToX: 172, running: false, label: 'subagent · t · done' });
    expect(lane.loops[0].stops.map(s => s.x)).toEqual([80, 148]);
    // started on the current step and still on it: one stop wide
    expect(lane.loops[1]).toMatchObject({ fromX: 288, toX: 404, running: true });
    expect(lane.loops[1].stops.map(s => s.kind)).toEqual(['done', 'current', 'todo']);
    expect(lane.loops[1].doneToX).toBe(lane.loops[1].stops[1].x);
    // they do not overlap: one level
    expect(lane.loops[1].y).toBe(lane.loops[0].y);
    expect(lane.height).toBeGreaterThan(m.laneHeight);
  });

  it('a running loop is done as far as its last finished step, or not at all', () => {
    const lane = one(plan('a', { steps: [done, step(2)], subagents: [
      sub({ id: 'x', running: true, toStep: null, steps: [step(5, 'completed'), step(6)] }),
      sub({ id: 'y', running: true, toStep: null, steps: [] }),
    ] }));
    expect(lane.loops[0].doneToX).toBe(lane.loops[0].stops[0].x);
    expect(lane.loops[1].doneToX).toBe(lane.loops[1].fromX);
  });

  it('overlapping loops stack and a loop with one step centres it', () => {
    expect(loopLevels([{ from: 0, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 3 }, { from: 3, to: 4 }])).toEqual([0, 1, 0, 0]);
    expect(loopLevels([])).toEqual([]);
    const lane = one(plan('a', { steps: [done, step(2, 'completed'), step(3, 'in_progress')], current: 2, subagents: [
      sub({ id: 'a', toStep: 2, steps: [step(9, 'completed')] }), sub({ id: 'b', fromStep: 1, toStep: 2 }),
    ] }));
    expect(lane.loops[1].y).toBe(lane.loops[0].y + m.loopSpacing);
    expect(lane.loops[0].stops.map(s => s.x)).toEqual([(56 + 288) / 2]);
  });

  it('loop spans are clamped to the line', () => {
    expect(loopSpan(sub({ fromStep: null, toStep: null, running: true }), null, 0)).toEqual({ from: 0, to: 1 });
    expect(loopSpan(sub({ fromStep: 1, toStep: 9 }), 2, 3)).toEqual({ from: 1, to: 2 });
    expect(loopSpan(sub({ fromStep: 2, toStep: 2 }), 2, 3)).toEqual({ from: 2, to: 3 });
    expect(loopSpan(sub({ fromStep: 0, toStep: null, running: true }), 2, 3)).toEqual({ from: 0, to: 2 });
    expect(loopSpan(sub({ fromStep: 3, toStep: 1 }), 0, 4)).toEqual({ from: 3, to: 4 });
  });

  it('a marker sits between two stops; only a drawn one counts, and it takes room only before loops', () => {
    const at = 'x';
    const steps = [done, step(2, 'in_progress'), step(3)];
    const markers = [{ type: 'branch' as const, afterStep: 0, from: 'main', to: 'feat/x', at }, { type: 'compact' as const, afterStep: 1, at }];
    const lane = one(plan('a', { steps, current: 1, markers }));
    expect(lane.markers).toEqual([{ x: 56 + m.stopSpacing / 2, y: 40, labelY: 53, label: 'main → feat/x' }]);
    expect(lane.height).toBe(m.laneHeight);
    const withLoop = one(plan('a', { steps, current: 1, markers, subagents: [sub()] }));
    expect(withLoop.loops[0].y).toBe(40 + m.markerLabelHeight + m.loopDrop);
    expect(withLoop.height).toBeGreaterThan(m.laneHeight + m.markerLabelHeight);
    expect(one(plan('a', { steps: [step(1)], markers: [{ type: 'fork', afterStep: null, at }] })).markers[0].x).toBeLessThan(56);
    expect(one(plan('a', { steps: [step(1)], markers: [{ type: 'compact', afterStep: 0, at }] })).markers).toEqual([]);
  });
});

describe('buildOverview', () => {
  it('counts the running agents, says so, and lays out their families', () => {
    const o = buildOverview([
      plan('p', { steps: [done], state: 'waiting' }), plan('c', { parent: { session: 'p', step: 0 } }),
      plan('ended', { running: false, state: 'waiting' }), plan('z'),
    ]);
    expect(o).toMatchObject({ agents: 3, waiting: 1, summary: '3 agents · 1 waiting for you', metrics: { labelWidth: m.labelWidth, stopSpacing: m.stopSpacing } });
    expect(o.families.map(f => f.lanes.map(l => l.session))).toEqual([['p', 'c'], ['z']]);
    expect(o.families[0].lanes[0].waiting).toBe(true);
    expect(buildOverview([])).toMatchObject({ agents: 0, waiting: 0, summary: 'No agents running', families: [] });
  });

  it('a child whose parent ended is drawn as a root, with no elbow', () => {
    const o = buildOverview([plan('p', { running: false }), plan('c', { parent: { session: 'p', step: 0 } })]);
    expect(o.families).toHaveLength(1);
    expect(o.families[0].lanes[0]).toMatchObject({ session: 'c', child: false });
    expect(o.families[0].lanes[0]).not.toHaveProperty('elbow');
  });
});
