// kunj agent: run an agent in a host tmux session for a worktree.
// The session name is chosen by kunj (agentSessionName), so `worktree list --json` can report it.
// Keep top-level imports light: this command is on the fast path (src/commands/fast.ts).

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import * as fs from 'fs';
import * as path from 'path';
import { getKunjDir, loadResolvedConfig } from '../lib/config';
import { getCurrentBranch } from '../lib/git';
import { findWorktreeIn, listWorktreesDetailed } from '../lib/worktree';
import { repoIdentity } from '../lib/repo-identity';
import { AgentError, NO_TMUX_HINT, agentArgv, agentCommand, agentRunning, agentSessionName, agentResumeFile, agentStateDir, agentStateFile, readAgentResume, withAgentResume, checkShellSessionId, directArgv, hasTmuxSession, hostRunArgv, hostSecretEnv, killTmuxSession, killTmuxSessionIfExists, pickSession, readAgentState, readTaggedTmuxSessions, loginShell, worktreeAgentSessions, runTmux, withAgentHooks, withAgentPrompt, isClaudeCommand, agentPromptFile } from '../lib/agent-session';
import type { AgentSessionJson, AgentStartJson, AgentStatusJson, AgentStopJson } from '../lib/json-types';

interface AgentOptions {
  json?: boolean;
  command?: string;
  agent?: string;
  tmux?: boolean;
  session?: string;
  all?: boolean;
  resume?: boolean;
  detach?: boolean;
  promptFile?: string;
  openInApp?: boolean;
}

// The largest brief --prompt-file takes (it becomes one shell argument)
const MAX_PROMPT_BYTES = 256 * 1024;

const ACTIONS = ['start', 'status', 'stop'];

export class AgentCommand extends BaseCommand {
  constructor() {
    super({
      name: 'agent',
      description: 'Run or reattach an agent in a worktree (tmux)',
      arguments: '[action] [branch]',
      options: [
        { flags: '--command <cmd>', description: 'Command to run (default: the agent.command setting)' },
        { flags: '--agent <name>', description: 'Agent to run: claude or antigravity (agent.antigravityCommand, default agy); --command wins' },
        { flags: '--no-tmux', description: 'Run the agent directly in this terminal, without a tmux session' },
        { flags: '--session <id>', description: "One of several agents of the worktree: its own tmux session (<agent session>-a-<id>; letters, digits, _ and -, up to 32)" },
        { flags: '--resume', description: "[start] When the session is not running, resume its agent's last Claude conversation (saved by a hook)" },
        { flags: '--all', description: '[stop] Stop the default session and every --session one (exit 0 when none runs)' },
        { flags: '--detach', description: '[start] Start the tmux session without attaching to it (no terminal needed); a running one is left as it is' },
        { flags: '--prompt-file <file>', description: "[start] The agent's first prompt, read from a file (claude only; a new session only)" },
        { flags: '--open-in-app', description: '[start] Ask the workspace app to open, select and focus a tab for the new session' },
      ],
      helpText: [
        'Actions:',
        '  start [branch]    run the agent in the worktree\'s tmux session, or reattach to it (default)',
        '  status [branch]   whether the session exists',
        '  stop [branch]     kill the session',
        '',
        '[branch] defaults to the current branch; `kunj agent my-branch` starts. Without tmux (or with',
        '--no-tmux) start runs the agent directly in this terminal, and it stops when the terminal closes.',
        '',
        '--session <id> runs one more agent in the worktree, in its own tmux session; status, stop and',
        'start then act on that one. status without it reports every agent of the worktree; stop --all',
        'ends them all. stop with --session or --all exits 0 even when nothing ran.',
        '',
        '--resume: a Claude agent saves its conversation id as it starts; when its session was ended',
        '(the app quit with Close All, a reboot), start --resume runs claude --resume <id> in a new one.',
        '',
        '--detach starts the session in the background and returns (with --json: branch, worktree,',
        'session, id, started). --prompt-file gives a new claude agent its first prompt; --open-in-app',
        'has the workspace app switch to it. The /handoff skill (kunj install skill) uses all three.',
        '',
        '--agent antigravity runs the Antigravity CLI (agy) instead of agent.command. Only Claude Code',
        'reports when it waits for input; another agent shows as running while its session lives.',
      ].join('\n'),
    });
  }

