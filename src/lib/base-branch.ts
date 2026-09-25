// Base branch for new branches: `--base`, else preferences.defaultBaseBranch, else the
// repository's default branch - taken from origin (after a fetch) unless that is turned off.
// Only child_process imports: `kunj worktree add` uses this on the fast path.

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const REMOTE = 'origin';

export interface BaseRefOptions {
  // Explicit base from --base; wins over the configured default
  base?: string;
  // preferences.defaultBaseBranch
  defaultBase?: string;
  // preferences.baseFromOrigin (default true); --no-origin turns it off for one run
  fromOrigin?: boolean;
  cwd?: string;
}

export interface ResolvedBase {
  // What to pass to git as the start point, e.g. origin/main or main
  ref: string;
  // The branch name it came from, without the remote
  branch: string;
  fromOrigin: boolean;
  // Set when origin was wanted but could not be used and the local branch was taken instead
  warning?: string;
}

function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function git(args: string, cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git ${args}`, { cwd: cwd || process.cwd() });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function refExists(ref: string, cwd?: string): Promise<boolean> {
  return (await git(`rev-parse --verify --quiet ${quote(`${ref}^{commit}`)}`, cwd)) !== null;
}

// The repository's default branch: origin/HEAD, else main or master, locally or on origin
export async function detectDefaultBranch(cwd?: string): Promise<string | null> {
  const head = await git(`symbolic-ref --quiet --short refs/remotes/${REMOTE}/HEAD`, cwd);
  if (head && head.startsWith(`${REMOTE}/`)) {
    return head.slice(REMOTE.length + 1);
  }
  for (const name of ['main', 'master']) {
    if (await refExists(`refs/heads/${name}`, cwd) || await refExists(`refs/remotes/${REMOTE}/${name}`, cwd)) {
      return name;
    }
  }
  return null;
}

// Work out the start point for a new branch. Returns null when there is nothing to base on
// (no --base, no setting and no main/master), in which case git's default of HEAD applies.
export async function resolveBaseRef(options: BaseRefOptions = {}): Promise<ResolvedBase | null> {
  const { cwd } = options;
  const requested = options.base?.trim() || options.defaultBase?.trim() || (await detectDefaultBranch(cwd));
  if (!requested) {
    return null;
  }

  const hasOrigin = (await git(`remote get-url ${REMOTE}`, cwd)) !== null;
  // `--base origin/main` names the remote branch directly
  const branch = hasOrigin && requested.startsWith(`${REMOTE}/`) ? requested.slice(REMOTE.length + 1) : requested;
  // A commit, tag or HEAD~n that is not a branch here or on origin is used as given
  const isBranch = (await refExists(`refs/heads/${branch}`, cwd)) || (await refExists(`refs/remotes/${REMOTE}/${branch}`, cwd));
  if (!isBranch && branch === requested && (await refExists(requested, cwd))) {
    return { ref: requested, branch: requested, fromOrigin: false };
  }
  const wantOrigin = hasOrigin && (options.fromOrigin !== false || branch !== requested);

  let warning: string | undefined;
  if (wantOrigin) {
    const remoteRef = `refs/remotes/${REMOTE}/${branch}`;
    const fetched = (await git(`fetch --quiet ${REMOTE} ${quote(branch)}`, cwd)) !== null;
    if (fetched && (await refExists(remoteRef, cwd))) {
      return { ref: `${REMOTE}/${branch}`, branch, fromOrigin: true };
    }
    if (!fetched && (await refExists(remoteRef, cwd))) {
      // Offline: the last fetched copy beats a possibly older local branch
      return {
        ref: `${REMOTE}/${branch}`,
        branch,
        fromOrigin: true,
        warning: `Could not fetch ${REMOTE}/${branch}; using the last fetched copy`,
      };
    }
    warning = `'${branch}' is not on ${REMOTE}; using the local branch`;
  }

  if (await refExists(branch, cwd)) {
    return { ref: branch, branch, fromOrigin: false, warning };
  }
  const error = new Error(`Base branch '${requested}' not found${hasOrigin ? ` locally or on ${REMOTE}` : ''}`);
  // BaseCommand prints this without a stack trace
  error.name = 'BaseBranchError';
  throw error;
}

// Human readable "from X" for log lines
export function describeBase(base: ResolvedBase | null): string {
  return base ? ` from ${base.ref}` : '';
}
