// The details of a branch's pull request for the workspace app's PR panel (docs/specs/pr-panel.md):
// checks, review threads, reviews and merge state, and the actions on them (failed logs, ready,
// merge, resolve). GitHub only, through `gh` with argv only. On the fast path (`kunj worktree pr`):
// no heavy imports.
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalKunjDir, initGlobalKunjDirectory } from './config';
import { execFileAsync, ghError, GitHubError, type Exec } from './github-repos';
import {
  DEFAULT_PR_MAX_AGE_SECONDS,
  fetchPullRequestsCached,
  GH_FIELDS,
  githubPullRequestInfo,
  invalidatePullRequestCache,
  pickPullRequest,
  pullRequestCacheKey,
  type PullRequestInfo,
} from './worktree';
import type {
  PullRequestActionJson,
  PullRequestCheckJson,
  PullRequestDetailsJson,
  PullRequestFailedLogJson,
  PullRequestMergeMethod,
  PullRequestResolveJson,
  PullRequestThreadJson,
} from './json-types';

export const PR_DETAILS_CACHE_FILE = 'pr-details-cache.json';
export const DETAILS_MAX_AGE_MS = 20_000;
export const DETAILS_PENDING_MAX_AGE_MS = 5_000;
const MERGE_METHODS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_LINES = 150;
export const MAX_LOG_LINES = 2000;