  async execute(action?: any, branch?: any, options: AgentOptions = {}): Promise<void> {
    // Commander passes (action, branch, options, command); with fewer positionals the options shift left
    const args: unknown[] = [action, branch, options];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object');
    const opts = (optIndex === -1 ? {} : args[optIndex]) as AgentOptions;
    const positionals = (optIndex === -1 ? args : args.slice(0, optIndex)).filter((a): a is string => typeof a === 'string');
    if (opts.json) this.jsonMode = true;

    // A first positional that is not an action is the branch of an implicit start
    let verb = 'start';
    let target: string | undefined = positionals[0];
    if (target !== undefined && ACTIONS.includes(target)) {
      verb = target;
      target = positionals[1];
    }

    const listing = await listWorktreesDetailed({ includeStatus: false, includePullRequests: false });
    const name = target ?? (await getCurrentBranch());
    const wt = name ? findWorktreeIn(listing.worktrees, name) : null;
    if (!wt || !wt.branch || !wt.exists || wt.bare) {
      throw new AgentError('no-worktree', `No worktree for ${name || 'the current directory'}. See \`kunj worktree list\`, or create one with \`kunj worktree add <branch>\`.`);
    }
    const id = opts.session !== undefined ? checkShellSessionId(opts.session) : undefined;
    // An unknown name fails before anything starts (a reattach ignores it: the session runs already)
    if (opts.agent !== undefined) agentCommand(opts.agent, undefined);
    const repo = repoIdentity({ commonDir: listing.gitCommonDir, repoRoot: listing.repoRoot });
    const base = agentSessionName(repo.name, repo.id, wt.branch);
    const tmux = await readTaggedTmuxSessions();
    const sessions = Array.isArray(tmux) ? tmux.map(s => s.name) : null;
    // The worktree's agents, also those started before it checked out its current branch (tagged
    // with its path): a reattach, status or stop finds them under their original name
    const found = Array.isArray(tmux) ? worktreeAgentSessions(tmux, base, wt.path) : null;
    const session = pickSession(found ?? [], id ?? null, agentSessionName(repo.name, repo.id, wt.branch, id));

    if (verb === 'status') {
      const kunjDir = getKunjDir();
      const all = found && found.map((s): AgentSessionJson => {
        const state = readAgentState(agentStateFile(kunjDir, s.session));
        return state ? { ...s, state } : s;
      });
      const running = id !== undefined || !all ? agentRunning(sessions, session) : all.length > 0;
      if (this.jsonMode) {
        this.outputJSON({ branch: wt.branch, worktree: wt.path, session, running, ...(all ? { sessions: all } : {}) } satisfies AgentStatusJson);
      } else {
        const unknown = tmux === 'missing' ? 'unknown (tmux is not installed)' : 'unknown (tmux failed)';
        const state = running === null ? chalk.yellow(unknown) : running ? chalk.green('running') : chalk.dim('not running');
        console.log(`${wt.branch}: ${state} (${session})`);
        if (id === undefined && all && all.length > 1) for (const s of all) console.log(`  ${s.session}${s.state ? ` ${s.state}` : ''}`);
      }
      return;
    }

    // One named session, or all of the worktree's: quiet when nothing runs (the app ends tabs and environments with it)
    if (verb === 'stop' && (id !== undefined || opts.all)) {
      const targets = id !== undefined ? [session] : found ? found.map(s => s.session).sort((a, b) => (a === base ? -1 : b === base ? 1 : 0)) : tmux === 'failed' ? [base] : [];
      const stopped: string[] = [];
      for (const t of targets) if (await killTmuxSessionIfExists(t)) stopped.push(t);
      if (this.jsonMode) {
        this.outputJSON({ success: true, branch: wt.branch, session, stopped } satisfies AgentStopJson);
      } else {
        console.log(stopped.length ? chalk.green(`✓ Stopped ${stopped.join(', ')}`) : chalk.dim(`No agent session of ${wt.branch} was running`));
      }
      return;
    }

    if (verb === 'stop') {
      if (tmux === 'missing') throw new AgentError('tmux-missing', 'tmux is not installed. Install it (macOS: `brew install tmux`).');
      // When the listing failed, kill-session says whether the session exists
      if (sessions && !sessions.includes(session)) throw new AgentError('not-running', `No agent is running for ${wt.branch}. Start one with \`kunj agent start ${wt.branch}\`.`);
      await killTmuxSession(session);
      if (this.jsonMode) {
        this.outputJSON({ success: true, branch: wt.branch, session } satisfies AgentStopJson);
      } else {
        console.log(chalk.green(`✓ Stopped ${session}`));
      }
      return;
    }

    if ((opts.detach || opts.promptFile || opts.openInApp) && verb !== 'start') {
      throw new AgentError('bad-option', '--detach, --prompt-file and --open-in-app only go with `kunj agent start`.');
    }
    if (!opts.detach && !process.stdin.isTTY) throw new AgentError('no-tty', 'kunj agent needs a terminal to attach to. Run it from an interactive terminal, or use `kunj agent status` to check on it.');
    const config = await loadResolvedConfig(process.cwd());
    // The Claude Code hooks report "waiting for input" into the state file (agent-session.ts)
    const kunjDir = getKunjDir();
    const stateFile = agentStateFile(kunjDir, session);
    fs.mkdirSync(agentStateDir(kunjDir), { recursive: true });
    const resumeFile = agentResumeFile(kunjDir, session);
    fs.mkdirSync(path.dirname(resumeFile), { recursive: true });
    const agentCmd = opts.command || agentCommand(opts.agent, config.agent);
    // A running session is reattached below; only a new one resumes the saved conversation
    const resumeId = opts.resume && !(sessions?.includes(session) ?? false) ? readAgentResume(resumeFile) : null;
    // a failed listing does not mean it is not running: ask tmux about this one
    const alreadyRunning = sessions ? sessions.includes(session) : opts.detach === true && tmux === 'failed' && await hasTmuxSession(session);
    let promptCopy: string | null = null;
    if (opts.promptFile) {
      if (!isClaudeCommand(agentCmd)) {
        throw new AgentError('prompt-needs-claude', `--prompt-file only works with claude, and this agent runs \`${agentCmd}\`.`);
      }
      let text: Buffer;
      try {
        text = fs.readFileSync(opts.promptFile);
      } catch (error) {
        throw new AgentError('prompt-not-found', `Could not read the prompt file ${opts.promptFile}: ${(error as Error).message}`);
      }
      if (text.length > MAX_PROMPT_BYTES) {
        throw new AgentError('prompt-too-large', `The prompt file is ${Math.ceil(text.length / 1024)} KB; the most --prompt-file takes is ${MAX_PROMPT_BYTES / 1024} KB.`);
      }
      if (alreadyRunning) {
        process.stderr.write(`⚠ ${session} is already running; --prompt-file was not sent to it.\n`);
      } else {
        promptCopy = agentPromptFile(kunjDir, session);
        fs.mkdirSync(path.dirname(promptCopy), { recursive: true, mode: 0o700 });
        // a brief starting with `-` (front matter, a bullet) would be read by claude as an option
        fs.writeFileSync(promptCopy, text[0] === 0x2d ? Buffer.concat([Buffer.from('\n'), text]) : text, { mode: 0o600 });
        fs.chmodSync(promptCopy, 0o600);
      }
    }
    const command = withAgentPrompt(withAgentHooks(withAgentResume(agentCmd, resumeId), stateFile, config.agent?.hooks !== false), promptCopy);
    const vars = { KUNJ_BRANCH: wt.branch, KUNJ_REPO: repo.name, KUNJ_WORKTREE: wt.path, KUNJ_AGENT_STATE: stateFile, KUNJ_AGENT_RESUME: resumeFile };
    // Without TMUX, tmux refuses to nest when run from a pane (or an app started in one)
    const { TMUX: _tmux, ...env } = process.env;
    // Like kunj ct agent in an image without tmux: the agent runs here and ends with the terminal
    // agent.tmux false: direct, like --no-tmux (no hint: the user chose it), except that an agent still
    // running in this worktree's session is reattached rather than joined by a second one. The
    // --no-tmux flag is explicit and always runs directly.
    // A failed listing does not mean no session: ask tmux about this one before running a second agent
    const running = sessions ? sessions.includes(session) : tmux === 'failed' && config.agent?.tmux === false && opts.tmux !== false && await hasTmuxSession(session);
    const wantTmux = opts.tmux !== false && (config.agent?.tmux !== false || running);
    const direct = !wantTmux || tmux === 'missing';
    if (opts.detach) {
      if (direct) {
        throw new AgentError(tmux === 'missing' ? 'tmux-missing' : 'bad-option',
          tmux === 'missing' ? '--detach needs tmux, which is not installed. Install it (macOS: `brew install tmux`).'
            : '--detach needs a tmux session; drop --no-tmux (or set agent.tmux to true).');
      }
      const result: AgentStartJson = { branch: wt.branch, worktree: wt.path, session, id: id ?? null, started: !alreadyRunning };
      if (!alreadyRunning) {
        const argv = agentArgv(session, wt.path, hostRunArgv(wt.branch, [loginShell(), '-lc', command]), vars,
          { status: config.agent?.tmuxStatus === true, worktree: wt.path, detach: true, openInApp: opts.openInApp });
        const code = await runTmux(argv, wt.path, { ...env, ...vars });
        if (code !== 0) throw new AgentError('start-failed', `tmux could not start ${session} (exit ${code}).`);
      }
      if (this.jsonMode) {
        this.outputJSON(result);
      } else {
        console.log(alreadyRunning ? chalk.dim(`${session} is already running`) : chalk.green(`✓ Started ${session}`));
        console.log(chalk.dim(`  Attach with: kunj agent ${wt.branch}${id ? ` --session ${id}` : ''}`));
      }
      return;
    }
    if (tmux === 'missing' && wantTmux) process.stderr.write(NO_TMUX_HINT + '\n');
    // Host secrets: in tmux, `kunj run` unlocks the vault inside the session (new-session -e would put
    // the values in argv; KUNJ_* stay there); directly, the same resolution in-process.
    if (!direct) {
      const argv = agentArgv(session, wt.path, hostRunArgv(wt.branch, [loginShell(), '-lc', command]), vars, { status: config.agent?.tmuxStatus === true, worktree: wt.path, openInApp: opts.openInApp });
      process.exitCode = await runTmux(argv, wt.path, { ...env, ...vars });
      return;
    }
    const secrets = await hostSecretEnv(wt.branch, wt.path);
    process.exitCode = await runTmux(directArgv(command), wt.path, { ...env, ...vars, ...secrets });
  }
}
