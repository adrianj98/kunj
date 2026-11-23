import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Exec } from '../github-repos';
import type { PullRequestInfo } from '../worktree';

const mockKunjHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-prdetails-'));
jest.mock('../config', () => ({
  ...jest.requireActual<object>('../config'),
  getGlobalKunjDir: () => mockKunjHome,
  initGlobalKunjDirectory: () => fs.mkdirSync(mockKunjHome, { recursive: true }),
}));

let mockListing: { provider: 'github' | 'gitlab' | null; pullRequests: PullRequestInfo[] | null } = { provider: 'github', pullRequests: [] };
const mockInvalidate = jest.fn();
jest.mock('../worktree', () => ({
  ...jest.requireActual<object>('../worktree'),
  pullRequestCacheKey: async () => '/repo/.git',
  fetchPullRequestsCached: async () => ({ ...mockListing, fromCache: false }),
  invalidatePullRequestCache: (key: string) => mockInvalidate(key),
}));

import {
  actionsJobId, getFailedLogs, getPullRequestDetails, latestReviews, markReady, mergePullRequest, parseCheck,
  parseMergeMethods, parseThread, resolveThread, tailLines,
} from '../pr-details';

const listed = (n: number, branch = 'feat'): PullRequestInfo => ({
  provider: 'github', number: n, title: 't', state: 'open', url: `https://github.com/o/r/pull/${n}`, draft: false,
  baseBranch: 'main', headBranch: branch, reviewDecision: null, checks: null, updatedAt: null,
});

const VIEW = {
  number: 7, title: 'Fix token refresh', state: 'OPEN', url: 'https://github.com/o/r/pull/7', isDraft: false,
  headRefName: 'feat', baseRefName: 'main', reviewDecision: 'APPROVED', updatedAt: '2026-11-20T00:00:00Z',
  headRefOid: 'abc1234def', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', mergedAt: null, isCrossRepository: false,
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI',
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/11', startedAt: 'a', completedAt: 'b' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI',
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/12', startedAt: 'a', completedAt: 'b' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', targetUrl: 'https://ci.example/1' },
  ],
  reviews: [
    { author: { login: 'ann' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-01' },
    { author: { login: 'ann' }, state: 'APPROVED', submittedAt: '2026-11-02' },
    { author: { login: 'ann' }, state: 'COMMENTED', submittedAt: '2026-11-03' },
  ],
};

const THREADS = {
  data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: 'T_resolved', isResolved: true, isOutdated: false, path: 'a.ts', line: 1, originalLine: 1, diffSide: 'RIGHT',
      comments: { nodes: [{ author: { login: 'bo' }, body: 'ok', createdAt: 'x', url: 'u', diffHunk: '@@' }] } },
    { id: 'T_open', isResolved: false, isOutdated: true, path: 'b.ts', line: null, originalLine: 9, diffSide: 'LEFT',
      comments: { nodes: [{ author: null, body: 'why?', createdAt: 'x', url: 'u2', diffHunk: '@@ -1 +1 @@' }] } },
  ] } } } },
};

const REPO = { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: 'MERGE' };

// A fake gh: answers by the first arguments and records every call
function fakeGh(overrides: Record<string, (args: string[]) => string> = {}): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (file: string, args: string[]) => {
    expect(file).toBe('gh');
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (overrides[key]) return { stdout: overrides[key](args), stderr: '' };
    if (key === 'pr view') return { stdout: JSON.stringify(VIEW), stderr: '' };
    if (key === 'api graphql') return { stdout: JSON.stringify(THREADS), stderr: '' };
    if (key === 'repo view') return { stdout: JSON.stringify(REPO), stderr: '' };
    return { stdout: '', stderr: '' };
  }) as Exec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

const opts = <T extends object = {}>(exec: Exec, extra: T = {} as T) => ({ branch: 'feat', path: '/wt/feat', cwd: '/wt/feat', exec, ...extra });

beforeEach(() => {
  fs.rmSync(path.join(mockKunjHome, 'pr-details-cache.json'), { force: true });
  mockListing = { provider: 'github', pullRequests: [listed(7)] };
  mockInvalidate.mockReset();
});

