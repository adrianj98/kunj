import { execFile } from 'child_process';
import { AgentError, readTaggedTmuxSessions, worktreeAgentSessions, worktreeShellSessions, pickSession, agentSessionId, agentSessionName, agentSessionsOf, combineAgentStates, killTmuxSessionsWithPrefix, sessionsWithPrefix, agentRunning, agentArgv, checkShellSessionId, hasTmuxSession, killTmuxSessionIfExists, listTmuxSessions, loginShell, readTmuxSessions, shellArgv, shellSessionName, kunjSelf, hostRunArgv, HOST_RUN_SCRIPT, spawnCwd, inDirectory } from '../agent-session';
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
    "cd '/wt' && claude", ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest', ';', 'set-option', '-t', 'kunj-x', 'status', 'off',
  ]);
});

// A tmux server whose own directory was deleted ignores -c, so the command changes directory itself
test('inDirectory puts an explicit cd before the command, as argv or as a shell line', () => {
  expect(inDirectory('/wt/a b', ['/bin/zsh', '-l'])).toEqual(['sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', '/wt/a b', '/bin/zsh', '-l']);
  expect(inDirectory("/wt/it's", 'claude')).toEqual(["cd '/wt/it'\\''s' && claude"]);
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

test('tmux starts in the home directory, so its server never sits in a worktree that gets removed', () => {
  expect(spawnCwd(agentArgv('s', '/wt/a', 'claude', {}), '/wt/a')).toBe(require('os').homedir());
  expect(spawnCwd(['/bin/zsh', '-l'], '/wt/a')).toBe('/wt/a');
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

  test('claudeHookSettings is valid JSON with the six hooks, quotable in single quotes', () => {
    const json = claudeHookSettings();
    expect(json).not.toContain("'");
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.hooks).sort()).toEqual(['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(parsed.hooks.Notification[0].matcher).toBe('permission_prompt|idle_prompt|elicitation_dialog');
    expect(parsed.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: '(printf waiting > "$KUNJ_AGENT_STATE") 2>/dev/null; true' });
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('(printf running > "$KUNJ_AGENT_STATE") 2>/dev/null; true');
    expect(parsed.hooks.SessionEnd[0].hooks[0].command).toBe('(rm -f "$KUNJ_AGENT_STATE") 2>/dev/null; true');
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
      'tmux', '-u', 'new-session', '-A', '-s', 'kunjsh-x-sh-1', '-c', '/wt', ...inDirectory('/wt', ['/bin/zsh', '-l']),
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
      ...inDirectory('/wt', ['/bin/sh', '-c', HOST_RUN_SCRIPT, 'kunj-run', process.execPath, '/k/dist/index.js', 'feature/x', '/bin/zsh', '-lc', 'claude']),
      ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest', ';', 'set-option', '-t', 'kunj-x', 'status', 'off',
    ]);
    expect(argv.some((a) => a.includes('FOO='))).toBe(false);
  });

  test('hostRunArgv without a branch lets run use the worktree\'s current branch', () => {
    process.argv[1] = '/k/dist/index.js';
    expect(hostRunArgv(undefined, ['/bin/zsh', '-l'])).toEqual(['/bin/sh', '-c', HOST_RUN_SCRIPT, 'kunj-run', process.execPath, '/k/dist/index.js', '', '/bin/zsh', '-l']);
  });
});

describe('agentCommand', () => {
  const { agentCommand, AgentError } = jest.requireActual<typeof import('../agent-session')>('../agent-session');

  test('no name is agent.command, default claude', () => {
    expect(agentCommand(undefined, undefined)).toBe('claude');
    expect(agentCommand(undefined, { command: 'agy' })).toBe('agy');
  });

  test('claude keeps agent.command when it runs claude, else plain claude', () => {
    expect(agentCommand('claude', { command: '/opt/bin/claude --dangerously-skip-permissions' })).toBe('/opt/bin/claude --dangerously-skip-permissions');
    expect(agentCommand('claude', { command: 'aider' })).toBe('claude');
  });

  test('antigravity is agent.antigravityCommand, default agy', () => {
    expect(agentCommand('antigravity', { command: 'claude' })).toBe('agy');
    expect(agentCommand('antigravity', { antigravityCommand: 'agy --dangerously-skip-permissions' })).toBe('agy --dangerously-skip-permissions');
  });

  test('an unknown name is refused', () => {
    expect(() => agentCommand('codex', undefined)).toThrow(AgentError);
  });
});

