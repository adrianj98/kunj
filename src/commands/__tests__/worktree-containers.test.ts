// kunj worktree list --containers: the repository's branch containers next to its worktrees, each
// with its branch's pull request, for the VS Code extension and the macOS app.
import { WorktreeCommand } from '../worktree';
import { listWorktreesDetailed } from '../../lib/worktree';

const pr = (headBranch: string, number: number, state = 'open') => ({
  provider: 'github', number, title: headBranch, state, url: `https://x/${number}`, draft: false,
  baseBranch: 'main', headBranch, reviewDecision: null, checks: null, updatedAt: null,
});

jest.mock('../../lib/worktree', () => ({
  ...jest.requireActual('../../lib/worktree'),
  listWorktreesDetailed: jest.fn(),
}));

jest.mock('../../lib/repos', () => ({ recordRepo: jest.fn() }));

const mockListJson = jest.fn();
jest.mock('../container', () => ({
  ContainerCommand: jest.fn().mockImplementation(() => ({ listJson: mockListJson })),
}));

const container = (branch: string) => ({
  branch, name: `kunj-app-${branch}`, id: branch, state: 'running', image: 'img', imageInfo: { tag: 'img' },
  createdAt: '', firewall: 'default', dind: 'off', ports: [], agent: { running: false },
  workspace: { head: 'abc1234', ahead: 1, dirty: false }, status: 'ok', services: [], bridges: [],
});

let stdout: string[];

beforeEach(() => {
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(console, 'log').mockImplementation((s: string) => { stdout.push(String(s)); });
  (listWorktreesDetailed as jest.Mock).mockResolvedValue({
    repoRoot: '/wt', gitCommonDir: '/wt/.git', currentPath: '/wt', pullRequestLookup: 'github', pullRequestsFromCache: false,
    pullRequests: [pr('feature/x', 7), pr('feature-x', 8, 'merged')],
    worktrees: [{ branch: 'main', name: 'main', path: '/wt', exists: true, bare: false, sessions: [], isCurrent: true }],
  });
  mockListJson.mockReset();
  mockListJson.mockResolvedValue({ repo: 'app', backend: { kind: 'docker', context: 'default' }, containers: [container('feature/x'), container('other')], orphans: [] });
});

afterEach(() => jest.restoreAllMocks());

// BaseCommand's action wrapper sets jsonMode from --json; called directly, the test sets it
async function list(options: Record<string, unknown>): Promise<void> {
  const cmd = new WorktreeCommand();
  (cmd as any).jsonMode = options.json === true;
  await cmd.execute('list', options as any);
}

function json(): any {
  return JSON.parse(stdout.join(''));
}

it('adds the containers with the pull request of their exact branch', async () => {
  await list({ json: true, containers: true });
  const out = json();
  expect(out.worktrees).toHaveLength(1);
  expect(out.containers.available).toBe(true);
  expect(out.containers.items.map((c: any) => [c.branch, c.pullRequest?.number ?? null, c.prLabel])).toEqual([
    ['feature/x', 7, '#7 open'],
    ['other', null, null],
  ]);
  expect(mockListJson).toHaveBeenCalledWith({ status: true });
});

it('leaves containers out without --containers and never loads the container module', async () => {
  await list({ json: true });
  expect(json().containers).toBeUndefined();
  expect(mockListJson).not.toHaveBeenCalled();
});

it('reports Docker being unavailable without failing the listing', async () => {
  mockListJson.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
  await list({ json: true, containers: true });
  const out = json();
  expect(out.worktrees).toHaveLength(1);
  expect(out.containers).toEqual({ available: false, message: 'Cannot connect to the Docker daemon', items: [] });
});

it('passes --no-status on and leaves pullRequest out with --no-pr', async () => {
  await list({ json: true, containers: true, status: false, pr: false });
  const out = json();
  expect(mockListJson).toHaveBeenCalledWith({ status: false });
  expect(out.containers.items[0]).not.toHaveProperty('pullRequest');
  expect(out.containers.items[0].prLabel).toBeNull();
});

it('prints a Containers section in text mode', async () => {
  await list({ containers: true });
  const text = stdout.join('\n');
  expect(text).toContain('Containers:');
  expect(text).toContain('feature/x');
  expect(text).toContain('PR #7');
});
