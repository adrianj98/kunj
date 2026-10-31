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
import type { SearchScope, GrepMatch, CommitMatch, LogMatch } from './search';

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
  /** The default session's name (`kunj agent` without --session); a running one started on an
   *  earlier branch of the worktree keeps that branch's name (found by its @kunj_worktree tag) */
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

// ---- kunj repos github --json / kunj repos clone --json ---------------------------------------

/** A repository the gh login can clone (`gh api user/repos`) */
export interface GitHubRepoJson {
  /** owner/name */
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushedAt: string | null;
  /** The repository's page, https://github.com/owner/name */
  url: string;
  defaultBranch: string;
  /** The root of a known repository (`kunj repos`) whose origin is this one, else null */
  local: string | null;
}

export interface GitHubReposJson {
  repos: GitHubRepoJson[];
}

export interface RepoCloneJson {
  success: true;
  /** The new entry in `kunj repos` */
  repo: RepoJson;
  /** The checkout, or the bare repository */
  path: string;
  bare: boolean;
  /** The default branch's worktree of a bare clone, else null */
  worktree: string | null;
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
  /**
   * 'docker': the laptop's Docker (`context` its Docker context); 'remote': a `kunj serve` (`remote`
   * its name from kunj remote add, `context` the Docker context on the box). `features` says what
   * the backend can do (editorAttach is false on a remote, so `ct open` refuses there).
   */
  backend: {
    kind: 'docker' | 'remote';
    context: string;
    remote?: string;
    features?: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  };
  containers: ContainerJson[];
  // Helpers, services, volumes and networks whose branch container is gone (kunj ct prune removes them)
  orphans: PruneOrphan[];
}

// ---- kunj remote --json ----------------------------------------------------------------------

/** `kunj remote list --json`: how each remote is reached; never its token. */
export interface RemoteListJson {
  /** `insecure`: a plain http URL to a non-loopback address, added with --allow-insecure-http */
  remotes: Array<{ name: string; via: 'ssh' | 'url'; ssh?: string; port?: number; url?: string; insecure?: boolean; addedAt: string }>;
}

/** `kunj remote ping <name> --json` */
export interface RemotePingJson {
  name: string;
  via: 'ssh' | 'url';
  /** The server's kunj version */
  kunj: string;
  /** The Docker context on the box */
  context: string;
  features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  engine: { serverVersion: string; runtimes: string[]; operatingSystem: string };
  ms: number;
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

/**
 * `kunj ct token check --json`: whether the Claude Code token new containers get works (one `claude -p`
 * with it as the only credential). `source` is a stored container secret or container.env; `valid` is
 * null when there is none or it could not be told. Never holds the token.
 */
export interface ContainerTokenCheckJson {
  claude: { source: 'secret' | 'env' | null; valid: boolean | null; message: string };
}

// ---- kunj agent --json -----------------------------------------------------------------------

export interface AgentStatusJson {
  branch: string;
  worktree: string;
  /** The default session, or the --session one; possibly named after an earlier branch of the worktree */
  session: string;
  /** Without --session: any of the worktree's agent sessions; with it: that one */
  running: boolean | null;
  /** Every running agent session of the worktree (absent when tmux could not be asked) */
  sessions?: AgentSessionJson[];
}

export interface AgentStopJson {
  success: true;
  branch: string;
  /** The default session, or the --session one; possibly named after an earlier branch of the worktree */
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

// ---- kunj search --json ----------------------------------------------------------------------

/**
 * `kunj search <pattern> --json`. `sources` holds every worktree, branch and container that matched
 * or failed (never the ones searched without a match); `searched` counts all of them. `commits`,
 * `logs` and `containers` are present only when their scope was asked for.
 */
export interface SearchJson {
  query: {
    pattern: string;
    ignoreCase: boolean;
    fixed: boolean;
    word: boolean;
    paths: string[];
    maxCount: number;
    scopes: SearchScope[];
    /** --branch: the branches the search was limited to (empty: all) */
    branches: string[];
  };
  repoRoot: string;
  searched: { worktrees: number; branches: number; containers: number };
  sources: SearchSourceJson[];
  /** The containers scope: available false (with a message) when Docker could not be asked; `stopped` the branches whose container was not running */
  containers?: { available: boolean; message?: string; stopped: string[] };
  commits?: CommitMatch[];
  logs?: LogMatch[];
  /** The commits or logs scope failed (e.g. a pattern git log or JavaScript cannot read); its list is then empty */
  commitsError?: string;
  logsError?: string;
}

/**
 * Where matches were found. `worktree`: `path` is the worktree (match paths are relative to it);
 * `branch`: `ref` is the committed tree searched (`refs/heads/x`, or `refs/remotes/origin/x` with
 * `remote`); `container`: `container` is its name, match paths are relative to /workspace.
 */
export interface SearchSourceJson {
  kind: 'worktree' | 'branch' | 'container';
  /** null for a detached worktree */
  branch: string | null;
  path?: string;
  ref?: string;
  remote?: boolean;
  container?: string;
  isCurrent?: boolean;
  matches: GrepMatch[];
  /** More matches than maxCount: only the first ones are listed */
  truncated: boolean;
  /** The search failed here (the others still ran) */
  error?: string;
}

/** A terminal attached to a tmux session: its tty, the tmux client's pid, and the app it runs in (`Kunj Workspace`, `Terminal`, `iTerm2`, `Code`; null when unknown). */
export interface SessionAttachJson {
  tty: string;
  pid: number;
  via: string | null;
}

/**
 * One of kunj's tmux sessions (`kunj sessions list --json`): a host agent (`kunj-…`) or shell
 * (`kunjsh-…`), or one in a container (`agent`, `agent-<id>`, `sh-<id>`, with `container` set).
 * `worktree` is null for a host session whose worktree is gone (`orphan: 'worktree-gone'`) and for
 * container sessions. `usage` adds up the session's process trees (null when ps could not be read);
 * `cpu` is ps's percentage (100 = one core), a recent average on macOS.
 * `orphan: 'idle'`: no terminal attached and no activity for more than `idleHours`.
 */
export interface TmuxSessionJson {
  name: string;
  kind: 'agent' | 'shell';
  /** The `--session <id>` it was started with; null for the default agent session */
  id: string | null;
  repo: { name: string; root: string } | null;
  worktree: { path: string; branch: string | null } | null;
  /** The worktree's branch, or the branch the container was created for */
  branch: string | null;
  container: string | null;
  /** The first pane's current command and directory */
  command: string | null;
  cwd: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  attached: SessionAttachJson[];
  usage: { cpu: number; memoryBytes: number } | null;
  orphan: 'worktree-gone' | 'idle' | null;
}

/** `kunj sessions list --json`: `tmux` says whether the host's tmux could be asked. */
export interface SessionsJson {
  tmux: 'ok' | 'missing' | 'failed';
  idleHours: number;
  /** Host and (with --containers) container sessions, by repo, container and branch */
  sessions: TmuxSessionJson[];
  /** With --containers: each running branch container asked; available false when Docker could not be */
  containers?: {
    available: boolean;
    message?: string;
    items: Array<{ container: string; repo: string | null; branch: string | null; tmux: 'ok' | 'missing' | 'failed'; count: number }>;
  };
}

/** `kunj sessions kill --json`: the sessions ended, and the ones that could not be (refused or failed). */
export interface SessionsKillJson {
  killed: string[];
  failed: Array<{ name: string; container: string | null; error: string }>;
}
