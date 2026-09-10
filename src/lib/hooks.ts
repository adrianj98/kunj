// Hooks: user scripts that kunj runs at well-defined points, like git hooks.
//
// A hook can be provided in three ways; everything found runs, in this order:
//   1. Executable files in ~/.kunj/hooks/                (global, every repository)
//   2. Executable files in ~/.kunj/{reponame}/hooks/     (this repository)
//      In both places a hook is either a single file named after the hook
//      (e.g. post-worktree-create) or a directory <name>.d/ whose executables
//      run in sorted order. *.sample files and dotfiles are ignored.
//   3. Commands in config: "hooks": { "<name>": "cmd" | ["cmd", ...] }
//      Run through the shell with ${...} config variables expanded, plus
//      ${branch} and ${worktree} where those are in scope.
//
// Scripts receive the hook's positional arguments (see HOOKS) and a KUNJ_*
// environment describing the repository and the object being acted on.
// A pre-* hook that exits non-zero aborts the operation; post-* failures are
// reported but do not undo anything.
//
// This module is imported by the worktree fast path: keep it free of heavy
// imports and of git subprocesses (callers pass the repository variables in).
// The hook names and descriptions live in hook-defs.ts, which has no imports,
// so the settings registry (loaded by config.ts) can use them without a cycle.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalKunjDir, getKunjDir } from './config';
import { ConfigVariables, RepoVariables, expandVariables } from './config-vars';
import { HOOKS_DIR, HOOK_NAMES, HookName, HookDefinition, getHookDefinition } from './hook-defs';

export * from './hook-defs';

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export type HookScope = 'global' | 'repo';

