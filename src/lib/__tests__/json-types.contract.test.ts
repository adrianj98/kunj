import type { ContainerJson, EventJson, SearchJson } from '../json-types';

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