const VIEW_FIELDS = `${GH_FIELDS},headRefOid,mergeable,mergeStateStatus,reviews,mergedAt,isCrossRepository`;

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { ${threadFields()} } }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { ${threadFields()} } }
}`;

function threadFields(): string {
  return 'id isResolved isOutdated path line originalLine diffSide ' +
    'comments(first: 50) { nodes { author { login } body createdAt url diffHunk } }';
}

export interface PrDetailsOptions {
  branch: string;
  /** The worktree path, reported back */
  path: string;
  /** Where gh and git run: the worktree when it exists */
  cwd?: string;
  /** Skip both PR caches */
  fresh?: boolean;
  exec?: Exec;
  now?: () => number;
}

// ---- parsing gh's output ---------------------------------------------------------------------

/** The Actions job id in a check run's details URL (`…/actions/runs/<run>/job/<job>`) */
export function actionsJobId(url: string | null | undefined): number | null {
  const m = /\/actions\/runs\/\d+\/job(?:s)?\/(\d+)/.exec(url || '');
  return m ? Number(m[1]) : null;
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/** One entry of `statusCheckRollup` (a CheckRun or a StatusContext) */
export function parseCheck(c: any): PullRequestCheckJson {
  if (c?.__typename === 'StatusContext' || (c?.context !== undefined && c?.name === undefined)) {
    const s = String(c.state || '').toUpperCase();
    return {
      name: String(c.context || ''),
      workflow: null,
      state: s === 'SUCCESS' ? 'success' : FAILED.has(s) ? 'failure' : 'pending',
      url: c.targetUrl || null,
      startedAt: c.startedAt || null,
      completedAt: null,
      jobId: null,
    };
  }
  const status = String(c?.status || '').toUpperCase();
  const conclusion = String(c?.conclusion || '').toUpperCase();
  let state: PullRequestCheckJson['state'];
  if (status && status !== 'COMPLETED') state = 'pending';
  else if (conclusion === 'SUCCESS') state = 'success';
  else if (FAILED.has(conclusion)) state = 'failure';
  else if (conclusion === 'CANCELLED') state = 'cancelled';
  else if (conclusion === 'SKIPPED') state = 'skipped';
  else if (conclusion === 'NEUTRAL' || conclusion === 'STALE') state = 'neutral';
  else state = 'pending';
  const url = c?.detailsUrl || null;
  return {
    name: String(c?.name || ''),
    workflow: c?.workflowName || null,
    state,
    url,
    startedAt: c?.startedAt || null,
    completedAt: state === 'pending' ? null : c?.completedAt || null,
    jobId: actionsJobId(url),
  };
}

/** A review thread node of the GraphQL query */
export function parseThread(t: any): PullRequestThreadJson {
  const comments = Array.isArray(t?.comments?.nodes) ? t.comments.nodes : [];
  const outdated = !!t?.isOutdated;
  return {
    id: String(t?.id || ''),
    path: String(t?.path || ''),
    line: outdated ? null : typeof t?.line === 'number' ? t.line : null,
    originalLine: typeof t?.originalLine === 'number' ? t.originalLine : null,
    side: t?.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    resolved: !!t?.isResolved,
    outdated,
    diffHunk: String(comments[0]?.diffHunk || ''),
    comments: comments.map((c: any) => ({
      author: String(c?.author?.login || 'ghost'),
      body: String(c?.body || ''),
      createdAt: String(c?.createdAt || ''),
      url: String(c?.url || ''),
    })),
  };
}

/** Each reviewer's latest review, oldest first */
export function latestReviews(reviews: any): Array<{ author: string; state: string; submittedAt: string }> {
  if (!Array.isArray(reviews)) return [];
  const byAuthor = new Map<string, { author: string; state: string; submittedAt: string }>();
  for (const r of reviews) {
    const author = String(r?.author?.login || 'ghost');
    const entry = { author, state: String(r?.state || ''), submittedAt: String(r?.submittedAt || '') };
    const prev = byAuthor.get(author);
    // A plain comment does not replace an approval or a change request
    if (prev && entry.state === 'COMMENTED' && prev.state !== 'COMMENTED') continue;
    if (!prev || entry.submittedAt >= prev.submittedAt) byAuthor.set(author, entry);
  }
  return [...byAuthor.values()].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** `gh repo view --json …` → the allowed merge methods, the repository's default first */
export function parseMergeMethods(repo: any): PullRequestMergeMethod[] {
  const allowed: PullRequestMergeMethod[] = [];
  if (repo?.squashMergeAllowed) allowed.push('squash');
  if (repo?.mergeCommitAllowed) allowed.push('merge');
  if (repo?.rebaseMergeAllowed) allowed.push('rebase');
  const preferred = String(repo?.viewerDefaultMergeMethod || '').toLowerCase() as PullRequestMergeMethod;
  const i = allowed.indexOf(preferred);
  if (i > 0) allowed.unshift(...allowed.splice(i, 1));
  return allowed;
}

function lowerOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v.toLowerCase() : undefined;
}

// ---- the details cache -----------------------------------------------------------------------

interface DetailsCacheEntry {
  fetchedAt: number;
  details?: PullRequestDetailsJson;
  mergeMethods?: PullRequestMergeMethod[];
}

export function getDetailsCachePath(): string {
  return path.join(getGlobalKunjDir(), PR_DETAILS_CACHE_FILE);
}

function readDetailsCache(): Record<string, DetailsCacheEntry> {
  try {
    const data = JSON.parse(fs.readFileSync(getDetailsCachePath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeDetailsCache(cache: Record<string, DetailsCacheEntry>, now: number): void {
  try {
    initGlobalKunjDirectory();
    const pruned: Record<string, DetailsCacheEntry> = {};
    for (const [k, v] of Object.entries(cache)) if (now - v.fetchedAt < MERGE_METHODS_MAX_AGE_MS) pruned[k] = v;
    const file = getDetailsCachePath();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pruned));
    fs.renameSync(tmp, file);
  } catch {
    // the cache is best effort
  }
}

function updateDetailsCache(mutate: (cache: Record<string, DetailsCacheEntry>) => void, now: number): void {
  const cache = readDetailsCache();
  mutate(cache);
  writeDetailsCache(cache, now);
}

/** How long cached details may be used: shorter while a check is still running */
export function detailsMaxAgeMs(details: PullRequestDetailsJson): number {
  return details.checks?.some(c => c.state === 'pending') ? DETAILS_PENDING_MAX_AGE_MS : DETAILS_MAX_AGE_MS;
}

const detailsKey = (repoKey: string, n: number) => `${repoKey}#${n}`;
const methodsKey = (repoKey: string) => `${repoKey}#repo`;

/** Forget everything cached about a repository's PRs, after kunj changed one */
export function invalidatePullRequestCaches(repoKey: string, number: number | null, now = Date.now()): void {
  invalidatePullRequestCache(repoKey);
  if (number !== null) updateDetailsCache(cache => { delete cache[detailsKey(repoKey, number)]; }, now);
}

// ---- gh --------------------------------------------------------------------------------------

async function gh(exec: Exec, args: string[], cwd: string | undefined, what: string): Promise<string> {
  try {
    return (await exec('gh', args, { cwd })).stdout;
  } catch (error) {
    throw ghError(error, what);
  }
}