describe('sessions follow their worktree across a checkout', () => {
  const repo = ['app', 'github.com/acme/app'] as const;
  const a = agentSessionName(...repo, 'feat-a');
  const b = agentSessionName(...repo, 'feat-b');
  const wt = '/r/.git/kunj/worktrees/feat-a';

  test('readTaggedTmuxSessions reads each name with its @kunj_worktree tag', async () => {
    execFileMock.mockReset();
    tmuxResult(null, `${a}\t${wt}\nplain\t\n`);
    await expect(readTaggedTmuxSessions()).resolves.toEqual([{ name: a, worktree: wt, open: '' }, { name: 'plain', worktree: '', open: '' }]);
    expect(execFileMock.mock.calls[0][1]).toEqual(['-u', 'list-sessions', '-F', '#{session_name}\t#{@kunj_worktree}\t#{@kunj_open}']);
    tmuxResult(failure({ code: 'ENOENT' }));
    await expect(readTaggedTmuxSessions()).resolves.toBe('missing');
    tmuxResult(failure({ stderr: 'no server running on /tmp/x\n' }));
    await expect(readTaggedTmuxSessions()).resolves.toEqual([]);
  });

  test('a tagged agent session belongs to its worktree after the worktree moved to another branch', () => {
    const all = [
      { name: a, worktree: wt },
      { name: a + '-a-74e95f0d', worktree: wt },
      { name: b + '-a-abcdef', worktree: wt },
      { name: agentSessionName(...repo, 'other'), worktree: '/r/other' },
      { name: b + '-a-x', worktree: '' },
      { name: 'kunjsh-app-feat-a-123456-sh-1', worktree: wt },
    ];
    expect(worktreeAgentSessions(all, b, wt)).toEqual([
      { session: a, id: null },
      { session: a + '-a-74e95f0d', id: '74e95f0d' },
      { session: b + '-a-abcdef', id: 'abcdef' },
      { session: b + '-a-x', id: 'x' },
    ]);
  });

  test('a session tagged with another worktree is not this one\'s even when its name matches', () => {
    // feat-b was checked out elsewhere first; the worktree now on feat-b must not take its agent
    expect(worktreeAgentSessions([{ name: b, worktree: '/r/elsewhere' }], b, wt)).toEqual([]);
  });

  test('worktreeShellSessions: tagged by tag, untagged by the branch prefix', () => {
    const prefixB = shellSessionName(...repo, 'feat-b', '');
    const oldShell = shellSessionName(...repo, 'feat-a', '1df4eb7a');
    const all = [
      { name: oldShell, worktree: wt },
      { name: prefixB + 'u1', worktree: '' },
      { name: prefixB + 'u2', worktree: '/r/elsewhere' },
      { name: a, worktree: wt },
    ];
    expect(worktreeShellSessions(all, prefixB, wt)).toEqual([
      { session: oldShell, id: '1df4eb7a' },
      { session: prefixB + 'u1', id: 'u1' },
    ]);
  });

  test('pickSession prefers the current name, then any session with the id, else the current name', () => {
    const found = [{ session: a, id: null }, { session: b, id: null }, { session: a + '-a-x', id: 'x' }];
    expect(pickSession(found, null, b)).toBe(b);
    expect(pickSession(found, 'x', b + '-a-x')).toBe(a + '-a-x');
    expect(pickSession([{ session: a, id: null }], null, b)).toBe(a);
    expect(pickSession(found, 'y', b + '-a-y')).toBe(b + '-a-y');
  });
});

