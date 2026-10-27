// Searching a repository for `kunj search`: file contents of its worktrees, of branches without a
// worktree and of its running branch containers (all through `git grep`), commit messages
// (`git log --grep`) and the work logs. On the fast path: no heavy imports.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ContainerBackend } from './container/backend';

export const SEARCH_SCOPES = ['worktrees', 'branches', 'containers', 'commits', 'logs'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export interface SearchQuery {
  pattern: string;
  ignoreCase: boolean;
  /** The pattern is a fixed string, not an extended regex */
  fixed: boolean;
  /** Match whole words only */
  word: boolean;
  /** Pathspecs limiting the files searched (git grep scopes only) */
  paths: string[];
  /** Matches kept per worktree, branch or container, and commits and log lines kept in all */
  maxCount: number;
}

export interface GrepMatch {
  path: string;
  /** 1-based */
  line: number;
  /** 1-based, in characters, of the first match on the line */
  column: number;
  /** Length of that match in characters (0 when it could not be told) */
  length: number;
  /** The line, cut to MAX_TEXT characters */
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** More matches than maxCount were found */
  truncated: boolean;
  error?: string;
}

const MAX_TEXT = 400;
const GREP_TIMEOUT_MS = 60_000;

/**
 * `git grep` arguments (without `git`) for the query: `-z` so a path is printed verbatim and ends at a
 * NUL, as `[<rev>:]<path>\0<line>\0<column>\0<text>`. `-I` skips binary files. `untracked` adds the
 * untracked files that are not ignored, i.e. the work not yet committed in a worktree.
 */
export function grepArgs(q: SearchQuery, opts: { revs?: string[]; untracked?: boolean } = {}): string[] {
  const args = ['grep', '-n', '--column', '-z', '-I', '--no-color'];
  if (opts.untracked) args.push('--untracked');
  if (q.ignoreCase) args.push('-i');
  if (q.word) args.push('-w');
  args.push(q.fixed ? '-F' : '-E', '-e', q.pattern, ...(opts.revs ?? []), '--', ...q.paths);
  return args;
}

/** A RegExp for the query (global), to find the match's column and length and to highlight it; null when JS cannot read the pattern */
export function searchRegExp(q: Pick<SearchQuery, 'pattern' | 'ignoreCase' | 'fixed' | 'word'>): RegExp | null {
  let source = q.fixed ? q.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : posixClasses(q.pattern);
  if (q.word) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, q.ignoreCase ? 'giu' : 'gu');
  } catch {
    return null;
  }
}

// The POSIX bracket classes an extended regex may use, as JS has them
function posixClasses(pattern: string): string {
  const classes: Record<string, string> = {
    alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z',
    space: '\\s', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w',
  };
  return pattern.replace(/\[:(\w+):\]/g, (m, name: string) => classes[name] ?? m);
}

/** Where the first match on a line is (1-based column, length), from the RegExp, else git's column */
export function locate(text: string, re: RegExp | null, gitColumn: number): { column: number; length: number } {
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return { column: Array.from(text.slice(0, m.index)).length + 1, length: Array.from(m[0]).length };
  }
  return { column: gitColumn || 1, length: 0 };
}

function cut(text: string): string {
  const chars = Array.from(text.replace(/\r$/, ''));
  return chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT).join('') + '…' : chars.join('');
}

interface GrepRecord {
  /** The rev prefix when revs were searched */
  rev?: string;
  path: string;
  line: number;
  column: number;
  text: string;
}

/**
 * Parse `git grep -n --column -z` output. With revs, each path is prefixed by one of them and a `:`;
 * the rev is matched against the list (a path may contain `:`, a branch name may not).
 */
export function parseGrepOutput(output: string, revs: string[] = []): GrepRecord[] {
  const records: GrepRecord[] = [];
  for (const raw of output.split('\n')) {
    const record = parseGrepLine(raw, revs);
    if (record) records.push(record);
  }
  return records;
}

function parseGrepLine(raw: string, revs: string[]): GrepRecord | null {
  const parts = raw.split('\0');
  if (parts.length < 4) return null;
  let file = parts[0];
  let rev: string | undefined;
  if (revs.length) {
    rev = revs.find(r => file.startsWith(r + ':'));
    if (rev === undefined) return null;
    file = file.slice(rev.length + 1);
  }
  const line = Number(parts[1]);
  if (!file || !Number.isInteger(line)) return null;
  return { rev, path: file, line, column: Number(parts[2]) || 1, text: parts.slice(3).join('\0') };
}

function toMatch(r: GrepRecord, re: RegExp | null): GrepMatch {
  const text = cut(r.text);
  return { path: r.path, line: r.line, ...locate(r.text, re, r.column), text };
}

