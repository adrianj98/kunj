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

export type ParsedWorktree = Omit<WorktreeInfo, 'sessions' | 'isCurrent' | 'exists' | 'status'>;

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

export async function getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  const status: WorktreeStatus = { dirty: false, changedFiles: 0, ahead: null, behind: null, upstream: null };

  try {
    const { stdout } = await execAsync('git status --porcelain --untracked-files=normal', {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = stdout.split('\n').filter(l => l.trim());
    status.changedFiles = lines.length;
    status.dirty = lines.length > 0;
  } catch {
    // leave defaults
  }

  try {
    const { stdout: upstream } = await execAsync('git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', {
      cwd: worktreePath,
    });
    status.upstream = upstream.trim() || null;
    if (status.upstream) {
      const { stdout } = await execAsync('git rev-list --left-right --count HEAD...@{upstream}', {
        cwd: worktreePath,
      });
      const [ahead, behind] = stdout.trim().split(/\s+/).map(n => parseInt(n, 10));
      status.ahead = Number.isNaN(ahead) ? null : ahead;
      status.behind = Number.isNaN(behind) ? null : behind;
    }
  } catch {
    // no upstream configured
  }

  return status;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListWorktreesOptions {
  includeStatus?: boolean;
  cwd?: string;
}

export async function listWorktrees(options: ListWorktreesOptions = {}): Promise<WorktreeInfo[]> {
  const cwd = options.cwd || process.cwd();
  const { stdout } = await execAsync('git worktree list --porcelain', { cwd, maxBuffer: 10 * 1024 * 1024 });
  const parsed = parseWorktreeList(stdout);
  const sessions = loadActiveSessions();
  const currentPath = await getCurrentWorktreePath(cwd);

  const worktrees: WorktreeInfo[] = await Promise.all(
    parsed.map(async wt => {
      const exists = fs.existsSync(wt.path);
      const info: WorktreeInfo = {
        ...wt,
        exists,
        sessions: sessions.filter(s => samePath(s.path, wt.path)),
        isCurrent: currentPath !== null && samePath(currentPath, wt.path),
      };
      if (options.includeStatus !== false && exists && !wt.bare) {
        info.status = await getWorktreeStatus(wt.path);
      }
      return info;
    })
  );

  return worktrees;
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
