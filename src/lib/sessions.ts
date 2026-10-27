// kunj's tmux sessions, for `kunj sessions` and the workspace app's Sessions window: which worktree or
// container each belongs to, what is attached to it, its CPU and memory, and whether it is orphaned.
//
// One shell call (SESSIONS_SCRIPT) gives everything: tmux's sessions, panes and clients, and `ps`.
// The same script runs on the host and, as the sandbox user, in each running container.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { SESSION_WORKTREE_OPTION, agentSessionName, shellSessionName } from './agent-session';
import { dockerSafe } from './container/names';
import { repoIdentity } from './repo-identity';
import { listRepos } from './repos';
import { parseWorktreeList } from './worktree';
import type { SessionAttachJson, SessionsJson, TmuxSessionJson } from './json-types';

const execFileAsync = promisify(execFile);

export const DEFAULT_IDLE_HOURS = 24;

// A real tab inside the single quotes: tmux formats do not expand \t
const T = '\t';
// tmux=missing when there is no tmux; tmux=ok with no lines when it has no server. ps is last and
// optional (an image without procps gives no usage). comm is the last column: it may hold spaces.
export const SESSIONS_SCRIPT = [
  `if ! command -v tmux >/dev/null 2>&1; then echo tmux=missing; exit 0; fi`,
  `echo tmux=ok`,
  `echo '#sessions'; tmux list-sessions -F '#{session_name}${T}#{session_created}${T}#{session_activity}${T}#{${SESSION_WORKTREE_OPTION}}' 2>/dev/null`,
  `echo '#panes'; tmux list-panes -a -F '#{session_name}${T}#{pane_pid}${T}#{pane_current_command}${T}#{pane_current_path}' 2>/dev/null`,
  `echo '#clients'; tmux list-clients -F '#{session_name}${T}#{client_tty}${T}#{client_pid}' 2>/dev/null`,
  `echo '#ps'; ps -axo pid=,ppid=,pcpu=,rss=,comm= 2>/dev/null`,
  `true`,
].join('; ');

export interface RawSession {
  name: string;
  createdAt: string | null;
  lastActivityAt: string | null;
  /** The @kunj_worktree tag kunj sets on host sessions it starts; null on older ones */
  worktreeTag: string | null;
  panes: Array<{ pid: number; command: string; cwd: string }>;
  clients: Array<{ tty: string; pid: number }>;
}

export interface Proc {
  ppid: number;
  cpu: number;
  rssKb: number;
  comm: string;
}

export interface SessionsSnapshot {
  tmux: 'ok' | 'missing';
  sessions: RawSession[];
  procs: Map<number, Proc> | null;
}

const epoch = (s: string | undefined): string | null => {
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** Parse SESSIONS_SCRIPT's output. */
export function parseSessionsOutput(stdout: string): SessionsSnapshot {
  const lines = stdout.split('\n');
  if (lines[0]?.trim() === 'tmux=missing') return { tmux: 'missing', sessions: [], procs: null };
  const byName = new Map<string, RawSession>();
  const procs = new Map<number, Proc>();
  let sawPs = false;
  let section = '';
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('#') && /^#(sessions|panes|clients|ps)$/.test(line)) {
      section = line.slice(1);
      if (section === 'ps') sawPs = true;
      continue;
    }
    if (!line.trim()) continue;
    if (section === 'ps') {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s?(.*)$/.exec(line);
      if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), cpu: parseFloat(m[3]) || 0, rssKb: Number(m[4]), comm: m[5] ?? '' });
      continue;
    }
    const f = line.split('\t');
    if (section === 'sessions' && f[0]) {
      byName.set(f[0], { name: f[0], createdAt: epoch(f[1]), lastActivityAt: epoch(f[2]), worktreeTag: f[3] || null, panes: [], clients: [] });
    } else if (section === 'panes') {
      const s = byName.get(f[0]);
      const pid = Number(f[1]);
      if (s && pid > 0) s.panes.push({ pid, command: f[2] ?? '', cwd: f[3] ?? '' });
    } else if (section === 'clients') {
      const s = byName.get(f[0]);
      const pid = Number(f[2]);
      if (s && pid > 0) s.clients.push({ tty: f[1] ?? '', pid });
    }
  }
  return { tmux: 'ok', sessions: [...byName.values()], procs: sawPs && procs.size ? procs : null };
}

/** CPU% and resident memory of the process trees rooted at `roots`, each process counted once. */
export function treeUsage(roots: number[], procs: Map<number, Proc>): { cpu: number; memoryBytes: number } | null {
  const children = new Map<number, number[]>();
  for (const [pid, p] of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(pid);
    else children.set(p.ppid, [pid]);
  }
  const seen = new Set<number>();
  const stack = roots.filter(pid => procs.has(pid));
  if (!stack.length) return null;
  let cpu = 0;
  let kb = 0;
  while (stack.length) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = procs.get(pid);
    if (!p) continue;
    cpu += p.cpu;
    kb += p.rssKb;
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return { cpu: Math.round(cpu * 10) / 10, memoryBytes: kb * 1024 };
}

