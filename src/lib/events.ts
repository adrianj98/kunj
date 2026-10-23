// The change stream behind `kunj events`: one long-lived process tells a consumer (the workspace
// app) which repository to refresh, instead of it polling every repository.
//
// Sources: each repository's git common dir (recursive fs.watch, debounced per repository), the
// registry files in ~/.kunj, a poll of the host tmux sessions, and the container backend's events
// (retried while the engine is unreachable). Everything stops when `signal` aborts.
// On the fast path: keep the imports light.

import * as fs from 'fs';
import * as path from 'path';
import type { ContainerBackend, BackendEvent } from './container/backend';
import type { EventJson } from './json-types';
import type { KnownRepoInfo } from './repos';
import { LABEL } from './container/names';
import { forwardsFile } from './container/autoforward';
import { WORKTREE_SESSIONS_FILE } from './worktree';
import { REPOS_FILE } from './repos';
import { listTmuxSessions } from './agent-session';
import { repoIdentity } from './repo-identity';

export interface WatchEventsOptions {
  repos: KnownRepoInfo[];
  kunjDir: string;
  backend: ContainerBackend | null;
  onEvent: (e: EventJson) => void;
  signal: AbortSignal;
  debounceMs?: number;
  tmuxPollMs?: number;
  backendRetryMs?: number;
  now?: () => Date;
  /** The repository's id as container labels carry it (kunj.repo) */
  repoId?: (repo: KnownRepoInfo) => Promise<string>;
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
  const backendRetryMs = options.backendRetryMs ?? 10000;
  const now = options.now ?? (() => new Date());
  const repoId = options.repoId ?? (async (r: KnownRepoInfo) => repoIdentity({ commonDir: r.gitCommonDir, repoRoot: r.root }).id);
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

  // A directory that is missing (or cannot be watched) is skipped
  const watch = (dir: string, recursive: boolean, onChange: (file: string | null) => void) => {
    try {
      const watcher = fs.watch(dir, { recursive }, (_type, file) => onChange(file == null ? null : String(file)));
      watcher.on('error', () => watcher.close());
      cleanup.push(() => watcher.close());
    } catch {
      // not watchable
    }
  };

  for (const repo of repos) {
    const ref = { name: repo.name, root: repo.root };
    watch(repo.gitCommonDir, true, file => {
      if (file === null || gitPathMatters(file)) debounce(`git:${repo.gitCommonDir}`, () => emit({ type: 'git', repo: ref, at: at() }));
    });
  }

  const registryFiles: Record<string, 'sessions' | 'forwards' | 'repos'> = {
    [WORKTREE_SESSIONS_FILE]: 'sessions',
    [path.basename(forwardsFile())]: 'forwards',
    [REPOS_FILE]: 'repos',
  };
  watch(kunjDir, false, file => {
    const type = file === null ? undefined : registryFiles[file];
    if (type) debounce(type, () => emit({ type, at: at() }));
  });

  // Host agent sessions: the first poll is the baseline
  let known: Set<string> | null = null;
  let tmuxTimer: NodeJS.Timeout | undefined;
  const pollTmux = async () => {
    const sessions = await listTmuxSessions();
    if (signal.aborted) return;
    const current = new Set((sessions ?? []).filter(s => s.startsWith('kunj-')));
    if (known) {
      for (const s of current) if (!known.has(s)) emit({ type: 'agent', session: s, running: true, at: at() });
      for (const s of known) if (!current.has(s)) emit({ type: 'agent', session: s, running: false, at: at() });
    }
    known = current;
    tmuxTimer = setTimeout(pollTmux, tmuxPollMs);
  };
  cleanup.push(() => clearTimeout(tmuxTimer));
  void pollTmux();

  let backendDone: Promise<void> = Promise.resolve();
  if (backend) {
    const byId = new Map<string, { name: string; root: string }>();
    await Promise.all(repos.map(async r => {
      try {
        byId.set(await repoId(r), { name: r.name, root: r.root });
      } catch {
        // its containers are reported with repo null
      }
    }));
    const onContainer = (e: BackendEvent) => {
      if (!containerActionMatters(e.action)) return;
      const id = e.labels[LABEL.repo];
      emit({
        type: 'container',
        repo: (id !== undefined && byId.get(id)) || null,
        branch: e.labels[LABEL.branch] ?? null,
        container: e.name,
        action: e.action,
        at: e.at,
      });
    };
    backendDone = (async () => {
      let available = true;
      while (!signal.aborted) {
        if (!available) {
          try {
            await backend.info();
          } catch {
            await sleep(backendRetryMs, signal);
            continue;
          }
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
  }

  await new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await backendDone;
  for (const fn of cleanup) fn();
}
