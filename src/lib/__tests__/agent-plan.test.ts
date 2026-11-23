import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import * as os from 'os';
import { CONTAINER_PLAN_SCRIPT, subagentToolHookCommand, agentPlanDir, agentPlanFile, recordedPlanSessions, removePlanRecords, currentStep, parentLine, parseContainerPlans, planHookCommand, planTitle, reducePlan } from '../agent-plan';

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
    // done out of order: the one left behind is the current step, not "all done"
    const outOfOrder = [line(create('1', 'a')), line(create('2', 'b')), line(create('3', 'c')), line(update('1', 'completed')), line(update('3', 'completed'))];
    expect(reducePlan(outOfOrder.join('\n')).current).toBe(1);
    expect(reducePlan([...outOfOrder, line(update('2', 'completed'))].join('\n')).current).toBeNull();
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

  it('a new conversation goes on after the finished steps of the earlier ones, behind a new marker', () => {
    const start = (source: string) => ({ hook_event_name: 'SessionStart', source });
    const plan = reducePlan([
      line(start('startup')), line(create('1', 'a')), line(create('2', 'b')), line(update('1', 'completed')), line(update('2', 'in_progress')),
      line(start('clear')), line(create('1', 'c')), line(update('1', 'in_progress')),
      line(start('startup')), line(create('1', 'd')),
    ].join('\n'));
    // b was left unfinished: not kept; ids of the earlier conversations do not clash with the new ones
    expect(plan.steps.map(s => [s.id, s.subject, s.status])).toEqual([['h1-1', 'a', 'completed'], ['1', 'd', 'pending']]);
    expect(plan.markers).toMatchObject([{ type: 'new', afterStep: 0 }]);
    expect(plan.current).toBe(1);
    // a handoff's parent goes with its own conversation: a later fresh start or /clear drops it
    const handed = [parentLine('p', 1).trim(), line(start('startup')), line(create('1', 'a'))];
    expect(reducePlan(handed.join('\n')).parent).toEqual({ session: 'p', step: 1 });
    expect(reducePlan([...handed, line(start('clear'))].join('\n')).parent).toBeUndefined();
    // a first conversation has no marker
    expect(reducePlan([line(start('startup')), line(create('1', 'a'))].join('\n')).markers).toEqual([]);
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

  it('a TodoWrite from a subagent whose start was not recorded replaces its list instead of doubling it', () => {
    const todo = (todos: any[]) => ({ hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', agent_id: 'unknown', tool_input: { todos } });
    const plan = reducePlan([
      line(todo([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }]), 1),
      line(todo([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }]), 2),
    ].join('\n'));
    expect(plan.steps.map(s => [s.subject, s.status])).toEqual([['a', 'completed'], ['b', 'in_progress']]);
  });

  it('a subagent\'s tool calls are counted with the latest tool; one whose start was not recorded is ignored', () => {
    const tool = (agent: string, name: string) => ({ hook_event_name: 'SubagentTool', agent_id: agent, tool_name: name });
    const plan = reducePlan([
      line({ hook_event_name: 'SubagentStart', agent_id: 'bg', agent_type: 'general-purpose' }),
      line(tool('bg', 'Grep')), line(tool('bg', 'Read')), line(tool('unknown', 'Bash')), line(tool('bg', 'SubagentHandback')),
      line({ hook_event_name: 'SubagentStart', agent_id: 'quiet', agent_type: 'Explore' }),
    ].join('\n'));
    expect(plan.subagents.map(s => [s.id, s.toolCalls, s.lastTool])).toEqual([['bg', 2, 'Read'], ['quiet', undefined, undefined]]);
    expect(plan.subagents[1]).not.toHaveProperty('toolCalls');
  });

  it('the title is the first heading of the plan from plan mode', () => {
    const exit = { hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'intro\n\n# Plan: Agent overview\n\n## Steps' } };
    expect(reducePlan(line(exit)).title).toBe('Agent overview');
    expect(planTitle('just a line')).toBe('just a line');
    expect(planTitle('')).toBeNull();
  });
});

