import { execFile } from 'child_process';
import { agentSessionName, agentRunning, agentArgv, listTmuxSessions, readTmuxSessions } from '../agent-session';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;

// promisify(execFile) on a plain mock: the callback is the last argument
function tmuxResult(error: (Error & { code?: string; stderr?: string }) | null, stdout = ''): void {
  execFileMock.mockImplementation((...args: any[]) => args[args.length - 1](error, { stdout, stderr: '' }));
}

function failure(props: { code?: string; stderr?: string }): Error {
  return Object.assign(new Error('Command failed: tmux list-sessions'), props);
}

test('session names are tmux-safe and distinguish feature/x from feature-x', () => {
  const a = agentSessionName('app', 'github.com/acme/app', 'feature/v1.2:hotfix');
  const b = agentSessionName('app', 'github.com/acme/app', 'feature-v1-2-hotfix');
  expect(a).toMatch(/^kunj-[A-Za-z0-9_-]+$/);
  expect(a).not.toContain('.');
  expect(a).not.toContain(':');
  expect(a).not.toEqual(b);
});

test('agentRunning is null without tmux', () => {
  expect(agentRunning(null, 'kunj-x')).toBeNull();
  expect(agentRunning(['kunj-x'], 'kunj-x')).toBe(true);
  expect(agentRunning([], 'kunj-x')).toBe(false);
});

test('agentArgv attaches or creates, passes the env with -e and sets window-size latest', () => {
  expect(agentArgv('kunj-x', '/wt', 'claude', { KUNJ_BRANCH: 'a b', KUNJ_REPO: 'app' })).toEqual([
    'tmux', '-u', 'new-session', '-A', '-s', 'kunj-x', '-c', '/wt',
    '-e', 'KUNJ_BRANCH=a b', '-e', 'KUNJ_REPO=app',
    'claude', ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest',
  ]);
});

describe('listTmuxSessions', () => {
  beforeEach(() => execFileMock.mockReset());

  test('lists the session names', async () => {
    tmuxResult(null, 'a\nkunj-x\n');
    await expect(listTmuxSessions()).resolves.toEqual(['a', 'kunj-x']);
  });

  test('null when tmux is not installed', async () => {
    tmuxResult(failure({ code: 'ENOENT' }));
    await expect(listTmuxSessions()).resolves.toBeNull();
  });

  test('[] when no server is running', async () => {
    tmuxResult(failure({ stderr: 'no server running on /private/tmp/tmux-501/default\n' }));
    await expect(listTmuxSessions()).resolves.toEqual([]);
  });

  test('[] when the socket cannot be connected to', async () => {
    tmuxResult(failure({ stderr: 'error connecting to /private/tmp/tmux-501/default (No such file or directory)\n' }));
    await expect(listTmuxSessions()).resolves.toEqual([]);
  });

  test('null on any other failure, so a transient error is not read as "no agents"', async () => {
    tmuxResult(failure({ stderr: 'server exited unexpectedly\n' }));
    await expect(listTmuxSessions()).resolves.toBeNull();
  });

  test('readTmuxSessions tells a missing tmux from a failing one', async () => {
    tmuxResult(failure({ code: 'ENOENT' }));
    await expect(readTmuxSessions()).resolves.toBe('missing');
    tmuxResult(failure({ stderr: 'server exited unexpectedly\n' }));
    await expect(readTmuxSessions()).resolves.toBe('failed');
    tmuxResult(failure({ stderr: 'no server running on /tmp/tmux-501/default\n' }));
    await expect(readTmuxSessions()).resolves.toEqual([]);
  });
});