// ~/.kunj/hooks (global) or ~/.kunj/{reponame}/hooks (repo)
export function getHooksDir(scope: HookScope): string {
  return path.join(scope === 'global' ? getGlobalKunjDir() : getKunjDir(), HOOKS_DIR);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface HookScript {
  scope: HookScope;
  path: string;
  executable: boolean;
}

function isExecutable(file: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isHookFileName(name: string): boolean {
  return !name.startsWith('.') && !name.endsWith('.sample');
}

// Scripts for a hook in one hooks directory: the file <name> and then <name>.d/*
function scriptsIn(dir: string, name: string, scope: HookScope): HookScript[] {
  const found: HookScript[] = [];
  const single = path.join(dir, name);
  try {
    if (fs.statSync(single).isFile()) {
      found.push({ scope, path: single, executable: isExecutable(single) });
    }
  } catch {
    // no single-file hook
  }
  const dropIn = path.join(dir, `${name}.d`);
  try {
    const entries = fs
      .readdirSync(dropIn, { withFileTypes: true })
      .filter(e => e.isFile() && isHookFileName(e.name))
      .map(e => e.name)
      .sort();
    for (const entry of entries) {
      const file = path.join(dropIn, entry);
      found.push({ scope, path: file, executable: isExecutable(file) });
    }
  } catch {
    // no drop-in directory
  }
  return found;
}

export function findHookScripts(name: HookName): HookScript[] {
  return [...scriptsIn(getHooksDir('global'), name, 'global'), ...scriptsIn(getHooksDir('repo'), name, 'repo')];
}

// The hooks section of the config: a string or list of strings per hook
export type HooksConfig = Partial<Record<HookName, string | string[]>>;

export function configuredHookCommands(name: HookName, hooks: HooksConfig | undefined): string[] {
  const value = hooks?.[name];
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map(c => c.trim());
}

// Everything that would run for a hook, for `kunj hooks list`
export interface HookSource {
  kind: 'script' | 'config';
  scope: HookScope | 'config';
  // Script path, or the configured command
  target: string;
  executable: boolean;
}

export function listHookSources(name: HookName, hooks: HooksConfig | undefined): HookSource[] {
  const scripts = findHookScripts(name).map<HookSource>(s => ({
    kind: 'script',
    scope: s.scope,
    target: s.path,
    executable: s.executable,
  }));
  const commands = configuredHookCommands(name, hooks).map<HookSource>(c => ({
    kind: 'config',
    scope: 'config',
    target: c,
    executable: true,
  }));
  return [...scripts, ...commands];
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface HookContext {
  // Positional arguments handed to scripts, matching HookDefinition.args
  args: string[];
  // Directory the hook runs in
  cwd: string;
  // Extra KUNJ_* environment for the hook
  env: Record<string, string>;
  // ${...} variables available to configured commands (on top of the repo ones)
  vars: ConfigVariables;
}

// Context for the worktree hooks: run inside the worktree when it exists,
// otherwise from the main worktree (or the bare repository directory)
export function worktreeHookContext(repo: RepoVariables, worktreePath: string, branch: string | null): HookContext {
  const branchName = branch || '';
  return {
    args: [worktreePath, branchName],
    cwd: fs.existsSync(worktreePath) ? worktreePath : repo.repoRoot,
    env: {
      KUNJ_REPO_ROOT: repo.repoRoot,
      KUNJ_REPO_CONFIG: repo.repoconfig,
      KUNJ_REPO_NAME: repo.repoName,
      KUNJ_WORKTREE_PATH: worktreePath,
      KUNJ_BRANCH: branchName,
    },
    vars: { ...repo, branch: branchName, worktree: worktreePath },
  };
}

export interface RunHookOptions {
  // The config's hooks section; omit to run scripts only
  hooks?: HooksConfig;
  // Send hook stdout to stderr and give hooks no stdin, so `--json` output stays clean
  jsonMode?: boolean;
  // Do not run anything (e.g. --no-hooks); the result records the skip
  skip?: boolean;
}

export interface HookExecution {
  kind: 'script' | 'config';
  // Script path, or the configured command as written
  source: string;
  // What actually ran (the command after variable expansion)
  command: string;
  status: 'ok' | 'failed' | 'skipped';
  exitCode: number | null;
  signal: string | null;
  // Why a hook was skipped, or what went wrong starting it
  reason?: string;
  durationMs: number;
}

export interface HookRunResult {
  hook: HookName;
  // False when the caller asked to skip hooks
  enabled: boolean;
  executions: HookExecution[];
  // True when every hook that ran exited 0 (skipped hooks do not count)
  ok: boolean;
}

// Thrown when a pre-* hook fails. `result` has the details.
export class HookError extends Error {
  readonly result!: HookRunResult;
  constructor(result: HookRunResult) {
    super(describeHookFailure(result));
    this.name = 'HookError';
    // Non-enumerable so console.error(error) shows the message, not the whole result
    Object.defineProperty(this, 'result', { value: result, enumerable: false });
  }
}

export function failedExecutions(result: HookRunResult): HookExecution[] {
  return result.executions.filter(e => e.status === 'failed');
}

export function describeHookFailure(result: HookRunResult): string {
  const failed = failedExecutions(result);
  if (failed.length === 0) return `${result.hook} hook failed`;
  const first = failed[0];
  const how = first.signal
    ? `killed by ${first.signal}`
    : first.exitCode !== null
      ? `exit code ${first.exitCode}`
      : first.reason || 'could not run';
  return `${result.hook} hook failed (${how}): ${first.source}`;
}

interface SpawnSpec {
  file: string;
  args: string[];
  shell: boolean;
}

function spawnHook(spec: SpawnSpec, context: HookContext, jsonMode: boolean): Promise<Omit<HookExecution, 'kind' | 'source' | 'command'>> {
  const started = Date.now();
  return new Promise(resolve => {
    const finish = (partial: Partial<HookExecution>) =>
      resolve({
        status: 'failed',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        ...partial,
      });
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: context.cwd,
        env: { ...process.env, ...context.env },
        shell: spec.shell,
        // Hook output goes to the terminal, but never into our JSON stdout
        stdio: jsonMode ? ['ignore', 2, 2] : ['inherit', 'inherit', 'inherit'],
      });
    } catch (error: any) {
      finish({ reason: error?.message || String(error) });
      return;
    }
    child.on('error', error => finish({ reason: error.message }));
    child.on('close', (code, signal) =>
      finish({ status: code === 0 ? 'ok' : 'failed', exitCode: code, signal: signal || null })
    );
  });
}

