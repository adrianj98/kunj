// Host tmux sessions for worktree agents (`kunj agent`).
//
// One tmux server serves the whole host, so the session name must be unique per repository and
// branch: it is the container name (readable part plus a hash of repo id and branch) made safe for
// tmux, which treats `.` and `:` as target separators.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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

  // BaseCommand prints this as the code of a --json error (opt-in); one source, so it cannot differ from `code`
  get jsonCode(): AgentErrorCode {
    return this.code;
  }
}

export function agentSessionName(repoName: string, repoId: string, branch: string): string {
  return containerNames(repoName, repoId, branch).container.replace(/[.:]/g, '-');
}

// []: tmux has no server (or no sessions). 'missing': tmux is not installed. 'failed': any other
// failure, so a transient error is never read as "no agents".
export async function readTmuxSessions(): Promise<string[] | 'missing' | 'failed'> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    return /no server running|error connecting to/.test(stderr) ? [] : 'failed';
  }
}

// null: unknown (tmux is not installed, or it failed)
export async function listTmuxSessions(): Promise<string[] | null> {
  const sessions = await readTmuxSessions();
  return Array.isArray(sessions) ? sessions : null;
}

export function agentRunning(sessions: string[] | null, name: string): boolean | null {
  return sessions === null ? null : sessions.includes(name);
}

// -u: UTF-8 even without a locale. window-size latest: the size follows the client that attached last.
// status off (agent.tmuxStatus turns it on): no tmux status line in kunj's sessions; the workspace app and the terminal show the
// session already, and the line costs the agent a row. Set on every start, so reattaching applies it.
// tmux runs a single command argument through the shell, so the setting keeps its quoting.
// -e (tmux 3.2+): a new session's environment comes from the tmux server, not this client, so the
// variables must be given here or a running server hands it an earlier agent's values.
export function agentArgv(name: string, cwd: string, command: string, env: Record<string, string>, opts: { status?: boolean } = {}): string[] {
  const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['tmux', '-u', 'new-session', '-A', '-s', name, '-c', cwd, ...vars, command, ';', 'set-option', '-t', name, 'window-size', 'latest', ';', 'set-option', '-t', name, 'status', opts.status ? 'on' : 'off'];
}

// Without tmux: the agent runs in this terminal, through the login shell as tmux would run it
export function directArgv(command: string, shell = process.env.SHELL || 'sh'): string[] {
  return [shell, '-lc', command];
}

export const NO_TMUX_HINT = 'tmux is not installed: the agent stops when this terminal closes (brew install tmux to keep it running)';

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

// ---------------------------------------------------------------------------
// Agent state: "waiting for input" through Claude Code hooks
//
// tmux says whether an agent runs; whether it waits for the user is written by Claude Code hooks
// that kunj passes with `--settings` (only when the command is claude). Each hook is a printf into
// the file named by KUNJ_AGENT_STATE: on the host ~/.kunj/<repo>/agent-state/<session>, in a
// container /tmp/kunj-agent-state (read by the status script). `kunj events` watches the directory.
// ---------------------------------------------------------------------------

export type AgentHookState = 'running' | 'waiting';

export const CONTAINER_AGENT_STATE_FILE = '/tmp/kunj-agent-state';

export function agentStateDir(kunjDir: string): string {
  return path.join(kunjDir, 'agent-state');
}

export function agentStateFile(kunjDir: string, session: string): string {
  return path.join(agentStateDir(kunjDir), session);
}

// The hooks as `claude --settings` takes them. No single quotes anywhere, so the JSON can be
// single-quoted for the shell tmux runs the command through.
export function claudeHookSettings(): string {
  const hook = (command: string, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }];
  const write = (state: AgentHookState) => `printf ${state} > "$KUNJ_AGENT_STATE"`;
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: hook(write('running')),
      PreToolUse: hook(write('running')),
      Stop: hook(write('waiting')),
      Notification: hook(write('waiting'), 'permission_prompt|idle_prompt|elicitation_dialog'),
      SessionEnd: hook('rm -f "$KUNJ_AGENT_STATE"'),
    },
  });
}

// `command` with the hooks appended when it is claude (the setting agent.hooks, default on)
export function withAgentHooks(command: string, _stateFile: string, enabled: boolean): string {
  if (!enabled) return command;
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (path.basename(first) !== 'claude') return command;
  return `${command.trim()} --settings '${claudeHookSettings().replace(/'/g, "'\\''")}'`;
}

export function readAgentState(stateFile: string): AgentHookState | null {
  try {
    const s = fs.readFileSync(stateFile, 'utf8').trim();
    return s === 'running' || s === 'waiting' ? s : null;
  } catch {
    return null;
  }
}
