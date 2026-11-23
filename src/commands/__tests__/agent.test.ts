import { Command } from 'commander';
import { AgentCommand } from '../agent';
import { AgentError, killTmuxSessionIfExists, agentArgv, agentSessionName, agentStateFile, hasTmuxSession, hostRunArgv, loginShell, readTmuxSessions, runTmux, killTmuxSession, withAgentHooks } from '../../lib/agent-session';
import { loadResolvedConfig } from '../../lib/config';
import { hostSecrets } from '../../lib/secrets/host';

jest.mock('../../lib/worktree', () => ({
  ...jest.requireActual('../../lib/worktree'),
  listWorktreesDetailed: jest.fn(async () => ({
    repoRoot: '/wt',
    gitCommonDir: '/wt/.git',
    currentPath: '/wt/feature-a',
    pullRequestLookup: 'skipped',
    pullRequestsFromCache: false,
    worktrees: [{ branch: 'feature-a', name: 'feature-a', path: '/wt/feature-a', exists: true, bare: false, sessions: [], isCurrent: true }],
  })),
}));

jest.mock('../../lib/repo-identity', () => ({
  repoIdentity: jest.fn(() => ({ root: '/wt', name: 'app', id: 'github.com/acme/app', originUrl: '' })),
}));

jest.mock('../../lib/agent-session', () => ({
  ...jest.requireActual('../../lib/agent-session'),
  readTmuxSessions: jest.fn(),
  // The tests list names; the commands read them with their (absent) worktree tags
  readTaggedTmuxSessions: jest.fn(async () => {
    const r = await jest.requireMock<any>('../../lib/agent-session').readTmuxSessions();
    return Array.isArray(r) ? r.map((name: string) => ({ name, worktree: '' })) : r ?? 'missing';
  }),
  runTmux: jest.fn(async () => 0),
  killTmuxSession: jest.fn(async () => undefined),
  hasTmuxSession: jest.fn(async () => false),
  killTmuxSessionIfExists: jest.fn(async () => true),
  readAgentResume: jest.fn(() => null),
  savedAgents: jest.fn(() => []),
}));

// No plugin unless a test points at one (the real claude-plugin/ would change every command)
jest.mock('../../lib/skills', () => ({ packagedPluginDir: jest.fn(() => '/no/claude-plugin') }));

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ agent: { command: 'claude' } })),
  getKunjDir: jest.fn(() => '/h/.kunj/app'),
}));

// The state directory under the mocked kunj dir is never created on disk
jest.mock('fs', () => ({ ...jest.requireActual<object>('fs'), mkdirSync: jest.fn(), unlinkSync: jest.fn() }));

// The secrets a direct start puts in the agent's environment; the tmux path never opens the vault
jest.mock('../../lib/secrets/host', () => ({
  hostSecrets: jest.fn(async () => ({ env: { FOO: 's3cret-value' }, files: [] })),
}));

// `kunj agent overview --containers` loads the container command lazily; the tests give it a listing
const containerListJson = jest.fn();
const containerPlansJson = jest.fn();
jest.mock('../container', () => ({
  ContainerCommand: class {
    listJson = containerListJson;
    agentPlansJson = containerPlansJson;
    abortDockerCalls = jest.fn();
  },
}));

jest.mock('../../lib/git', () => ({
  getCurrentBranch: jest.fn(async () => 'feature-a'),
}));

