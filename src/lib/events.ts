// The change stream behind `kunj events`: one long-lived process tells a consumer (the workspace
// app) which repository to refresh, instead of it polling every repository.
//
// Sources: each repository's git common dir (fs.watch, debounced per repository), the registry
// files in ~/.kunj, a poll of the host tmux sessions, and the container backend's events (retried
// while the engine is unreachable). The watches cannot see a file edited in a worktree or the work
// inside a container, so a status poll (every statusPollMs) runs `git status` in each worktree and
// the `kunj ct list` status script in each running container, and reports what changed.
// Everything stops when `signal` aborts. On the fast path: keep the imports light.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { ContainerBackend, BackendEvent } from './container/backend';
import type { EventJson } from './json-types';
import type { KnownRepoInfo } from './repos';
import { LABEL, isMain, optionsLabel, repoIdFromUrl } from './container/names';
import { STATUS_SCRIPT, parseStatus } from './container/env';
import { stripUserinfo } from './container/seed';
import { forwardsFile } from './container/autoforward';
import { WORKTREE_SESSIONS_FILE } from './worktree';
import { REPOS_FILE } from './repos';
import { agentStateDir, listTmuxSessions, readAgentState } from './agent-session';
import { kunjDirName } from './repo-identity';
import type { AgentHookState } from './agent-session';

const execFileAsync = promisify(execFile);

export interface WatchEventsOptions {
  repos: KnownRepoInfo[];
  kunjDir: string;
  /** The container backend of every repository (null: no container events) */
  backend: ContainerBackend | null;
  /**
   * A repository's own backend (its container.remote), else `backend`. Repositories sharing a backend
   * share its event stream and status poll, so one remote is one connection.
   */
  backendFor?: (repo: KnownRepoInfo) => ContainerBackend | null;
  onEvent: (e: EventJson) => void;
  signal: AbortSignal;
  debounceMs?: number;
  tmuxPollMs?: number;
  /** How often git status runs in every worktree and the status script in every running container */
  statusPollMs?: number;
  backendRetryMs?: number;
  now?: () => Date;
  /** The repository's id as container labels carry it (kunj.repo) */
  repoId?: (repo: KnownRepoInfo) => Promise<string>;
  /** Called once the watches, the repo ids and the first tmux and status polls are in place (not waiting for Docker) */
  onReady?: () => void;
}

const ROOT_FILES = new Set(['HEAD', 'ORIG_HEAD', 'index', 'packed-refs', 'worktrees']);

/** Whether a change at this path (relative to the git common dir) can change what a listing shows. */
export function gitPathMatters(relative: string): boolean {
  const p = relative.split(path.sep).join('/');
  if (p.endsWith('.lock')) return false;
  if (ROOT_FILES.has(p) || p.startsWith('refs/')) return true;
  // worktrees/<name>/{HEAD,index,...}, but not worktrees/<name>/logs/...
  return p.startsWith('worktrees/') && p.split('/')[2] !== 'logs';
}

// Docker reports every exec, attach and copy; `kunj ct list` execs into each container, so passing
// these on would make every refresh trigger the next one
function containerActionMatters(action: string): boolean {
  return !action.startsWith('exec_') && !['attach', 'detach', 'resize', 'top', 'archive-path', 'extract-to-dir'].includes(action);
}

// GIT_OPTIONAL_LOCKS=0: git status must not refresh the index, which the watches would report
async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// As the container labels have it: origin's URL as git reports it (insteadOf, includes), without credentials
async function originRepoId(repo: KnownRepoInfo): Promise<string> {
  let url = '';
  try {
    url = stripUserinfo((await git(['-C', repo.root, 'remote', 'get-url', 'origin'])).trim());
  } catch {
    // no origin
  }
  return repoIdFromUrl(url || repo.root);
}

