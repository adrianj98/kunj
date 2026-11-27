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
  /** `kunj ct list --json`'s `backends`: who was asked, and who did not answer (its rows are missing, not gone) */
  backends?: ContainerListJson['backends'];
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
  /** The `kunj serve` remote the container is on (a name from kunj remote add); absent on this machine's Docker */
  remote?: string;
  /** The cloud machine the container runs on, when its remote coordinates machines */
  machine?: { provider: string; name: string; state: MachineJson['state']; size: string; owner?: string };
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
  /**
   * Every backend this listing asked: the one of --remote / --context, else the fleet (this machine's
   * Docker, then each remote of kunj remote list). One that did not answer has `available: false`
   * and a `message`, and its containers are missing from `containers`: not gone, just not listed.
   * `backend` above stays the default backend, where a start without --remote creates.
   */
  backends?: Array<{
    kind: 'docker' | 'remote';
    context: string;
    remote?: string;
    available: boolean;
    message?: string;
    features?: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  }>;
  containers: ContainerJson[];
  /**
   * Cloud machines of the repository that have no container row: asleep (suspended, stopped), not
   * answering, or without a container yet. `remote` is the coordinator. A listing never wakes one;
   * `kunj ct start <branch>` does. Absent when no backend coordinates machines.
   */
  machines?: Array<MachineJson & { remote: string; provider: string }>;
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

// ---- kunj machine --json (docs/specs/cloud-machines.md) --------------------------------------

/** One cloud machine as the coordinator reports it. */
export interface MachineJson {
  name: string;
  state: 'provisioning' | 'running' | 'suspending' | 'suspended' | 'stopping' | 'stopped' | 'unknown';
  repo: string;
  branch: string;
  /** The provider's shape (e2-standard-2…) */
  size: string;
  zone?: string;
  createdAt: string;
  /** The coordinator client that created it */
  owner?: string;
  /** The golden image it booted from */
  image?: string;
  /** kunj version that created it */
  version?: string;
  /** Whether the coordinator holds its kunj serve token */
  paired: boolean;
  /** When it last went to sleep (suspended or stopped), when the cloud says */
  sleptAt?: string;
}

/** `kunj machine list --json`; `repo` is absent with --all */
/** A golden machine image: what a repository's new machines boot from (`kunj machine image`). */
export interface MachineImageJson {
  name: string;
  repo: string;
  createdAt: string;
  /** The kunj that baked it */
  version?: string;
  /** The blueprint hash of the snapshot inside, when known */
  blueprint?: string;
}

export interface MachineImageListJson {
  coordinator: string;
  repo: string;
  images: MachineImageJson[];
}

export interface MachineImageBuildJson {
  coordinator: string;
  image: MachineImageJson;
  /** The builder machine, deleted after the bake */
  builder: string;
  snapshot: boolean;
  seconds: number;
}

export interface MachineListJson {
  /** 'local' or the remote's name */
  coordinator: string;
  repo?: string;
  machines: MachineJson[];
}

/**
 * `kunj resources --json`: everything kunj manages, wherever it is. `places` are where it looked
 * (this computer's Docker, each remote, each coordinator's cloud); one that did not answer has
 * `available: false` and its resources are missing, not gone.
 */
export interface ResourcesJson {
  places: Array<{ name: string; kind: 'docker' | 'remote' | 'cloud'; available: boolean; message?: string; provider?: string }>;
  resources: ResourceJson[];
}

export interface ResourceJson {
  /** container: a branch's container; helper: its firewall sidecar; service: a sidecar service */
  kind: 'container' | 'helper' | 'service' | 'volume' | 'network' | 'image' | 'machine' | 'machine-image' | 'cache-store';
  name: string;
  /** The place it is in: "This Mac", a remote's name, or a coordinator's */
  place: string;
  /** The cloud machine it is on, for what lives on one */
  machine?: string;
  /** The repository id (kunj.repo), when it belongs to one */
  repo?: string;
  branch?: string;
  /** running, exited, suspended… (containers and machines) */
  state?: string;
  /** What it is, in a few words: an image tag, a machine shape, "cache db", "snapshot" */
  detail?: string;
  sizeBytes?: number;
  createdAt?: string;
}

/** `kunj machine setup --json` */
export interface MachineSetupJson {
  provider: string;
  /** e.g. "project my-project, zone us-central1-a" */
  target: string;
  /** Nothing was created (missing things are `planned`) */
  dryRun: boolean;
  success: boolean;
  steps: Array<{ title: string; cost?: string; state: 'present' | 'planned' | 'created' | 'failed'; message?: string }>;
  /** The global settings written (empty unless everything is in place) */
  config: Record<string, unknown>;
}

