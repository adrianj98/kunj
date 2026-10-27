import {
  CONTAINER_SESSION,
  SESSIONS_SCRIPT,
  classifyHostSession,
  clientVia,
  containerSessions,
  isKunjHostSession,
  parseSessionsOutput,
  sessionJson,
  treeUsage,
  ExpectedOwner,
  Proc,
} from '../sessions';
import { agentSessionName, shellSessionName } from '../agent-session';

const T = '\t';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const secs = (iso: string) => String(Date.parse(iso) / 1000);

const output = [
  'tmux=ok',
  '#sessions',
  `kunj-app-main-abc123${T}${secs('2026-10-27T10:00:00Z')}${T}${secs('2026-10-27T11:59:00Z')}${T}/r/app`,
  `kunjsh-app-main-abc123-sh-t1${T}${secs('2026-10-20T10:00:00Z')}${T}${secs('2026-10-20T10:05:00Z')}${T}`,
  `mine${T}1${T}1${T}`,
  '#panes',
  `kunj-app-main-abc123${T}100${T}node${T}/r/app`,
  `kunjsh-app-main-abc123-sh-t1${T}200${T}zsh${T}/r/app/src`,
  '#clients',
  `kunj-app-main-abc123${T}/dev/ttys001${T}900`,
  '#ps',
  '    1     0   0.0   100 /sbin/launchd',
  '  100    50   1.5  2048 /usr/local/bin/node',
  '  101   100  50.0  4096 claude',
  '  102   101  10.0  1024 yarn test',
  '  200    50   0.0   512 -zsh',
  '  800     1   2.0  9000 /Applications/Kunj Workspace.app/Contents/MacOS/KunjWorkspace',
  '  850   800   0.0   100 /usr/bin/env',
  '  900   850   0.0   100 tmux',
].join('\n');

describe('parseSessionsOutput', () => {
  it('reads sessions, panes, clients, the worktree tag and ps (comm with spaces)', () => {
    const snap = parseSessionsOutput(output);
    expect(snap.tmux).toBe('ok');
    expect(snap.sessions.map(s => s.name)).toEqual(['kunj-app-main-abc123', 'kunjsh-app-main-abc123-sh-t1', 'mine']);
    const [agent, shell] = snap.sessions;
    expect(agent).toMatchObject({
      createdAt: '2026-10-27T10:00:00.000Z',
      lastActivityAt: '2026-10-27T11:59:00.000Z',
      worktreeTag: '/r/app',
      panes: [{ pid: 100, command: 'node', cwd: '/r/app' }],
      clients: [{ tty: '/dev/ttys001', pid: 900 }],
    });
    expect(shell.worktreeTag).toBeNull();
    expect(snap.procs?.get(800)?.comm).toBe('/Applications/Kunj Workspace.app/Contents/MacOS/KunjWorkspace');
    expect(snap.procs?.get(102)).toEqual({ ppid: 101, cpu: 10, rssKb: 1024, comm: 'yarn test' });
  });

  it('tmux=missing, an empty server, and no ps', () => {
    expect(parseSessionsOutput('tmux=missing\n')).toEqual({ tmux: 'missing', sessions: [], procs: null });
    expect(parseSessionsOutput('tmux=ok\n#sessions\n#panes\n#clients\n#ps\n')).toEqual({ tmux: 'ok', sessions: [], procs: null });
  });

  it('the script separates fields with a real tab (tmux formats do not expand \\t)', () => {
    expect(SESSIONS_SCRIPT).toContain('#{session_name}\t#{session_created}');
    expect(SESSIONS_SCRIPT).not.toContain('\\t');
    expect(SESSIONS_SCRIPT).toContain('#{@kunj_worktree}');
  });
});