const session = agentSessionName('app', 'github.com/acme/app', 'feature-a');
const stateFile = agentStateFile('/h/.kunj/app', session);
const claudeWithHooks = withAgentHooks('claude', stateFile, true, true);
// What a claude agent gets on top of the KUNJ_* variables: its plan record and Claude Code's task tools
const planVars = (session: string) => ({ KUNJ_AGENT_PLAN: `/h/.kunj/app/agent-plan/${session}.ndjson`, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' });
// The tmux client's own environment carries the KUNJ_* variables but never the plan ones: a client
// that starts the tmux server would hand them to every later session
const clientEnv = (vars: Record<string, string>) => Object.fromEntries(Object.entries(vars).filter(([k]) => k !== 'KUNJ_AGENT_PLAN' && k !== 'CLAUDE_CODE_ENABLE_TODO_TOOLS'));
const tmuxSessions = readTmuxSessions as jest.Mock;
// tmux runs the agent under `kunj run --branch <b>`, which unlocks the vault inside the session
const underRun = (branch: string, command: string) => hostRunArgv(branch, [loginShell(), '-lc', command]);
let stdout: string[];
let ttyBefore: boolean | undefined;

beforeEach(() => {
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  tmuxSessions.mockReset();
  (runTmux as jest.Mock).mockClear();
  (hostSecrets as jest.Mock).mockClear();
  (killTmuxSession as jest.Mock).mockClear();
  ttyBefore = process.stdin.isTTY;
  (process.stdin as any).isTTY = true;
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  (process.stdin as any).isTTY = ttyBefore;
});

test('status --json reports the session', async () => {
  tmuxSessions.mockResolvedValue([session]);
  await new AgentCommand().execute('status', 'feature-a', { json: true });
  expect(JSON.parse(stdout.join(''))).toEqual({ branch: 'feature-a', worktree: '/wt/feature-a', session: expect.stringMatching(/^kunj-/), running: true, sessions: [{ session, id: null }] });
});

test('status without a branch uses the current branch and reports null without tmux', async () => {
  tmuxSessions.mockResolvedValue('missing');
  await new AgentCommand().execute('status', { json: true });
  expect(JSON.parse(stdout.join('')).running).toBeNull();
});

test('start runs tmux in the worktree with agent.command', async () => {
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('start', 'feature-a', {});
  const vars = { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: stateFile, KUNJ_AGENT_RESUME: `/h/.kunj/app/agent-resume/${session}.json`, ...planVars(session) };
  expect(runTmux).toHaveBeenCalledWith(agentArgv(session, '/wt/feature-a', underRun('feature-a', claudeWithHooks), vars, { worktree: '/wt/feature-a' }), '/wt/feature-a', expect.objectContaining(clientEnv(vars)));
  // tmux takes a new session's environment from its server, not this client: the values go in argv
  expect((runTmux as jest.Mock).mock.calls[0][0]).toEqual(expect.arrayContaining(['-e', 'KUNJ_BRANCH=feature-a', '-e', 'KUNJ_WORKTREE=/wt/feature-a']));
});

test('start under tmux runs the agent through kunj run for the branch; no secret is in argv or opened here', async () => {
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('start', 'feature-a', {});
  const [argv, , env] = (runTmux as jest.Mock).mock.calls[0];
  const i = argv.indexOf('run');
  expect(argv.slice(i, i + 5)).toEqual(['run', '--hold', '--branch', 'feature-a', '--']);
  expect(argv.some((a: string) => a.includes('s3cret-value') || a.includes('FOO='))).toBe(false);
  expect(env).not.toHaveProperty('FOO');
  expect(hostSecrets).not.toHaveBeenCalled();
});

test('start without tmux puts the branch\'s host secrets in the agent\'s environment, not in argv', async () => {
  tmuxSessions.mockResolvedValue('missing');
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await new AgentCommand().execute('start', 'feature-a', {});
  expect(hostSecrets).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature-a', root: '/wt/feature-a' }));
  const [argv, , env] = (runTmux as jest.Mock).mock.calls[0];
  expect(env).toEqual(expect.objectContaining({ FOO: 's3cret-value', KUNJ_BRANCH: 'feature-a' }));
  expect(argv.join(' ')).not.toContain('s3cret-value');
});

test('start works inside a tmux pane: TMUX is not passed on', async () => {
  tmuxSessions.mockResolvedValue([]);
  const before = process.env.TMUX;
  process.env.TMUX = '/private/tmp/tmux-501/default,123,0';
  try {
    await new AgentCommand().execute('start', 'feature-a', {});
  } finally {
    if (before === undefined) delete process.env.TMUX;
    else process.env.TMUX = before;
  }
  expect((runTmux as jest.Mock).mock.calls[0][2]).not.toHaveProperty('TMUX');
});

test('a bare branch name starts, and --command overrides the setting', async () => {
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('feature-a', { command: 'aider' });
  expect((runTmux as jest.Mock).mock.calls[0][0]).toEqual(
    agentArgv(session, '/wt/feature-a', underRun('feature-a', 'aider'), { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: stateFile, KUNJ_AGENT_RESUME: `/h/.kunj/app/agent-resume/${session}.json` }, { worktree: '/wt/feature-a' }),
  );
});

test('--agent antigravity runs agy, without the Claude hooks', async () => {
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('feature-a', { agent: 'antigravity', session: 'ab12' });
  const named = agentSessionName('app', 'github.com/acme/app', 'feature-a', 'ab12');
  expect((runTmux as jest.Mock).mock.calls[0][0]).toEqual(
    agentArgv(named, '/wt/feature-a', underRun('feature-a', 'agy'), { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: agentStateFile('/h/.kunj/app', named), KUNJ_AGENT_RESUME: `/h/.kunj/app/agent-resume/${named}.json` }, { worktree: '/wt/feature-a' }),
  );
});

test('an unknown --agent is refused before anything starts', async () => {
  tmuxSessions.mockResolvedValue([]);
  await expect(new AgentCommand().execute('feature-a', { agent: 'codex' })).rejects.toThrow(AgentError);
  expect(runTmux).not.toHaveBeenCalled();
});

test('start without tmux runs the command directly, prints the hint, passes the exit code', async () => {
  tmuxSessions.mockResolvedValue('missing');
  (runTmux as jest.Mock).mockResolvedValueOnce(3);
  const stderr: string[] = [];
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  });
  const shellBefore = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  try {
    await new AgentCommand().execute('start', 'feature-a', {});
  } finally {
    if (shellBefore === undefined) delete process.env.SHELL;
    else process.env.SHELL = shellBefore;
  }
  const [argv, cwd, env] = (runTmux as jest.Mock).mock.calls[0];
  expect(argv).toEqual(['/bin/zsh', '-lc', claudeWithHooks]);
  expect(cwd).toBe('/wt/feature-a');
  expect(env).toEqual(expect.objectContaining({ KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: stateFile }));
  expect(env).not.toHaveProperty('TMUX');
  expect(stderr.join('')).toBe('tmux is not installed: the agent stops when this terminal closes (brew install tmux to keep it running)\n');
  expect(process.exitCode).toBe(3);
});