function parseJson(text: string, what: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError('gh-failed', `${what} failed: gh printed something that is not JSON`);
  }
}

const NO_PR = /no pull requests? found/i;

async function viewPullRequest(exec: Exec, ref: string, cwd: string | undefined): Promise<any | null> {
  try {
    return parseJson((await exec('gh', ['pr', 'view', ref, '--json', VIEW_FIELDS], { cwd })).stdout, 'Reading the pull request');
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    if (NO_PR.test(String((error as { stderr?: string }).stderr || ''))) return null;
    throw ghError(error, 'Reading the pull request');
  }
}

async function fetchThreads(exec: Exec, number: number, cwd: string | undefined): Promise<PullRequestThreadJson[]> {
  const out = await gh(exec, [
    'api', 'graphql',
    '-f', `query=${THREADS_QUERY}`,
    '-F', 'owner={owner}', '-F', 'repo={repo}', '-F', `number=${number}`,
  ], cwd, 'Reading the review threads');
  const nodes = parseJson(out, 'Reading the review threads')?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  return Array.isArray(nodes) ? nodes.map(parseThread) : [];
}

async function fetchMergeMethods(exec: Exec, cwd: string | undefined): Promise<PullRequestMergeMethod[]> {
  const out = await gh(exec, [
    'repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod',
  ], cwd, 'Reading the repository settings');
  return parseMergeMethods(parseJson(out, 'Reading the repository settings'));
}

// ---- details ---------------------------------------------------------------------------------

interface Resolved {
  repoKey: string;
  /** The PR's number when the listing knows it; undefined when the listing could not ask */
  number: number | null | undefined;
}

async function resolvePullRequest(opts: PrDetailsOptions): Promise<Resolved> {
  const [repoKey, lookup] = await Promise.all([
    pullRequestCacheKey(opts.cwd || process.cwd()),
    fetchPullRequestsCached(opts.cwd, opts.fresh ? 0 : DEFAULT_PR_MAX_AGE_SECONDS),
  ]);
  if (lookup.provider === 'gitlab') {
    throw new GitHubError('pr-details-unsupported', 'Pull request details are only available for GitHub; this repository is on GitLab.');
  }
  // A failed listing (gh missing, logged out) is asked again by `gh pr view`, which says why
  if (!lookup.pullRequests) return { repoKey, number: undefined };
  return { repoKey, number: pickPullRequest(lookup.pullRequests, opts.branch)?.number ?? null };
}

/** `kunj worktree pr [branch] --details --json` */
export async function getPullRequestDetails(opts: PrDetailsOptions): Promise<PullRequestDetailsJson> {
  const exec = opts.exec ?? execFileAsync;
  const now = opts.now ?? Date.now;
  const { repoKey, number } = await resolvePullRequest(opts);
  const base = { branch: opts.branch, path: opts.path };
  if (number === null) {
    return { ...base, pullRequest: null, fromCache: false, fetchedAt: new Date(now()).toISOString() };
  }

  const cache = readDetailsCache();
  if (number !== undefined && !opts.fresh) {
    const hit = cache[detailsKey(repoKey, number)];
    if (hit?.details && now() - hit.fetchedAt < detailsMaxAgeMs(hit.details)) {
      return { ...hit.details, ...base, fromCache: true };
    }
  }

  const methodsHit = cache[methodsKey(repoKey)];
  // Optional: without them the panel's Merge sheet asks gh's default. null = not cached and not read
  const cachedMethods = methodsHit?.mergeMethods && now() - methodsHit.fetchedAt < MERGE_METHODS_MAX_AGE_MS
    ? methodsHit.mergeMethods
    : null;
  const methodsPromise: Promise<PullRequestMergeMethod[] | null> = cachedMethods
    ? Promise.resolve(cachedMethods)
    : fetchMergeMethods(exec, opts.cwd).catch(() => null);

  // With the number known, the threads are asked alongside the PR; otherwise after it
  const [view, early] = await Promise.all([
    viewPullRequest(exec, number !== undefined ? String(number) : opts.branch, opts.cwd),
    number !== undefined ? fetchThreads(exec, number, opts.cwd) : Promise.resolve(null),
  ]);
  if (!view) {
    return { ...base, pullRequest: null, fromCache: false, fetchedAt: new Date(now()).toISOString() };
  }
  const threads = early ?? (await fetchThreads(exec, view.number, opts.cwd));
  const mergeMethods = (await methodsPromise) ?? undefined;

  const mergeable = lowerOrUndefined(view.mergeable);
  const details: PullRequestDetailsJson = {
    ...base,
    pullRequest: githubPullRequestInfo(view),
    headSha: view.headRefOid || undefined,
    mergeable: mergeable === 'mergeable' || mergeable === 'conflicting' ? mergeable : 'unknown',
    mergeState: lowerOrUndefined(view.mergeStateStatus) ?? 'unknown',
    mergedAt: view.mergedAt || null,
    mergeMethods,
    checks: sortChecks((Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : []).map(parseCheck)),
    reviews: latestReviews(view.reviews),
    threads: sortThreads(threads),
    fromCache: false,
    fetchedAt: new Date(now()).toISOString(),
  };
  const t = now();
  updateDetailsCache(c => {
    c[detailsKey(repoKey, view.number)] = { fetchedAt: t, details };
    if (!cachedMethods && mergeMethods) c[methodsKey(repoKey)] = { fetchedAt: t, mergeMethods };
  }, t);
  return details;
}

