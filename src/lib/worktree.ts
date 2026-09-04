// Git worktree operations and editor session tracking for Kunj CLI
//
// Sessions let editors (e.g. the Kunj VS Code extension) register which
// worktree they have open. They are stored globally in
// ~/.kunj/worktree-sessions.json and pruned automatically when the owning
// process is no longer alive.

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGlobalKunjDir, initGlobalKunjDirectory } from './config';

const execAsync = promisify(exec);

export const WORKTREE_SESSIONS_FILE = 'worktree-sessions.json';

// Sessions that have not been seen for this long are considered stale
// (only used when we cannot check the owning PID, e.g. a different host).
const SESSION_STALE_MS = 24 * 60 * 60 * 1000;

export interface WorktreeSession {
  id: string;
  path: string;
  pid: number;
  host: string;
  editor: string;
  label?: string;
  registeredAt: string;
  lastSeen: string;
}

export interface WorktreeStatus {
  dirty: boolean;
  changedFiles: number;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
}

export type PullRequestState = 'open' | 'merged' | 'closed';
export type ChecksState = 'success' | 'failure' | 'pending';

export interface PullRequestInfo {
  provider: 'github' | 'gitlab';
  number: number;
  title: string;
  state: PullRequestState;
  url: string;
  draft: boolean;
  baseBranch: string | null;
  headBranch: string;
  reviewDecision: string | null; // e.g. APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  checks: ChecksState | null;
  updatedAt: string | null;
}