/** The checkouts in `git worktree list --porcelain` output (not the bare entry). */
export function worktreePaths(porcelain: string): string[] {
  return porcelain.split(/\n\n+/).flatMap(block => {
    const lines = block.split('\n');
    const first = lines[0] ?? '';
    if (!first.startsWith('worktree ') || lines.includes('bare')) return [];
    return [first.slice('worktree '.length)];
  });
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex');

// The promise's value, or undefined as soon as the signal aborts (a hung Docker call must not block exit)
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(undefined);
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function watchEvents(options: WatchEventsOptions): Promise<void> {
  const { repos, kunjDir, backend, onEvent, signal } = options;
  const debounceMs = options.debounceMs ?? 250;
  const tmuxPollMs = options.tmuxPollMs ?? 5000;
  const statusPollMs = options.statusPollMs ?? 10000;
  const backendRetryMs = options.backendRetryMs ?? 10000;
  const now = options.now ?? (() => new Date());
  const repoId = options.repoId ?? originRepoId;
  if (signal.aborted) return;

  const at = () => now().toISOString();
  const emit = (e: EventJson) => {
    if (!signal.aborted) onEvent(e);
  };
  const cleanup: Array<() => void> = [];

  // One pending event per key: the first change starts the timer, later ones ride along
  const pending = new Map<string, NodeJS.Timeout>();
  const debounce = (key: string, fire: () => void) => {
    if (pending.has(key)) return;
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      fire();
    }, debounceMs));
  };
  cleanup.push(() => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  });

  // Runs tick now and every ms; a tick is skipped while the previous one runs, and a failure is dropped
  const every = (ms: number, tick: () => Promise<void>): (() => Promise<void>) => {
    let busy = false;
    const run = async () => {
      if (busy || signal.aborted) return;
      busy = true;
      try {
        await tick();
      } catch {
        // the next tick tries again
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void run(), ms);
    cleanup.push(() => clearInterval(timer));
    return run;
  };

  // A directory that is missing (or cannot be watched) is skipped; one that errors is closed
  const watch = (dir: string, recursive: boolean, onChange: (file: string | null) => void, onError?: () => void): fs.FSWatcher | null => {
    try {
      const watcher = fs.watch(dir, { recursive }, (_type, file) => onChange(file == null ? null : String(file)));
      watcher.on('error', () => {
        watcher.close();
        onError?.();
      });
      cleanup.push(() => watcher.close());
      return watcher;
    } catch {
      return null;
    }
  };

  const gitEvent = (repo: KnownRepoInfo) => {
    debounce(`git:${repo.gitCommonDir}`, () => emit({ type: 'git', repo: { name: repo.name, root: repo.root }, at: at() }));
  };

  // Never the whole common dir recursively: worktrees live in it by default (.git/kunj/worktrees),
  // node_modules and all. Its top level (HEAD, index, packed-refs) plus refs/ and worktrees/.
  const resyncs: Array<() => void> = [];
  for (const repo of repos) {
    const onGit = (relative: string | null) => {
      if (relative === null || gitPathMatters(relative)) gitEvent(repo);
    };
    const subWatchers = new Map<string, fs.FSWatcher>();
    // (Re)starts the watch of refs/ or worktrees/ when it exists; worktrees/ appears with the first
    // linked worktree. One that errored was dropped from subWatchers, so the next sync restarts it.
    const syncSub = (name: 'refs' | 'worktrees') => {
      const dir = path.join(repo.gitCommonDir, name);
      const current = subWatchers.get(name);
      if (fs.existsSync(dir)) {
        if (current) return;
        const watcher = watch(dir, true, file => onGit(file === null ? null : path.join(name, file)), () => {
          if (subWatchers.get(name) === watcher) subWatchers.delete(name);
        });
        if (watcher) subWatchers.set(name, watcher);
      } else if (current) {
        current.close();
        subWatchers.delete(name);
      }
    };
    const top = watch(repo.gitCommonDir, false, file => {
      if (file === 'refs' || file === 'worktrees') syncSub(file);
      onGit(file);
    });
    if (top) {
      syncSub('refs');
      syncSub('worktrees');
      resyncs.push(() => {
        syncSub('refs');
        syncSub('worktrees');
      });
    }
  }

  // The agent state files the Claude Code hooks write (agent-session.ts): one directory per repo,
  // created by kunj agent; watched once it exists (resynced with the git watches)
  const stateWatchers = new Map<string, fs.FSWatcher>();
  const syncStateWatch = (repo: KnownRepoInfo) => {
    const dir = agentStateDir(path.join(kunjDir, kunjDirName(repo)));
    if (stateWatchers.has(dir) || !fs.existsSync(dir)) return;
    // Only a change is an event: PreToolUse rewrites the same value on every tool call. A deleted
    // file (SessionEnd) is not one either; the tmux poll reports the session ending.
    const last = new Map<string, AgentHookState>();
    const watcher = watch(dir, false, file => {
      if (!file || !file.startsWith('kunj-')) return;
      debounce(`agent-state:${dir}/${file}`, () => {
        const state = readAgentState(path.join(dir, file));
        if (state === null) {
          last.delete(file);
          return;
        }
        if (last.get(file) === state) return;
        last.set(file, state);
        emit({ type: 'agent', session: file, running: true, state, repo: { name: repo.name, root: repo.root }, at: at() });
      });
    }, () => stateWatchers.delete(dir));
    if (watcher) stateWatchers.set(dir, watcher);
  };
  for (const repo of repos) syncStateWatch(repo);
  resyncs.push(() => repos.forEach(syncStateWatch));

  const registryFiles: Record<string, 'sessions' | 'forwards' | 'repos'> = {
    [WORKTREE_SESSIONS_FILE]: 'sessions',
    [path.basename(forwardsFile())]: 'forwards',
    [REPOS_FILE]: 'repos',
  };
  watch(kunjDir, false, file => {
    const type = file === null ? undefined : registryFiles[file];
    if (type) debounce(type, () => emit({ type, at: at() }));
  });

  // Container labels carry the repo id; computed once. Repositories are grouped by backend.
  const byId = new Map<string, { name: string; root: string }>();
  const groups = new Map<ContainerBackend, Set<string>>();
  await Promise.all(repos.map(async r => {
    try {
      const id = await repoId(r);
      byId.set(id, { name: r.name, root: r.root });
      const b = options.backendFor ? options.backendFor(r) : backend;
      if (b) {
        if (!groups.has(b)) groups.set(b, new Set());
        groups.get(b)!.add(id);
      }
    } catch {
      // its containers are reported with repo null
    }
  }));
  // A backend no repository named still streams (its events carry repo null), as before
  if (backend && !groups.has(backend) && !options.backendFor) groups.set(backend, new Set());

  // Host agent sessions: the first poll is the baseline; a failed listing (null) is not a change
  let known: Set<string> | null = null;
  const pollTmux = every(tmuxPollMs, async () => {
    const sessions = await listTmuxSessions();
    if (signal.aborted || sessions === null) return;
    const current = new Set(sessions.filter(s => s.startsWith('kunj-')));
    if (known) {
      for (const s of current) if (!known.has(s)) emit({ type: 'agent', session: s, running: true, at: at() });
      for (const s of known) if (!current.has(s)) emit({ type: 'agent', session: s, running: false, at: at() });
    }
    known = current;
  });

  // Worktree status: one git worktree list per repository, one git status per worktree. A
  // worktree seen for the first time only primes; one whose status fails keeps its last hash.
  const worktreeHashes = new Map<string, Map<string, string>>();
  const pollWorktrees = every(statusPollMs, async () => {
    for (const resync of resyncs) resync();
    await Promise.all(repos.map(async repo => {
      let paths: string[];
      try {
        paths = worktreePaths(await git(['-C', repo.root, 'worktree', 'list', '--porcelain']));
      } catch {
        return;
      }
      const before = worktreeHashes.get(repo.gitCommonDir);
      const after = new Map<string, string>();
      let changed = false;
      await Promise.all(paths.map(async dir => {
        try {
          const h = hash(await git(['-C', dir, 'status', '--porcelain=v2', '--branch']));
          after.set(dir, h);
          if (before?.has(dir) && before.get(dir) !== h) changed = true;
        } catch {
          const last = before?.get(dir);
          if (last !== undefined) after.set(dir, last);
        }
      }));
      worktreeHashes.set(repo.gitCommonDir, after);
      if (changed && !signal.aborted) gitEvent(repo);
    }));
  });

  await Promise.all([pollTmux(), pollWorktrees()]);
  if (!signal.aborted) options.onReady?.();

  const watchBackend = (backend: ContainerBackend, ids: Set<string>): Promise<void> => {
    let available = true;
    const onContainer = (e: BackendEvent) => {
      if (!containerActionMatters(e.action)) return;
      const id = e.labels[LABEL.repo];
      // Another backend reports its own repositories
      if (id !== undefined && byId.has(id) && !ids.has(id)) return;
      emit({
        type: 'container',
        repo: (id !== undefined && byId.get(id)) || null,
        branch: e.labels[LABEL.branch] ?? null,
        container: e.name,
        action: e.action,
        at: e.at,
      });
    };

    // Running main containers of the watched repositories: the `kunj ct list` status script in each
    const containerHashes = new Map<string, string>();
    const pollContainers = every(statusPollMs, async () => {
      if (!available) return;
      const lists = await untilAbort(Promise.all([...ids].map(id => backend.list({ [LABEL.repo]: id }).catch(() => []))), signal);
      if (!lists) return;
      const mains = lists.flat().filter(c => c.state === 'running' && isMain(c));
      const seen = new Set(mains.map(c => c.name));
      await Promise.all(mains.map(async c => {
        let status;
        try {
          const user = optionsLabel(c.labels).user || undefined;
          const r = await untilAbort(backend.exec(c.id, ['sh', '-c', STATUS_SCRIPT], { user, timeoutMs: 2000 }), signal);
          if (!r) return;
          status = parseStatus(r.stdout);
        } catch {
          return;
        }
        const h = JSON.stringify({ agentRunning: status.agentRunning, agentState: status.agentState, agentSessions: status.agentSessions, head: status.head, ahead: status.ahead, dirty: status.dirty });
        const before = containerHashes.get(c.name);
        containerHashes.set(c.name, h);
        if (before !== undefined && before !== h) {
          emit({ type: 'container', repo: byId.get(c.labels[LABEL.repo]) ?? null, branch: c.labels[LABEL.branch] ?? null, container: c.name, action: 'status', at: at() });
        }
      }));
      for (const name of [...containerHashes.keys()]) if (!seen.has(name)) containerHashes.delete(name);
    });
    void pollContainers();

    return (async () => {
      while (!signal.aborted) {
        if (!available) {
          try {
            await untilAbort(backend.info(), signal);
          } catch {
            await sleep(backendRetryMs, signal);
            continue;
          }
          if (signal.aborted) break;
          available = true;
          emit({ type: 'backend', status: 'available', at: at() });
        }
        try {
          await backend.events({ [LABEL.repo]: '' }, onContainer, signal);
        } catch (err) {
          if (available && !signal.aborted) {
            available = false;
            emit({ type: 'backend', status: 'unavailable', message: (err as Error).message, at: at() });
          }
        }
        await sleep(backendRetryMs, signal);
      }
    })();
  };
  const backendDone = Promise.all([...groups].map(([b, ids]) => watchBackend(b, ids)));

  await new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await backendDone;
  for (const fn of cleanup) fn();
}
