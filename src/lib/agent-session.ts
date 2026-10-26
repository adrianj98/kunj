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
import { kunjEntry } from './self';

const execFileAsync = promisify(execFile);

export type AgentErrorCode = 'tmux-missing' | 'no-tty' | 'not-running' | 'no-worktree' | 'bad-session-id' | 'unknown-agent';

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

// With an id: one of several agents of the worktree (`kunj agent --session <id>`). The name keeps the
// `kunj-` prefix, so `kunj events`' poll and the hook state files work per session.
export function agentSessionName(repoName: string, repoId: string, branch: string, id?: string | null): string {
  const base = containerNames(repoName, repoId, branch).container.replace(/[.:]/g, '-');
  return id ? `${base}-a-${id}` : base;
}

// null: the default session `base`; undefined: not an agent session of that branch
export function agentSessionId(session: string, base: string): string | null | undefined {
  if (session === base) return null;
  const prefix = `${base}-a-`;
  if (!session.startsWith(prefix)) return undefined;
  const id = session.slice(prefix.length);
  return SHELL_SESSION_ID.test(id) ? id : undefined;
}

// The branch's agent sessions among a tmux listing, in listing order
export function agentSessionsOf(sessions: string[], base: string): Array<{ session: string; id: string | null }> {
  return sessions.flatMap(session => {
    const id = agentSessionId(session, base);
    return id === undefined ? [] : [{ session, id }];
  });
}

// One state for several agents: waiting when any waits, else running when any reports running
export function combineAgentStates(states: Array<AgentHookState | null>): AgentHookState | null {
  if (states.includes('waiting')) return 'waiting';
  return states.includes('running') ? 'running' : null;
}

// Names of the form <prefix><id>
export function sessionsWithPrefix(sessions: string[], prefix: string): string[] {
  return sessions.filter(s => s.startsWith(prefix) && SHELL_SESSION_ID.test(s.slice(prefix.length)));
}

// Kill every <prefix><id> session; the names it killed (none without tmux or on failure)
export async function killTmuxSessionsWithPrefix(prefix: string): Promise<string[]> {
  const sessions = await readTmuxSessions();
  if (!Array.isArray(sessions)) return [];
  const killed: string[] = [];
  for (const s of sessionsWithPrefix(sessions, prefix)) {
    if (await killTmuxSessionIfExists(s)) killed.push(s);
  }
  return killed;
}

// Persistent shells (`kunj worktree shell --session <id>`): one host tmux session per worktree and id.
// `kunjsh-` rather than `kunj-`, so `kunj events`' agent poll and the worktree listing, which match
// `kunj-`, never take a shell for an agent.
export function shellSessionName(repoName: string, repoId: string, branch: string, id: string): string {
  return agentSessionName(repoName, repoId, branch).replace(/^kunj-/, 'kunjsh-') + `-sh-${id}`;
}

// The id becomes part of a tmux target, so only characters tmux gives no meaning to
export const SHELL_SESSION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function checkShellSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SHELL_SESSION_ID.test(id)) {
    throw new AgentError('bad-session-id', `Invalid session id ${JSON.stringify(id ?? '')}: use 1-32 letters, digits, _ or -`);
  }
  return id;
}

export function loginShell(): string {
  return process.env.SHELL || 'sh';
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

// One session by exact name (`=`), for when the full listing failed; any failure reads as absent
export async function hasTmuxSession(name: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
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
// An array command is run by tmux as argv, without a shell in between.
export function agentArgv(name: string, cwd: string, command: string | string[], env: Record<string, string>, opts: { status?: boolean } = {}): string[] {
  const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['tmux', '-u', 'new-session', '-A', '-s', name, '-c', cwd, ...vars, ...(Array.isArray(command) ? command : [command]), ';', 'set-option', '-t', name, 'window-size', 'latest', ';', 'set-option', '-t', name, 'status', opts.status ? 'on' : 'off'];
}

// A login shell in the session (no KUNJ_* variables: it is not an agent)
export function shellArgv(name: string, cwd: string, shell: string, opts: { status?: boolean } = {}): string[] {
  return agentArgv(name, cwd, [shell, '-l'], {}, opts);
}

// This CLI as argv: node and its entry (src/lib/self.ts), for commands tmux runs
export function kunjSelf(): string[] {
  return [process.execPath, kunjEntry()];
}

// `argv` under `kunj run`, which unlocks the vault and puts the host secrets in argv's environment.
// tmux sessions start agents and shells this way: `new-session -e` would put the values in argv.
// Without a branch, run resolves with the branch checked out where it runs (the session's -c).
// --hold keeps the pane open on a failed unlock, so its message is not lost with the pane.
export function hostRunArgv(branch: string | undefined, argv: string[]): string[] {
  return [...kunjSelf(), 'run', '--hold', ...(branch ? ['--branch', branch] : []), '--', ...argv];
}

// The branch's host secrets for a process started here without tmux (`kunj agent`, `kunj worktree shell`),
// file deliveries rendered into the worktree first (warnings on stderr). Loaded lazily: the listing
// imports this module and must not load the vault code.
export async function hostSecretEnv(branch: string | undefined, root: string): Promise<Record<string, string>> {
  const { hostSecrets } = await import('./secrets/host');
  const { env } = await hostSecrets({ branch, root, warn: (message) => process.stderr.write(`⚠ ${message}\n`) });
  return env;
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

// Exact name (`=`); false when there was no such session, no server or no tmux
export async function killTmuxSessionIfExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['kill-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
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

// The agents `kunj agent --agent <name>` knows. No name: agent.command. claude: agent.command when it
// runs claude (keeping its flags), else plain claude. antigravity: agent.antigravityCommand (agy).
export const AGENT_NAMES = ['claude', 'antigravity'] as const;

export function agentCommand(name: string | undefined, agent: { command?: string; antigravityCommand?: string } | undefined): string {
  const configured = agent?.command?.trim() || 'claude';
  if (name === undefined) return configured;
  if (name === 'claude') return path.basename(configured.split(/\s+/)[0] ?? '') === 'claude' ? configured : 'claude';
  if (name === 'antigravity') return agent?.antigravityCommand?.trim() || 'agy';
  throw new AgentError('unknown-agent', `Unknown agent ${JSON.stringify(name)}: use ${AGENT_NAMES.join(' or ')}`);
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
