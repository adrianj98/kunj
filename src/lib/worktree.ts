// Git worktree operations for the `kunj tree` command

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { KunjConfig } from '../types';
import { getKunjDir, getRepoCommonRoot, getRepoName } from './config';

const execAsync = promisify(exec);

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null when detached or bare
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

// Folder name for a branch: feature/bob -> feature_bob
export function worktreeFolderName(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[\/\\]+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_');
}

// Expand ~ and {repo} in a configured path
export function expandWorktreePath(value: string, repoName: string, baseDir: string): string {
  let p = value.trim();
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  p = p.replace(/\{repo\}/g, repoName);
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

// Resolve the base directory where worktrees are created
export function resolveWorktreeDir(config: KunjConfig): string {
  const configured = config.worktree?.dir?.trim();
  if (!configured) {
    return path.join(getKunjDir(), 'worktrees');
  }
  const repoName = getRepoName() || 'repo';
  const baseDir = getRepoCommonRoot() || process.cwd();
  return expandWorktreePath(configured, repoName, baseDir);
}

// Target path for a branch's worktree
export function getWorktreePathForBranch(branch: string, config: KunjConfig): string {
  return path.join(resolveWorktreeDir(config), worktreeFolderName(branch));
}

// Parse `git worktree list --porcelain`
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current) {
        result.push(current);
        current = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), head: '', branch: null, bare: false, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

// List all worktrees of the current repository (excluding bare entries)
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const { stdout } = await execAsync('git worktree list --porcelain');
  return parseWorktreeList(stdout).filter(w => !w.bare);
}

// Find the worktree that has a branch checked out, if any
export async function findWorktreeForBranch(branch: string): Promise<WorktreeInfo | undefined> {
  const worktrees = await listWorktrees();
  return worktrees.find(w => w.branch === branch);
}

// Root of the worktree the command was run from
export async function getCurrentWorktreeRoot(): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --show-toplevel');
  return stdout.trim();
}

async function refExists(ref: string): Promise<boolean> {
  try {
    await execAsync(`git show-ref --verify --quiet ${ref}`);
    return true;
  } catch {
    return false;
  }
}

export interface CreateWorktreeResult {
  path: string;
  createdBranch: boolean;
  baseBranch?: string;
}

// Create a worktree for a branch, creating the branch if needed
export async function createWorktree(branch: string, targetPath: string): Promise<CreateWorktreeResult> {
  if (fs.existsSync(targetPath)) {
    throw new Error(`Target directory already exists: ${targetPath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const quotedPath = JSON.stringify(targetPath);
  const localExists = await refExists(`refs/heads/${branch}`);
  const remoteExists = !localExists && (await refExists(`refs/remotes/origin/${branch}`));

  if (localExists) {
    await execAsync(`git worktree add ${quotedPath} ${JSON.stringify(branch)}`);
    return { path: targetPath, createdBranch: false };
  }

  if (remoteExists) {
    await execAsync(
      `git worktree add --track -b ${JSON.stringify(branch)} ${quotedPath} ${JSON.stringify(`origin/${branch}`)}`
    );
    return { path: targetPath, createdBranch: true, baseBranch: `origin/${branch}` };
  }

  let base = 'HEAD';
  try {
    const { stdout } = await execAsync('git branch --show-current');
    if (stdout.trim()) {
      base = stdout.trim();
    }
  } catch {
    // fall back to HEAD
  }
  await execAsync(`git worktree add -b ${JSON.stringify(branch)} ${quotedPath} ${JSON.stringify(base)}`);
  return { path: targetPath, createdBranch: true, baseBranch: base };
}

// Remove a worktree (and optionally force removal of dirty trees)
export async function removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
  const forceFlag = force ? ' --force' : '';
  await execAsync(`git worktree remove${forceFlag} ${JSON.stringify(worktreePath)}`);
}

const VSCODE_LIKE = new Set(['code', 'code-insiders', 'cursor', 'codium', 'windsurf']);

export interface OpenOptions {
  newWindow?: boolean;
  existing?: boolean; // worktree already existed; let the editor focus an open window
}

// Build the argv used to open a worktree in the configured editor
export function buildOpenCommand(command: string, targetPath: string, options: OpenOptions = {}): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const bin = path.basename(parts[0]);
  const args = parts.slice(1);
  if (VSCODE_LIKE.has(bin)) {
    if (options.newWindow) {
      args.push('-n');
    } else if (!options.existing) {
      args.push('-r');
    }
  }
  args.push(targetPath);
  return [parts[0], ...args];
}

// Open a worktree in the configured editor. Returns false if nothing was opened.
export async function openWorktree(command: string, targetPath: string, options: OpenOptions = {}): Promise<boolean> {
  const argv = buildOpenCommand(command, targetPath, options);
  if (!argv) {
    return false;
  }
  return new Promise<boolean>(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
