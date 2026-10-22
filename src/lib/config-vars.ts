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

function substitute(value: string, vars: ConfigVariables, format: (resolved: string) => string): string {
  if (!hasVariables(value)) return value;
  const lookup = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(VARIABLE_PATTERN, (match, name: string) => {
    const resolved = lookup.get(name.toLowerCase());
    return resolved === undefined ? match : format(resolved);
  });
}

export function expandVariables(value: string, vars: ConfigVariables): string {
  return substitute(value, vars, resolved => resolved);
}

// POSIX single-quoting: nothing inside is interpreted by the shell
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Inside "...": only \, $, ` and " are special, so escaping them keeps the value literal
function doubleQuoteEscape(value: string): string {
  return value.replace(/[\\$`"]/g, '\\$&');
}

const VARIABLE_AT = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/y;

// Inside `...` the shell first strips one level of backslashes before \, ` and $, and a bare `
// ends the substitution whatever the quoting, so a value in there is escaped once more
function backtickEscape(value: string): string {
  return value.replace(/[\\`$]/g, '\\$&');
}

interface QuoteFrame {
  kind: 'top' | 'subst' | 'backtick';
  quote: 'none' | 'single' | 'double';
  /** Unbalanced "(" inside a $(...), so its own ")" is not taken for the end */
  depth: number;
}

/**
 * For text that goes to a shell: a branch name like x$(cmd) must stay data, however the command
 * quotes the variable. The quoting context is tracked with POSIX rules, including $(...) and
 * `...`, which open a fresh unquoted context even inside "...": bare values are single-quoted,
 * values inside "..." have \ $ ` and " escaped, values inside '...' are spliced in with '\'' for
 * their own quotes, and inside backticks the result is escaped once more.
 */
export function expandVariablesQuoted(value: string, vars: ConfigVariables): string {
  if (!hasVariables(value)) return value;
  const lookup = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  const frames: QuoteFrame[] = [{ kind: 'top', quote: 'none', depth: 0 }];
  let out = '';
  let i = 0;
  while (i < value.length) {
    const f = frames[frames.length - 1];
    const c = value[i];
    if (c === '$') {
      VARIABLE_AT.lastIndex = i;
      const m = VARIABLE_AT.exec(value);
      const resolved = m ? lookup.get(m[1].toLowerCase()) : undefined;
      if (m && resolved !== undefined) {
        let text = f.quote === 'none' ? shellQuote(resolved) : f.quote === 'double' ? doubleQuoteEscape(resolved) : resolved.replace(/'/g, `'\\''`);
        for (let k = frames.length - 1; k >= 0; k--) if (frames[k].kind === 'backtick') text = backtickEscape(text);
        out += text;
        i += m[0].length;
        continue;
      }
    }
    if (f.quote === 'single') {
      if (c === "'") f.quote = 'none';
      out += c;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < value.length) {
      out += c + value[i + 1];
      i += 2;
      continue;
    }
    if (c === '$' && value[i + 1] === '(') {
      frames.push({ kind: 'subst', quote: 'none', depth: 0 });
      out += '$(';
      i += 2;
      continue;
    }
    if (c === '`') {
      if (f.kind === 'backtick') frames.pop();
      else frames.push({ kind: 'backtick', quote: 'none', depth: 0 });
      out += c;
      i++;
      continue;
    }
    if (f.quote === 'double') {
      if (c === '"') f.quote = 'none';
    } else if (c === "'") {
      f.quote = 'single';
    } else if (c === '"') {
      f.quote = 'double';
    } else if (f.kind === 'subst' && c === '(') {
      f.depth++;
    } else if (f.kind === 'subst' && c === ')') {
      if (f.depth > 0) f.depth--;
      else frames.pop();
    }
    out += c;
    i++;
  }
  return out;
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