test('--no-tmux runs the command directly even when tmux is installed', async () => {
  tmuxSessions.mockResolvedValue([]);
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await new AgentCommand().execute('start', 'feature-a', { tmux: false });
  expect((runTmux as jest.Mock).mock.calls[0][0]).toEqual([process.env.SHELL || 'sh', '-lc', claudeWithHooks]);
  expect(stderr).not.toHaveBeenCalled();
});

test('agent.hooks false runs claude without --settings', async () => {
  tmuxSessions.mockResolvedValue([]);
  (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ agent: { command: 'claude', hooks: false } });
  await new AgentCommand().execute('start', 'feature-a', {});
  expect((runTmux as jest.Mock).mock.calls[0][0]).toContain('claude');
  expect((runTmux as jest.Mock).mock.calls[0][0].join(' ')).not.toContain('--settings');
});

test('agent.tmux false runs the agent directly without a hint', async () => {
  tmuxSessions.mockResolvedValue([]);
  (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ agent: { command: 'aider', tmux: false } });
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await new AgentCommand().execute('start', 'feature-a', {});
  expect((runTmux as jest.Mock).mock.calls[0][0]).toEqual([process.env.SHELL || 'sh', '-lc', 'aider']);
  expect(stderr).not.toHaveBeenCalled();
});

test('agent.tmux false reattaches to a session that is still running instead of starting a second agent', async () => {
  tmuxSessions.mockResolvedValue([session]);
  (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ agent: { command: 'aider', tmux: false } });
  await new AgentCommand().execute('start', 'feature-a', {});
  expect((runTmux as jest.Mock).mock.calls[0][0][0]).toBe('tmux');
});

test('agent.tmux false asks tmux for the session when the listing failed, and reattaches', async () => {
  tmuxSessions.mockResolvedValue('failed');
  (hasTmuxSession as jest.Mock).mockResolvedValueOnce(true);
  (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ agent: { command: 'aider', tmux: false } });
  await new AgentCommand().execute('start', 'feature-a', {});
  expect(hasTmuxSession).toHaveBeenCalledWith(session);
  expect((runTmux as jest.Mock).mock.calls[0][0][0]).toBe('tmux');
});

test('agent.tmuxStatus true keeps the tmux status line', async () => {
  tmuxSessions.mockResolvedValue([]);
  (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ agent: { command: 'aider', tmuxStatus: true } });
  await new AgentCommand().execute('start', 'feature-a', {});
  expect((runTmux as jest.Mock).mock.calls[0][0].slice(-8, -6)).toEqual(['status', 'on']);
});

