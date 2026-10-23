// kunj agent: run an agent in a host tmux session for a worktree.
// The session name is chosen by kunj (agentSessionName), so `worktree list --json` can report it.
// Keep top-level imports light: this command is on the fast path (src/commands/fast.ts).

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import * as fs from 'fs';
import { getKunjDir, loadResolvedConfig } from '../lib/config';
import { getCurrentBranch } from '../lib/git';
import { findWorktreeIn, listWorktreesDetailed } from '../lib/worktree';
import { repoIdentity } from '../lib/repo-identity';
import { AgentError, NO_TMUX_HINT, agentArgv, agentRunning, agentSessionName, agentStateDir, agentStateFile, directArgv, killTmuxSession, readTmuxSessions, runTmux, withAgentHooks } from '../lib/agent-session';
import type { AgentStatusJson, AgentStopJson } from '../lib/json-types';

interface AgentOptions {
  json?: boolean;
  command?: string;
  tmux?: boolean;
}

const ACTIONS = ['start', 'status', 'stop'];

export class AgentCommand extends BaseCommand {
  constructor() {
    super({
      name: 'agent',
      description: 'Run or reattach an agent in a worktree (tmux)',
      arguments: '[action] [branch]',
      options: [
        { flags: '--command <cmd>', description: 'Command to run (default: the agent.command setting)' },
        { flags: '--no-tmux', description: 'Run the agent directly in this terminal, without a tmux session' },
      ],
      helpText: [
        'Actions:',
        '  start [branch]    run the agent in the worktree\'s tmux session, or reattach to it (default)',
        '  status [branch]   whether the session exists',
        '  stop [branch]     kill the session',
        '',
        '[branch] defaults to the current branch; `kunj agent my-branch` starts. Without tmux (or with',
        '--no-tmux) start runs the agent directly in this terminal, and it stops when the terminal closes.',
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
      throw new AgentError('no-worktree', `No worktree for ${name || 'the current directory'}; see kunj worktree list`);
    }
    const repo = repoIdentity({ commonDir: listing.gitCommonDir, repoRoot: listing.repoRoot });
    const session = agentSessionName(repo.name, repo.id, wt.branch);
    const tmux = await readTmuxSessions();
    const sessions = Array.isArray(tmux) ? tmux : null;

    if (verb === 'status') {
      const running = agentRunning(sessions, session);
      if (this.jsonMode) {
        this.outputJSON({ branch: wt.branch, worktree: wt.path, session, running } satisfies AgentStatusJson);
      } else {
        const unknown = tmux === 'missing' ? 'unknown (tmux is not installed)' : 'unknown (tmux failed)';
        const state = running === null ? chalk.yellow(unknown) : running ? chalk.green('running') : chalk.dim('not running');
        console.log(`${wt.branch}: ${state} (${session})`);
      }
      return;
    }

    if (verb === 'stop') {
      if (tmux === 'missing') throw new AgentError('tmux-missing', 'tmux is not installed; brew install tmux');
      // When the listing failed, kill-session says whether the session exists
      if (sessions && !sessions.includes(session)) throw new AgentError('not-running', `No agent session for ${wt.branch}`);
      await killTmuxSession(session);
      if (this.jsonMode) {
        this.outputJSON({ success: true, branch: wt.branch, session } satisfies AgentStopJson);
      } else {
        console.log(chalk.green(`✓ Stopped ${session}`));
      }
      return;
    }

    if (!process.stdin.isTTY) throw new AgentError('no-tty', 'kunj agent needs a terminal to attach to');
    const config = await loadResolvedConfig(process.cwd());
    // The Claude Code hooks report "waiting for input" into the state file (agent-session.ts)
    const kunjDir = getKunjDir();
    const stateFile = agentStateFile(kunjDir, session);
    fs.mkdirSync(agentStateDir(kunjDir), { recursive: true });
    const command = withAgentHooks(opts.command || config.agent?.command || 'claude', stateFile, config.agent?.hooks !== false);
    const vars = { KUNJ_BRANCH: wt.branch, KUNJ_REPO: repo.name, KUNJ_WORKTREE: wt.path, KUNJ_AGENT_STATE: stateFile };
    // Without TMUX, tmux refuses to nest when run from a pane (or an app started in one)
    const { TMUX: _tmux, ...env } = process.env;
    // Like kunj ct agent in an image without tmux: the agent runs here and ends with the terminal
    const direct = opts.tmux === false || tmux === 'missing';
    if (tmux === 'missing' && opts.tmux !== false) process.stderr.write(NO_TMUX_HINT + '\n');
    const argv = direct ? directArgv(command) : agentArgv(session, wt.path, command, vars);
    process.exitCode = await runTmux(argv, wt.path, { ...env, ...vars });
  }
}