describe('resuming a Claude conversation', () => {
  const { agentResumeFile, readAgentResume, withAgentResume, claudeHookSettings, savedAgents, conversationTitle } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const os = jest.requireActual<typeof import('os')>('os');
  const path = jest.requireActual<typeof import('path')>('path');

  test('the SessionStart hook saves its input only when KUNJ_AGENT_RESUME is set', () => {
    expect(JSON.parse(claudeHookSettings()).hooks.SessionStart[0].hooks[0].command)
      .toBe('([ -z "$KUNJ_AGENT_RESUME" ] || cat > "$KUNJ_AGENT_RESUME") 2>/dev/null; true');
  });

  test('reads the saved session id, refusing anything that is not one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-resume-'));
    const file = agentResumeFile(dir, 'kunj-r-main-abc123-a-1');
    expect(file).toBe(path.join(dir, 'agent-resume', 'kunj-r-main-abc123-a-1.json'));
    expect(readAgentResume(file)).toBeNull();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ session_id: '0b5e-41aa', source: 'startup' }));
    expect(readAgentResume(file)).toBe('0b5e-41aa');
    fs.writeFileSync(file, JSON.stringify({ session_id: 'x; rm -rf ~' }));
    expect(readAgentResume(file)).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });

  test('the title is the first real prompt of the transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-title-'));
    const t = path.join(dir, 't.jsonl');
    fs.writeFileSync(t, [
      JSON.stringify({ type: 'summary', summary: 'x' }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'caveat' } }),
      JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
      'not json "user"',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '  fix the\nlogin   bug ' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'later' } }),
    ].join('\n'));
    expect(conversationTitle(t)).toBe('fix the login bug');
    expect(conversationTitle('relative.jsonl')).toBeNull();
    expect(conversationTitle(path.join(dir, 'missing.jsonl'))).toBeNull();
    fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { content: 'y'.repeat(300) } }));
    expect(conversationTitle(t)).toHaveLength(100);
    fs.rmSync(dir, { recursive: true });
  });

  test('savedAgents lists the branch saved conversations that do not run, newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-saved-'));
    const save = (session: string, body: unknown, at: number) => {
      const f = agentResumeFile(dir, session);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(body));
      fs.utimesSync(f, at, at);
    };
    const transcript = path.join(dir, 'a.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hello' } }));
    expect(savedAgents(dir, 'kunj-r-main', [])).toEqual([]);
    save('kunj-r-main', { session_id: 'c0' }, 1000);
    save('kunj-r-main-a-1', { session_id: 'c1', transcript_path: transcript }, 2000);
    save('kunj-r-main-a-2', { session_id: 'c2' }, 3000);
    save('kunj-r-other', { session_id: 'c3' }, 4000);
    save('kunj-r-main-a-3', { session_id: 'bad id' }, 5000);
    const items = savedAgents(dir, 'kunj-r-main', ['kunj-r-main-a-2']);
    expect(items.map(i => [i.session, i.id, i.conversation, i.title])).toEqual([
      ['kunj-r-main-a-1', '1', 'c1', 'hello'],
      ['kunj-r-main', null, 'c0', null],
    ]);
    expect(items[0].savedAt).toBe(new Date(2000_000).toISOString());
    // tmux could not be asked: nothing is left out as running
    expect(savedAgents(dir, 'kunj-r-main', null)).toHaveLength(3);
    fs.rmSync(dir, { recursive: true });
  });

  test('only claude is asked to keep a task list, in one shell word', () => {
    const { withAgentTaskList, TASK_LIST_PROMPT } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
    expect(withAgentTaskList('claude --resume x', true)).toBe(`claude --resume x --append-system-prompt '${TASK_LIST_PROMPT}'`);
    expect(TASK_LIST_PROMPT).not.toContain("'");
    expect(withAgentTaskList('claude', false)).toBe('claude');
    expect(withAgentTaskList('agy', true)).toBe('agy');
  });

  test('only claude gets the kunj plugin, quoted for the shell', () => {
    const { withAgentPlugin } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
    expect(withAgentPlugin('claude --resume x', '/opt/kunj/claude-plugin')).toBe("claude --resume x --plugin-dir '/opt/kunj/claude-plugin'");
    expect(withAgentPlugin('claude', "/it's/claude-plugin")).toBe("claude --plugin-dir '/it'\\''s/claude-plugin'");
    expect(withAgentPlugin('agy', '/p')).toBe('agy');
    expect(withAgentPlugin('claude', null)).toBe('claude');
  });

  test('only claude gets --resume', () => {
    expect(withAgentResume('claude --model opus', 'abc')).toBe('claude --model opus --resume abc');
    expect(withAgentResume('agy', 'abc')).toBe('agy');
    expect(withAgentResume('claude', null)).toBe('claude');
  });

  it('teleports a claude to a web session given by id or URL, and refuses anything else', () => {
    const { withAgentTeleport, checkTeleportId } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
    expect(withAgentTeleport('claude --model opus', 'session_01Gsw')).toBe('claude --model opus --teleport session_01Gsw');
    expect(withAgentTeleport('claude', null)).toBe('claude');
    expect(checkTeleportId('session_01GswEqFVAEhfqNDfU19ZpW8')).toBe('session_01GswEqFVAEhfqNDfU19ZpW8');
    expect(checkTeleportId('https://claude.ai/code/session_01Gsw?x=1')).toBe('session_01Gsw');
    for (const bad of ['', 'a b', 'x;rm -rf /', '$(id)', '-p']) {
      expect(() => checkTeleportId(bad)).toThrow(/Not a Claude Code session id/);
    }
  });
});

