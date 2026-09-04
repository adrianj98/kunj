// Worktree settings - used by the `kunj worktree` command and editor integrations

import { registerSettings } from '../lib/settings-registry';

export function registerWorktreeSettings(): void {
  registerSettings([
    {
      key: 'worktree.baseDir',
      description: 'Directory where new worktrees are created',
      type: 'string',
      defaultValue: '',
      category: 'worktree',
      detailedDescription:
        'Relative paths are resolved from the main repository root. Leave empty to use a "<repo>-worktrees" folder next to the repository.',
      examples: ['../my-repo-worktrees', '~/worktrees/my-repo'],
    },
    {
      key: 'worktree.editorCommand',
      description: 'Command used by `kunj worktree open` to open a worktree',
      type: 'string',
      defaultValue: 'code',
      category: 'worktree',
      detailedDescription:
        'The worktree path is appended as the last argument. Use "code -n" to always open a new VS Code window.',
      examples: ['code', 'code -n', 'cursor', 'idea'],
    },
  ]);
}