describe('parsing', () => {
  it('finds the Actions job id', () => {
    expect(actionsJobId('https://github.com/o/r/actions/runs/123/job/456')).toBe(456);
    expect(actionsJobId('https://ci.example/build/1')).toBeNull();
    expect(actionsJobId(null)).toBeNull();
  });

  it('maps check runs and statuses', () => {
    expect(parseCheck({ name: 'x', status: 'IN_PROGRESS', conclusion: '' }).state).toBe('pending');
    expect(parseCheck({ name: 'x', status: 'QUEUED' }).state).toBe('pending');
    expect(parseCheck({ name: 'x', status: 'COMPLETED', conclusion: 'TIMED_OUT' }).state).toBe('failure');
    expect(parseCheck({ name: 'x', status: 'COMPLETED', conclusion: 'CANCELLED' }).state).toBe('cancelled');
    expect(parseCheck({ name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' }).state).toBe('skipped');
    expect(parseCheck({ __typename: 'StatusContext', context: 'c', state: 'ERROR' })).toMatchObject({ name: 'c', state: 'failure', jobId: null });
    expect(parseCheck({ __typename: 'StatusContext', context: 'c', state: 'EXPECTED' }).state).toBe('pending');
  });

  it('keeps an outdated thread off the head line', () => {
    const t = parseThread(THREADS.data.repository.pullRequest.reviewThreads.nodes[1]);
    expect(t).toMatchObject({ line: null, originalLine: 9, side: 'LEFT', outdated: true, diffHunk: '@@ -1 +1 @@' });
    expect(t.comments[0].author).toBe('ghost');
  });

  it("keeps each reviewer's latest verdict, not a later comment", () => {
    expect(latestReviews(VIEW.reviews)).toEqual([{ author: 'ann', state: 'APPROVED', submittedAt: '2026-11-02' }]);
  });

  it("puts the repository's default merge method first", () => {
    expect(parseMergeMethods(REPO)).toEqual(['merge', 'squash']);
    expect(parseMergeMethods({ rebaseMergeAllowed: true })).toEqual(['rebase']);
  });

  it('tails a log', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual({ log: 'b\nc', truncated: true });
    expect(tailLines('a\nb', 5)).toEqual({ log: 'a\nb', truncated: false });
  });
});

describe('getPullRequestDetails', () => {
  it('asks gh for the PR, its threads and the merge methods, and orders what it shows', async () => {
    const gh = fakeGh();
    const d = await getPullRequestDetails(opts(gh));
    expect(gh.calls.map(c => c.slice(0, 2).join(' ')).sort()).toEqual(['api graphql', 'pr view', 'repo view']);
    expect(gh.calls.find(c => c[1] === 'graphql')).toEqual(expect.arrayContaining(['number=7', 'owner={owner}', 'repo={repo}']));
    expect(d).toMatchObject({
      branch: 'feat', path: '/wt/feat', headSha: 'abc1234def', mergeable: 'mergeable', mergeState: 'clean',
      mergeMethods: ['merge', 'squash'], fromCache: false,
    });
    expect(d.pullRequest).toMatchObject({ number: 7, title: 'Fix token refresh', checks: 'failure' });
    expect(d.checks!.map(c => `${c.state}:${c.name}`)).toEqual(['failure:ci/legacy', 'failure:test', 'success:lint']);
    expect(d.threads!.map(t => t.id)).toEqual(['T_open', 'T_resolved']);
  });

  it('serves a second call from the cache, and --fresh skips it', async () => {
    const gh = fakeGh();
    await getPullRequestDetails(opts(gh));
    const again = await getPullRequestDetails(opts(gh));
    expect(again.fromCache).toBe(true);
    expect(gh.calls).toHaveLength(3);
    await getPullRequestDetails(opts(gh, { fresh: true }));
    // The merge methods are kept for a day, even past --fresh
    expect(gh.calls.map(c => c[0] + ' ' + c[1]).filter(c => c === 'repo view')).toHaveLength(1);
    expect(gh.calls).toHaveLength(5);
  });

  it('keeps cached details only 5 s while a check runs', async () => {
    const pending = { ...VIEW, statusCheckRollup: [{ name: 'x', status: 'IN_PROGRESS' }] };
    const gh = fakeGh({ 'pr view': () => JSON.stringify(pending) });
    let t = 1_000_000;
    await getPullRequestDetails(opts(gh, { now: () => t }));
    t += 6_000;
    expect((await getPullRequestDetails(opts(gh, { now: () => t }))).fromCache).toBe(false);
  });

  it('costs no gh call for a branch without a PR', async () => {
    mockListing = { provider: 'github', pullRequests: [listed(3, 'other')] };
    const gh = fakeGh();
    const d = await getPullRequestDetails(opts(gh));
    expect(d.pullRequest).toBeNull();
    expect(gh.calls).toHaveLength(0);
  });

  it('asks gh directly when the listing failed, so its error reaches the user', async () => {
    mockListing = { provider: null, pullRequests: null };
    const missing: Exec = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
    await expect(getPullRequestDetails(opts(missing))).rejects.toMatchObject({ code: 'gh-missing' });
    const none: Exec = async (_f, args) => {
      if (args[0] === 'pr') throw Object.assign(new Error('x'), { code: 1, stderr: 'no pull requests found for branch "feat"' });
      return { stdout: '{}', stderr: '' };
    };
    expect((await getPullRequestDetails(opts(none))).pullRequest).toBeNull();
  });

  it('refuses GitLab', async () => {
    mockListing = { provider: 'gitlab', pullRequests: [] };
    await expect(getPullRequestDetails(opts(fakeGh()))).rejects.toMatchObject({ code: 'pr-details-unsupported' });
  });

  it('still answers when the repository settings cannot be read', async () => {
    const gh = fakeGh({ 'repo view': () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 502' }); } });
    const d = await getPullRequestDetails(opts(gh));
    expect(d.mergeMethods).toBeUndefined();
    expect(d.pullRequest?.number).toBe(7);
  });
});

describe('actions', () => {
  it('--failed-log tails each failed Actions job and gives the rest their URL', async () => {
    const gh = fakeGh({ 'run view': () => Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n' });
    const r = await getFailedLogs(opts(gh, { lines: 3 }));
    expect(r.checks).toEqual([
      { name: 'ci/legacy', jobId: null, url: 'https://ci.example/1', log: null, truncated: false },
      { name: 'test', jobId: 12, url: 'https://github.com/o/r/actions/runs/1/job/12', log: 'line 197\nline 198\nline 199', truncated: true },
    ]);
    expect(gh.calls.find(c => c[0] === 'run')).toEqual(['run', 'view', '--job', '12', '--log-failed']);
  });

  it('--failed-log --check names one check, and an unknown name is an error', async () => {
    const gh = fakeGh({ 'run view': () => 'ok' });
    expect((await getFailedLogs(opts(gh, { check: 'lint' }))).checks.map(c => c.name)).toEqual(['lint']);
    await expect(getFailedLogs(opts(gh, { check: 'nope' }))).rejects.toMatchObject({ code: 'check-not-found' });
  });

  it('--ready marks the PR ready and drops both caches', async () => {
    const gh = fakeGh();
    const r = await markReady(opts(gh));
    expect(gh.calls).toContainEqual(['pr', 'ready', '7']);
    expect(mockInvalidate).toHaveBeenCalledWith('/repo/.git');
    expect(r.pullRequest?.number).toBe(7);
  });

  it('--ready without a PR is no-pull-request', async () => {
    mockListing = { provider: 'github', pullRequests: [] };
    await expect(markReady(opts(fakeGh()))).rejects.toMatchObject({ code: 'no-pull-request' });
  });

  it('--merge merges only the head it saw, with the default method, and deletes only the remote branch', async () => {
    const gh = fakeGh();
    const r = await mergePullRequest(opts(gh, { deleteBranch: true, subject: 'Fix it' }));
    expect(gh.calls).toContainEqual(['pr', 'merge', '7', '--merge', '--match-head-commit', 'abc1234def', '--subject', 'Fix it']);
    expect(gh.calls).toContainEqual(['api', '-X', 'DELETE', 'repos/{owner}/{repo}/git/refs/heads/feat']);
    expect(gh.calls.flat()).not.toContain('--delete-branch');
    expect(gh.calls.flat()).not.toContain('--admin');
    expect(r.branchDeleted).toBe(true);
  });

  it('--merge refuses what GitHub cannot merge and methods the repository does not allow', async () => {
    const conflicting = fakeGh({ 'pr view': () => JSON.stringify({ ...VIEW, mergeable: 'CONFLICTING' }) });
    await expect(mergePullRequest(opts(conflicting))).rejects.toMatchObject({ code: 'not-mergeable' });
    expect(conflicting.calls.some(c => c[1] === 'merge')).toBe(false);
    const draft = fakeGh({ 'pr view': () => JSON.stringify({ ...VIEW, isDraft: true }) });
    await expect(mergePullRequest(opts(draft))).rejects.toMatchObject({ code: 'not-mergeable' });
    await expect(mergePullRequest(opts(fakeGh(), { method: 'rebase' }))).rejects.toMatchObject({ code: 'bad-merge-method' });
  });

  it('--merge --delete-branch leaves a fork alone', async () => {
    const gh = fakeGh({ 'pr view': () => JSON.stringify({ ...VIEW, isCrossRepository: true }) });
    const r = await mergePullRequest(opts(gh, { deleteBranch: true }));
    expect(r).toMatchObject({ branchDeleted: false });
    expect(gh.calls.some(c => c.includes('DELETE'))).toBe(false);
  });

  it('--resolve checks the id and returns the resolved thread', async () => {
    await expect(resolveThread(opts(fakeGh(), { threadId: '--jq=.' }))).rejects.toMatchObject({ code: 'bad-thread-id' });
    const node = { ...THREADS.data.repository.pullRequest.reviewThreads.nodes[1], isResolved: true };
    const gh = fakeGh({ 'api graphql': () => JSON.stringify({ data: { resolveReviewThread: { thread: node } } }) });
    const r = await resolveThread(opts(gh, { threadId: 'T_open' }));
    expect(r.thread).toMatchObject({ id: 'T_open', resolved: true });
    expect(gh.calls.find(c => c[1] === 'graphql')).toContain('threadId=T_open');
  });
});
