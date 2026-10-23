// kunj agent: run an agent in a host tmux session for a worktree.
// The session name is chosen by kunj (agentSessionName), so `worktree list --json` can report it.
// Keep top-level imports light: this command is on the fast path (src/commands/fast.ts).

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadResolvedConfig } from '../lib/config';
import { getCurrentBranch } from '../lib/git';
import { findWorktreeIn, listWorktreesDetailed } from '../lib/worktree';
import { repoIdentity } from '../lib/repo-identity';
import { AgentError, agentArgv, agentRunning, agentSessionName, killTmuxSession, listTmuxSessions, runTmux } from '../lib/agent-session';
import type { AgentStatusJson, AgentStopJson } from '../lib/json-types';

interface AgentOptions {
  json?: boolean;
  command?: string;
}

const ACTIONS = ['start', 'status', 'stop'];

export class AgentCommand extends BaseCommand {
  constructor() {
    super({
      name: 'agent',
      description: 'Run or reattach an agent in a worktree (tmux)',
      arguments: '[action] [branch]',
      options: [{ flags: '--command <cmd>', description: 'Command to run (default: the agent.command setting)' }],
      helpText: [
        'Actions:',
        '  start [branch]    run the agent in the worktree\'s tmux session, or reattach to it (default)',
        '  status [branch]   whether the session exists',
        '  stop [branch]     kill the session',
        '',
        '[branch] defaults to the current branch; `kunj agent my-branch` starts. Needs tmux.',
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
    const repo = repoIdentity();
    const session = agentSessionName(repo.name, repo.id, wt.branch);
    const sessions = await listTmuxSessions();

    if (verb === 'status') {
      const running = agentRunning(sessions, session);
      if (this.jsonMode) {
        this.outputJSON({ branch: wt.branch, worktree: wt.path, session, running } satisfies AgentStatusJson);
      } else {
        const state = running === null ? chalk.yellow('unknown (tmux is not installed)') : running ? chalk.green('running') : chalk.dim('not running');
        console.log(`${wt.branch}: ${state} (${session})`);
      }
      return;
    }

    if (verb === 'stop') {
      if (sessions === null) throw new AgentError('tmux-missing', 'tmux is not installed; brew install tmux');
      if (!sessions.includes(session)) throw new AgentError('not-running', `No agent session for ${wt.branch}`);
      await killTmuxSession(session);
      if (this.jsonMode) {
        this.outputJSON({ success: true, branch: wt.branch, session } satisfies AgentStopJson);
      } else {
        console.log(chalk.green(`✓ Stopped ${session}`));
      }
      return;
    }

    if (sessions === null) throw new AgentError('tmux-missing', 'tmux is not installed; brew install tmux');
    if (!process.stdin.isTTY) throw new AgentError('no-tty', 'kunj agent needs a terminal to attach to');
    const config = await loadResolvedConfig(process.cwd());
    const command = opts.command || config.agent?.command || 'claude';
    process.exitCode = await runTmux(agentArgv(session, wt.path, command), wt.path, {
      ...process.env,
      KUNJ_BRANCH: wt.branch,
      KUNJ_REPO: repo.name,
      KUNJ_WORKTREE: wt.path,
    });
  }
}