const CHECK_ORDER: Record<PullRequestCheckJson['state'], number> = {
  failure: 0, pending: 1, cancelled: 2, success: 3, neutral: 4, skipped: 5,
};

/** Failed first, then running, then the rest; by name within each */
export function sortChecks(checks: PullRequestCheckJson[]): PullRequestCheckJson[] {
  return [...checks].sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
}

/** Unresolved first, then by path and line */
export function sortThreads(threads: PullRequestThreadJson[]): PullRequestThreadJson[] {
  return [...threads].sort((a, b) =>
    Number(a.resolved) - Number(b.resolved) ||
    a.path.localeCompare(b.path) ||
    (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0));
}

// ---- actions ---------------------------------------------------------------------------------

async function requirePullRequest(opts: PrDetailsOptions): Promise<{ repoKey: string; view: any }> {
  const exec = opts.exec ?? execFileAsync;
  const { repoKey, number } = await resolvePullRequest({ ...opts, fresh: true });
  const view = number === null ? null : await viewPullRequest(exec, number !== undefined ? String(number) : opts.branch, opts.cwd);
  if (!view) {
    throw new GitHubError('no-pull-request', `'${opts.branch}' has no pull request.`);
  }
  return { repoKey, view };
}

/** The last `lines` lines of `text` */
export function tailLines(text: string, lines: number): { log: string; truncated: boolean } {
  const all = text.replace(/\n+$/, '').split('\n');
  return all.length > lines
    ? { log: all.slice(-lines).join('\n'), truncated: true }
    : { log: all.join('\n'), truncated: false };
}

/** `--failed-log [--check <name>] [--lines n]` */
export async function getFailedLogs(
  opts: PrDetailsOptions & { check?: string; lines?: number },
): Promise<PullRequestFailedLogJson> {
  const exec = opts.exec ?? execFileAsync;
  const lines = Math.min(opts.lines ?? DEFAULT_LOG_LINES, MAX_LOG_LINES);
  const details = await getPullRequestDetails(opts);
  if (!details.pullRequest) throw new GitHubError('no-pull-request', `'${opts.branch}' has no pull request.`);
  const checks = details.checks ?? [];
  const chosen = opts.check
    ? checks.filter(c => c.name === opts.check)
    : checks.filter(c => c.state === 'failure');
  if (opts.check && chosen.length === 0) {
    throw new GitHubError('check-not-found', `Pull request #${details.pullRequest.number} has no check named '${opts.check}'.`);
  }
  const out = await Promise.all(chosen.map(async c => {
    const row = { name: c.name, jobId: c.jobId, url: c.url };
    if (c.jobId === null) return { ...row, log: null, truncated: false };
    try {
      const { stdout } = await exec('gh', ['run', 'view', '--job', String(c.jobId), '--log-failed'], { cwd: opts.cwd });
      return { ...row, ...tailLines(stdout, lines) };
    } catch (error) {
      return { ...row, log: null, truncated: false, error: ghError(error, 'Reading the job log').message };
    }
  }));
  return { checks: out };
}

async function freshPullRequest(opts: PrDetailsOptions, repoKey: string, number: number): Promise<PullRequestInfo | null> {
  invalidatePullRequestCaches(repoKey, number, (opts.now ?? Date.now)());
  const view = await viewPullRequest(opts.exec ?? execFileAsync, String(number), opts.cwd);
  return view ? githubPullRequestInfo(view) : null;
}