// What a client runs inside: the nearest ancestor that is not tmux or a shell (the app, Terminal,
// iTerm2, VS Code), by its command's basename; null when ps is unknown
const SKIP_ANCESTOR = /^-?(tmux|zsh|bash|sh|fish|login|node|kunj|env)$/;
export function clientVia(pid: number, procs: Map<number, Proc> | null): string | null {
  if (!procs) return null;
  let cur = procs.get(pid)?.ppid;
  for (let i = 0; cur && cur > 1 && i < 12; i++) {
    const p = procs.get(cur);
    if (!p) return null;
    const comm = p.comm.trim();
    const app = /\/([^/]+)\.app\//.exec(comm);
    if (app) return app[1];
    const base = path.basename(comm);
    if (base && !SKIP_ANCESTOR.test(base)) return base;
    cur = p.ppid;
  }
  return null;
}

/** A host session kunj named: `kunj-` agents and `kunjsh-` shells; the user's own sessions are left out. */
export function isKunjHostSession(name: string): boolean {
  return name.startsWith('kunj-') || name.startsWith('kunjsh-');
}

/** A container session kunj named: `agent`, `agent-<id>`, `sh-<id>`. */
export const CONTAINER_SESSION = /^(agent(?:-[A-Za-z0-9_-]{1,32})?|sh-[A-Za-z0-9_-]{1,32})$/;

export interface ExpectedOwner {
  repo: { name: string; root: string };
  worktree: { path: string; branch: string | null };
  /** `kunj-…` default agent session name */
  agentBase: string;
  /** `kunjsh-…-sh-` prefix of its shells */
  shellPrefix: string;
}

/** The session names each worktree of each known repository would have; one git call per repository. */
export interface Owners {
  owners: ExpectedOwner[];
  repos: Array<{ name: string; root: string; prefix: string }>;
  /** Roots of repositories whose worktrees could not be listed: their sessions are never worktree-gone */
  unlisted: Set<string>;
}

