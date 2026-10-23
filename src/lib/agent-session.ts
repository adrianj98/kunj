// Host tmux sessions for worktree agents (`kunj agent`).
//
// One tmux server serves the whole host, so the session name must be unique per repository and
// branch: it is the container name (readable part plus a hash of repo id and branch) made safe for
// tmux, which treats `.` and `:` as target separators.

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { containerNames } from './container/names';

const execFileAsync = promisify(execFile);

export type AgentErrorCode = 'tmux-missing' | 'no-tty' | 'not-running' | 'no-worktree';

// Expected outcomes: printed without a stack trace
export class AgentError extends Error {
  constructor(public code: AgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export function agentSessionName(repoName: string, repoId: string, branch: string): string {
  return containerNames(repoName, repoId, branch).container.replace(/[.:]/g, '-');
}

// null: tmux is not installed. []: tmux is installed but has no server (or no sessions).
export async function listTmuxSessions(): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return [];
  }
}

export function agentRunning(sessions: string[] | null, name: string): boolean | null {
  return sessions === null ? null : sessions.includes(name);
}

// -u: UTF-8 even without a locale. window-size latest: the size follows the client that attached last.
// tmux runs a single command argument through the shell, so the setting keeps its quoting.
export function agentArgv(name: string, cwd: string, command: string): string[] {
  return ['tmux', '-u', 'new-session', '-A', '-s', name, '-c', cwd, command, ';', 'set-option', '-t', name, 'window-size', 'latest'];
}

// Run argv attached to the terminal; resolves with the exit code
export function runTmux(argv: string[], cwd: string, env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function killTmuxSession(name: string): Promise<void> {
  await execFileAsync('tmux', ['kill-session', '-t', name]);
}