/** `--ready` */
export async function markReady(opts: PrDetailsOptions): Promise<PullRequestActionJson> {
  const { repoKey, view } = await requirePullRequest(opts);
  await gh(opts.exec ?? execFileAsync, ['pr', 'ready', String(view.number)], opts.cwd, 'Marking the pull request ready');
  return { pullRequest: await freshPullRequest(opts, repoKey, view.number) };
}

export interface MergeOptions {
  method?: string;
  deleteBranch?: boolean;
  subject?: string;
}

/** `--merge [--method m] [--delete-branch] [--subject s]`: never --admin or --auto, and only the head kunj saw */
export async function mergePullRequest(opts: PrDetailsOptions & MergeOptions): Promise<PullRequestActionJson> {
  const exec = opts.exec ?? execFileAsync;
  const { repoKey, view } = await requirePullRequest(opts);
  const n = view.number;
  if (String(view.state).toUpperCase() !== 'OPEN') {
    throw new GitHubError('not-mergeable', `Pull request #${n} is ${String(view.state).toLowerCase()}, so it cannot be merged.`);
  }
  if (view.isDraft) {
    throw new GitHubError('not-mergeable', `Pull request #${n} is a draft. Mark it ready first (\`kunj worktree pr --ready\`).`);
  }
  if (String(view.mergeable).toUpperCase() !== 'MERGEABLE') {
    const why = String(view.mergeable).toUpperCase() === 'CONFLICTING' ? 'it has conflicts with its base' : 'GitHub has not worked out whether it can be merged yet';
    throw new GitHubError('not-mergeable', `Pull request #${n} cannot be merged: ${why}.`);
  }
  const allowed = await fetchMergeMethods(exec, opts.cwd);
  const method = (opts.method ?? allowed[0]) as PullRequestMergeMethod | undefined;
  if (!method || !allowed.includes(method)) {
    throw new GitHubError('bad-merge-method',
      `${method ? `'${method}' is not` : 'No merge method is'} allowed in this repository${allowed.length ? `; use one of: ${allowed.join(', ')}` : ''}.`);
  }
  const args = ['pr', 'merge', String(n), `--${method}`];
  if (view.headRefOid) args.push('--match-head-commit', view.headRefOid);
  if (opts.subject !== undefined) args.push('--subject', opts.subject);
  await gh(exec, args, opts.cwd, 'Merging the pull request');

  const result: PullRequestActionJson = { pullRequest: null };
  if (opts.deleteBranch) {
    // Not gh's --delete-branch, which also deletes the local branch and switches the worktree away
    if (view.isCrossRepository) {
      result.branchDeleted = false;
      result.branchDeleteError = 'The branch is in a fork; kunj deletes only branches of this repository.';
    } else {
      const ref = String(view.headRefName).split('/').map(encodeURIComponent).join('/');
      try {
        await exec('gh', ['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${ref}`], { cwd: opts.cwd });
        result.branchDeleted = true;
      } catch (error) {
        result.branchDeleted = false;
        result.branchDeleteError = ghError(error, 'Deleting the remote branch').message;
      }
    }
  }
  result.pullRequest = await freshPullRequest(opts, repoKey, n);
  return result;
}

const THREAD_ID = /^[A-Za-z0-9_=-]{1,128}$/;

/** `--resolve <threadId>` */
export async function resolveThread(opts: PrDetailsOptions & { threadId: string }): Promise<PullRequestResolveJson> {
  if (!THREAD_ID.test(opts.threadId)) {
    throw new GitHubError('bad-thread-id', `'${opts.threadId}' is not a review thread id (see \`kunj worktree pr --details --json\`).`);
  }
  const exec = opts.exec ?? execFileAsync;
  const { repoKey, view } = await requirePullRequest(opts);
  const out = await gh(exec, [
    'api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${opts.threadId}`,
  ], opts.cwd, 'Resolving the review thread');
  const thread = parseJson(out, 'Resolving the review thread')?.data?.resolveReviewThread?.thread;
  if (!thread) throw new GitHubError('gh-failed', 'Resolving the review thread failed: GitHub returned no thread.');
  invalidatePullRequestCaches(repoKey, view.number, (opts.now ?? Date.now)());
  return { thread: parseThread(thread) };
}
