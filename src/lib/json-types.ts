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

/** What a command prints (as JSON) when it fails in `--json` mode. */
export interface ErrorJson {
  error: { code: string; message: string };
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
}