export async function expectedOwners(): Promise<Owners> {
  const repos = listRepos().filter(r => r.exists);
  const owners: ExpectedOwner[] = [];
  const unlisted = new Set<string>();
  const prefixes: Array<{ name: string; root: string; prefix: string }> = [];
  await Promise.all(repos.map(async r => {
    const ident = repoIdentity({ commonDir: r.gitCommonDir, repoRoot: r.root });
    prefixes.push({ name: ident.name, root: r.root, prefix: `kunj-${dockerSafe(ident.name)}-` });
    let porcelain: string;
    try {
      ({ stdout: porcelain } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: r.gitCommonDir,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      unlisted.add(r.root);
      return;
    }
    for (const wt of parseWorktreeList(porcelain)) {
      if (wt.bare) continue;
      // `kunj worktree shell` names a detached worktree's shells after wt.name (detached@<sha>)
      const key = wt.branch || wt.name;
      owners.push({
        repo: { name: ident.name, root: r.root },
        worktree: { path: wt.path, branch: wt.branch },
        agentBase: agentSessionName(ident.name, ident.id, key),
        shellPrefix: shellSessionName(ident.name, ident.id, key, ''),
      });
    }
  }));
  return { owners, repos: prefixes, unlisted };
}

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export type HostOwner = Pick<TmuxSessionJson, 'kind' | 'id' | 'repo' | 'worktree'> & {
  /** Known to be gone: the tagged directory is missing, or no worktree of a listed repository has the name */
  gone: boolean;
};

/**
 * kind and id from a kunj host session's name, and the worktree it belongs to. The @kunj_worktree tag
 * wins: it names the worktree whatever branch is checked out there now, and a tagged directory that
 * still exists is never gone (git may spell the path differently). An untagged (older) session is
 * matched by the names its worktree's current branch would give; it is gone only when its repository's
 * worktrees were listed (a failed `git worktree list` never makes a live session an orphan).
 */
export function classifyHostSession(name: string, tag: string | null, o: Owners): HostOwner {
  const kind = name.startsWith('kunjsh-') ? ('shell' as const) : ('agent' as const);
  // After the name's 6-hex hash, so a branch that ends in -a (feature-a) is not read as an id
  const id = (kind === 'shell' ? /-[0-9a-f]{6}-sh-([A-Za-z0-9_-]{1,32})$/ : /-[0-9a-f]{6}-a-([A-Za-z0-9_-]{1,32})$/).exec(name)?.[1] ?? null;
  const tagReal = tag ? realpath(tag) : null;
  const owner = tag
    ? o.owners.find(w => w.worktree.path === tag || realpath(w.worktree.path) === tagReal)
    : o.owners.find(w => name === w.agentBase || name.startsWith(`${w.agentBase}-a-`) || name.startsWith(w.shellPrefix));
  if (owner) return { kind, id, repo: owner.repo, worktree: owner.worktree, gone: false };
  // The repository by the readable prefix; the longest wins (repo "app" vs "app-web")
  const agentName = kind === 'shell' ? name.replace(/^kunjsh-/, 'kunj-') : name;
  const r = o.repos.filter(x => agentName.startsWith(x.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const repo = r ? { name: r.name, root: r.root } : null;
  if (tag && fs.existsSync(tag)) return { kind, id, repo, worktree: { path: tag, branch: null }, gone: false };
  return { kind, id, repo, worktree: null, gone: !(repo && o.unlisted.has(repo.root)) };
}

function idleOrphan(s: RawSession, attached: number, idleHours: number, now: number): boolean {
  if (attached > 0 || !s.lastActivityAt) return false;
  return now - Date.parse(s.lastActivityAt) > idleHours * 3600 * 1000;
}

export function sessionJson(
  s: RawSession,
  procs: Map<number, Proc> | null,
  base: Pick<TmuxSessionJson, 'kind' | 'id' | 'repo' | 'worktree' | 'branch' | 'container'> & { gone?: boolean },
  idleHours: number,
  now: number
): TmuxSessionJson {
  const attached: SessionAttachJson[] = s.clients.map(c => ({ tty: c.tty, pid: c.pid, via: clientVia(c.pid, procs) }));
  const first = s.panes[0];
  // Never an orphan while a terminal is attached
  const orphan: TmuxSessionJson['orphan'] =
    attached.length > 0 ? null : base.gone ? 'worktree-gone' : idleOrphan(s, attached.length, idleHours, now) ? 'idle' : null;
  const { gone: _gone, ...owner } = base;
  return {
    name: s.name,
    ...owner,
    command: first?.command || null,
    cwd: first?.cwd || null,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    attached,
    usage: procs ? treeUsage(s.panes.map(p => p.pid), procs) : null,
    orphan,
  };
}

/** The host's kunj sessions. */
export async function hostSessions(idleHours: number, now = Date.now()): Promise<Pick<SessionsJson, 'tmux' | 'sessions'>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('sh', ['-c', SESSIONS_SCRIPT], { maxBuffer: 16 * 1024 * 1024, timeout: 10000 }));
  } catch {
    return { tmux: 'failed', sessions: [] };
  }
  const snap = parseSessionsOutput(stdout);
  if (snap.tmux === 'missing') return { tmux: 'missing', sessions: [] };
  const mine = snap.sessions.filter(s => isKunjHostSession(s.name));
  const owners: Owners = mine.length ? await expectedOwners() : { owners: [], repos: [], unlisted: new Set() };
  const sessions = mine.map(s => {
    const owner = classifyHostSession(s.name, s.worktreeTag, owners);
    return sessionJson(s, snap.procs, { ...owner, branch: owner.worktree?.branch ?? null, container: null }, idleHours, now);
  });
  return { tmux: 'ok', sessions: sortSessions(sessions) };
}

/** A container's kunj sessions, from SESSIONS_SCRIPT run in it. */
export function containerSessions(
  stdout: string,
  container: { name: string; repo: { name: string; root: string } | null; branch: string | null },
  idleHours: number,
  now = Date.now()
): { tmux: 'ok' | 'missing'; sessions: TmuxSessionJson[] } {
  const snap = parseSessionsOutput(stdout);
  const sessions = snap.sessions
    .filter(s => CONTAINER_SESSION.test(s.name))
    .map(s => {
      const kind = s.name.startsWith('sh-') ? ('shell' as const) : ('agent' as const);
      const id = kind === 'shell' ? s.name.slice(3) : s.name === 'agent' ? null : s.name.slice(6);
      // the branch it was created for; worktree stays null, and a container is never worktree-gone
      return sessionJson(s, snap.procs, { kind, id, repo: container.repo, worktree: null, branch: container.branch, container: container.name }, idleHours, now);
    });
  return { tmux: snap.tmux, sessions: sortSessions(sessions) };
}

export function sortSessions(sessions: TmuxSessionJson[]): TmuxSessionJson[] {
  return [...sessions].sort((a, b) =>
    (a.repo?.name ?? '~').localeCompare(b.repo?.name ?? '~') ||
    (a.container ?? '').localeCompare(b.container ?? '') ||
    (a.branch ?? '~').localeCompare(b.branch ?? '~') ||
    a.name.localeCompare(b.name)
  );
}

/** Clients attached to host session `name` right now (exact name); null when tmux cannot say. */
export async function hostSessionAttached(name: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{session_attached}']);
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** In a container: end session $1 only when nothing is attached (exit 3 when something is). */
export const KILL_IF_DETACHED_SCRIPT =
  `n=$(tmux display-message -p -t "=$1:" '#{session_attached}' 2>/dev/null) || exit 1; [ "$n" = 0 ] || exit 3; tmux kill-session -t "=$1"`;
