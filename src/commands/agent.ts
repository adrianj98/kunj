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
import { AgentError, NO_TMUX_HINT, agentArgv, agentCommand, agentRunning, agentSessionName, agentResumeFile, agentStateDir, agentStateFile, readAgentResume, savedAgents, agentSessionId, conversationTitle, withAgentResume, withAgentTeleport, checkTeleportId, checkShellSessionId, directArgv, hasTmuxSession, hostRunArgv, hostSecretEnv, killTmuxSession, killTmuxSessionIfExists, pickSession, readAgentState, readTaggedTmuxSessions, loginShell, worktreeAgentSessions, runTmux, withAgentHooks, planNudgeHookCommand, withAgentPlugin, withAgentTaskList, withAgentPrompt, isClaudeCommand, agentPromptFile, execScript, kunjSelf, shQuote } from '../lib/agent-session';
import { packagedPluginDir } from '../lib/skills';
import { activePlans, buildOverview, subagentLabel } from '../lib/agent-overview';
import { PLAN_ENV, agentPlanDir, agentPlanFile, recordedPlanSessions, parentLine, planNudge, planPosition, readPlanFile, reducePlan } from '../lib/agent-plan';
import type { AgentForgetJson, AgentOverviewJson, AgentPlanItemJson, AgentPlanJson, AgentPlanStepJson, AgentSavedJson, AgentSessionJson, AgentStartJson, AgentStatusJson, AgentStopJson } from '../lib/json-types';

interface AgentOptions {
  json?: boolean;
  command?: string;
  agent?: string;
  tmux?: boolean;
  session?: string;
  all?: boolean;
  resume?: boolean;
  teleport?: string;
  detach?: boolean;
  promptFile?: string;
  openInApp?: boolean;
  containers?: boolean;
  execScript?: boolean;
}

// The largest brief --prompt-file takes (it becomes one shell argument)
const MAX_PROMPT_BYTES = 256 * 1024;

const ACTIONS = ['start', 'status', 'stop', 'saved', 'forget', 'plan', 'overview', 'nudge', 'mcp'];

