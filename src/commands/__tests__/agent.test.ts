import { Command } from 'commander';
import { AgentCommand } from '../agent';
import { AgentError, agentArgv, agentSessionName, agentStateFile, hasTmuxSession, readTmuxSessions, runTmux, killTmuxSession, withAgentHooks } from '../../lib/agent-session';
import { loadResolvedConfig } from '../../lib/config';

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
  runTmux: jest.fn(async () => 0),
  killTmuxSession: jest.fn(async () => undefined),
  hasTmuxSession: jest.fn(async () => false),
}));

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ agent: { command: 'claude' } })),
  getKunjDir: jest.fn(() => '/h/.kunj/app'),
}));

// The state directory under the mocked kunj dir is never created on disk
jest.mock('fs', () => ({ ...jest.requireActual<object>('fs'), mkdirSync: jest.fn() }));

jest.mock('../../lib/git', () => ({
  getCurrentBranch: jest.fn(async () => 'feature-a'),
}));

const session = agentSessionName('app', 'github.com/acme/app', 'feature-a');
const stateFile = agentStateFile('/h/.kunj/app', session);
const claudeWithHooks = withAgentHooks('claude', stateFile, true);
const tmuxSessions = readTmuxSessions as jest.Mock;
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
  expect(JSON.parse(stdout.join(''))).toEqual({ branch: 'feature-a', worktree: '/wt/feature-a', session: expect.stringMatching(/^kunj-/), running: true });
});

test('status without a branch uses the current branch and reports null without tmux', async () => {
  tmuxSessions.mockResolvedValue('missing');
  await new AgentCommand().execute('status', { json: true });
  expect(JSON.parse(stdout.join('')).running).toBeNull();
});

test('start runs tmux in the worktree with agent.command', async () => {
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('start', 'feature-a', {});
  const vars = { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: stateFile };
  expect(runTmux).toHaveBeenCalledWith(agentArgv(session, '/wt/feature-a', claudeWithHooks, vars), '/wt/feature-a', expect.objectContaining(vars));
  // tmux takes a new session's environment from its server, not this client: the values go in argv
  expect((runTmux as jest.Mock).mock.calls[0][0]).toEqual(expect.arrayContaining(['-e', 'KUNJ_BRANCH=feature-a', '-e', 'KUNJ_WORKTREE=/wt/feature-a']));
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
    agentArgv(session, '/wt/feature-a', 'aider', { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a', KUNJ_AGENT_STATE: stateFile }),
  );
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
  expect((runTmux as jest.Mock).mock.calls[0][0].slice(-2)).toEqual(['status', 'on']);
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