/**
 * Run `git <args>` in `cwd` and collect the records, `limit` per rev (or in all without revs). git
 * grep exits 1 when nothing matched; anything above that is an error. The process is ended once every
 * rev (the one key '' without revs) has more than `limit`: a rev's own cap never cuts another's.
 */
function runGrep(cwd: string, args: string[], revs: string[], limit: number): Promise<{ byRev: Map<string, GrepRecord[]>; truncated: Set<string>; error?: string }> {
  const keys = revs.length || 1;
  return new Promise(resolve => {
    const byRev = new Map<string, GrepRecord[]>();
    const truncated = new Set<string>();
    let buffer = '';
    let stderr = '';
    let stopped = false;
    let settled = false;
    const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => stop(), GREP_TIMEOUT_MS);
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ byRev, truncated, error });
    };
    const stop = () => {
      stopped = true;
      child.kill();
    };
    const take = (raw: string) => {
      const record = parseGrepLine(raw, revs);
      if (!record) return;
      const key = record.rev ?? '';
      const list = byRev.get(key) ?? [];
      byRev.set(key, list);
      if (list.length >= limit) {
        truncated.add(key);
        if (truncated.size >= keys) stop();
      } else {
        list.push(record);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      buffer += chunk;
      let nl: number;
      while (!stopped && (nl = buffer.indexOf('\n')) !== -1) {
        take(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', e => finish(e.message));
    child.on('close', code => {
      if (stopped) {
        // Every rev full: what was read stands. Else the timeout: every rev may have lost matches
        if (truncated.size >= keys) return finish();
        for (const key of byRev.keys()) truncated.add(key);
        return finish(`git grep did not finish within ${GREP_TIMEOUT_MS / 1000}s`);
      }
      if (buffer) take(buffer);
      finish(code === 0 || code === 1 ? undefined : stderr.trim().split('\n')[0] || `git grep exited with ${code}`);
    });
  });
}

/** One worktree's files, the uncommitted and untracked (not ignored) ones included */
export async function grepWorktree(worktreePath: string, q: SearchQuery): Promise<GrepResult> {
  const re = searchRegExp(q);
  const r = await runGrep(worktreePath, grepArgs(q, { untracked: true }), [], q.maxCount);
  return { matches: (r.byRev.get('') ?? []).map(m => toMatch(m, re)), truncated: r.truncated.size > 0, error: r.error };
}

/** The committed trees of several refs in one git call, keyed by ref */
export async function grepRefs(cwd: string, refs: string[], q: SearchQuery): Promise<{ results: Map<string, GrepResult>; error?: string }> {
  const results = new Map<string, GrepResult>();
  if (refs.length === 0) return { results };
  const re = searchRegExp(q);
  const r = await runGrep(cwd, grepArgs(q, { revs: refs }), refs, q.maxCount);
  for (const ref of refs) {
    const found = r.byRev.get(ref);
    if (found) results.set(ref, { matches: found.map(m => toMatch(m, re)), truncated: r.truncated.has(ref) });
  }
  return { results, error: r.error };
}

/**
 * /workspace of a running branch container, as its sandbox user. The output is cut in the
 * container (`head`) so a common pattern does not stream megabytes over a remote backend.
 */
export async function grepContainer(backend: ContainerBackend, id: string, user: string | undefined, q: SearchQuery, signal?: AbortSignal): Promise<GrepResult> {
  const re = searchRegExp(q);
  const git = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...grepArgs(q, { untracked: true })];
  // `sh -c` gets the line limit as $0 and git's argv as "$@": nothing from the query is parsed by the
  // shell. The pipeline's status is head's, so git's own is printed past head on fd 3 (a line the
  // parser skips: it has no NUL).
  const script = '{ { "$@"; echo "kunj-grep-exit=$?" >&3; } | head -n "$0"; } 3>&1';
  const r = await backend.exec(id, ['sh', '-c', script, String(q.maxCount + 1), ...git], {
    user,
    workdir: '/workspace',
    timeoutMs: GREP_TIMEOUT_MS,
    signal,
  });
  const status = Number(/kunj-grep-exit=(\d+)/.exec(r.stdout)?.[1] ?? r.exitCode);
  // 1: nothing matched; above 128: git was ended by head closing the pipe (SIGPIPE)
  if (r.exitCode !== 0 || (status > 1 && status <= 128)) {
    return { matches: [], truncated: false, error: `git grep failed in the container (exit ${status || r.exitCode})` };
  }
  const records = parseGrepOutput(r.stdout);
  return {
    matches: records.slice(0, q.maxCount).map(m => toMatch(m, re)),
    truncated: records.length > q.maxCount,
  };
}