/** `kunj machine setup --remove --json` */
export interface MachineSetupRemoveJson {
  provider: string;
  target: string;
  remove: true;
  /** Nothing was deleted (what is there is `present`) */
  dryRun: boolean;
  success: boolean;
  /** In the order they are deleted; `absent` was already gone */
  steps: Array<{ title: string; cost?: string; state: 'present' | 'absent' | 'removed' | 'failed' | 'kept'; message?: string }>;
  /** The cache bucket, deleted only with --remove-bucket or a separate yes */
  bucket: { name: string; state: 'present' | 'absent' | 'removed' | 'failed' | 'kept' };
}

/** `kunj machine prune --json` */
export interface MachinePruneJson {
  coordinator: string;
  success: boolean;
  dryRun: boolean;
  plan: {
    /** Every machine with a reason to go; `kept` says why one stays anyway */
    machines: Array<{ name: string; branch: string; state: MachineJson['state']; reason: 'branch-gone' | 'no-container' | 'image-builder' | 'asleep-long'; kept?: string }>;
    warnings: string[];
    /** Golden images older than 14 days of a repository with no machine (this repository's; every one's with --all) */
    images?: Array<{ name: string; repo: string; createdAt: string; reason: 'unused'; kept?: string }>;
  };
  removed: string[];
  failed: string[];
  /** Golden images deleted, and ones that could not be */
  removedImages?: string[];
  failedImages?: string[];
}

/** `kunj machine status|create|suspend|resume|stop|start --json` */
export interface MachineJsonResult {
  coordinator: string;
  machine: MachineJson;
  created: boolean;
  woke: boolean;
}

/** `kunj machine providers --json` */
export interface MachineProvidersJson {
  coordinator: string;
  provider: string;
  features: { suspend: boolean; spot: boolean; images: boolean; diskSnapshots: boolean; selfSuspend: boolean };
  sizes: Array<{ name: 'small' | 'medium' | 'large'; shape: string; vcpus: number; memoryGb: number }>;
  network: 'private' | 'tunnel';
}

