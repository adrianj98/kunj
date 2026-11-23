import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as os from 'os';
import { currentStep, parentLine, planHookCommand, planTitle, reducePlan } from '../agent-plan';

const line = (hook: any, t = 100, branch = 'main') => JSON.stringify({ kunj: { t, branch }, hook });
const create = (id: string, subject: string, extra: any = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject }, tool_response: { task: { id, subject } }, ...extra });
const update = (taskId: string, status: string, extra: any = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId, status }, tool_response: { success: true }, ...extra });

describe('reducePlan', () => {
  it('reads a recording of Claude Code 2.1.330 (main steps, a subagent on the shared list, a deleted task)', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'agent-plan-probe.ndjson'), 'utf8');
    const plan = reducePlan(text);
    expect(plan.steps.map(s => [s.id, s.subject, s.status])).toEqual([['1', 'main-one', 'completed']]);
    expect(plan.steps[0].startedAt).toBeDefined();
    expect(plan.steps[0].completedAt).toBeDefined();
    expect(plan.current).toBeNull();
    expect(plan.subagents).toHaveLength(1);
    const sub = plan.subagents[0];
    expect(sub).toMatchObject({ type: 'general-purpose', task: 'Subagent task tool test', fromStep: 0, toStep: 0, running: false });
    expect(sub.steps.map(s => [s.id, s.subject, s.status])).toEqual([['2', 'sub-one', 'completed'], ['3', 'sub-two', 'pending']]);
    expect(plan.branch).toBe('master');
    expect(plan.transcript).toMatch(/\.jsonl$/);
    expect(plan.markers).toEqual([]);
  });

  it('nothing recorded', () => {
    expect(reducePlan('')).toMatchObject({ steps: [], current: null, subagents: [], markers: [], updatedAt: null, title: null });
  });

  it('skips lines that do not parse or are not kunj lines', () => {
    const plan = reducePlan(['{broken', '{"other":1}', line(create('1', 'a')), ''].join('\n'));
    expect(plan.steps).toHaveLength(1);
  });

  it('the current step is the one in progress, else the next pending after the last completed', () => {
    const text = [line(create('1', 'a')), line(create('2', 'b')), line(create('3', 'c')), line(update('1', 'completed'))];
    expect(reducePlan(text.join('\n')).current).toBe(1);
    expect(reducePlan([...text, line(update('3', 'in_progress'))].join('\n')).current).toBe(2);
    expect(currentStep([])).toBeNull();
  });

  it('a failed update changes nothing; a rename is kept', () => {
    const failed = { ...update('1', 'completed'), tool_response: { success: false } };
    const rename = { hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '1', subject: 'renamed' }, tool_response: { success: true } };
    const plan = reducePlan([line(create('1', 'a')), line(failed), line(rename)].join('\n'));
    expect(plan.steps[0]).toMatchObject({ subject: 'renamed', status: 'pending' });
  });

  it('a branch change is a marker after the step being worked on; a subagent line does not make one', () => {
    const plan = reducePlan([
      line(create('1', 'a'), 1, 'main'), line(update('1', 'in_progress'), 2, 'main'),
      line(create('9', 's', { agent_id: 'x' }), 3, 'other'),
      line(create('2', 'b'), 4, 'feat/x'),
    ].join('\n'));
    expect(plan.markers).toEqual([{ type: 'branch', afterStep: 0, from: 'main', to: 'feat/x', at: new Date(4000).toISOString() }]);
    expect(plan.branch).toBe('feat/x');
  });

  it('a move between two worktrees is one worktree marker, not also a branch one', () => {
    const cwd = { hook_event_name: 'CwdChanged', old_cwd: '/r/src', new_cwd: '/r/.git/kunj/worktrees/b/src' };
    const plan = reducePlan([line(create('1', 'a'), 1, 'main'), line(cwd, 2, 'b')].join('\n'), ['/r', '/r/.git/kunj/worktrees/b']);
    expect(plan.markers).toEqual([{ type: 'worktree', afterStep: null, from: '/r', to: '/r/.git/kunj/worktrees/b', at: new Date(2000).toISOString() }]);
  });

  it('a cd inside one worktree is no marker', () => {
    const cwd = { hook_event_name: 'CwdChanged', old_cwd: '/r', new_cwd: '/r/src' };
    expect(reducePlan(line(cwd), ['/r']).markers).toEqual([]);
  });

  it('fork and compact are markers; startup and clear start the line again but keep the parent', () => {
    const start = (source: string) => ({ hook_event_name: 'SessionStart', source });
    const plan = reducePlan([parentLine('kunj-r-main-1', 2).trim(), line(create('1', 'a')), line(start('fork')), line(start('compact'))].join('\n'));
    expect(plan.markers.map(m => m.type)).toEqual(['fork', 'compact']);
    expect(plan.parent).toEqual({ session: 'kunj-r-main-1', step: 2 });
    const again = reducePlan([parentLine('p', null).trim(), line(create('1', 'a')), line(start('fork')), line(start('clear'))].join('\n'));
    expect(again).toMatchObject({ steps: [], markers: [], parent: { session: 'p', step: null } });
  });

  it('a running subagent has no end; its task comes from the Agent call of the same type', () => {
    const plan = reducePlan([
      line({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'explore', subagent_type: 'Explore' } }),
      line({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'write tests', subagent_type: 'general-purpose' } }),
      line({ hook_event_name: 'SubagentStart', agent_id: 'g', agent_type: 'general-purpose' }),
      line({ hook_event_name: 'SubagentStart', agent_id: 'e', agent_type: 'Explore' }),
      line(create('5', 'sub step', { agent_id: 'g' })),
    ].join('\n'));
    expect(plan.subagents.map(s => [s.id, s.task, s.running, s.toStep])).toEqual([['g', 'write tests', true, null], ['e', 'explore', true, null]]);
    expect(plan.subagents[0].steps.map(s => s.subject)).toEqual(['sub step']);
    expect(plan.steps).toEqual([]);
  });

  it('TodoWrite replaces the list and keeps the start time of an entry that stays', () => {
    const todo = (todos: any[]) => ({ hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos } });
    const plan = reducePlan([
      line(todo([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }]), 1),
      line(todo([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]), 2),
    ].join('\n'));
    expect(plan.steps.map(s => [s.subject, s.status])).toEqual([['a', 'completed'], ['b', 'in_progress'], ['c', 'pending']]);
    expect(plan.steps[0].startedAt).toBe(new Date(1000).toISOString());
    expect(plan.current).toBe(1);
  });

  it('the title is the first heading of the plan from plan mode', () => {
    const exit = { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'intro\n\n# Plan: Agent overview\n\n## Steps' } };
    expect(reducePlan(line(exit)).title).toBe('Agent overview');
    expect(planTitle('just a line')).toBe('just a line');
    expect(planTitle('')).toBeNull();
  });
});

describe('planHookCommand', () => {
  it('has no single quote (the settings JSON is single-quoted for the shell)', () => {
    expect(planHookCommand()).not.toContain("'");
  });

  it('appends one line the reducer reads, and nothing without KUNJ_AGENT_PLAN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-plan-'));
    const file = path.join(dir, 'p.ndjson');
    const input = JSON.stringify(create('1', 'with "quotes" and $HOME'));
    execFileSync('sh', ['-c', planHookCommand()], { input, cwd: dir, env: { PATH: process.env.PATH, KUNJ_AGENT_PLAN: file } });
    execFileSync('sh', ['-c', planHookCommand()], { input, cwd: dir, env: { PATH: process.env.PATH } });
    const text = fs.readFileSync(file, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(reducePlan(text).steps[0].subject).toBe('with "quotes" and $HOME');
    fs.rmSync(dir, { recursive: true });
  });
});
