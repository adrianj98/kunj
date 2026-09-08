// Worktree settings - used by the `kunj worktree` command and editor integrations

import { registerSettings } from '../lib/settings-registry';
import { DEFAULT_WORKTREE_BASE_DIR } from '../lib/worktree-defaults';

export function registerWorktreeSettings(): void {
  registerSettings([
    {
      key: 'worktree.baseDir',
      description: 'Directory where new worktrees are created',
      type: 'string',
      defaultValue: DEFAULT_WORKTREE_BASE_DIR,
      category: 'worktree',
      detailedDescription:
        'Supports ${repoconfig} (the .git directory, or the repository itself when bare), ${repoRoot}, ${repoName}, ${home} and ${branch}. ' +
        'Relative paths are resolved from the main repository root. Unless ${branch} appears, the branch directory is appended automatically.',
      examples: [
        DEFAULT_WORKTREE_BASE_DIR,
        '${repoRoot}/../${repoName}-worktrees',
        '~/worktrees/${repoName}',
      ],
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