// `kunj agent overview --containers` stops waiting for the containers after this long
const OVERVIEW_CONTAINERS_TIMEOUT_MS = 8000;

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
        { flags: '--teleport <session>', description: '[start] Continue a Claude Code web session here (claude --teleport <session>; a session id or its claude.ai/code URL; a new session only)' },
        { flags: '--all', description: '[stop] Stop the default session and every --session one (exit 0 when none runs); [forget] forget every saved conversation of the worktree; [plan] the agents of every worktree of the repository' },
        { flags: '--detach', description: '[start] Start the tmux session without attaching to it (no terminal needed); a running one is left as it is' },
        { flags: '--prompt-file <file>', description: "[start] The agent's first prompt, read from a file (claude only; a new session only)" },
        { flags: '--containers', description: "[overview] Also the agents in this repository's running branch containers" },
        { flags: '--exec-script', description: '[start] Print the sh line that attaches instead of attaching (a terminal runs it as sh -c, so no kunj process waits beside it)' },
        { flags: '--open-in-app', description: '[start] Ask the workspace app to open, select and focus a tab for the new session' },
      ],
      helpText: [
        'Actions:',
        '  start [branch]    run the agent in the worktree\'s tmux session, or reattach to it (default)',
        '  status [branch]   whether the session exists',
        '  stop [branch]     kill the session',
        '  saved [branch]    saved Claude conversations of sessions that are not running (to resume)',
        '  forget [branch]   forget a saved conversation (--session <id>, or --all)',
        '  plan [branch]     where each agent is in its plan: its task list as steps, subagents, branch changes',
        '  overview          the running agents of the repository, grouped and laid out as lines of stops (for the apps)',
        '  nudge             (for the agent\'s prompt hook) one line about its plan, from $KUNJ_AGENT_PLAN',
        '  mcp               (for kunj\'s plugin) the MCP server with the set_plan tool, on stdin/stdout',
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
        '`saved` lists those conversations with their first prompt; resume one with',
        '`kunj agent start <branch> --session <id> --resume` (no --session for the default one).',
        '--teleport: `kunj agent start <branch> --teleport session_01…` runs claude --teleport in the worktree;',
        'claude checks out the web session\'s branch there, so that branch must not be checked out elsewhere.',
        '',
        '--detach starts the session in the background and returns (with --json: branch, worktree,',
        'session, id, started). --prompt-file gives a new claude agent its first prompt; --open-in-app',
        'has the workspace app switch to it. The /handoff skill (kunj install skill) uses all three.',
        '',
        'plan: a Claude agent\'s hooks record its task list (agent.plan, default on); `plan` prints the',
        'steps with the current one marked, `plan --all` for every worktree, `--json` for the apps.',
        '`overview --json` is what a window needs to draw them: the running agents of the repository',
        '(with --containers also those in its branch containers), an agent that another one started',
        'under its parent, their text and the position of every stop, loop and marker.',
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

    // the UserPromptSubmit hook: one line about the agent's task list, from its record alone (no git)
    // the set_plan tool every claude kunj starts gets through kunj's plugin (src/lib/plan-mcp.ts)
    if (verb === 'mcp') {
      const { servePlanMcp } = await import('../lib/plan-mcp');
      const { getVersion } = await import('../lib/version');
      return servePlanMcp(getVersion());
    }
    if (verb === 'nudge') {
      const file = process.env.KUNJ_AGENT_PLAN;
      if (file) process.stdout.write(`${planNudge(reducePlan(readPlanFile(file)))}\n`);
      return;
    }
    const listing = await listWorktreesDetailed({ includeStatus: false, includePullRequests: false });
    if (verb === 'plan') return this.plan(listing, target, opts);
    if (verb === 'overview') return this.overview(listing, opts);
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

    if (verb === 'saved') {
      const items = savedAgents(getKunjDir(), base, sessions).filter(s => id === undefined || s.id === id);
      if (this.jsonMode) {
        this.outputJSON({ branch: wt.branch, worktree: wt.path, items } satisfies AgentSavedJson);
      } else if (items.length === 0) {
        console.log(chalk.dim(`No saved conversation of ${wt.branch} to resume`));
      } else {
        for (const s of items) {
          const flag = s.id ? ` --session ${s.id}` : '';
          console.log(`${chalk.bold(s.title ?? '(no prompt yet)')}\n  ${chalk.dim(`${new Date(s.savedAt).toLocaleString()}  kunj agent start ${wt.branch}${flag} --resume`)}`);
        }
      }
      return;
    }

    if (verb === 'forget') {
      if (id === undefined && !opts.all) throw new AgentError('bad-option', '`kunj agent forget` needs --session <id> or --all.');
      const kunjDir = getKunjDir();
      // --all leaves running agents' conversations alone, so it needs to know which run
      if (opts.all && !sessions) {
        throw new AgentError(tmux === 'missing' ? 'tmux-missing' : 'tmux-failed', 'Could not ask tmux which agents are running, so nothing was forgotten. Use --session <id> to forget one.');
      }
      if (!opts.all && sessions?.includes(session)) {
        throw new AgentError('bad-option', `${session} is running; its conversation is kept so it can be resumed later. Stop it first.`);
      }
      // --all: every session of the worktree that is not running and left something behind, a saved
      // conversation or only a plan record (an agent ended before its conversation was saved)
      const recorded = recordedPlanSessions(kunjDir).filter(s => agentSessionId(s, base) !== undefined && !sessions?.includes(s));
      const targets = opts.all ? [...new Set([...savedAgents(kunjDir, base, sessions).map(s => s.session), ...recorded])] : [session];
      const forgotten: string[] = [];
      for (const t of targets) {
        let gone = false;
        try {
          fs.unlinkSync(agentResumeFile(kunjDir, t));
          gone = true;
        } catch { /* nothing saved */ }
        try {
          fs.unlinkSync(agentPlanFile(kunjDir, t));
          gone = true;
        } catch { /* no plan recorded */ }
        if (gone) forgotten.push(t);
      }
      if (this.jsonMode) {
        this.outputJSON({ branch: wt.branch, forgotten } satisfies AgentForgetJson);
      } else {
        console.log(forgotten.length ? chalk.green(`✓ Forgot ${forgotten.length} session${forgotten.length === 1 ? '' : 's'} (saved conversation, plan record)`) : chalk.dim('Nothing saved to forget'));
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

    if ((opts.detach || opts.promptFile || opts.openInApp || opts.teleport) && verb !== 'start') {
      throw new AgentError('bad-option', '--detach, --prompt-file, --open-in-app and --teleport only go with `kunj agent start`.');
    }
    const teleportArg = opts.teleport !== undefined ? checkTeleportId(opts.teleport) : null;
    if (teleportArg && opts.resume) throw new AgentError('bad-option', '--teleport and --resume each pick the conversation; use one.');
    if (teleportArg && opts.promptFile) throw new AgentError('bad-option', '--teleport continues a conversation that has its own prompts; drop --prompt-file.');
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
    if (teleportArg && !isClaudeCommand(agentCmd)) {
      throw new AgentError('teleport-needs-claude', `--teleport only works with claude, and this agent runs \`${agentCmd}\`.`);
    }
    // a running session is reattached as it is
    const teleportId = teleportArg && !alreadyRunning ? teleportArg : null;
    if (teleportArg && alreadyRunning) process.stderr.write(`⚠ ${session} is already running; --teleport was not applied to it.\n`);
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
    // The plan record (agent-plan.ts): only Claude has the hooks and the task tools they read
    const withPlan = config.agent?.hooks !== false && config.agent?.plan !== false && isClaudeCommand(agentCmd);
    const planFile = agentPlanFile(kunjDir, session);
    // A failed listing does not mean the session is not running: ask about this one before emptying
    // the record of an agent that is about to be reattached
    const recordInUse = alreadyRunning || (withPlan && tmux === 'failed' && !opts.detach && await hasTmuxSession(session));
    if (withPlan && !recordInUse) {
      // The record is kept across conversations (history); a new one is told apart by its SessionStart.
      // Started from inside another agent's session (the /handoff skill), that parent and its step are added.
      // The record is an extra: failing to prepare it never stops the agent.
      try {
        fs.mkdirSync(agentPlanDir(kunjDir), { recursive: true });
        const from = process.env.KUNJ_AGENT_PLAN;
        const parent = from && path.resolve(from) !== planFile && from.endsWith('.ndjson')
          ? parentLine(path.basename(from, '.ndjson'), planPosition(reducePlan(readPlanFile(from)).steps)) : '';
        // a new conversation is appended too: the record keeps the agent's earlier steps (reducePlan
        // starts the new conversation after them)
        if (!resumeId) trimPlanFile(planFile);
        if (parent) fs.appendFileSync(planFile, parent);
        else if (!fs.existsSync(planFile)) fs.writeFileSync(planFile, '');
      } catch { /* no record */ }
    }
    // kunj's skills (claude-plugin/ in this install) in every claude agent, before the first prompt
    const plugin = fs.existsSync(path.join(packagedPluginDir(), '.claude-plugin', 'plugin.json')) ? packagedPluginDir() : null;
    // the plan is only worth recording when the agent keeps a task list: ask it to (agent.taskList)
    const taskList = withPlan && config.agent?.taskList !== false;
    const command = withAgentPrompt(withAgentPlugin(withAgentTaskList(withAgentHooks(withAgentTeleport(withAgentResume(agentCmd, resumeId), teleportId), stateFile, config.agent?.hooks !== false, withPlan, taskList ? planNudgeHookCommand() : undefined), taskList), plugin), promptCopy);
    const vars = {
      KUNJ_BRANCH: wt.branch, KUNJ_REPO: repo.name, KUNJ_WORKTREE: wt.path, KUNJ_AGENT_STATE: stateFile, KUNJ_AGENT_RESUME: resumeFile,
      ...(withPlan ? { KUNJ_AGENT_PLAN: planFile, ...PLAN_ENV } : {}),
    };
    // Without TMUX, tmux refuses to nest when run from a pane (or an app started in one)
    const { TMUX: _tmux, ...env } = process.env;
    // What the tmux client itself runs with. A client that starts the tmux server gives it its
    // environment, and every later session inherits that: the plan variables go to this session only
    // (new-session -e), or another agent started from any tmux pane would look handed off by this one.
    const planNames = ['KUNJ_AGENT_PLAN', ...Object.keys(PLAN_ENV)];
    const tmuxEnv = Object.fromEntries(Object.entries({ ...env, ...vars }).filter(([name]) => !planNames.includes(name)));
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
        const code = await runTmux(argv, wt.path, tmuxEnv);
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
      // --exec-script: the terminal's sh becomes the tmux client (EXEC_SCRIPT_RUNNER)
      if (opts.execScript) {
        process.stdout.write(execScript(argv, wt.path, tmuxEnv));
        return;
      }
      process.exitCode = await runTmux(argv, wt.path, tmuxEnv);
      return;
    }
    // without tmux the agent runs in this process: the wrapper runs kunj again, without the flag
    if (opts.execScript) {
      process.stdout.write(`exec ${[...kunjSelf(), ...process.argv.slice(2).filter(a => a !== '--exec-script')].map(shQuote).join(' ')}\n`);
      return;
    }
    const secrets = await hostSecretEnv(wt.branch, wt.path);
    process.exitCode = await runTmux(directArgv(command), wt.path, { ...env, ...vars, ...secrets });
  }

  // `kunj agent overview`: the repository's running agents, grouped and laid out (agent-overview.ts)
  private async overview(listing: Awaited<ReturnType<typeof listWorktreesDetailed>>, opts: AgentOptions): Promise<void> {
    const [host, inContainers] = await Promise.all([
      this.collectPlans(listing, undefined, { all: true }),
      opts.containers ? this.containerPlans() : Promise.resolve(undefined),
    ]);
    const plans = [...host, ...(inContainers?.plans ?? [])];
    const repo = repoIdentity({ commonDir: listing.gitCommonDir, repoRoot: listing.repoRoot });
    const built = buildOverview(plans);
    if (this.jsonMode) {
      this.outputJSON({
        repo: { name: repo.name, root: listing.repoRoot }, ...built,
        ...(inContainers ? { containers: { available: inContainers.available, ...(inContainers.message ? { message: inContainers.message } : {}), ...(inContainers.unreadable ? { unreadable: inContainers.unreadable } : {}) } } : {}),
      } satisfies AgentOverviewJson);
      return;
    }
    console.log(chalk.bold(built.summary));
    if (inContainers && !inContainers.available) console.log(chalk.gray(`containers unavailable: ${inContainers.message ?? 'Docker could not be asked'}`));
    if (inContainers?.unreadable) console.log(chalk.gray(`could not read the agents in the container${inContainers.unreadable.length === 1 ? '' : 's'} of ${inContainers.unreadable.join(', ')}`));
    this.printPlans(activePlans(plans));
  }

  // The plans of the agents in this repository's running containers, across its backends. Docker
  // being down, slow or missing is `available: false`, never a failed overview.
  private async containerPlans(): Promise<{ available: boolean; message?: string; unreadable?: string[]; plans: AgentPlanItemJson[] }> {
    let timer: NodeJS.Timeout | undefined;
    const commands: Array<{ abortDockerCalls(): void }> = [];
    try {
      const { ContainerCommand } = await import('./container');
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          for (const c of commands) c.abortDockerCalls();
          reject(new Error(`Docker did not answer within ${OVERVIEW_CONTAINERS_TIMEOUT_MS / 1000}s`));
        }, OVERVIEW_CONTAINERS_TIMEOUT_MS);
      });
      const work = (async () => {
        const lister = new ContainerCommand();
        commands.push(lister);
        const list = await lister.listJson({ status: true });
        const withAgent = list.containers.filter(c => c.state === 'running' && c.agent.running === true);
        const each = await Promise.all(withAgent.map(async c => {
          const command = new ContainerCommand();
          commands.push(command);
          // one container that cannot be read keeps the others, and is named
          try { return await command.agentPlansJson(c.branch, { remote: c.remote ?? 'local' }); } catch { return c.branch; }
        }));
        const unreadable = each.filter((e): e is string => typeof e === 'string');
        return { plans: each.flatMap(e => (typeof e === 'string' ? [] : e)), unreadable };
      })();
      const done = await Promise.race([work, timeout]);
      return { available: true, plans: done.plans, ...(done.unreadable.length ? { unreadable: done.unreadable } : {}) };
    } catch (error) {
      return { available: false, message: error instanceof Error ? error.message : String(error), plans: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // `kunj agent plan`: what the hooks recorded for each agent session of a worktree (or of all)
  private async plan(listing: Awaited<ReturnType<typeof listWorktreesDetailed>>, target: string | undefined, opts: AgentOptions): Promise<void> {
    const plans = await this.collectPlans(listing, target, opts);
    if (this.jsonMode) {
      this.outputJSON({ plans } satisfies AgentPlanJson);
      return;
    }
    if (plans.length === 0) {
      console.log(chalk.dim(opts.all ? 'No agent has a plan recorded' : 'No agent of this worktree has a plan recorded'));
      return;
    }
    this.printPlans(plans);
  }

  private async collectPlans(listing: Awaited<ReturnType<typeof listWorktreesDetailed>>, target: string | undefined, opts: AgentOptions): Promise<AgentPlanItemJson[]> {
    const usable = listing.worktrees.filter(w => w.branch && w.exists && !w.bare);
    let worktrees = usable;
    if (!opts.all) {
      const name = target ?? (await getCurrentBranch());
      const wt = name ? findWorktreeIn(listing.worktrees, name) : null;
      if (!wt || !wt.branch || !wt.exists || wt.bare) {
        throw new AgentError('no-worktree', `No worktree for ${name || 'the current directory'}. See \`kunj worktree list\`, or use \`kunj agent plan --all\`.`);
      }
      worktrees = [wt];
    }
    const id = opts.session !== undefined ? checkShellSessionId(opts.session) : undefined;
    const repo = repoIdentity({ commonDir: listing.gitCommonDir, repoRoot: listing.repoRoot });
    const tmux = await readTaggedTmuxSessions();
    const running = Array.isArray(tmux) ? tmux.map(s => s.name) : null;
    const kunjDir = getKunjDir();
    const recorded = recordedPlanSessions(kunjDir);
    // A running session belongs to the worktree it is tagged with, whatever branch its name was made
    // from: a record is matched by name only for a session that is not tagged with another worktree
    const tagOf = new Map((Array.isArray(tmux) ? tmux : []).map(s => [s.name, s.worktree] as const));
    const elsewhere = (session: string, worktree: string): boolean => {
      const tag = tagOf.get(session);
      return !!tag && path.resolve(tag) !== path.resolve(worktree);
    };
    const listed = new Set<string>();
    const roots = listing.worktrees.map(w => w.path);

    const plans: AgentPlanItemJson[] = [];
    for (const wt of worktrees) {
      const base = agentSessionName(repo.name, repo.id, wt.branch!);
      const sessions = Array.isArray(tmux) ? worktreeAgentSessions(tmux, base, wt.path) : [];
      for (const session of recorded) {
        const sid = agentSessionId(session, base);
        if (sid !== undefined && !elsewhere(session, wt.path) && !sessions.some(s => s.session === session)) sessions.push({ session, id: sid });
      }
      for (const s of sessions) {
        if (id !== undefined && s.id !== id) continue;
        // one item per session, even if two worktrees could claim it
        if (listed.has(s.session)) continue;
        listed.add(s.session);
        const isRunning = running ? running.includes(s.session) : null;
        const text = readPlanFile(agentPlanFile(kunjDir, s.session));
        if (!text.trim() && isRunning !== true) continue;
        const { branch: _branch, transcript, ...plan } = reducePlan(text, roots);
        plans.push({
          session: s.session, id: s.id, branch: wt.branch!, worktree: wt.path,
          running: isRunning, state: isRunning === false ? null : readAgentState(agentStateFile(kunjDir, s.session)),
          ...plan, title: plan.title ?? conversationTitle(transcript),
        });
      }
    }

    return plans;
  }

  private printPlans(plans: AgentPlanItemJson[]): void {
    const mark = (st: AgentPlanStepJson, current: boolean) => st.status === 'completed' ? chalk.green('✓') : current ? chalk.yellow('▶') : chalk.dim('○');
    for (const p of plans) {
      const state = p.running === false ? chalk.dim('not running') : p.state === 'waiting' ? chalk.yellow('waiting for input') : p.running ? chalk.green('running') : chalk.dim('unknown');
      console.log(`${chalk.bold(p.title ?? p.branch)}  ${chalk.dim(`${p.branch}${p.id ? ` · ${p.id}` : ''}`)}  ${state}`);
      if (p.parent) console.log(chalk.dim(`  started by ${p.parent.session}${p.parent.step === null ? '' : ` at its step ${p.parent.step + 1}`}`));
      if (p.steps.length === 0) console.log(chalk.dim('  no task list yet'));
      p.steps.forEach((st, i) => {
        console.log(`  ${mark(st, i === p.current)} ${st.status === 'pending' && i !== p.current ? chalk.dim(st.subject) : st.subject}`);
        for (const m of p.markers.filter(m => m.afterStep === i)) console.log(chalk.dim(`    ◇ ${m.type}${m.to ? ` ${m.from} → ${m.to}` : ''}`));
        for (const sub of p.subagents.filter(sub => sub.fromStep === i)) {
          console.log(chalk.dim(`    ↳ ${subagentLabel(sub)}`));
          sub.steps.forEach((ss, k) => console.log(`      ${mark(ss, sub.running && ss.status === 'in_progress')} ${chalk.dim(ss.subject)}`));
        }
      });
      for (const sub of p.subagents.filter(sub => sub.fromStep === null)) console.log(chalk.dim(`  ↳ ${subagentLabel(sub)}`));
    }
  }
}

/** A record past this many bytes is cut to its last ones at a fresh start (it is kept across conversations). */
export const PLAN_FILE_MAX = 1024 * 1024;

/** Keeps the last PLAN_FILE_MAX / 2 bytes of an oversized record, from a line start. */
export function trimPlanFile(file: string): void {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size <= PLAN_FILE_MAX) return;
  // bytes, not characters: a record of wide characters must still end up under the cap
  const bytes = fs.readFileSync(file);
  const tail = bytes.subarray(bytes.length - PLAN_FILE_MAX / 2);
  const cut = tail.indexOf(0x0a);
  fs.writeFileSync(file, cut >= 0 ? tail.subarray(cut + 1) : Buffer.alloc(0));
}