describe('planNudgeHookCommand', () => {
  const { planNudgeHookCommand, claudeHookSettings } = jest.requireActual<typeof import('../agent-session')>('../agent-session');

  test('runs this kunj with agent nudge only when the agent has a plan record', () => {
    const cmd = planNudgeHookCommand(['/usr/bin/node', '/opt/kunj/dist/index.js'])!;
    expect(cmd).toContain('[ -z "$KUNJ_AGENT_PLAN" ] || "/usr/bin/node" "/opt/kunj/dist/index.js" agent nudge');
    expect(cmd).toMatch(/; true$/);
  });

  test('a path with a quote gets no nudge (the settings are single-quoted)', () => {
    expect(planNudgeHookCommand(['/usr/bin/node', "/opt/it's/index.js"])).toBeUndefined();
    expect(planNudgeHookCommand(['/usr/bin/node', '/opt/"x"/index.js'])).toBeUndefined();
  });

  test('claudeHookSettings adds it to UserPromptSubmit after the state write, and only when given', () => {
    expect(JSON.parse(claudeHookSettings(true)).hooks.UserPromptSubmit).toHaveLength(1);
    const hooks = JSON.parse(claudeHookSettings(true, 'NUDGE')).hooks.UserPromptSubmit;
    expect(hooks).toHaveLength(2);
    expect(hooks[1].hooks[0].command).toBe('NUDGE');
  });
});

describe('execScript (--exec-script)', () => {
  const { execScript, EXEC_SCRIPT_RUNNER } = jest.requireActual<typeof import('../agent-session')>('../agent-session');
  const { execFileSync } = jest.requireActual<typeof import('child_process')>('child_process');
  const fs = jest.requireActual<typeof import('fs')>('fs');
  const os = jest.requireActual<typeof import('os')>('os');
  const path = jest.requireActual<typeof import('path')>('path');

  test('the runner execs the exact argv with only the env differences, in the directory', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kunj exec '")));
    const base = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMUX: '/tmp/x', KEEP: 'k' };
    const env = { PATH: base.PATH, HOME: base.HOME, KEEP: 'k', KUNJ_BRANCH: "it's $x" };
    const argv = ['/bin/sh', '-c', 'printf "%s|%s|%s|%s|%s" "$PWD" "${TMUX-unset}" "$KEEP" "$KUNJ_BRANCH" "$1"', 'sh', 'a "b" `c`'];
    // a non-tmux argv: the directory given is used as it is
    const line = execScript(argv, dir, env, base);
    expect(line).not.toContain('KEEP=');
    const printer = path.join(dir, 'print.js');
    fs.writeFileSync(printer, `process.stdout.write(${JSON.stringify(line)})`);
    const out = execFileSync('/bin/sh', ['-c', EXEC_SCRIPT_RUNNER, 'kunj-attach', process.execPath, printer], { env: base, encoding: 'utf8' });
    expect(out).toBe(`${dir}|unset|k|it's $x|a "b" \`c\``);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a failing kunj ends the runner with its exit code and runs nothing', () => {
    let code = 0;
    try { execFileSync('/bin/sh', ['-c', EXEC_SCRIPT_RUNNER, 'kunj-attach', '/bin/sh', '-c', 'exit 3'], { stdio: 'ignore' }); } catch (e: any) { code = e.status; }
    expect(code).toBe(3);
  });
});