// Run every script and configured command for a hook. Throws HookError when
// a hook that aborts on failure (pre-*) fails; later hooks are not run then.
export async function runHook(name: HookName, context: HookContext, options: RunHookOptions = {}): Promise<HookRunResult> {
  const definition = getHookDefinition(name);
  if (!definition) {
    throw new Error(`Unknown hook '${name}'. Known hooks: ${HOOK_NAMES.join(', ')}`);
  }
  const result: HookRunResult = { hook: name, enabled: !options.skip, executions: [], ok: true };
  if (options.skip) return result;

  const jsonMode = options.jsonMode === true;
  const env = { ...context.env, KUNJ_HOOK: name };
  const runContext: HookContext = { ...context, env };

  const queue: Array<{ kind: 'script' | 'config'; source: string; command: string; spec: SpawnSpec | null; reason?: string }> = [];
  for (const script of findHookScripts(name)) {
    queue.push(
      script.executable
        ? { kind: 'script', source: script.path, command: script.path, spec: { file: script.path, args: context.args, shell: process.platform === 'win32' } }
        : { kind: 'script', source: script.path, command: script.path, spec: null, reason: 'not executable (chmod +x to enable)' }
    );
  }
  for (const configured of configuredHookCommands(name, options.hooks)) {
    const command = expandVariables(configured, runContext.vars);
    queue.push({ kind: 'config', source: configured, command, spec: { file: command, args: [], shell: true } });
  }

  for (const item of queue) {
    if (!item.spec) {
      result.executions.push({
        kind: item.kind,
        source: item.source,
        command: item.command,
        status: 'skipped',
        exitCode: null,
        signal: null,
        reason: item.reason,
        durationMs: 0,
      });
      continue;
    }
    const outcome = await spawnHook(item.spec, runContext, jsonMode);
    result.executions.push({ kind: item.kind, source: item.source, command: item.command, ...outcome });
    if (outcome.status === 'failed') {
      result.ok = false;
      if (definition.abortsOnFailure) {
        throw new HookError(result);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scaffolding (`kunj hooks add`)
// ---------------------------------------------------------------------------

export function hookTemplate(definition: HookDefinition): string {
  const argLines = definition.args.map((a, i) => `#   $${i + 1}  ${a}`).join('\n');
  const envLines = ['KUNJ_HOOK', 'KUNJ_REPO_ROOT', 'KUNJ_REPO_CONFIG', 'KUNJ_REPO_NAME', ...definition.env]
    .map(e => `#   ${e}`)
    .join('\n');
  return [
    '#!/bin/sh',
    `# kunj ${definition.name} hook`,
    `# ${definition.description}`,
    '#',
    '# Arguments:',
    argLines,
    '#',
    '# Environment:',
    envLines,
    '#',
    definition.abortsOnFailure
      ? '# Exit with a non-zero status to abort the operation.'
      : '# The exit status is reported but does not undo the operation.',
    'set -e',
    '',
    `echo "kunj ${definition.name}: $1 ($2)"`,
    '',
  ].join('\n');
}

// Create an executable hook script from the template. Fails if one exists unless force is set.
export function createHookScript(name: HookName, scope: HookScope, force = false): string {
  const definition = getHookDefinition(name);
  if (!definition) {
    throw new Error(`Unknown hook '${name}'. Known hooks: ${HOOK_NAMES.join(', ')}`);
  }
  const dir = getHooksDir(scope);
  const file = path.join(dir, name);
  if (fs.existsSync(file) && !force) {
    throw new Error(`Hook already exists: ${file} (use --force to overwrite)`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, hookTemplate(definition), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}