describe('treeUsage and clientVia', () => {
  const procs = parseSessionsOutput(output).procs as Map<number, Proc>;

  it('adds up the whole process tree under the pane, each process once', () => {
    expect(treeUsage([100], procs)).toEqual({ cpu: 61.5, memoryBytes: (2048 + 4096 + 1024) * 1024 });
    expect(treeUsage([100, 101], procs)).toEqual({ cpu: 61.5, memoryBytes: (2048 + 4096 + 1024) * 1024 });
    expect(treeUsage([999], procs)).toBeNull();
  });

  it('names the app a client runs in, skipping tmux, env and shells', () => {
    expect(clientVia(900, procs)).toBe('Kunj Workspace');
    expect(clientVia(900, null)).toBeNull();
    const terminal = new Map<number, Proc>([
      [5, { ppid: 1, cpu: 0, rssKb: 0, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }],
      [6, { ppid: 5, cpu: 0, rssKb: 0, comm: 'login' }],
      [7, { ppid: 6, cpu: 0, rssKb: 0, comm: '-zsh' }],
      [8, { ppid: 7, cpu: 0, rssKb: 0, comm: 'tmux' }],
    ]);
    expect(clientVia(8, terminal)).toBe('Terminal');
  });
});

describe('classifyHostSession', () => {
  const repo = { name: 'app', root: '/r/app' };
  const owner = (branch: string, wtPath: string): ExpectedOwner => ({
    repo,
    worktree: { path: wtPath, branch },
    agentBase: agentSessionName('app', 'id1', branch),
    shellPrefix: shellSessionName('app', 'id1', branch, ''),
  });
  const owners = [owner('main', '/r/app'), owner('feature-a', '/r/app/.git/kunj/worktrees/feature-a')];
  const repos = [{ ...repo, prefix: 'kunj-app-' }];
  const O = (extra: Partial<{ repos: typeof repos; unlisted: Set<string> }> = {}) => ({ owners, repos, unlisted: new Set<string>(), ...extra });

  it('matches untagged sessions by the names of each worktree branch', () => {
    const base = agentSessionName('app', 'id1', 'feature-a');
    expect(classifyHostSession(base, null, O())).toEqual({ kind: 'agent', id: null, repo, worktree: owners[1].worktree, gone: false });
    expect(classifyHostSession(`${base}-a-x1`, null, O())).toMatchObject({ kind: 'agent', id: 'x1', worktree: owners[1].worktree });
    expect(classifyHostSession(shellSessionName('app', 'id1', 'main', 't9'), null, O())).toMatchObject({ kind: 'shell', id: 't9', worktree: owners[0].worktree });
  });

  it('a branch ending in -a is not read as an -a-<id> session', () => {
    expect(classifyHostSession(agentSessionName('app', 'id1', 'feature-a'), null, O()).id).toBeNull();
  });

  it('the worktree tag wins: the session follows its worktree to another branch', () => {
    const old = agentSessionName('app', 'id1', 'gone-branch');
    expect(classifyHostSession(old, '/r/app/.git/kunj/worktrees/feature-a', O())).toMatchObject({ worktree: owners[1].worktree });
    expect(classifyHostSession(agentSessionName('app', 'id1', 'main'), '/removed/wt', O())).toMatchObject({ worktree: null, repo, gone: true });
  });

  it('a tagged directory that exists is never gone, however git spells it', () => {
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'kunj-sess-'));
    expect(classifyHostSession(agentSessionName('app', 'id1', 'x'), dir, O())).toMatchObject({ worktree: { path: dir, branch: null }, gone: false });
    const viaSymlink = require('fs').realpathSync(dir);
    const own: ExpectedOwner = { ...owners[0], worktree: { path: viaSymlink, branch: 'main' } };
    expect(classifyHostSession('kunj-app-x-123456', dir, { owners: [own], repos, unlisted: new Set() })).toMatchObject({ worktree: own.worktree, gone: false });
  });

  it('a repository whose worktrees could not be listed never has gone sessions', () => {
    expect(classifyHostSession('kunj-app-old-123456', null, O({ unlisted: new Set(['/r/app']) }))).toMatchObject({ worktree: null, gone: false });
    expect(classifyHostSession('kunj-app-old-123456', null, O())).toMatchObject({ worktree: null, gone: true });
  });

  it('a session of a removed worktree keeps its repository by prefix (longest wins)', () => {
    const r = classifyHostSession('kunj-app-web-old-123456', null, O({ repos: [...repos, { name: 'app-web', root: '/r/web', prefix: 'kunj-app-web-' }] }));
    expect(r).toEqual({ kind: 'agent', id: null, repo: { name: 'app-web', root: '/r/web' }, worktree: null, gone: true });
    expect(classifyHostSession('kunjsh-zzz-x-123456-sh-t1', null, O())).toEqual({ kind: 'shell', id: 't1', repo: null, worktree: null, gone: true });
  });
});

