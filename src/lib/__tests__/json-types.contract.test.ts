import type { ContainerJson, EventJson, SearchJson, SessionsJson, SessionsKillJson } from '../json-types';

// Type-level checks: this file fails to compile when the published types lose these fields
test('ContainerJson.agent declares the hook state', () => {
  const agent: ContainerJson['agent'] = { running: true, state: 'waiting' };
  expect(agent.state).toBe('waiting');
});

test('the agent event may carry the repo', () => {
  const e: EventJson = { type: 'agent', session: 's', running: true, state: null, repo: { name: 'app', root: '/r' }, at: '' };
  expect(e.type).toBe('agent');
});

test('SearchJson carries the query, the sources and the opt-in scopes', () => {
  const r: SearchJson = {
    query: { pattern: 'x', ignoreCase: false, fixed: false, word: false, paths: [], maxCount: 200, scopes: ['worktrees', 'containers'], branches: [] },
    repoRoot: '/r',
    searched: { worktrees: 1, branches: 0, containers: 1 },
    sources: [
      { kind: 'worktree', branch: 'main', path: '/r', isCurrent: true, matches: [{ path: 'a', line: 1, column: 1, length: 1, text: 'x' }], truncated: false },
      { kind: 'container', branch: 'feat', container: 'kunj-r-feat-1', matches: [], truncated: false, error: 'boom' },
    ],
    containers: { available: true, stopped: [] },
  };
  expect(r.sources[0].matches[0].column).toBe(1);
});

test('SessionsJson carries each session with its owner, terminals, usage and orphan state', () => {
  const r: SessionsJson = {
    tmux: 'ok',
    idleHours: 24,
    sessions: [{
      name: 'kunj-app-main-abc123', kind: 'agent', id: null, repo: { name: 'app', root: '/r' }, worktree: { path: '/r', branch: 'main' },
      branch: 'main', container: null, command: 'node', cwd: '/r', createdAt: null, lastActivityAt: null,
      attached: [{ tty: '/dev/ttys001', pid: 9, via: 'Kunj Workspace' }], usage: { cpu: 1.5, memoryBytes: 1024 }, orphan: null,
    }],
    containers: { available: true, items: [{ container: 'kunj-app-x-1', repo: 'app', branch: 'x', tmux: 'ok', count: 0 }] },
  };
  const k: SessionsKillJson = { killed: ['a'], failed: [{ name: 'b', container: null, error: 'no such session' }] };
  expect(r.sessions[0].usage?.cpu).toBe(1.5);
  expect(k.failed[0].error).toBe('no such session');
});
