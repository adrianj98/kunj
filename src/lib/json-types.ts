/**
 * The published JSON contract of `kunj ... --json`.
 *
 * Consumers (the VS Code extension, the macOS menu bar app and the workspace app) read
 * these shapes from the CLI's output. The commands build their output with `satisfies`
 * against these types, so this file and the output cannot drift apart.
 *
 * Type-only imports and no runtime code: the commands on the fast path import it freely.
 */
import type { WorktreeInfo, PullRequestLookup } from './worktree';
import type { KnownRepoInfo } from './repos';
import type { ContainerStatus } from './container/env';
import type { ServiceState } from './container/services';
import type { PruneOrphan } from './container/prune';
import type { DindMode } from './container/dind';

/** What a command prints (as JSON) when it fails in `--json` mode: `kunj ct` always gives { code, message } (code 'error' when the error has none); `kunj agent` and `kunj events` give it for errors with a `jsonCode`; the other commands a plain message string (BaseCommand's generic path is opt-in). */
export interface ErrorJson {
  error: string | { code: string; message: string };
}

/** The agent session of a worktree or container. `running` is null when it could not be determined. */
export interface AgentState {
  running: boolean | null;
  session: string;
}

// ---- kunj worktree list --json ---------------------------------------------------------------

export type WorktreeJson = WorktreeInfo & {
  openCount: number;
  changedFiles: number | null;
  prLabel: string | null;
};

export interface WorktreeListJson {
  repoRoot: string;
  currentPath: string | null;
  pullRequestLookup: PullRequestLookup;
  pullRequestsFromCache: boolean;
  worktrees: WorktreeJson[];
}

// ---- kunj repos --json -----------------------------------------------------------------------

export interface ReposJson {
  repos: KnownRepoInfo[];
}

// ---- kunj ct list --json ---------------------------------------------------------------------

export interface ContainerPortJson {
  container: number;
  host: number;
  kind: 'publish' | 'forward';
  pid?: number;
}

export interface ContainerJson {
  branch: string;
  name: string;
  id: string;
  state: string;
  image: string;
  imageInfo: { tag: string; kind?: string };
  blueprint?: { hash: string; stale: boolean | null };
  createdAt: string;
  firewall: string;
  dind: DindMode | string;
  ports: ContainerPortJson[];
  agent: { running: boolean | null };
  workspace: { head: string | null; ahead: number | null; dirty: boolean | null };
  status: ContainerStatus['status'] | 'skipped';
  services: ServiceState[];
}

export interface ContainerListJson {
  repo: string;
  backend: { kind: 'docker'; context: string };
  containers: ContainerJson[];
  // Helpers, services, volumes and networks whose branch container is gone (kunj ct prune removes them)
  orphans: PruneOrphan[];
}

// ---- kunj ct file --json ---------------------------------------------------------------------

/** `kunj ct file read [branch] <path> --json` */
export interface FileReadJson {
  path: string;
  content: string;
}

/** `kunj ct file write [branch] <path> --json` */
export interface FileWriteJson {
  success: true;
  path: string;
}

// ---- kunj agent --json -----------------------------------------------------------------------

export interface AgentStatusJson {
  branch: string;
  worktree: string;
  session: string;
  running: boolean | null;
}

export interface AgentStopJson {
  success: true;
  branch: string;
  session: string;
}

// ---- kunj events --json ----------------------------------------------------------------------

/**
 * One line of `kunj events --json` (NDJSON). Each says what to refresh, not what changed:
 * `git` a repository's refs, HEAD or index; `sessions`/`forwards`/`repos` the registry file in
 * ~/.kunj (`repo` is reserved for per-repository files); `container` a Docker event of a kunj
 * container (`repo` null when it belongs to no watched repository); `agent` a host tmux session
 * (`kunj-…`) that appeared or went away; `backend` the container engine going away or coming back.
 */
export type EventJson = { at: string } & (
  | { type: 'hello'; version: string; repos: number }
  | { type: 'git' | 'sessions' | 'forwards' | 'repos'; repo?: { name: string; root: string } }
  | { type: 'container'; repo: { name: string; root: string } | null; branch: string | null; container: string; action: string }
  | { type: 'agent'; session: string; running: boolean }
  | { type: 'backend'; status: 'available' | 'unavailable'; message?: string }
);
