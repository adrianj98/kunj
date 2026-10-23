import type { WorktreeListJson, ContainerListJson, ReposJson, ErrorJson } from '../json-types';

test('json contract types are exported and describe the documented shapes', () => {
  const err: ErrorJson = { error: { code: 'x', message: 'y' } };
  const repos: ReposJson = { repos: [] };
  const worktrees: WorktreeListJson = { repoRoot: '/r', currentPath: null, pullRequestLookup: 'skipped', pullRequestsFromCache: false, worktrees: [] };
  const containers: ContainerListJson = { repo: 'app', backend: { kind: 'docker', context: 'default' }, containers: [], orphans: [] };
  expect([err, repos, worktrees, containers]).toHaveLength(4);
});
