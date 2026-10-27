// kunj worktree shell [branch] [--session <id>] [--kill]: a login shell in a worktree, kept in a host
// tmux session (kunjsh-…) when --session is given so it survives the app that opened it.
import { WorktreeCommand } from '../worktree';
import { AgentError, hostRunArgv, killTmuxSessionIfExists, killTmuxSessionsWithPrefix, readTmuxSessions, runTmux, shellSessionName } from '../../lib/agent-session';
import { loadResolvedConfig } from '../../lib/config';
import { hostSecrets } from '../../lib/secrets/host';

// The host secrets a direct shell gets in its environment; a tmux shell gets them from kunj run inside
jest.mock('../../lib/secrets/host', () => ({
  hostSecrets: jest.fn(async () => ({ env: { FOO: 's3cret-value' }, files: [] })),
}));

jest.mock('../../lib/worktree', () => ({
  ...jest.requireActual('../../lib/worktree'),
  listWorktreesDetailed: jest.fn(async () => ({
    repoRoot: '/wt',
    gitCommonDir: '/wt/.git',
    currentPath: '/wt/feature-a',
    pullRequestLookup: 'skipped',
    pullRequestsFromCache: false,
    worktrees: [
      { branch: 'main', name: 'main', path: '/wt', exists: true, bare: false, sessions: [], isCurrent: false },
      { branch: 'feature-a', name: 'feature-a', path: '/wt/feature-a', exists: true, bare: false, sessions: [], isCurrent: true },
      { branch: 'gone', name: 'gone', path: '/wt/gone', exists: false, bare: false, sessions: [], isCurrent: false },
    ],
  })),
}));

jest.mock('../../lib/repo-identity', () => ({
  repoIdentity: jest.fn(() => ({ root: '/wt', name: 'app', id: 'github.com/acme/app', originUrl: '' })),
}));

jest.mock('../../lib/agent-session', () => ({
  ...jest.requireActual('../../lib/agent-session'),
  readTmuxSessions: jest.fn(async () => []),
  runTmux: jest.fn(async () => 0),
  killTmuxSessionIfExists: jest.fn(async () => true),
  killTmuxSessionsWithPrefix: jest.fn(async () => ['x']),
}));

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

const run = runTmux as jest.Mock;
const tmux = readTmuxSessions as jest.Mock;
const kill = killTmuxSessionIfExists as jest.Mock;
const config = loadResolvedConfig as jest.Mock;
const session = shellSessionName('app', 'github.com/acme/app', 'feature-a', 'tab1');
let stdout: string[];
let shellBefore: string | undefined;

beforeEach(() => {
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  run.mockClear();
  run.mockResolvedValue(0);
  (hostSecrets as jest.Mock).mockClear();
  tmux.mockReset();
  tmux.mockResolvedValue([]);
  kill.mockClear();
  config.mockReset();
  config.mockResolvedValue({});
  shellBefore = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  process.env.TMUX = '/tmp/tmux-501/default,1,0';
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  if (shellBefore === undefined) delete process.env.SHELL; else process.env.SHELL = shellBefore;
  delete process.env.TMUX;
  process.exitCode = undefined;
});

test('without --session: a plain login shell in the worktree, exit code passed through', async () => {
  run.mockResolvedValue(3);
  await new WorktreeCommand().execute('shell', 'feature-a', { } as any);
  expect(run).toHaveBeenCalledTimes(1);
  const [argv, cwd, env] = run.mock.calls[0];
  expect(argv).toEqual(['/bin/zsh', '-l']);
  expect(cwd).toBe('/wt/feature-a');
  expect(tmux).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(3);
  // The branch's host secrets, in the environment only
  expect(hostSecrets).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature-a', root: '/wt/feature-a' }));
  expect(env.FOO).toBe('s3cret-value');
});

test('no branch: the current worktree; $SHELL unset falls back to sh', async () => {
  delete process.env.SHELL;
  await new WorktreeCommand().execute('shell', {} as any);
  expect(run.mock.calls[0][0]).toEqual(['sh', '-l']);
  expect(run.mock.calls[0][1]).toBe('/wt/feature-a');
});

