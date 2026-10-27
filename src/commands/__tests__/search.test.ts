// kunj search: which worktrees, branches and containers each scope and filter reaches, and the JSON
import { SearchCommand } from '../search';
import { listWorktreesDetailed } from '../../lib/worktree';
import * as search from '../../lib/search';

jest.mock('../../lib/worktree', () => ({ listWorktreesDetailed: jest.fn() }));
jest.mock('../../lib/work-log', () => ({ getWorkLogDir: () => '/logs' }));
jest.mock('../../lib/search', () => ({
  ...jest.requireActual('../../lib/search'),
  grepWorktree: jest.fn(),
  grepRefs: jest.fn(),
  gitOutput: jest.fn(),
  searchCommits: jest.fn(),
  searchWorkLogs: jest.fn(),
}));

const mockSearchJson = jest.fn();
const mockAbort = jest.fn();
jest.mock('../container', () => ({
  ContainerCommand: jest.fn().mockImplementation(() => ({ searchJson: mockSearchJson, abortDockerCalls: mockAbort })),
}));

const match = { path: 'a.ts', line: 1, column: 1, length: 1, text: 'x' };
const wt = (branch: string, isCurrent = false, extra = {}) => ({ branch, name: branch, path: `/wt/${branch}`, exists: true, bare: false, sessions: [], isCurrent, ...extra });

let stdout: string[];

beforeEach(() => {
  jest.clearAllMocks();
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(console, 'log').mockImplementation((s: string) => { stdout.push(String(s)); });
  (listWorktreesDetailed as jest.Mock).mockResolvedValue({
    repoRoot: '/wt/main', gitCommonDir: '/wt/main/.git', currentPath: '/wt/feat',
    worktrees: [wt('main'), wt('feat', true), wt('gone', false, { exists: false }), wt('bare', false, { bare: true })],
  });
  (search.grepWorktree as jest.Mock).mockImplementation(async (p: string) =>
    p === '/wt/main' ? { matches: [match], truncated: false } : { matches: [], truncated: false });
  (search.gitOutput as jest.Mock).mockResolvedValue('refs/heads/main\nrefs/heads/feat\nrefs/heads/idle\nrefs/remotes/origin/far\n');
  (search.grepRefs as jest.Mock).mockResolvedValue({ results: new Map([['refs/heads/idle', { matches: [match], truncated: true }]]) });
  (search.searchCommits as jest.Mock).mockResolvedValue([]);
  (search.searchWorkLogs as jest.Mock).mockReturnValue([]);
  mockSearchJson.mockResolvedValue({ sources: [{ kind: 'container', branch: 'feat', container: 'kunj-a-feat', matches: [match], truncated: false }], searched: 1, stopped: ['old'] });
});

afterEach(() => jest.restoreAllMocks());

async function run(pattern: string, options: Record<string, unknown> = {}, paths?: string[]): Promise<any> {
  const cmd = new SearchCommand();
  (cmd as any).jsonMode = true;
  if (paths) await cmd.execute(pattern, paths, options as any);
  else await cmd.execute(pattern, options as any);
  return JSON.parse(stdout.join(''));
}

it('searches every existing worktree by default, the current one first, and lists only matches', async () => {
  const json = await run('x');
  expect((search.grepWorktree as jest.Mock).mock.calls.map(c => c[0])).toEqual(['/wt/feat', '/wt/main']);
  expect(json.query.scopes).toEqual(['worktrees']);
  expect(json.searched).toEqual({ worktrees: 2, branches: 0, containers: 0 });
  expect(json.sources).toEqual([{ kind: 'worktree', branch: 'main', path: '/wt/main', isCurrent: false, matches: [match], truncated: false }]);
  expect(json).not.toHaveProperty('containers');
  expect(json).not.toHaveProperty('commits');
  expect(mockSearchJson).not.toHaveBeenCalled();
});

it('passes the paths and flags on', async () => {
  await run('x', { ignoreCase: true, fixedStrings: true, wordRegexp: true, maxCount: '7' }, ['src/']);
  expect((search.grepWorktree as jest.Mock).mock.calls[0][1]).toEqual({ pattern: 'x', ignoreCase: true, fixed: true, word: true, paths: ['src/'], maxCount: 7 });
});

it('limits to --current or --branch', async () => {
  await run('x', { current: true });
  expect((search.grepWorktree as jest.Mock).mock.calls.map(c => c[0])).toEqual(['/wt/feat']);
  (search.grepWorktree as jest.Mock).mockClear();
  const json = await (stdout = [], run('x', { branch: 'main, other', in: 'worktrees,containers' }));
  expect((search.grepWorktree as jest.Mock).mock.calls.map(c => c[0])).toEqual(['/wt/main']);
  expect(mockSearchJson).toHaveBeenCalledWith(expect.anything(), ['main', 'other']);
  expect(json.query.branches).toEqual(['main', 'other']);
});

it('--all searches every scope; branches are those without a worktree', async () => {
  const json = await run('x', { all: true, origin: true });
  expect(json.query.scopes).toEqual(['worktrees', 'branches', 'containers', 'commits', 'logs']);
  expect((search.grepRefs as jest.Mock).mock.calls[0][1]).toEqual(['refs/heads/idle', 'refs/remotes/origin/far']);
  expect(json.searched).toEqual({ worktrees: 2, branches: 2, containers: 1 });
  expect(json.sources.map((s: any) => `${s.kind}:${s.branch}`)).toEqual(['worktree:main', 'branch:idle', 'container:feat']);
  expect(json.sources[1]).toMatchObject({ ref: 'refs/heads/idle', remote: false, truncated: true });
  expect(json.containers).toEqual({ available: true, stopped: ['old'] });
  expect(json.commits).toEqual([]);
  expect(json.logs).toEqual([]);
  expect(search.searchWorkLogs).toHaveBeenCalledWith('/logs', expect.anything());
});

it('reports Docker being down instead of failing the search', async () => {
  mockSearchJson.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
  const json = await run('x', { in: 'containers' });
  expect(json.containers).toEqual({ available: false, message: 'Cannot connect to the Docker daemon', stopped: [] });
  expect(json.sources).toEqual([]);
});

it('-e gives the pattern and makes every argument a path', async () => {
  await run('src/', { regexp: '-x' }, ['lib/']);
  expect((search.grepWorktree as jest.Mock).mock.calls[0][1]).toMatchObject({ pattern: '-x', paths: ['src/', 'lib/'] });
});

it('refuses an unknown scope and a bad --max-count', async () => {
  await expect(run('x', { in: 'worktrees,files' })).rejects.toThrow(/Unknown search scope 'files'/);
  await expect(run('x', { maxCount: '0' })).rejects.toThrow(/--max-count/);
});

it('prints matches grouped by worktree and file in text mode', async () => {
  const cmd = new SearchCommand();
  await cmd.execute('x', {} as any);
  const text = stdout.join('\n');
  expect(text).toContain('main');
  expect(text).toContain('a.ts');
  expect(text).toMatch(/1 match \(searched 2 worktrees\)/);
});