export interface WorktreeInfo {
  path: string;
  name: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMain: boolean;
  exists: boolean;
  status?: WorktreeStatus;
  pullRequest?: PullRequestInfo | null;
  sessions: WorktreeSession[];
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// Normalize a path for comparison (resolve symlinks when possible)
export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

// Directory of the worktree that contains the current working directory
export async function getCurrentWorktreePath(cwd: string = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// The main worktree (the one holding the real .git directory)
export async function getMainWorktreePath(cwd: string = process.cwd()): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --path-format=absolute --git-common-dir', { cwd });
  const commonDir = stdout.trim();
  // For a normal repo the common dir is <root>/.git; for a bare repo it is the repo itself
  if (path.basename(commonDir) === '.git') {
    return path.dirname(commonDir);
  }
  return commonDir;
}

// Turn a branch name into a safe directory name (feature/foo -> feature-foo)
export function branchToDirName(branch: string): string {
  return branch
    .replace(/^refs\/heads\//, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/, '') || 'worktree';
}

// Default location for a new worktree of the given branch
export async function getDefaultWorktreePath(branch: string, baseDir?: string, cwd?: string): Promise<string> {
  const mainRoot = await getMainWorktreePath(cwd);
  const repoName = path.basename(mainRoot);
  const dir = baseDir && baseDir.trim()
    ? path.resolve(mainRoot, baseDir.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(path.dirname(mainRoot), `${repoName}-worktrees`);
  return path.join(dir, branchToDirName(branch));
}

// ---------------------------------------------------------------------------
// Parsing `git worktree list --porcelain`
// ---------------------------------------------------------------------------

export type ParsedWorktree = Omit<WorktreeInfo, 'sessions' | 'isCurrent' | 'exists' | 'status' | 'pullRequest'>;

export function parseWorktreeList(porcelain: string): ParsedWorktree[] {
  const blocks = porcelain.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const result: ParsedWorktree[] = [];

  blocks.forEach((block, index) => {
    const wt: ParsedWorktree = {
      path: '',
      name: '',
      head: null,
      branch: null,
      detached: false,
      bare: false,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
      isMain: index === 0,
    };

    for (const rawLine of block.split('\n')) {
      const line = rawLine.trimEnd();
      if (line.startsWith('worktree ')) {
        wt.path = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        wt.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        wt.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        wt.detached = true;
      } else if (line === 'bare') {
        wt.bare = true;
      } else if (line.startsWith('locked')) {
        wt.locked = true;
        wt.lockedReason = line.slice('locked'.length).trim() || null;
      } else if (line.startsWith('prunable')) {
        wt.prunable = true;
        wt.prunableReason = line.slice('prunable'.length).trim() || null;
      }
    }

    if (!wt.path) return;
    wt.name = wt.branch || (wt.head ? `detached@${wt.head.slice(0, 7)}` : path.basename(wt.path));
    result.push(wt);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Worktree status
// ---------------------------------------------------------------------------

// Parse `git status --porcelain=v2 --branch` output: one call gives us the
// changed-file count, the upstream and the ahead/behind counts.
export function parseStatusV2(output: string): WorktreeStatus {
  const status: WorktreeStatus = { dirty: false, changedFiles: 0, ahead: null, behind: null, upstream: null };
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        status.ahead = parseInt(m[1], 10);
        status.behind = parseInt(m[2], 10);
      }
    } else if (!line.startsWith('#')) {
      status.changedFiles++;
    }
  }
  status.dirty = status.changedFiles > 0;
  return status;
}

export async function getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  try {
    const { stdout } = await execAsync('git status --porcelain=v2 --branch --untracked-files=normal', {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseStatusV2(stdout);
  } catch {
    return { dirty: false, changedFiles: 0, ahead: null, behind: null, upstream: null };
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListWorktreesOptions {
  includeStatus?: boolean;
  includePullRequests?: boolean;
  // Reuse cached pull request data younger than this (seconds). 0 forces a fresh lookup.
  pullRequestMaxAge?: number;
  cwd?: string;
}

export type PullRequestLookup = 'github' | 'gitlab' | 'unavailable' | 'skipped';

export interface WorktreeListing {
  repoRoot: string;
  currentPath: string | null;
  pullRequestLookup: PullRequestLookup;
  pullRequestsFromCache: boolean;
  worktrees: WorktreeInfo[];
}

// One git call for both the current worktree root and the main worktree root
async function getRepoPaths(cwd: string): Promise<{ currentPath: string; repoRoot: string }> {
  let stdout: string;
  try {
    ({ stdout } = await execAsync('git rev-parse --path-format=absolute --show-toplevel --git-common-dir', { cwd }));
  } catch {
    throw new Error('Not a git repository');
  }
  const [currentPath, commonDir] = stdout.trim().split('\n').map(l => l.trim());
  const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return { currentPath, repoRoot };
}

export async function listWorktreesDetailed(options: ListWorktreesOptions = {}): Promise<WorktreeListing> {
  const cwd = options.cwd || process.cwd();
  const includePullRequests = options.includePullRequests === true;

  // Independent work runs concurrently: worktree list, repo paths, PR lookup
  const [porcelain, paths, prResult] = await Promise.all([
    execAsync('git worktree list --porcelain', { cwd, maxBuffer: 10 * 1024 * 1024 }).then(r => r.stdout),
    getRepoPaths(cwd),
    includePullRequests
      ? fetchPullRequestsCached(cwd, options.pullRequestMaxAge)
      : Promise.resolve<PullRequestFetchResult>({ provider: null, pullRequests: null, fromCache: false }),
  ]);

  const parsed = parseWorktreeList(porcelain);
  const sessions = loadActiveSessions();

  const worktrees: WorktreeInfo[] = await Promise.all(
    parsed.map(async wt => {
      const exists = fs.existsSync(wt.path);
      const info: WorktreeInfo = {
        ...wt,
        exists,
        sessions: sessions.filter(s => samePath(s.path, wt.path)),
        isCurrent: samePath(paths.currentPath, wt.path),
      };
      if (options.includeStatus !== false && exists && !wt.bare) {
        info.status = await getWorktreeStatus(wt.path);
      }
      if (includePullRequests) {
        info.pullRequest = prResult.pullRequests && wt.branch ? pickPullRequest(prResult.pullRequests, wt.branch) : null;
      }
      return info;
    })
  );

  return {
    repoRoot: paths.repoRoot,
    currentPath: paths.currentPath,
    pullRequestLookup: !includePullRequests ? 'skipped' : prResult.pullRequests ? prResult.provider || 'github' : 'unavailable',
    pullRequestsFromCache: prResult.fromCache,
    worktrees,
  };
}

export async function listWorktrees(options: ListWorktreesOptions = {}): Promise<WorktreeInfo[]> {
  return (await listWorktreesDetailed(options)).worktrees;
}

// Resolve a user supplied target (path, branch name or worktree name) to a worktree
export async function findWorktree(target: string, cwd?: string): Promise<WorktreeInfo | null> {
  const worktrees = await listWorktrees({ includeStatus: false, cwd });
  const byBranch = worktrees.find(wt => wt.branch === target || wt.name === target);
  if (byBranch) return byBranch;
  const candidate = path.resolve(cwd || process.cwd(), target);
  return worktrees.find(wt => samePath(wt.path, candidate)) || null;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

// Reduce a GitHub statusCheckRollup array to a single state
export function summarizeChecks(rollup: any[] | null | undefined): ChecksState | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let pending = false;
  for (const check of rollup) {
    // CheckRun: { status, conclusion }; StatusContext: { state }
    const conclusion = String(check?.conclusion || check?.state || '').toUpperCase();
    const status = String(check?.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) {
      return 'failure';
    }
    if (status && status !== 'COMPLETED') pending = true;
    else if (!conclusion || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING'].includes(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'success';
}

// Prefer an open PR; otherwise the most recently updated one for the branch
export function pickPullRequest(prs: PullRequestInfo[], branch: string): PullRequestInfo | null {
  const forBranch = prs.filter(pr => pr.headBranch === branch);
  if (forBranch.length === 0) return null;
  const open = forBranch.find(pr => pr.state === 'open');
  if (open) return open;
  return forBranch.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
}

const GH_FIELDS = 'number,title,state,url,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt';

async function fetchGitHubPullRequests(cwd: string): Promise<PullRequestInfo[] | null> {
  try {
    const { stdout } = await execAsync(`gh pr list --state all --limit 200 --json ${GH_FIELDS}`, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    const rows = JSON.parse(stdout || '[]');
    if (!Array.isArray(rows)) return null;
    return rows.map((r: any) => ({
      provider: 'github' as const,
      number: r.number,
      title: r.title || '',
      state: String(r.state || '').toLowerCase() as PullRequestState,
      url: r.url,
      draft: !!r.isDraft,
      baseBranch: r.baseRefName || null,
      headBranch: r.headRefName,
      reviewDecision: r.reviewDecision || null,
      checks: summarizeChecks(r.statusCheckRollup),
      updatedAt: r.updatedAt || null,
    }));
  } catch {
    return null; // gh missing, not authenticated, or not a GitHub remote
  }
}

async function fetchGitLabPullRequests(cwd: string): Promise<PullRequestInfo[] | null> {
  try {
    const { stdout } = await execAsync('glab mr list --all --per-page 100 --output json', {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout || '[]');
    if (!Array.isArray(rows)) return null;
    return rows.map((r: any) => ({
      provider: 'gitlab' as const,
      number: r.iid,
      title: r.title || '',
      state: (r.state === 'opened' ? 'open' : r.state === 'merged' ? 'merged' : 'closed') as PullRequestState,
      url: r.web_url,
      draft: !!(r.draft || r.work_in_progress),
      baseBranch: r.target_branch || null,
      headBranch: r.source_branch,
      reviewDecision: null,
      checks: r.head_pipeline?.status === 'success' ? 'success'
        : r.head_pipeline?.status === 'failed' ? 'failure'
        : r.head_pipeline?.status ? 'pending' : null,
      updatedAt: r.updated_at || null,
    }));
  } catch {
    return null;
  }
}

async function detectProvider(cwd: string): Promise<'github' | 'gitlab' | null> {
  try {
    const { stdout } = await execAsync('git config --get remote.origin.url', { cwd });
    const url = stdout.trim().toLowerCase();
    if (url.includes('github.com')) return 'github';
    if (url.includes('gitlab')) return 'gitlab';
    return null;
  } catch {
    return null;
  }
}

export interface PullRequestFetchResult {
  provider: 'github' | 'gitlab' | null;
  pullRequests: PullRequestInfo[] | null;
  fromCache: boolean;
}

// Fetch every PR/MR of the repository in one call so listing stays fast.
// Returns null pullRequests when no provider CLI is available.
export async function fetchPullRequests(cwd: string = process.cwd()): Promise<PullRequestFetchResult> {
  const provider = await detectProvider(cwd);
  if (provider === 'gitlab') {
    return { provider, pullRequests: await fetchGitLabPullRequests(cwd), fromCache: false };
  }
  if (provider === 'github') {
    return { provider, pullRequests: await fetchGitHubPullRequests(cwd), fromCache: false };
  }
  // Unknown host (e.g. GitHub Enterprise): try both
  const github = await fetchGitHubPullRequests(cwd);
  if (github) return { provider: 'github', pullRequests: github, fromCache: false };
  const gitlab = await fetchGitLabPullRequests(cwd);
  return { provider: gitlab ? 'gitlab' : null, pullRequests: gitlab, fromCache: false };
}

// ---- on-disk cache so repeated listings (editor refreshes) don't hit the network

export const PR_CACHE_FILE = 'pr-cache.json';
export const DEFAULT_PR_MAX_AGE_SECONDS = 60;

interface PullRequestCacheEntry {
  fetchedAt: number;
  provider: 'github' | 'gitlab' | null;
  pullRequests: PullRequestInfo[] | null;
}

export function getPullRequestCachePath(): string {
  return path.join(getGlobalKunjDir(), PR_CACHE_FILE);
}

function readPullRequestCache(): Record<string, PullRequestCacheEntry> {
  try {
    const file = getPullRequestCachePath();
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writePullRequestCache(cache: Record<string, PullRequestCacheEntry>): void {
  try {
    initGlobalKunjDirectory();
    const file = getPullRequestCachePath();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {
    // cache is best effort
  }
}

async function pullRequestCacheKey(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --path-format=absolute --git-common-dir', { cwd });
    return normalizePath(stdout.trim());
  } catch {
    return normalizePath(cwd);
  }
}

// Exposed for testing: decide whether a cache entry is still usable
export function isCacheFresh(entry: PullRequestCacheEntry | undefined, maxAgeSeconds: number, now = Date.now()): boolean {
  if (!entry || maxAgeSeconds <= 0) return false;
  return now - entry.fetchedAt < maxAgeSeconds * 1000;
}

export async function fetchPullRequestsCached(
  cwd: string = process.cwd(),
  maxAgeSeconds: number = DEFAULT_PR_MAX_AGE_SECONDS
): Promise<PullRequestFetchResult> {
  const key = await pullRequestCacheKey(cwd);
  const cache = readPullRequestCache();
  const entry = cache[key];
  if (isCacheFresh(entry, maxAgeSeconds)) {
    return { provider: entry.provider, pullRequests: entry.pullRequests, fromCache: true };
  }

  const result = await fetchPullRequests(cwd);

  // Failed lookups are cached too (briefly, via the same TTL) so a missing
  // gh/glab does not cost a subprocess on every refresh.
  const pruned: Record<string, PullRequestCacheEntry> = {};
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(cache)) if (v.fetchedAt > cutoff) pruned[k] = v;
  pruned[key] = { fetchedAt: Date.now(), provider: result.provider, pullRequests: result.pullRequests };
  writePullRequestCache(pruned);
  return result;
}

// Look up the PR for a single branch
export async function getPullRequestForBranch(branch: string, cwd?: string, maxAgeSeconds = 0): Promise<PullRequestInfo | null> {
  const { pullRequests } = await fetchPullRequestsCached(cwd, maxAgeSeconds);
  return pullRequests ? pickPullRequest(pullRequests, branch) : null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface AddWorktreeOptions {
  branch: string;
  path: string;
  newBranch?: boolean;
  base?: string;
  force?: boolean;
  cwd?: string;
}

export async function addWorktree(options: AddWorktreeOptions): Promise<{ path: string; branch: string }> {
  const args = ['git', 'worktree', 'add'];
  if (options.force) args.push('--force');
  if (options.newBranch) {
    args.push('-b', quote(options.branch), quote(options.path));
    if (options.base) args.push(quote(options.base));
  } else {
    args.push(quote(options.path), quote(options.branch));
  }
  fs.mkdirSync(path.dirname(options.path), { recursive: true });
  await execAsync(args.join(' '), { cwd: options.cwd || process.cwd() });
  return { path: options.path, branch: options.branch };
}

export async function removeWorktree(worktreePath: string, force = false, cwd?: string): Promise<void> {
  const args = ['git', 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(quote(worktreePath));
  await execAsync(args.join(' '), { cwd: cwd || process.cwd() });
}

export async function pruneWorktrees(cwd?: string): Promise<string> {
  const { stdout } = await execAsync('git worktree prune -v', { cwd: cwd || process.cwd() });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Editor sessions
// ---------------------------------------------------------------------------

export function getSessionsPath(): string {
  return path.join(getGlobalKunjDir(), WORKTREE_SESSIONS_FILE);
}

interface SessionsFile {
  sessions: WorktreeSession[];
}

function readSessionsFile(): SessionsFile {
  try {
    const file = getSessionsPath();
    if (!fs.existsSync(file)) return { sessions: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { sessions: Array.isArray(data?.sessions) ? data.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

function writeSessionsFile(data: SessionsFile): void {
  initGlobalKunjDirectory();
  const file = getSessionsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but belongs to another user
    return error?.code === 'EPERM';
  }
}

// Decide whether a session is still alive. Exposed for testing.
export function isSessionAlive(
  session: WorktreeSession,
  now: number = Date.now(),
  host: string = os.hostname(),
  aliveCheck: (pid: number) => boolean = isProcessAlive
): boolean {
  if (session.host === host) {
    return aliveCheck(session.pid);
  }
  const lastSeen = Date.parse(session.lastSeen || session.registeredAt);
  return !Number.isNaN(lastSeen) && now - lastSeen < SESSION_STALE_MS;
}

// Load sessions, dropping (and persisting the removal of) dead ones
export function loadActiveSessions(): WorktreeSession[] {
  const data = readSessionsFile();
  const alive = data.sessions.filter(s => isSessionAlive(s));
  if (alive.length !== data.sessions.length) {
    try {
      writeSessionsFile({ sessions: alive });
    } catch {
      // best effort
    }
  }
  return alive;
}

export interface RegisterSessionOptions {
  path: string;
  pid: number;
  editor?: string;
  label?: string;
  id?: string;
}

function makeSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Register (or refresh) an editor session. A session is identified by
// (host, pid, path) so calling this repeatedly acts as a heartbeat.
export function registerSession(options: RegisterSessionOptions): WorktreeSession {
  const host = os.hostname();
  const normalized = normalizePath(options.path);
  const now = new Date().toISOString();
  const data = readSessionsFile();
  const alive = data.sessions.filter(s => isSessionAlive(s));

  let session = alive.find(
    s => (options.id && s.id === options.id) || (s.host === host && s.pid === options.pid && samePath(s.path, normalized))
  );

  if (session) {
    session.lastSeen = now;
    session.path = normalized;
    if (options.editor) session.editor = options.editor;
    if (options.label !== undefined) session.label = options.label;
  } else {
    session = {
      id: options.id || makeSessionId(),
      path: normalized,
      pid: options.pid,
      host,
      editor: options.editor || 'unknown',
      label: options.label,
      registeredAt: now,
      lastSeen: now,
    };
    alive.push(session);
  }

  writeSessionsFile({ sessions: alive });
  return session;
}

export interface UnregisterSessionOptions {
  id?: string;
  pid?: number;
  path?: string;
}

// Remove sessions matching the given criteria. Returns number removed.
export function unregisterSession(options: UnregisterSessionOptions): number {
  const host = os.hostname();
  const data = readSessionsFile();
  const before = data.sessions.length;
  const remaining = data.sessions.filter(s => {
    if (options.id) return s.id !== options.id;
    if (options.pid !== undefined) {
      const pidMatch = s.host === host && s.pid === options.pid;
      if (!pidMatch) return true;
      return options.path ? !samePath(s.path, options.path) : false;
    }
    if (options.path) return !samePath(s.path, options.path);
    return true;
  });
  writeSessionsFile({ sessions: remaining.filter(s => isSessionAlive(s)) });
  return before - remaining.length;
}