test('--session: new-session -A in the worktree, no KUNJ_ agent variables, TMUX dropped', async () => {
  await new WorktreeCommand().execute('shell', 'feature-a', { session: 'tab1' } as any);
  const [argv, cwd, env] = run.mock.calls[0];
  expect(argv).toEqual([
    'tmux', '-u', 'new-session', '-A', '-s', session, '-c', '/wt/feature-a', ...hostRunArgv('feature-a', ['/bin/zsh', '-l']),
    ';', 'set-option', '-t', session, 'window-size', 'latest', ';', 'set-option', '-t', session, 'status', 'off',
    ';', 'set-option', '-t', session, '@kunj_worktree', '/wt/feature-a',
  ]);
  expect(session).toMatch(/^kunjsh-.*-sh-tab1$/);
  expect(cwd).toBe('/wt/feature-a');
  expect(env.TMUX).toBeUndefined();
  expect(Object.keys(env).filter(k => k.startsWith('KUNJ_AGENT') || k === 'KUNJ_BRANCH')).toEqual([]);
  // The vault is opened by kunj run inside the session: no value here or in argv
  expect(hostSecrets).not.toHaveBeenCalled();
  expect(env.FOO).toBeUndefined();
  expect(argv.join(' ')).not.toContain('s3cret-value');
});

test('--session with agent.tmuxStatus keeps the status line', async () => {
  config.mockResolvedValue({ agent: { tmuxStatus: true } });
  await new WorktreeCommand().execute('shell', 'feature-a', { session: 'tab1' } as any);
  expect(run.mock.calls[0][0].slice(-8, -6)).toEqual(['status', 'on']);
});

test('--session without tmux runs the login shell directly, without a hint', async () => {
  tmux.mockResolvedValue('missing');
  const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  run.mockResolvedValue(5);
  await new WorktreeCommand().execute('shell', 'feature-a', { session: 'tab1' } as any);
  expect(run.mock.calls[0][0]).toEqual(['/bin/zsh', '-l']);
  expect(run.mock.calls[0][2].FOO).toBe('s3cret-value');
  expect(err).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(5);
});

test('--session with agent.tmux false runs the login shell directly', async () => {
  config.mockResolvedValue({ agent: { tmux: false } });
  await new WorktreeCommand().execute('shell', 'feature-a', { session: 'tab1' } as any);
  expect(run.mock.calls[0][0]).toEqual(['/bin/zsh', '-l']);
});

test('an invalid session id is refused before anything runs', async () => {
  await expect(new WorktreeCommand().execute('shell', 'feature-a', { session: 'a b' } as any)).rejects.toMatchObject({ name: 'AgentError', code: 'bad-session-id' });
  await expect(new WorktreeCommand().execute('shell', 'feature-a', { session: 'x'.repeat(33) } as any)).rejects.toBeInstanceOf(AgentError);
  expect(run).not.toHaveBeenCalled();
});

test('a branch without a worktree, or with its directory missing, is an AgentError', async () => {
  await expect(new WorktreeCommand().execute('shell', 'nope', {} as any)).rejects.toMatchObject({ name: 'AgentError', code: 'no-worktree' });
  await expect(new WorktreeCommand().execute('shell', 'gone', {} as any)).rejects.toMatchObject({ name: 'AgentError', code: 'no-worktree', message: expect.stringMatching(/missing/) });
  expect(run).not.toHaveBeenCalled();
});

test('--kill kills the session quietly and reports it with --json', async () => {
  await new WorktreeCommand().execute('shell', 'feature-a', { session: 'tab1', kill: true } as any);
  expect(kill).toHaveBeenCalledWith(session);
  expect(stdout.join('')).toBe('');
  expect(run).not.toHaveBeenCalled();

  kill.mockResolvedValueOnce(false);
  const cmd = new WorktreeCommand();
  (cmd as any).jsonMode = true;
  await cmd.execute('shell', 'feature-a', { session: 'tab1', kill: true, json: true } as any);
  expect(JSON.parse(stdout.join(''))).toEqual({ killed: false });
  expect(process.exitCode).toBeUndefined();
});

test('--kill ends the session of a branch whose worktree is gone', async () => {
  await new WorktreeCommand().execute('shell', 'removed-branch', { session: 'tab1', kill: true } as any);
  expect(kill).toHaveBeenCalledWith(shellSessionName('app', 'github.com/acme/app', 'removed-branch', 'tab1'));
});

test('--kill without --session kills every shell session of the branch', async () => {
  const killAll = killTmuxSessionsWithPrefix as jest.Mock;
  killAll.mockClear();
  killAll.mockResolvedValueOnce([]);
  const cmd = new WorktreeCommand();
  (cmd as any).jsonMode = true;
  await cmd.execute('shell', 'feature-a', { kill: true, json: true } as any);
  expect(killAll).toHaveBeenCalledWith(shellSessionName('app', 'github.com/acme/app', 'feature-a', ''));
  expect(shellSessionName('app', 'github.com/acme/app', 'feature-a', '')).toMatch(/^kunjsh-.*-sh-$/);
  expect(JSON.parse(stdout.join(''))).toEqual({ killed: false });
  expect(kill).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});