test('stop without tmux fails with tmux-missing', async () => {
  tmuxSessions.mockResolvedValue('missing');
  await expect(new AgentCommand().execute('stop', 'feature-a', {})).rejects.toMatchObject({ name: 'AgentError', code: 'tmux-missing' });
  expect(killTmuxSession).not.toHaveBeenCalled();
});

test('start without a terminal fails with no-tty on the direct path too', async () => {
  tmuxSessions.mockResolvedValue('missing');
  (process.stdin as any).isTTY = false;
  await expect(new AgentCommand().execute('start', 'feature-a', {})).rejects.toMatchObject({ code: 'no-tty' });
  expect(runTmux).not.toHaveBeenCalled();
});

test('start without a terminal fails with no-tty', async () => {
  tmuxSessions.mockResolvedValue([]);
  (process.stdin as any).isTTY = false;
  await expect(new AgentCommand().execute('start', 'feature-a', {})).rejects.toMatchObject({ code: 'no-tty' });
});

test('stop kills the session and reports it', async () => {
  tmuxSessions.mockResolvedValue([session]);
  await new AgentCommand().execute('stop', 'feature-a', { json: true });
  expect(killTmuxSession).toHaveBeenCalledWith(session);
  expect(JSON.parse(stdout.join(''))).toEqual({ success: true, branch: 'feature-a', session });
});

test('stop when not running fails with not-running', async () => {
  tmuxSessions.mockResolvedValue([]);
  const error = await new AgentCommand().execute('stop', 'feature-a', {}).catch(e => e);
  expect(error).toBeInstanceOf(AgentError);
  expect(error.code).toBe('not-running');
  expect(killTmuxSession).not.toHaveBeenCalled();
});

test('unknown branch fails with no-worktree', async () => {
  tmuxSessions.mockResolvedValue([]);
  await expect(new AgentCommand().execute('status', 'nope', {})).rejects.toMatchObject({ code: 'no-worktree' });
});

test('status --json for an unknown branch prints a coded error and exits 1', async () => {
  tmuxSessions.mockResolvedValue([]);
  let exit: unknown;
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code;
    throw new Error('exit');
  }) as any);
  const program = new Command();
  new AgentCommand().register(program);
  await program.parseAsync(['agent', 'status', 'nope', '--json'], { from: 'user' }).catch(() => undefined);
  expect(JSON.parse(stdout.join(''))).toEqual({ error: { code: 'no-worktree', message: expect.stringContaining('nope') } });
  expect(exit).toBe(1);
});

describe('--session: several agents per worktree', () => {
  const two = agentSessionName('app', 'github.com/acme/app', 'feature-a', 'two');
  const kill = killTmuxSessionIfExists as jest.Mock;
  beforeEach(() => {
    kill.mockReset();
    kill.mockResolvedValue(true);
  });

  test('start --session runs its own tmux session and state file', async () => {
    tmuxSessions.mockResolvedValue([session]);
    await new AgentCommand().execute('start', 'feature-a', { session: 'two' } as any);
    const file = agentStateFile('/h/.kunj/app', two);
    const vars = { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: file, KUNJ_AGENT_RESUME: `/h/.kunj/app/agent-resume/${two}.json`, ...planVars(two) };
    expect(runTmux).toHaveBeenCalledWith(agentArgv(two, '/wt/feature-a', underRun('feature-a', withAgentHooks('claude', file, true, true)), vars, { worktree: '/wt/feature-a' }), '/wt/feature-a', expect.objectContaining(clientEnv(vars)));
    expect(two).toBe(session + '-a-two');
  });

  test('a bad id is refused', async () => {
    tmuxSessions.mockResolvedValue([]);
    await expect(new AgentCommand().execute('start', 'feature-a', { session: 'a:b' } as any)).rejects.toMatchObject({ code: 'bad-session-id' });
    expect(runTmux).not.toHaveBeenCalled();
  });

  test('status is running when only a --session agent runs, and lists the sessions', async () => {
    tmuxSessions.mockResolvedValue([two, 'kunj-other']);
    await new AgentCommand().execute('status', 'feature-a', { json: true });
    expect(JSON.parse(stdout.join(''))).toEqual({ branch: 'feature-a', worktree: '/wt/feature-a', session, running: true, sessions: [{ session: two, id: 'two' }] });
  });

  test('status --session reports that session', async () => {
    tmuxSessions.mockResolvedValue([session]);
    await new AgentCommand().execute('status', 'feature-a', { json: true, session: 'two' } as any);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ session: two, running: false });
  });

  test('stop --session kills that one and exits 0 when it did not run', async () => {
    tmuxSessions.mockResolvedValue([]);
    kill.mockResolvedValue(false);
    await new AgentCommand().execute('stop', 'feature-a', { json: true, session: 'two' } as any);
    expect(kill).toHaveBeenCalledWith(two);
    expect(JSON.parse(stdout.join(''))).toEqual({ success: true, branch: 'feature-a', session: two, stopped: [] });
    expect(process.exitCode).toBeUndefined();
  });

  test('stop --all kills the default session and every -a-<id> one of the branch', async () => {
    const three = agentSessionName('app', 'github.com/acme/app', 'feature-a', 'three');
    tmuxSessions.mockResolvedValue([two, 'kunj-other', session, three]);
    await new AgentCommand().execute('stop', 'feature-a', { json: true, all: true } as any);
    expect(kill.mock.calls.map(c => c[0])).toEqual([session, two, three]);
    expect(JSON.parse(stdout.join(''))).toEqual({ success: true, branch: 'feature-a', session, stopped: [session, two, three] });
  });

  test('stop --all without tmux exits 0 having stopped nothing', async () => {
    tmuxSessions.mockResolvedValue('missing');
    await new AgentCommand().execute('stop', 'feature-a', { json: true, all: true } as any);
    expect(kill).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(''))).toEqual({ success: true, branch: 'feature-a', session, stopped: [] });
  });
});

