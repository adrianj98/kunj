import { execFile } from 'child_process';
import { AgentError, agentSessionId, agentSessionName, agentSessionsOf, combineAgentStates, killTmuxSessionsWithPrefix, sessionsWithPrefix, agentRunning, agentArgv, checkShellSessionId, hasTmuxSession, killTmuxSessionIfExists, listTmuxSessions, loginShell, readTmuxSessions, shellArgv, shellSessionName, kunjSelf, hostRunArgv } from '../agent-session';
import { kunjEntry } from '../self';

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
    'claude', ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest', ';', 'set-option', '-t', 'kunj-x', 'status', 'off',
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

test('agentArgv shows the tmux status line when asked', () => {
  const argv = agentArgv('kunj-x', '/wt', 'claude', {}, { status: true });
  expect(argv.slice(-6)).toEqual([';', 'set-option', '-t', 'kunj-x', 'status', 'on']);
});

test('hasTmuxSession runs has-session for that name only and is false on any failure', async () => {
  tmuxResult(null);
  expect(await hasTmuxSession('kunj-x')).toBe(true);
  expect(execFileMock.mock.calls[execFileMock.mock.calls.length - 1].slice(0, 2)).toEqual(['tmux', ['has-session', '-t', '=kunj-x']]);
  tmuxResult(failure({ stderr: "can't find session" }));
  expect(await hasTmuxSession('kunj-x')).toBe(false);
});

describe('agent state hooks', () => {
  const { withAgentHooks, claudeHookSettings, readAgentState, agentStateFile, agentStateDir } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const os = jest.requireActual<typeof import('os')>('os');
  const path = jest.requireActual<typeof import('path')>('path');

  test('withAgentHooks appends --settings for claude', () => {
    const cmd = withAgentHooks('claude', '/s', true);
    expect(cmd).toMatch(/^claude --settings '\{"hooks":/);
    expect(withAgentHooks('claude --dangerously-skip-permissions', '/s', true)).toMatch(/^claude --dangerously-skip-permissions --settings '/);
    expect(withAgentHooks('/opt/bin/claude', '/s', true)).toMatch(/^\/opt\/bin\/claude --settings '/);
  });

  test('withAgentHooks leaves other commands and disabled alone', () => {
    expect(withAgentHooks('aider', '/s', true)).toBe('aider');
    expect(withAgentHooks('claude', '/s', false)).toBe('claude');
  });

  test('claudeHookSettings is valid JSON with the five hooks, quotable in single quotes', () => {
    const json = claudeHookSettings();
    expect(json).not.toContain("'");
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.hooks).sort()).toEqual(['Notification', 'PreToolUse', 'SessionEnd', 'Stop', 'UserPromptSubmit']);
    expect(parsed.hooks.Notification[0].matcher).toBe('permission_prompt|idle_prompt|elicitation_dialog');
    expect(parsed.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'printf waiting > "$KUNJ_AGENT_STATE"' });
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('printf running > "$KUNJ_AGENT_STATE"');
    expect(parsed.hooks.SessionEnd[0].hooks[0].command).toBe('rm -f "$KUNJ_AGENT_STATE"');
  });

  test('readAgentState reads running, waiting, else null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-state-'));
    fs.writeFileSync(path.join(dir, 'a'), 'waiting\n');
    fs.writeFileSync(path.join(dir, 'b'), 'bogus');
    expect(readAgentState(path.join(dir, 'a'))).toBe('waiting');
    expect(readAgentState(path.join(dir, 'b'))).toBeNull();
    expect(readAgentState(path.join(dir, 'missing'))).toBeNull();
  });

  test('agentStateFile lives in agent-state under the repo kunj dir', () => {
    expect(agentStateDir('/h/.kunj/app')).toBe('/h/.kunj/app/agent-state');
    expect(agentStateFile('/h/.kunj/app', 'kunj-app-x-1')).toBe('/h/.kunj/app/agent-state/kunj-app-x-1');
  });
});