describe('hook commands never block the agent', () => {
  // dash exits 2 on a failed redirect, and Claude Code reads 2 as "block the tool call / the stop"
  const shells = ['sh', 'dash', 'bash'].filter(sh => { try { execFileSync('which', [sh]); return true; } catch { return false; } });
  it.each(shells)('every kunj hook exits 0 in %s when the file cannot be written', (sh) => {
    const { claudeHookSettings } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
    const settings = JSON.parse(claudeHookSettings(true));
    const commands: string[] = Object.values(settings.hooks).flatMap((list: any) => list.flatMap((h: any) => h.hooks.map((x: any) => x.command)));
    expect(commands.length).toBeGreaterThan(8);
    const env = { PATH: process.env.PATH!, KUNJ_AGENT_PLAN: '/nonexistent-kunj/p.ndjson', KUNJ_AGENT_STATE: '/nonexistent-kunj/s', KUNJ_AGENT_RESUME: '/nonexistent-kunj/r.json' };
    const input = JSON.stringify({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
    for (const command of commands) {
      const r = spawnSync(sh, ['-c', command], { input, env, encoding: 'utf8' });
      expect({ command, status: r.status, stderr: r.stderr }).toEqual({ command, status: 0, stderr: '' });
    }
  });
});

describe('subagentToolHookCommand', () => {
  const run = (input: string, env: Record<string, string>) =>
    execFileSync('sh', ['-c', subagentToolHookCommand()], { input, env: { PATH: process.env.PATH!, ...env } });

  it('has no single quote', () => {
    expect(subagentToolHookCommand()).not.toContain("'");
  });

  it('records a subagent\'s call as one short line, never its input, and nothing for the main agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-subtool-'));
    const file = path.join(dir, 'p.ndjson');
    const marker = path.join(dir, 'ran');
    // a value that looks like the key, and one that would run a command if it reached the shell
    const tricky = `/x/"agent_id":"evil" $(touch ${marker}) \`x\``;
    run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'a266ff19', tool_input: { file_path: tricky } }), { KUNJ_AGENT_PLAN: file });
    run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: '"agent_id":"x"' } }), { KUNJ_AGENT_PLAN: file });
    run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'a1' }), {});
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ kunj: { t: expect.any(Number) }, hook: { hook_event_name: 'SubagentTool', agent_id: 'a266ff19', tool_name: 'Read' } });
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it('a tool whose arguments hold agent_id or tool_name keys neither names the subagent nor makes a main call look like one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-subtool-'));
    const file = path.join(dir, 'p.ndjson');
    // the shape Claude Code sends: agent_id and tool_name ahead of tool_input
    run(JSON.stringify({ session_id: 's', agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x', agent_id: 'evil', tool_name: 'WRONG' } }), { KUNJ_AGENT_PLAN: file });
    run(JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { agent_id: 'a1' } }), { KUNJ_AGENT_PLAN: file });
    const hooks = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).hook);
    expect(hooks).toEqual([{ hook_event_name: 'SubagentTool', agent_id: 'a1', tool_name: 'Bash' }]);
    fs.rmSync(dir, { recursive: true });
  });

  it('an id with a character outside the safe set records nothing; a tool name outside it is left empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-subtool-'));
    const file = path.join(dir, 'p.ndjson');
    run('{"tool_name":"Read","agent_id":"ab$cd"}', { KUNJ_AGENT_PLAN: file });
    run('{"tool_name":"Read","agent_id":"$(id)"}', { KUNJ_AGENT_PLAN: file });
    expect(fs.existsSync(file)).toBe(false);
    run('{"tool_name":"x y","agent_id":"a1"}', { KUNJ_AGENT_PLAN: file });
    run('{"tool_name":"mcp__chrome__click","agent_id":"a1"}', { KUNJ_AGENT_PLAN: file });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).hook.tool_name);
    expect(lines).toEqual(['', 'mcp__chrome__click']);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('removePlanRecords', () => {
  it('removes the records of a branch\'s sessions and no other', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-plan-rm-'));
    fs.mkdirSync(agentPlanDir(dir));
    for (const s of ['kunj-r-x-abc123', 'kunj-r-x-abc123-a-two', 'kunj-r-x-abc1234', 'kunj-r-y-def456']) fs.writeFileSync(agentPlanFile(dir, s), '');
    expect(removePlanRecords(dir, 'kunj-r-x-abc123').sort()).toEqual(['kunj-r-x-abc123', 'kunj-r-x-abc123-a-two']);
    expect(recordedPlanSessions(dir).sort()).toEqual(['kunj-r-x-abc1234', 'kunj-r-y-def456']);
    expect(removePlanRecords(path.join(dir, 'nowhere'), 'x')).toEqual([]);
    fs.rmSync(dir, { recursive: true });
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

describe('container plans', () => {
  it('splits the script output into one record per session and skips names kunj does not give', () => {
    const out = ['#kunj-plan agent 1 waiting', line(create('1', 'a')), '', '#kunj-plan agent-two 0 ', line(create('1', 'b')), '#kunj-plan evil;name 1 running', line(create('1', 'c'))].join('\n');
    const records = parseContainerPlans(out);
    expect(records.map(r => [r.session, r.id, r.running, r.state])).toEqual([['agent', null, true, 'waiting'], ['agent-two', 'two', false, null]]);
    expect(records.map(r => reducePlan(r.text).steps[0].subject)).toEqual(['a', 'b']);
    expect(parseContainerPlans('')).toEqual([]);
  });

  it('the script prints the records of a directory as the parser reads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-cplan-'));
    fs.writeFileSync(path.join(dir, 'kunj-agent-plan'), line(create('1', 'a')) + '\n');
    fs.writeFileSync(path.join(dir, 'kunj-agent-plan-x1'), line(create('1', 'b')) + '\n');
    fs.writeFileSync(path.join(dir, 'kunj-agent-state-x1'), 'waiting');
    const script = CONTAINER_PLAN_SCRIPT.split('/tmp/').join(`${dir}/`);
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, TMUX_TMPDIR: dir } });
    const records = parseContainerPlans(out);
    expect(records.map(r => [r.session, r.running, r.state])).toEqual([['agent', false, null], ['agent-x1', false, 'waiting']]);
    expect(reducePlan(records[1].text).steps[0].subject).toBe('b');
    fs.rmSync(dir, { recursive: true });
  });
});