describe('--resume', () => {
  const { readAgentResume } = jest.requireMock<any>('../../lib/agent-session');
  afterEach(() => { readAgentResume.mockReturnValue(null); readAgentResume.mockClear(); });

  test('a new session resumes the saved Claude conversation', async () => {
    tmuxSessions.mockResolvedValue([]);
    readAgentResume.mockReturnValue('5f0c-77');
    await new AgentCommand().execute('start', 'feature-a', { resume: true } as any);
    expect(readAgentResume).toHaveBeenCalledWith(`/h/.kunj/app/agent-resume/${session}.json`);
    expect(JSON.stringify((runTmux as jest.Mock).mock.calls[0][0])).toContain('claude --resume 5f0c-77 --settings');
  });

  test('a running session is reattached, and without --resume nothing is read', async () => {
    tmuxSessions.mockResolvedValue([session]);
    readAgentResume.mockReturnValue('5f0c-77');
    await new AgentCommand().execute('start', 'feature-a', { resume: true } as any);
    tmuxSessions.mockResolvedValue([]);
    await new AgentCommand().execute('start', 'feature-a', {});
    expect(readAgentResume).not.toHaveBeenCalled();
    for (const call of (runTmux as jest.Mock).mock.calls) expect(JSON.stringify(call[0])).not.toContain('--resume');
  });
});

