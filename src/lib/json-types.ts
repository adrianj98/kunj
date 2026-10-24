/**
 * The published JSON contract of `kunj ... --json`.
 *
 * Consumers (the VS Code extension, the macOS menu bar app and the workspace app) read
 * these shapes from the CLI's output. The commands build their output with `satisfies`
 * against these types, so this file and the output cannot drift apart.
 *
 * Type-only imports and no runtime code: the commands on the fast path import it freely.
 */
import type { WorktreeInfo, PullRequestInfo, PullRequestLookup } from './worktree';
import type { KnownRepoInfo } from './repos';
import type { ContainerStatus } from './container/env';
import type { ServiceState } from './container/services';
import type { PruneOrphan } from './container/prune';
import type { DindMode } from './container/dind';

/** What a command prints (as JSON) when it fails in `--json` mode: `kunj ct` always gives { code, message } (code 'error' when the error has none); `kunj agent` and `kunj events` give it for errors with a `jsonCode`; the other commands a plain message string (BaseCommand's generic path is opt-in). */
export interface ErrorJson {
  error: string | { code: string; message: string };
}

/**
 * The agent session of a worktree or container. `running` is null when it could not be determined.
 * `state` is what the Claude Code hooks kunj installs last wrote: 'waiting' when the agent waits for
 * input, 'running' while it works, null when unknown (no hooks, not claude, or not running).
 */
export interface AgentState {
  /** true when the default session or any `--session <id>` one runs */
  running: boolean | null;
  /** The default session's name (`kunj agent` without --session) */
  session: string;
  /** Across the running sessions: 'waiting' when any waits, else 'running' when any works */
  state?: 'running' | 'waiting' | null;
  /** Every running agent session of the worktree or container; absent when tmux could not be asked */
  sessions?: AgentSessionJson[];
}

/**
 * One running agent session. `id` is the `--session <id>` it was started with, null for the default
 * session. `state` is absent when its hooks have not written one.
 */
export interface AgentSessionJson {
  session: string;
  id: string | null;
  state?: 'running' | 'waiting';
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
  /** With --containers: this repository's branch containers, listed alongside the worktrees */
  containers?: WorktreeListContainersJson;
}

export interface WorktreeListContainersJson {
  /** false when Docker could not be asked; `items` is then empty and `message` says why */
  available: boolean;
  message?: string;
  items: BranchContainerJson[];
}

/** A `kunj ct list --json` container plus its branch's pull request, looked up like a worktree's */
export type BranchContainerJson = ContainerJson & {
  /** Absent with --no-pr; null when the branch has none or the lookup failed */
  pullRequest?: PullRequestInfo | null;
  prLabel: string | null;
};

// ---- kunj repos --json -----------------------------------------------------------------------

export interface RepoJson extends KnownRepoInfo {
  /** The directory kunj keeps this repository's files in, `~/.kunj/<kunjName>`: named after
   * origin, so it can differ from `name` (the folder) for a bare clone or a renamed checkout */
  kunjName: string;
}

export interface ReposJson {
  repos: RepoJson[];
}

// ---- kunj ct list --json ---------------------------------------------------------------------

export interface ContainerPortJson {
  container: number;
  host: number;
  kind: 'publish' | 'forward';
  pid?: number;
  /** A forward to a sidecar service's port (`kunj ct forward postgres:5432`) */
  service?: string;
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
  /** `sessions`: the container's agent tmux sessions (`agent`, `agent-<id>`); absent when unknown */
  agent: { running: boolean | null; state?: 'running' | 'waiting' | null; sessions?: AgentSessionJson[] };
  workspace: { head: string | null; ahead: number | null; dirty: boolean | null };
  status: ContainerStatus['status'] | 'skipped';
  services: ServiceState[];
  /** Host MCP servers bridged into the container (kunj ct mcp, started by kunj ct agent) */
  bridges: Array<{ name: string; pid: number }>;
  /** The vault changed since the container was created (its kunj.secrets label differs from the files'
   * stamp; read without unlocking): env secrets reach it on `kunj ct start --rebuild`. This repository's
   * containers only */
  secretsChanged?: boolean;
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

/**
 * `kunj ct token status --json`: where a new container's GitHub token would come from. `source` is
 * 'env' when container.env forwards GH_TOKEN, GITHUB_TOKEN or GITLAB_TOKEN from the host env, 'gh'
 * when `gh auth token` gives one for origin's host now, else null. `enabled` is container.useGhToken.
 * Token values are never printed.
 */
export interface ContainerTokenStatusJson {
  github: { source: 'env' | 'gh' | null; enabled: boolean };
}

// ---- kunj agent --json -----------------------------------------------------------------------

export interface AgentStatusJson {
  branch: string;
  worktree: string;
  /** The default session, or the --session one */
  session: string;
  /** Without --session: any of the worktree's agent sessions; with it: that one */
  running: boolean | null;
  /** Every running agent session of the worktree (absent when tmux could not be asked) */
  sessions?: AgentSessionJson[];
}

export interface AgentStopJson {
  success: true;
  branch: string;
  /** The default session, or the --session one */
  session: string;
  /** With --session or --all: the sessions that were ended (may be empty) */
  stopped?: string[];
}

/** `kunj worktree shell --session <id> --kill --json` and `kunj ct shell --session <id> --kill --json` */
export interface ShellKillJson {
  /** Whether a session was ended (with no --session: any of them) */
  killed: boolean;
}

// ---- kunj events --json ----------------------------------------------------------------------

/**
 * One line of `kunj events --json` (NDJSON). Each says what to refresh, not what changed:
 * `git` a repository's refs, HEAD or index; `sessions`/`forwards`/`repos` the registry file in
 * ~/.kunj (`repo` is reserved for per-repository files); `container` a Docker event of a kunj
 * container, or `action: 'status'` when the poll saw its agent, HEAD, ahead count or dirty state
 * change (`repo` null when it belongs to no watched repository); `agent` a host tmux session
 * (`kunj-…`) that appeared or went away; `backend` the container engine going away or coming back.
 * The first line is `hello`; a first line of any other shape is an ErrorJson (the command failed
 * before it started watching, e.g. `not-a-repo`).
 */
export type EventJson = { at: string } & (
  | { type: 'hello'; version: string; repos: number }
  | { type: 'git' | 'sessions' | 'forwards' | 'repos'; repo?: { name: string; root: string } }
  | { type: 'container'; repo: { name: string; root: string } | null; branch: string | null; container: string; action: string }
  | { type: 'agent'; session: string; running: boolean; state?: 'running' | 'waiting' | null; repo?: { name: string; root: string } }
  | { type: 'backend'; status: 'available' | 'unavailable'; message?: string }
);

/** `kunj secret list --json`: names, scope, targets and delivery of the stored secrets; never a value. */
export interface SecretListJson {
  secrets: Array<{
    name: string;
    scope: 'global' | 'repo' | 'branch';
    /** Present when scope is 'branch' */
    branch?: string;
    targets: Array<'host' | 'container'>;
    delivery: { env: boolean; file?: string };
    updatedAt: string;
  }>;
}

/** `kunj secret set|rm --json`: the entry written or removed (never its value). */
export interface SecretWriteJson {
  success: true;
  name: string;
  scope: 'global' | 'repo' | 'branch';
  branch?: string;
}

/** `kunj secret import --json`: the names imported (never values). */
export interface SecretImportJson {
  imported: string[];
}

/** `kunj secret apply --json`: worktree path -> the files rendered into it. */
export interface SecretApplyJson {
  applied: Record<string, string[]>;
}