describe('shell sessions', () => {
  beforeEach(() => execFileMock.mockReset());

  test('shellSessionName is the agent session name with kunjsh- and -sh-<id>, out of reach of kunj- matching', () => {
    const agent = agentSessionName('app', 'github.com/acme/app', 'feature/x');
    const name = shellSessionName('app', 'github.com/acme/app', 'feature/x', 'tab_1');
    expect(name).toBe(agent.replace(/^kunj-/, 'kunjsh-') + '-sh-tab_1');
    expect(name.startsWith('kunj-')).toBe(false);
    expect(shellSessionName('app', 'github.com/acme/app', 'feature-x', 'tab_1')).not.toBe(name);
  });

  test('checkShellSessionId accepts 1-32 of [A-Za-z0-9_-] and rejects the rest', () => {
    for (const id of ['a', 'A-b_9', 'x'.repeat(32)]) expect(checkShellSessionId(id)).toBe(id);
    for (const id of ['', 'x'.repeat(33), 'a b', 'a.b', 'a:b', '=a', 'a/b', 'é']) {
      expect(() => checkShellSessionId(id)).toThrow(AgentError);
    }
    try {
      checkShellSessionId('a b');
    } catch (e) {
      expect((e as AgentError).code).toBe('bad-session-id');
    }
  });

  test('shellArgv runs the login shell in the worktree, no -e variables, status off unless asked', () => {
    expect(shellArgv('kunjsh-x-sh-1', '/wt', '/bin/zsh')).toEqual([
      'tmux', '-u', 'new-session', '-A', '-s', 'kunjsh-x-sh-1', '-c', '/wt', '/bin/zsh', '-l',
      ';', 'set-option', '-t', 'kunjsh-x-sh-1', 'window-size', 'latest', ';', 'set-option', '-t', 'kunjsh-x-sh-1', 'status', 'off',
    ]);
    expect(shellArgv('s', '/wt', 'sh', { status: true }).slice(-2)).toEqual(['status', 'on']);
  });

  test('loginShell is $SHELL, else sh', () => {
    const before = process.env.SHELL;
    try {
      process.env.SHELL = '/bin/fish';
      expect(loginShell()).toBe('/bin/fish');
      delete process.env.SHELL;
      expect(loginShell()).toBe('sh');
    } finally {
      if (before === undefined) delete process.env.SHELL; else process.env.SHELL = before;
    }
  });

  test('killTmuxSessionIfExists kills the exact name and reports whether it did', async () => {
    tmuxResult(null);
    await expect(killTmuxSessionIfExists('kunjsh-x-sh-1')).resolves.toBe(true);
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(['tmux', ['kill-session', '-t', '=kunjsh-x-sh-1']]);
    tmuxResult(failure({ stderr: "can't find session" }));
    await expect(killTmuxSessionIfExists('kunjsh-x-sh-1')).resolves.toBe(false);
    tmuxResult(failure({ code: 'ENOENT' }));
    await expect(killTmuxSessionIfExists('kunjsh-x-sh-1')).resolves.toBe(false);
  });
});