// ---- branches without a worktree ------------------------------------------------------------

export interface BranchRef {
  /** The branch name (without origin/ for a remote one) */
  branch: string;
  /** The full ref searched, e.g. refs/heads/x or refs/remotes/origin/x */
  ref: string;
  remote: boolean;
}

/**
 * The branches to search in the branches scope from `git for-each-ref --format=%(refname)` output:
 * local branches without a worktree, and with `remote`, origin's branches with neither a worktree nor
 * a local branch of that name.
 */
export function branchRefs(refnames: string, worktreeBranches: Set<string>, remote: boolean): BranchRef[] {
  const local = new Set<string>();
  const refs: BranchRef[] = [];
  const lines = refnames.split('\n').map(l => l.trim()).filter(Boolean);
  for (const ref of lines) {
    if (!ref.startsWith('refs/heads/')) continue;
    const branch = ref.slice('refs/heads/'.length);
    local.add(branch);
    if (!worktreeBranches.has(branch)) refs.push({ branch, ref, remote: false });
  }
  if (remote) {
    for (const ref of lines) {
      if (!ref.startsWith('refs/remotes/origin/')) continue;
      const branch = ref.slice('refs/remotes/origin/'.length);
      if (branch === 'HEAD' || local.has(branch) || worktreeBranches.has(branch)) continue;
      refs.push({ branch, ref, remote: true });
    }
  }
  return refs;
}

export function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c: string) => { err += c; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n')[0] || `git ${args[0]} exited with ${code}`))));
  });
}

// ---- commit messages -------------------------------------------------------------------------

export interface CommitMatch {
  sha: string;
  author: string;
  /** Author date, ISO 8601 */
  date: string;
  subject: string;
  /** The first message line that matched (1 is the subject) */
  line: number;
  column: number;
  length: number;
  text: string;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** `git log` arguments for commit messages matching the query on all branches (or the given ones) */
export function commitLogArgs(q: SearchQuery, branches: string[]): string[] {
  const args = ['log', `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%B${RECORD}`, `--grep=${q.pattern}`, q.fixed ? '--fixed-strings' : '--extended-regexp'];
  if (q.ignoreCase) args.push('--regexp-ignore-case');
  // -w has no git log equivalent: those are filtered here, so ask for more
  args.push(`--max-count=${q.word ? q.maxCount * 4 : q.maxCount}`);
  if (branches.length) args.push(...branches, '--');
  else args.push('--branches', '--remotes=origin', '--');
  return args;
}

/** Parse commitLogArgs output; drops a commit whose message the RegExp does not match (the -w filter) */
export function parseCommitLog(output: string, re: RegExp | null, max: number, filter: boolean): CommitMatch[] {
  const commits: CommitMatch[] = [];
  for (const record of output.split(RECORD)) {
    const [sha, author, date, body] = record.replace(/^\n/, '').split(FIELD);
    if (!sha || body === undefined) continue;
    const lines = body.replace(/\n+$/, '').split('\n');
    let hit: CommitMatch | null = null;
    for (let i = 0; i < lines.length && !hit; i++) {
      if (!re) break;
      re.lastIndex = 0;
      if (re.test(lines[i])) hit = { sha, author, date, subject: lines[0], line: i + 1, ...locate(lines[i], re, 1), text: cut(lines[i]) };
    }
    if (!hit && filter) continue;
    commits.push(hit ?? { sha, author, date, subject: lines[0], line: 1, column: 1, length: 0, text: cut(lines[0]) });
    if (commits.length >= max) break;
  }
  return commits;
}

export async function searchCommits(cwd: string, q: SearchQuery, branches: string[]): Promise<CommitMatch[]> {
  const re = searchRegExp(q);
  const output = await gitOutput(cwd, commitLogArgs(q, branches));
  return parseCommitLog(output, re, q.maxCount, q.word);
}

// ---- work logs -------------------------------------------------------------------------------

export interface LogMatch {
  /** The log's date (its file name, YYYY-MM-DD) */
  date: string;
  file: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

/** Lines of the work logs (`<dir>/*.md`), newest log first */
export function searchWorkLogs(dir: string, q: SearchQuery): LogMatch[] {
  const re = searchRegExp(q);
  if (!re) throw new Error(`The pattern cannot be used to search the work logs: ${q.pattern}`);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
  const found: LogMatch[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      found.push({ date: name.slice(0, -3), file, line: i + 1, ...locate(lines[i], re, 1), text: cut(lines[i]) });
      if (found.length >= q.maxCount) return found;
    }
  }
  return found;
}

/** Run `fn` over `items`, at most `limit` at a time, results in order */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
