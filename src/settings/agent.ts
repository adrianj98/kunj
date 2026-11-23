// Agent settings - used by the `kunj agent` command

import { registerSettings } from '../lib/settings-registry';

export function registerAgentSettings(): void {
  registerSettings([
    {
      key: 'agent.command',
      description: 'Command `kunj agent` runs in a host tmux session for a worktree',
      type: 'string',
      defaultValue: 'claude',
      category: 'agent',
      examples: ['claude', 'claude --dangerously-skip-permissions'],
    },
    {
      key: 'agent.antigravityCommand',
      description: 'Command `kunj agent --agent antigravity` runs (the Antigravity CLI)',
      type: 'string',
      defaultValue: 'agy',
      category: 'agent',
      examples: ['agy', 'agy --dangerously-skip-permissions'],
    },
    {
      key: 'agent.tmux',
      description: 'Run agents in a tmux session (kunj agent, kunj ct agent) so they outlive the terminal and can be reattached; false runs them directly, like --no-tmux',
      type: 'boolean',
      defaultValue: true,
      category: 'agent',
    },
    {
      key: 'agent.tmuxStatus',
      description: "Show tmux's status line in agent sessions (off by default: the workspace app and the terminal show the session already)",
      type: 'boolean',
      defaultValue: false,
      category: 'agent',
    },
    {
      key: 'agent.plan',
      description: "Record where a Claude agent is in its plan (its task list, subagents, branch changes) for `kunj agent plan` and the workspace app's Overview; turns Claude Code's task tools on for the agent (CLAUDE_CODE_ENABLE_TODO_TOOLS). Needs agent.hooks",
      type: 'boolean',
      defaultValue: true,
      category: 'agent',
    },
    {
      key: 'agent.hooks',
      description: 'Pass Claude Code hooks to the agent that report when it waits for input (agent.state in worktree list and ct list)',
      type: 'boolean',
      defaultValue: true,
      category: 'agent',
    },
  ]);
}