describe('saved and forget', () => {
  const { savedAgents } = jest.requireMock<any>('../../lib/agent-session');
  const fs = jest.requireMock<any>('fs');
  const item = (id: string | null) => ({ session: id ? `${session}-a-${id}` : session, id, conversation: `c-${id}`, savedAt: '2026-11-19T10:00:00.000Z', title: 'fix it' });
  afterEach(() => { savedAgents.mockReset(); savedAgents.mockReturnValue([]); fs.unlinkSync.mockReset(); });

  test('saved --json lists what is saved for the branch, leaving out running sessions', async () => {
    tmuxSessions.mockResolvedValue([`${session}-a-2`]);
    savedAgents.mockReturnValue([item('1'), item(null)]);
    await new AgentCommand().execute('saved', 'feature-a', { json: true } as any);
    expect(savedAgents).toHaveBeenCalledWith('/h/.kunj/app', session, [`${session}-a-2`]);
    expect(JSON.parse(stdout.join(''))).toEqual({ branch: 'feature-a', worktree: '/wt/feature-a', items: [item('1'), item(null)] });
  });

  test('saved --session keeps only that one', async () => {
    tmuxSessions.mockResolvedValue([]);
    savedAgents.mockReturnValue([item('1'), item(null)]);
    await new AgentCommand().execute('saved', 'feature-a', { json: true, session: '1' } as any);
    expect(JSON.parse(stdout.join('')).items).toEqual([item('1')]);
  });

  test('forget needs --session or --all, and removes the saved files', async () => {
    tmuxSessions.mockResolvedValue([]);
    await expect(new AgentCommand().execute('forget', 'feature-a', {})).rejects.toThrow(/--session <id> or --all/);
    await new AgentCommand().execute('forget', 'feature-a', { json: true, session: '1' } as any);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`/h/.kunj/app/agent-resume/${session}-a-1.json`);
    stdout = [];
    savedAgents.mockReturnValue([item('1'), item(null)]);
    fs.unlinkSync.mockImplementation((f: string) => { if (f.includes('-a-1')) throw new Error('ENOENT'); });
    await new AgentCommand().execute('forget', 'feature-a', { json: true, all: true } as any);
    expect(JSON.parse(stdout.join(''))).toEqual({ branch: 'feature-a', forgotten: [session] });
  });

  test('forget --session keeps the conversation of a running session', async () => {
    tmuxSessions.mockResolvedValue([`${session}-a-1`]);
    await expect(new AgentCommand().execute('forget', 'feature-a', { session: '1' } as any)).rejects.toThrow(/is running/);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  test('forget --all refuses when tmux cannot say which agents run', async () => {
    tmuxSessions.mockResolvedValue('failed');
    savedAgents.mockReturnValue([item('1')]);
    await expect(new AgentCommand().execute('forget', 'feature-a', { all: true } as any)).rejects.toThrow(/nothing was forgotten/);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('plan', () => {
  const realFs = jest.requireActual<typeof import('fs')>('fs');
  const os = jest.requireActual<typeof import('os')>('os');
  const nodePath = jest.requireActual<typeof import('path')>('path');
  const { getKunjDir } = jest.requireMock<any>('../../lib/config');
  let dir: string;
  const record = (name: string, lines: object[]) =>
    realFs.writeFileSync(nodePath.join(dir, 'agent-plan', `${name}.ndjson`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const create = (id: string, subject: string) => ({ kunj: { t: 10, branch: 'feature-a' }, hook: { hook_event_name: 'PostToolUse', tool_name: 'TaskCreate', tool_input: { subject }, tool_response: { task: { id, subject } } } });

  beforeEach(() => {
    dir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), 'kunj-agent-plan-'));
    realFs.mkdirSync(nodePath.join(dir, 'agent-plan'));
    getKunjDir.mockReturnValue(dir);
    containerListJson.mockReset();
    containerPlansJson.mockReset();
  });
  afterEach(() => {
    getKunjDir.mockReturnValue('/h/.kunj/app');
    realFs.rmSync(dir, { recursive: true, force: true });
    delete process.env.KUNJ_AGENT_PLAN;
  });

  test('--json lists the running session and a recorded one that ended, not another branch\'s', async () => {
    tmuxSessions.mockResolvedValue([session]);
    record(session, [create('1', 'Read the code'), { kunj: { t: 11, branch: 'feature-a' }, hook: { hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress' }, tool_response: { success: true } } }]);
    record(`${session}-a-two`, [create('1', 'Other agent')]);
    record('kunj-app-other-abcdef', [create('1', 'Not this branch')]);
    await new AgentCommand().execute('plan', 'feature-a', { json: true });
    const { plans } = JSON.parse(stdout.join(''));
    expect(plans.map((p: any) => [p.session, p.id, p.running, p.steps.map((s: any) => s.subject), p.current])).toEqual([
      [session, null, true, ['Read the code'], 0],
      [`${session}-a-two`, 'two', false, ['Other agent'], 0],
    ]);
    expect(plans[0]).toMatchObject({ branch: 'feature-a', worktree: '/wt/feature-a', markers: [], subagents: [], state: null, title: null });
  });

  test('--session picks one; a running agent with nothing recorded is listed with no steps', async () => {
    tmuxSessions.mockResolvedValue([session, `${session}-a-two`]);
    await new AgentCommand().execute('plan', 'feature-a', { json: true, session: 'two' });
    expect(JSON.parse(stdout.join('')).plans).toEqual([expect.objectContaining({ session: `${session}-a-two`, id: 'two', running: true, steps: [], current: null, updatedAt: null })]);
  });

  test('--all needs no current worktree and an unknown branch fails without it', async () => {
    tmuxSessions.mockResolvedValue([]);
    await new AgentCommand().execute('plan', { json: true, all: true });
    expect(JSON.parse(stdout.join(''))).toEqual({ plans: [] });
    await expect(new AgentCommand().execute('plan', 'nope', { json: true })).rejects.toMatchObject({ jsonCode: 'no-worktree' });
  });

  test('overview --json groups and lays out the running agents; an ended one is left out', async () => {
    tmuxSessions.mockResolvedValue([session, `${session}-a-two`]);
    record(session, [create('1', 'Read the code'), create('2', 'Write the fix')]);
    record(`${session}-a-two`, [{ kunj: { t: 1, parent: { session, step: 0 } } }, create('1', 'Child step')]);
    record(`${session}-a-gone`, [create('1', 'Ended')]);
    await new AgentCommand().execute('overview', { json: true });
    const o = JSON.parse(stdout.join(''));
    expect(o).toMatchObject({ repo: { name: 'app', root: '/wt' }, agents: 2, waiting: 0, summary: '2 agents', metrics: { labelWidth: 248, stopSpacing: 116 } });
    expect(o).not.toHaveProperty('containers');
    expect(o.families).toHaveLength(1);
    expect(o.families[0].lanes.map((l: any) => [l.session, l.child, l.stops.map((s: any) => s.label)])).toEqual([
      [session, false, ['Read the code', 'Write the fix']],
      [`${session}-a-two`, true, ['Child step']],
    ]);
    expect(o.families[0].lanes[1].elbow).toMatchObject({ fromX: 56, toX: 114 });
    expect(containerListJson).not.toHaveBeenCalled();
  });

  test('overview --containers adds the agents of running containers that have one, each on its own backend', async () => {
    tmuxSessions.mockResolvedValue([]);
    const ct = (branch: string, state: string, running: boolean | null, remote?: string) => ({ branch, state, agent: { running }, ...(remote ? { remote } : {}) });
    containerListJson.mockResolvedValue({ containers: [ct('feat/a', 'running', true), ct('feat/b', 'running', false), ct('feat/c', 'exited', true), ct('feat/d', 'running', true, 'box')] });
    containerPlansJson.mockImplementation(async (branch: string) => {
      if (branch === 'feat/d') throw new Error('box is down');
      return [{ session: 'agent', id: null, branch, worktree: '/workspace', container: 'kunj-app-a', title: 'In a container', running: true, state: 'waiting', steps: [], current: null, markers: [], subagents: [], updatedAt: null }];
    });
    await new AgentCommand().execute('overview', { json: true, containers: true });
    const o = JSON.parse(stdout.join(''));
    expect(containerPlansJson.mock.calls).toEqual([['feat/a', { remote: 'local' }], ['feat/d', { remote: 'box' }]]);
    // the container that could not be read is named, not passed over in silence
    expect(o).toMatchObject({ agents: 1, waiting: 1, containers: { available: true, unreadable: ['feat/d'] } });
    expect(o.families[0].lanes[0]).toMatchObject({ container: 'kunj-app-a', place: 'feat/a · container', status: 'Waiting for input', labelBeside: true });
  });

  test('overview --containers with Docker down still gives the host agents', async () => {
    tmuxSessions.mockResolvedValue([session]);
    containerListJson.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    await new AgentCommand().execute('overview', { json: true, containers: true });
    const o = JSON.parse(stdout.join(''));
    expect(o.agents).toBe(1);
    expect(o.containers).toEqual({ available: false, message: 'Cannot connect to the Docker daemon' });
  });

  test('the plan variables reach the session (-e) but not the tmux client, even when inherited', async () => {
    tmuxSessions.mockResolvedValue([]);
    process.env.KUNJ_AGENT_PLAN = nodePath.join(dir, 'agent-plan', 'kunj-app-main-123abc.ndjson');
    await new AgentCommand().execute('start', 'feature-a', {});
    const [argv, , env] = (runTmux as jest.Mock).mock.calls[0];
    expect(argv).toContain(`KUNJ_AGENT_PLAN=${nodePath.join(dir, 'agent-plan', `${session}.ndjson`)}`);
    expect(argv).toContain('CLAUDE_CODE_ENABLE_TODO_TOOLS=1');
    expect(env).not.toHaveProperty('KUNJ_AGENT_PLAN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS');
    expect(env.KUNJ_BRANCH).toBe('feature-a');
  });

  test('a session tagged with another worktree is not listed here by its name, even with a record', async () => {
    const { readTaggedTmuxSessions } = jest.requireMock<any>('../../lib/agent-session');
    readTaggedTmuxSessions.mockResolvedValueOnce([{ name: session, worktree: '/wt/moved-away' }]);
    record(session, [create('1', 'Belongs to the worktree that moved')]);
    await new AgentCommand().execute('plan', 'feature-a', { json: true });
    expect(JSON.parse(stdout.join('')).plans).toEqual([]);
    // tagged with this worktree, it is listed once
    stdout.length = 0;
    readTaggedTmuxSessions.mockResolvedValueOnce([{ name: session, worktree: '/wt/feature-a' }]);
    await new AgentCommand().execute('plan', 'feature-a', { json: true });
    expect(JSON.parse(stdout.join('')).plans.map((p: any) => p.session)).toEqual([session]);
  });

  test('a reattach after a failed tmux listing keeps the running agent\'s record', async () => {
    tmuxSessions.mockResolvedValue('failed');
    (hasTmuxSession as jest.Mock).mockResolvedValue(true);
    record(session, [create('1', 'Still working')]);
    await new AgentCommand().execute('start', 'feature-a', {});
    expect(realFs.readFileSync(nodePath.join(dir, 'agent-plan', `${session}.ndjson`), 'utf8')).toContain('Still working');
    (hasTmuxSession as jest.Mock).mockResolvedValue(false);
  });

  test('forget --all also removes the record of an ended session that saved no conversation', async () => {
    tmuxSessions.mockResolvedValue([session]);
    record(session, [create('1', 'running, kept')]);
    record(`${session}-a-dead`, [create('1', 'ended')]);
    record('kunj-app-other-abcdef', [create('1', 'another branch')]);
    const unlink = jest.requireMock<any>('fs').unlinkSync as jest.Mock;
    unlink.mockClear();
    unlink.mockImplementation((file: string) => { if (!String(file).includes(`${session}-a-dead.ndjson`)) throw new Error('ENOENT'); });
    await new AgentCommand().execute('forget', 'feature-a', { json: true, all: true } as any);
    expect(JSON.parse(stdout.join('')).forgotten).toEqual([`${session}-a-dead`]);
    expect(unlink.mock.calls.map(c => nodePath.basename(c[0]))).toEqual([`${session}-a-dead.json`, `${session}-a-dead.ndjson`]);
    unlink.mockReset();
  });

  test('a start from inside another agent\'s session records that parent and its step', async () => {
    tmuxSessions.mockResolvedValue([]);
    const parent = 'kunj-app-main-123abc';
    record(parent, [create('1', 'a'), { kunj: { t: 11, branch: 'main' }, hook: { hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress' }, tool_response: { success: true } } }]);
    process.env.KUNJ_AGENT_PLAN = nodePath.join(dir, 'agent-plan', `${parent}.ndjson`);
    await new AgentCommand().execute('start', 'feature-a', { detach: true });
    const first = JSON.parse(realFs.readFileSync(nodePath.join(dir, 'agent-plan', `${session}.ndjson`), 'utf8').split('\n')[0]);
    expect(first.kunj.parent).toEqual({ session: parent, step: 0 });
  });

  test('a new conversation empties an old record; agent.plan false records nothing and leaves the task tools alone', async () => {
    tmuxSessions.mockResolvedValue([]);
    record(session, [create('1', 'old')]);
    await new AgentCommand().execute('start', 'feature-a', { detach: true });
    expect(realFs.readFileSync(nodePath.join(dir, 'agent-plan', `${session}.ndjson`), 'utf8')).toBe('');
    (runTmux as jest.Mock).mockClear();
    (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ agent: { command: 'claude', plan: false } });
    await new AgentCommand().execute('start', 'feature-a', { detach: true });
    const argv = (runTmux as jest.Mock).mock.calls[0][0].join(' ');
    expect(argv).not.toContain('KUNJ_AGENT_PLAN');
    expect(argv).not.toContain('CLAUDE_CODE_ENABLE_TODO_TOOLS');
  });
});

test('start loads the packaged plugin into claude when this install has one', async () => {
  const { packagedPluginDir } = jest.requireMock<any>('../../lib/skills');
  const real = require('path').resolve(__dirname, '..', '..', '..', 'claude-plugin');
  packagedPluginDir.mockReturnValue(real);
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('start', 'feature-a', {});
  expect(JSON.stringify((runTmux as jest.Mock).mock.calls[0][0])).toContain(`--plugin-dir '${real}'`);
  packagedPluginDir.mockReturnValue('/no/claude-plugin');
});