describe('many agent sessions per worktree', () => {
  const base = agentSessionName('app', 'github.com/acme/app', 'feature-a');

  test('agentSessionName with an id appends -a-<id> and keeps the kunj- prefix', () => {
    expect(agentSessionName('app', 'github.com/acme/app', 'feature-a', 'two')).toBe(base + '-a-two');
    expect(agentSessionName('app', 'github.com/acme/app', 'feature-a', null)).toBe(base);
  });

  test('agentSessionsOf finds the default and every -a-<id> session of the branch, nothing else', () => {
    const other = agentSessionName('app', 'github.com/acme/app', 'feature-b');
    expect(agentSessionsOf([other, base + '-a-x', 'zzz', base, base + '-a-bad id', base + '-ax', base + '-a-y'], base)).toEqual([
      { session: base + '-a-x', id: 'x' },
      { session: base, id: null },
      { session: base + '-a-y', id: 'y' },
    ]);
    expect(agentSessionId(base + '-a-x', base)).toBe('x');
    expect(agentSessionId(base, base)).toBeNull();
    expect(agentSessionId(base + '-sh-x', base)).toBeUndefined();
  });

  test('combineAgentStates: waiting if any, else running if any, else null', () => {
    expect(combineAgentStates(['running', 'waiting', null])).toBe('waiting');
    expect(combineAgentStates(['running', null])).toBe('running');
    expect(combineAgentStates([null])).toBeNull();
    expect(combineAgentStates([])).toBeNull();
  });

  test('sessionsWithPrefix keeps names whose rest after the prefix is a valid id', () => {
    expect(sessionsWithPrefix(['p-sh-a', 'p-sh-', 'p-sh-a.b', 'q-sh-a', 'p-sh-b_2'], 'p-sh-')).toEqual(['p-sh-a', 'p-sh-b_2']);
  });

  test('killTmuxSessionsWithPrefix kills each matching session by exact name', async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (args[1][0] === 'list-sessions') return cb(null, { stdout: 'p-sh-a\nother\np-sh-b\n', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });
    await expect(killTmuxSessionsWithPrefix('p-sh-')).resolves.toEqual(['p-sh-a', 'p-sh-b']);
    expect(execFileMock.mock.calls.map(c => c[1])).toEqual([
      ['list-sessions', '-F', '#{session_name}'],
      ['kill-session', '-t', '=p-sh-a'],
      ['kill-session', '-t', '=p-sh-b'],
    ]);
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: any[]) => args[args.length - 1](Object.assign(new Error('x'), { code: 'ENOENT' })));
    await expect(killTmuxSessionsWithPrefix('p-sh-')).resolves.toEqual([]);
  });
});

describe('kunjSelf and hostRunArgv', () => {
  const argv1 = process.argv[1];
  afterEach(() => {
    process.argv[1] = argv1;
  });

  test('kunjSelf is node plus the CLI entry; under ts-node the built dist/index.js', () => {
    process.argv[1] = '/usr/local/lib/node_modules/kunj/dist/index.js';
    expect(kunjSelf()).toEqual([process.execPath, '/usr/local/lib/node_modules/kunj/dist/index.js']);
    process.argv[1] = '/src/kunj/src/index.ts';
    const [node, entry] = kunjSelf();
    expect(node).toBe(process.execPath);
    expect(entry).toMatch(/[\\/]dist[\\/]index\.js$/);
    expect(kunjEntry()).toBe(entry);
  });

  test('hostRunArgv runs the command under kunj run for the branch, with no secret in argv', () => {
    process.argv[1] = '/k/dist/index.js';
    const argv = agentArgv('kunj-x', '/wt', hostRunArgv('feature/x', ['/bin/zsh', '-lc', 'claude']), { KUNJ_BRANCH: 'feature/x' });
    expect(argv).toEqual([
      'tmux', '-u', 'new-session', '-A', '-s', 'kunj-x', '-c', '/wt', '-e', 'KUNJ_BRANCH=feature/x',
      process.execPath, '/k/dist/index.js', 'run', '--branch', 'feature/x', '--', '/bin/zsh', '-lc', 'claude',
      ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest', ';', 'set-option', '-t', 'kunj-x', 'status', 'off',
    ]);
    expect(argv.some((a) => a.includes('FOO='))).toBe(false);
  });

  test('hostRunArgv without a branch lets run use the worktree\'s current branch', () => {
    process.argv[1] = '/k/dist/index.js';
    expect(hostRunArgv(undefined, ['/bin/zsh', '-l'])).toEqual([process.execPath, '/k/dist/index.js', 'run', '--', '/bin/zsh', '-l']);
  });
});
