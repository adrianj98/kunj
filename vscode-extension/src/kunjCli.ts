// Thin wrapper around the kunj CLI. Every call goes through `kunj ... --json`
// so the extension never talks to git directly.

import { spawn } from 'child_process';
import * as vscode from 'vscode';

export class KunjCliError extends Error {
  constructor(
    message: string,
    public readonly code: 'not-found' | 'not-a-repo' | 'command-failed',
    public readonly args: string[]
  ) {
    super(message);
    this.name = 'KunjCliError';
  }
}

export interface WorktreeSession {
  id: string;
  path: string;
  pid: number;
  host: string;
  editor: string;
  label?: string;
  registeredAt: string;
  lastSeen: string;
}

export interface WorktreeStatus {
  dirty: boolean;
  changedFiles: number;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
}

export interface PullRequest {
  provider: 'github' | 'gitlab';
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  url: string;
  draft: boolean;
  baseBranch: string | null;
  headBranch: string;
  reviewDecision: string | null;
  checks: 'success' | 'failure' | 'pending' | null;
  updatedAt: string | null;
}

export interface Worktree {
  path: string;
  name: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMain: boolean;
  exists: boolean;
  isCurrent: boolean;
  sessions: WorktreeSession[];
  status?: WorktreeStatus;
  pullRequest?: PullRequest | null;
}

export interface WorktreeListResult {
  repoRoot: string;
  currentPath: string | null;
  pullRequestLookup?: 'github' | 'gitlab' | 'unavailable' | 'skipped';
  pullRequestsFromCache?: boolean;
  worktrees: Worktree[];
}

export interface BranchListResult {
  branches: Array<{ name: string; current: boolean; lastActivity: string | null; description: string | null }>;
}

function resolveCommand(): { command: string; leadingArgs: string[] } {
  const configured = (vscode.workspace.getConfiguration('kunj').get<string>('cliPath') || 'kunj').trim();
  // Allow "node /path/to/kunj/dist/index.js" style values
  const parts = configured.match(/(?:[^\s"]+|"[^"]*")+/g) || [configured];
  const [command, ...leadingArgs] = parts.map(p => p.replace(/^"|"$/g, ''));
  return { command, leadingArgs };
}

export class KunjCli {
  private readonly output: vscode.OutputChannel;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  // Run `kunj <args> --json` in the given directory and parse the result.
  async run<T>(args: string[], cwd: string): Promise<T> {
    const { command, leadingArgs } = resolveCommand();
    const fullArgs = [...leadingArgs, ...args, '--json'];
    this.output.appendLine(`[${new Date().toISOString()}] ${command} ${fullArgs.join(' ')}  (cwd: ${cwd})`);

    return new Promise<T>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(command, fullArgs, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      child.stdout.on('data', chunk => (stdout += chunk.toString()));
      child.stderr.on('data', chunk => (stderr += chunk.toString()));

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          reject(new KunjCliError(`kunj CLI not found (${command}). Install it with "npm install -g kunj" or set kunj.cliPath.`, 'not-found', args));
        } else {
          reject(new KunjCliError(error.message, 'command-failed', args));
        }
      });

      child.on('close', code => {
        const parsed = this.parseJson(stdout);
        if (code === 0 && parsed !== undefined) {
          resolve(parsed as T);
          return;
        }

        const message: string =
          (parsed && typeof parsed === 'object' && typeof (parsed as any).error === 'string' && (parsed as any).error) ||
          stderr.trim().split('\n').pop() ||
          stdout.trim().split('\n').pop() ||
          `kunj exited with code ${code}`;
        this.output.appendLine(`  ! ${message}`);

        // Windows shells report a missing executable via exit code instead of ENOENT
        if (process.platform === 'win32' && code !== 0 && /not recognized|cannot find|no such file/i.test(stderr)) {
          reject(new KunjCliError(`kunj CLI not found (${command}). Install it with "npm install -g kunj" or set kunj.cliPath.`, 'not-found', args));
          return;
        }

        const isRepoError = /not (a|in a) git repository/i.test(message);
        reject(new KunjCliError(message, isRepoError ? 'not-a-repo' : 'command-failed', args));
      });
    });
  }

  private parseJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      // The CLI may print non-JSON lines before the payload; try the last JSON object
      const start = trimmed.indexOf('{');
      if (start > 0) {
        try {
          return JSON.parse(trimmed.slice(start));
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
  }

  // ---- worktree operations ---------------------------------------------

  listWorktrees(cwd: string, includeStatus: boolean, includePullRequests = true, fresh = false): Promise<WorktreeListResult> {
    const args = ['worktree', 'list'];
    if (!includeStatus) args.push('--no-status');
    if (!includePullRequests) args.push('--no-pr');
    if (fresh) args.push('--fresh');
    return this.run<WorktreeListResult>(args, cwd);
  }

  getPullRequest(cwd: string, target: string): Promise<{ branch: string; path: string; pullRequest: PullRequest | null }> {
    return this.run(['worktree', 'pr', target, '--fresh'], cwd);
  }

  addWorktree(
    cwd: string,
    branch: string,
    options: { path?: string; newBranch?: boolean; base?: string; force?: boolean } = {}
  ): Promise<{ success: boolean; worktree: Worktree }> {
    const args = ['worktree', 'add', branch];
    if (options.path) args.push(options.path);
    if (options.newBranch) args.push('--new-branch');
    if (options.base) args.push('--base', options.base);
    if (options.force) args.push('--force');
    return this.run(args, cwd);
  }

  removeWorktree(cwd: string, target: string, force = false): Promise<{ success: boolean; path: string }> {
    const args = ['worktree', 'remove', target];
    if (force) args.push('--force');
    return this.run(args, cwd);
  }

  pruneWorktrees(cwd: string): Promise<{ success: boolean; output: string }> {
    return this.run(['worktree', 'prune'], cwd);
  }

  resolveWorktreePath(cwd: string, target: string): Promise<{ path: string; branch: string | null; name: string }> {
    return this.run(['worktree', 'path', target], cwd);
  }

  listBranches(cwd: string): Promise<BranchListResult> {
    return this.run<BranchListResult>(['list', '--all'], cwd);
  }

  // ---- editor sessions ---------------------------------------------------

  startSession(cwd: string, options: { path: string; pid: number; label?: string; id?: string }): Promise<{ session: WorktreeSession }> {
    const args = ['worktree', 'session', 'start', '--path', options.path, '--pid', String(options.pid), '--editor', 'vscode'];
    if (options.label) args.push('--label', options.label);
    if (options.id) args.push('--id', options.id);
    return this.run(args, cwd);
  }

  endSession(cwd: string, options: { id?: string; pid?: number; path?: string }): Promise<{ removed: number }> {
    const args = ['worktree', 'session', 'end'];
    if (options.id) args.push('--id', options.id);
    if (options.pid !== undefined) args.push('--pid', String(options.pid));
    if (options.path) args.push('--path', options.path);
    return this.run(args, cwd);
  }
}
