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
      key: 'agent.hooks',
      description: 'Pass Claude Code hooks to the agent that report when it waits for input (agent.state in worktree list and ct list)',
      type: 'boolean',
      defaultValue: true,
      category: 'agent',
    },
  ]);
}