/** `kunj machine coordinator [status|stop] --json` (the local coordinator) */
export interface CoordinatorStatusJson {
  running: boolean;
  stopped?: boolean;
  pid?: number;
  port?: number;
  version?: string;
  startedAt?: string;
  log?: string;
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

/** `kunj agent start --detach --json`: the session it started, or found already running. */
export interface AgentStartJson {
  branch: string;
  worktree: string;
  session: string;
  /** The `--session <id>`; null for the default session */
  id: string | null;
  /** false when the session was already running (left as it was) */
  started: boolean;
  /**
   * With `--teleport` on a new session: `switched` once claude checked out the web session's branch
   * (the placeholder branch is then deleted), `failed` with claude's message (the pane stays open),
   * `pending` when it had not finished within 20 s (often the folder-trust question)
   */
  teleport?: { state: 'switched'; branch: string } | { state: 'failed' | 'pending'; message: string };
}

/**
 * `kunj agent saved [branch] --json`: Claude conversations of the worktree's agent sessions that are
 * not running (a closed tab, an ended session, a reboot), newest first. `kunj agent start --session
 * <id> --resume` (no --session for a null id) continues one.
 */
export interface AgentSavedJson {
  branch: string;
  worktree: string;
  items: Array<{
    /** The tmux session the agent ran in */
    session: string;
    /** Its `--session <id>`; null for the default session */
    id: string | null;
    /** Claude Code's session id, what `claude --resume` takes */
    conversation: string;
    /** Ended by agent.suspendAfterMinutes; its next `kunj agent start` resumes it */
    suspended?: boolean;
    /** When the conversation was saved (ISO 8601): it started, or /clear began a new one */
    savedAt: string;
    /** The conversation's first prompt, shortened; null when it has none yet */
    title: string | null;
  }>;
}

/** `kunj agent forget [branch] (--session <id> | --all) --json` */
export interface AgentForgetJson {
  branch: string;
  /** The tmux sessions whose saved conversation was removed */
  forgotten: string[];
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
  | { type: 'agent'; session: string; running: boolean; state?: 'running' | 'waiting' | null; repo?: { name: string; root: string };
      /** A new session's `--session` id (null: the default one), from the tmux poll */
      id?: string | null;
      /** A new session's worktree (its @kunj_worktree tag), from the tmux poll */
      worktree?: string;
      /** `app` when `kunj agent start --open-in-app` started it: the workspace app opens and focuses it */
      open?: 'app' }
  /**
   * An agent's plan record changed (`kunj agent plan` and `kunj agent overview` have something new).
   * `session` for a host agent, `container` (with `branch`) for the agents of a branch container.
   * Its own type, so a consumer that does not draw plans ignores it and runs no listing.
   */
  | { type: 'plan'; repo?: { name: string; root: string } | null; session?: string; container?: string; branch?: string | null }
  | { type: 'backend'; status: 'available' | 'unavailable'; message?: string }
  /** A cloud machine appeared, changed state or went away (`state: 'deleted'`), as its coordinator lists it */
  | { type: 'machine'; repo: { name: string; root: string } | null; branch: string; machine: string; state: MachineJson['state'] | 'deleted' }
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
/** `kunj lsp list --json`: the language servers the workspace app may start, and its lifecycle numbers. */
export interface LspListJson {
  servers: Array<{
    language: string;
    command: string[];
    extensions: string[];
    /** cached: keeps an index on disk, cheap to restart; cold: re-reads the project */
    restart: 'cached' | 'cold';
    cachePaths: string[];
    installed: boolean;
    /** Where the program was found */
    path?: string;
    /** How to install it when it is missing */
    install?: string;
  }>;
  idleStopMinutes: { cached: number; cold: number };
  closedStopMinutes: number;
  maxServers: number;
  readyTimeoutMs: number;
}

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

// `kunj config --schema --json`: every registered setting, for the workspace app's Settings window
// (docs/specs/workspace-settings.md)
export interface ConfigSettingJson {
  key: string;
  // One of ConfigSchemaJson.categories[].id
  category: string;
  type: 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'object';
  default: unknown;
  description: string;
  detailedDescription?: string;
  // For type 'enum'
  options?: string[];
  examples?: string[];
  // The value is a credential: never display it
  sensitive?: boolean;
}

export interface ConfigSchemaJson {
  // In display order
  categories: { id: string; title: string }[];
  settings: ConfigSettingJson[];
}

// `kunj config --set-json <key>=<json> --json`
export interface ConfigSetJson {
  key: string;
  value: unknown;
  scope: 'global' | 'local';
}

// `kunj config --unset <key> --json`
export interface ConfigUnsetJson {
  key: string;
  scope: 'global' | 'local';
  removed: boolean;
}

/** `kunj ct cache status --json` */
export interface ContainerCacheJson {
  caches: Array<{ name: string; path: string; volume: string }>;
  /** The coordinator's cache store (machine.cache); null when there is none or it is not a cloud machine */
  store: { kind: 'bucket'; location: string } | null;
}

/** `kunj ct cache pull|push --json` */
export interface ContainerCacheSyncJson {
  success: boolean;
  branch: string;
  direction: 'pull' | 'push';
  store: { kind: 'bucket'; location: string };
  caches: Array<{ name: string; action: 'pulled' | 'pushed' | 'empty' | 'failed'; message?: string }>;
}

/** One stop on an agent's line: a task of Claude's task list (`kunj agent plan`). */
export interface AgentPlanStepJson {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** ISO times, when the hooks saw the change */
  startedAt?: string;
  completedAt?: string;
}

/** Something that happened between two stops. `afterStep` indexes `steps`; null: before any step. */
export interface AgentPlanMarkerJson {
  /** `new`: a new conversation (/clear or a fresh start) begins after `afterStep` */
  type: 'branch' | 'worktree' | 'fork' | 'compact' | 'new';
  afterStep: number | null;
  from?: string;
  to?: string;
  at: string;
}

/** A subagent of the session: a loop from `fromStep` to `toStep` with its own steps. */
export interface AgentPlanSubagentJson {
  id: string;
  type: string;
  /** Tool calls it made (recorded for every subagent; a background one keeps no task list, so this is
   * all there is to show of its progress). Absent when none was recorded */
  toolCalls?: number;
  /** The tool of its latest call */
  lastTool?: string;
  /** The short description the agent gave it; null when the hooks did not see one */
  task: string | null;
  fromStep: number | null;
  /** null while it runs */
  toStep: number | null;
  running: boolean;
  steps: AgentPlanStepJson[];
}

/** One agent session's plan, as its hooks recorded it. */
export interface AgentPlanItemJson {
  session: string;
  /** The `--session <id>`; null for the default session */
  id: string | null;
  branch: string;
  worktree: string;
  /** The container's name, for a branch container's agent */
  container?: string;
  /** First heading of the plan from plan mode, else the conversation's first prompt */
  title: string | null;
  /** null: tmux could not be asked */
  running: boolean | null;
  state: 'running' | 'waiting' | null;
  steps: AgentPlanStepJson[];
  /** Index into `steps` of the step in progress (else the next one to do); null: none left, or no steps */
  current: number | null;
  markers: AgentPlanMarkerJson[];
  subagents: AgentPlanSubagentJson[];
  /** The session that started this one (a handoff) and the step it was on */
  parent?: { session: string; step: number | null };
  /** ISO time of the last recorded change; null when nothing was recorded */
  updatedAt: string | null;
}

/**
 * `kunj agent plan [branch] --json`: where each agent session of the worktree is in its plan
 * (`--all`: of every worktree of the repository). Sessions that are not running are
 * listed too while their record exists.
 */
export interface AgentPlanJson {
  plans: AgentPlanItemJson[];
}

// ---- kunj agent overview --json --------------------------------------------------------------
// Everything a consumer needs to draw the agents of a repository as lines of stops: which agents,
// their text and every position. A consumer only strokes it (docs/specs/agent-overview.md).
// Coordinates are in points, y down. Inside a family, x is measured from the right edge of the
// label column (`metrics.labelWidth` wide, where a lane's title, place and status go) and y from
// the family's top; families are stacked by the consumer in the order given.

export interface AgentOverviewStopJson {
  x: number;
  y: number;
  kind: 'done' | 'current' | 'todo';
  /** The step's subject (a tooltip; drawn above the stop, or beside it when `labelBeside`) */
  label: string;
  /** More about it for a hover card under `label`, one line each: "Step 3 of 5 · in progress", "Started 14:02" */
  detail?: string[];
}

/** A subagent: a loop that leaves the line at `fromX`, runs along `y` and rejoins at `toX`. */
export interface AgentOverviewLoopJson {
  fromX: number;
  toX: number;
  /** y of the lane's line, where the loop starts and ends */
  lineY: number;
  y: number;
  running: boolean;
  /** Drawn as done from `fromX` along the bottom up to here; the whole loop once it ended */
  doneToX: number;
  stops: AgentOverviewStopJson[];
  label: string;
  /** More about the subagent for a hover card under `label`: its type, task, progress, tool calls */
  detail?: string[];
  /** Several subagents with this one span (a fan-out), drawn as one stacked loop with a "×count" badge;
   * its stops are then one per subagent (finished ones first). Absent for one subagent */
  count?: number;
}

/** A branch or worktree change (or a fork): a diamond on the line at `x`,`y`, its label at `labelY`. */
export interface AgentOverviewMarkerJson {
  x: number;
  y: number;
  labelY: number;
  /** "branch: main → feat/x", "worktree: a → b", "fork", "new conversation" */
  label: string;
  /** What happened, so a consumer can tell a branch change from the rest; absent from an older kunj */
  kind?: 'branch' | 'worktree' | 'fork' | 'new';
  /** More about it for a hover card under `label`: "Switched branch", "From: main", "To: feat/x", "At 14:03" */
  detail?: string[];
}

export interface AgentOverviewLaneJson {
  session: string;
  id: string | null;
  branch: string;
  worktree: string;
  container?: string;
  /** The label column's three lines */
  title: string;
  place: string;
  status: string;
  waiting: boolean;
  /** A handed-off agent: indented under the lane it branches from */
  child: boolean;
  top: number;
  height: number;
  /** y of the line */
  y: number;
  stops: AgentOverviewStopJson[];
  /** The line between the first and last stop; absent with fewer than two stops */
  line?: { fromX: number; toX: number; /** drawn as done up to here; null: none of it */ doneToX: number | null };
  loops: AgentOverviewLoopJson[];
  markers: AgentOverviewMarkerJson[];
  /** The elbow from the parent's stop down to this lane's line; `label` ("handoff → feat/x") goes at its corner */
  elbow?: { fromX: number; fromY: number; toX: number; toY: number; label?: string; detail?: string[] };
  /** No task list: the one stop's label goes right of it */
  labelBeside: boolean;
  /** The agent ended: its last plan, drawn dimmed (only the newest of a place that has no running agent) */
  ended?: boolean;
  /** More about the agent for a hover card under `title`: branch, worktree or container, status, current step, handoff, last change */
  detail?: string[];
}

/** An agent with the agents it handed work to: `lanes[0]` is the root. */
export interface AgentOverviewFamilyJson {
  width: number;
  height: number;
  lanes: AgentOverviewLaneJson[];
}

/**
 * `kunj agent overview [--containers] --json`: the running agents of the repository, grouped and
 * laid out. Ended sessions are left out. `containers` is present with `--containers`: whether the
 * branch containers could be asked (their agents are among the families when they could).
 */
export interface AgentOverviewJson {
  repo: { name: string; root: string };
  agents: number;
  waiting: number;
  /** "3 agents · 1 waiting for you" */
  summary: string;
  metrics: { labelWidth: number; stopSpacing: number };
  families: AgentOverviewFamilyJson[];
  containers?: { available: boolean; message?: string; /** Branches whose running container has an agent but could not be read */ unreadable?: string[] };
}
