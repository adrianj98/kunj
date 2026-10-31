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
}));

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ agent: { command: 'claude' } })),
  getKunjDir: jest.fn(() => '/h/.kunj/app'),
}));

// The state directory under the mocked kunj dir is never created on disk
jest.mock('fs', () => ({ ...jest.requireActual<object>('fs'), mkdirSync: jest.fn() }));

// The secrets a direct start puts in the agent's environment; the tmux path never opens the vault
jest.mock('../../lib/secrets/host', () => ({
  hostSecrets: jest.fn(async () => ({ env: { FOO: 's3cret-value' }, files: [] })),
}));

jest.mock('../../lib/git', () => ({
  getCurrentBranch: jest.fn(async () => 'feature-a'),
}));

const session = agentSessionName('app', 'github.com/acme/app', 'feature-a');
const stateFile = agentStateFile('/h/.kunj/app', session);
const claudeWithHooks = withAgentHooks('claude', stateFile, true);
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
  const vars = { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: stateFile, KUNJ_AGENT_RESUME: `/h/.kunj/app/agent-resume/${session}.json` };
  expect(runTmux).toHaveBeenCalledWith(agentArgv(session, '/wt/feature-a', underRun('feature-a', claudeWithHooks), vars, { worktree: '/wt/feature-a' }), '/wt/feature-a', expect.objectContaining(vars));
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
    const vars = { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: file, KUNJ_AGENT_RESUME: `/h/.kunj/app/agent-resume/${two}.json` };
    expect(runTmux).toHaveBeenCalledWith(agentArgv(two, '/wt/feature-a', underRun('feature-a', withAgentHooks('claude', file, true)), vars, { worktree: '/wt/feature-a' }), '/wt/feature-a', expect.objectContaining(vars));
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
