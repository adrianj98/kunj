import { Command } from 'commander';
import { AgentCommand } from '../agent';
import { AgentError, agentArgv, agentSessionName, listTmuxSessions, runTmux, killTmuxSession } from '../../lib/agent-session';

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
  listTmuxSessions: jest.fn(),
  runTmux: jest.fn(async () => 0),
  killTmuxSession: jest.fn(async () => undefined),
}));

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ agent: { command: 'claude' } })),
}));

jest.mock('../../lib/git', () => ({
  getCurrentBranch: jest.fn(async () => 'feature-a'),
}));

const session = agentSessionName('app', 'github.com/acme/app', 'feature-a');
const tmuxSessions = listTmuxSessions as jest.Mock;
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
  tmuxSessions.mockResolvedValue(null);
  await new AgentCommand().execute('status', { json: true });
  expect(JSON.parse(stdout.join('')).running).toBeNull();
});

test('start runs tmux in the worktree with agent.command', async () => {
  tmuxSessions.mockResolvedValue([]);
  await new AgentCommand().execute('start', 'feature-a', {});
  const vars = { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a' };
  expect(runTmux).toHaveBeenCalledWith(agentArgv(session, '/wt/feature-a', 'claude', vars), '/wt/feature-a', expect.objectContaining(vars));
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
    agentArgv(session, '/wt/feature-a', 'aider', { KUNJ_BRANCH: 'feature-a', KUNJ_REPO: 'app', KUNJ_WORKTREE: '/wt/feature-a' }),
  );
});

test('start without tmux fails with tmux-missing', async () => {
  tmuxSessions.mockResolvedValue(null);
  await expect(new AgentCommand().execute('start', 'feature-a', {})).rejects.toMatchObject({ name: 'AgentError', code: 'tmux-missing' });
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