describe('sessionJson orphans', () => {
  const snap = parseSessionsOutput(output);
  const [agent, shell] = snap.sessions;
  const base = { kind: 'agent' as const, id: null, repo: null, branch: 'main', container: null };

  it('worktree-gone when known gone; idle when detached and quiet for idleHours; never while attached', () => {
    expect(sessionJson(shell, snap.procs, { ...base, worktree: null, gone: true }, 24 * 30, NOW).orphan).toBe('worktree-gone');
    expect(sessionJson(shell, snap.procs, { ...base, worktree: null, gone: false }, 24 * 30, NOW).orphan).toBeNull();
    expect(sessionJson(agent, snap.procs, { ...base, worktree: null, gone: true }, 24, NOW).orphan).toBeNull();
    expect('gone' in sessionJson(agent, snap.procs, { ...base, worktree: null, gone: true }, 24, NOW)).toBe(false);
    expect(sessionJson(shell, snap.procs, { ...base, worktree: { path: '/r/app', branch: 'main' } }, 24, NOW).orphan).toBe('idle');
    expect(sessionJson(shell, snap.procs, { ...base, worktree: { path: '/r/app', branch: 'main' } }, 24 * 30, NOW).orphan).toBeNull();
    const a = sessionJson(agent, snap.procs, { ...base, worktree: { path: '/r/app', branch: 'main' } }, 0.001, NOW);
    expect(a.orphan).toBeNull();
    expect(a.attached).toEqual([{ tty: '/dev/ttys001', pid: 900, via: 'Kunj Workspace' }]);
    expect(a).toMatchObject({ command: 'node', cwd: '/r/app', usage: { cpu: 61.5 } });
  });
});

describe('container sessions', () => {
  it('keeps only kunj names, with kind, id and the container; never worktree-gone', () => {
    const out = [
      'tmux=ok', '#sessions',
      `agent${T}1${T}${secs('2026-10-27T11:00:00Z')}${T}`,
      `agent-two${T}1${T}${secs('2026-10-27T11:00:00Z')}${T}`,
      `sh-t1${T}1${T}${secs('2026-10-27T11:00:00Z')}${T}`,
      `made-up${T}1${T}1${T}`,
      '#panes', '#clients', '#ps',
    ].join('\n');
    const r = containerSessions(out, { name: 'kunj-app-x-1', repo: { name: 'app', root: '/r/app' }, branch: 'x' }, 24, NOW);
    expect(r.sessions.map(s => [s.name, s.kind, s.id, s.container, s.branch, s.orphan])).toEqual([
      ['agent', 'agent', null, 'kunj-app-x-1', 'x', null],
      ['agent-two', 'agent', 'two', 'kunj-app-x-1', 'x', null],
      ['sh-t1', 'shell', 't1', 'kunj-app-x-1', 'x', null],
    ]);
    expect(r.sessions[0].usage).toBeNull();
  });

  it('names kunj may end', () => {
    expect(['agent', 'agent-a1', 'sh-t_1'].every(n => CONTAINER_SESSION.test(n))).toBe(true);
    expect(['bash', 'agent-', 'sh-', 'sh-a b', 'agent;x'].some(n => CONTAINER_SESSION.test(n))).toBe(false);
    expect(isKunjHostSession('kunj-app')).toBe(true);
    expect(isKunjHostSession('kunjsh-app')).toBe(true);
    expect(isKunjHostSession('work')).toBe(false);
  });
});
