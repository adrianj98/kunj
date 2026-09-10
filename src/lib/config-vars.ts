// Variable expansion for configuration values.
//
// Any string in the config may reference repository-derived values with the
// ${name} syntax, e.g. "${repoconfig}/kunj/worktrees". Names are matched
// case-insensitively, and an unknown name is left in place verbatim so a
// literal ${...} in a prompt or commit template survives untouched.

import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type ConfigVariables = Record<string, string>;

// The repository-derived variables, named so callers can rely on them
export interface RepoVariables extends ConfigVariables {
  repoconfig: string;
  repoRoot: string;
  repoName: string;
  home: string;
}

// Documented for `kunj config`; keep in step with resolveConfigVariables
export const CONFIG_VARIABLES: Array<{ name: string; description: string }> = [
  { name: 'repoconfig', description: 'The .git directory (the repository itself when bare)' },
  { name: 'repoRoot', description: 'Main worktree directory' },
  { name: 'repoName', description: 'Basename of the main worktree directory' },
  { name: 'home', description: 'Home directory' },
  { name: 'branch', description: 'Branch name, where a branch is in scope' },
  { name: 'worktree', description: 'Worktree path, where a worktree is in scope (hooks)' },
];

const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Cheap guard so callers can skip resolving variables nothing references
export function hasVariables(value: string): boolean {
  return value.includes('${');
}

export function expandVariables(value: string, vars: ConfigVariables): string {
  if (!hasVariables(value)) return value;
  const lookup = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(VARIABLE_PATTERN, (match, name: string) => {
    const resolved = lookup.get(name.toLowerCase());
    return resolved === undefined ? match : resolved;
  });
}

// Repo variables derived from an already-known common dir, so callers that
// have run `git rev-parse` do not pay for a second subprocess
export function repoVariables(commonDir: string): RepoVariables {
  const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return {
    repoconfig: commonDir,
    repoRoot,
    repoName: path.basename(repoRoot),
    home: os.homedir(),
  };
}

// One git call per cwd; outside a repository only ${home} is available
const variableCache = new Map<string, ConfigVariables>();

export async function resolveConfigVariables(
  cwd: string = process.cwd(),
  extra: ConfigVariables = {}
): Promise<ConfigVariables> {
  let base = variableCache.get(cwd);
  if (!base) {
    base = { home: os.homedir() };
    try {
      const { stdout } = await execAsync('git rev-parse --path-format=absolute --git-common-dir', { cwd });
      const commonDir = stdout.trim();
      if (commonDir) base = repoVariables(commonDir);
    } catch {
      // Not a git repository - leave the repo variables unresolved
    }
    variableCache.set(cwd, base);
  }
  return { ...base, ...extra };
}

// True when any string in the tree references a variable
export function treeHasVariables(value: unknown): boolean {
  if (typeof value === 'string') return hasVariables(value);
  if (Array.isArray(value)) return value.some(treeHasVariables);
  if (value && typeof value === 'object') return Object.values(value).some(treeHasVariables);
  return false;
}

// Deep-expand every string in a config tree
export function expandConfigStrings<T>(value: T, vars: ConfigVariables): T {
  if (typeof value === 'string') return expandVariables(value, vars) as unknown as T;
  if (Array.isArray(value)) return value.map(v => expandConfigStrings(v, vars)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandConfigStrings(item, vars);
    return out as T;
  }
  return value;
}
