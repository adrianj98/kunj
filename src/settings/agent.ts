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
  ]);
}
