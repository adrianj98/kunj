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
        'Base directory for worktrees created by `kunj worktree add`. Each worktree is placed in a folder named after its branch (e.g. feature/bob -> feature-bob). Leave empty to use a "<repo>-worktrees" folder next to the repository. Supports "~" and a "{repo}" placeholder; relative paths resolve from the main repository root.',
      examples: [
        '(empty) - Use <repo>-worktrees next to the repository (default)',
        '../my-repo-worktrees - Sibling folder next to the repository',
        '~/worktrees/{repo} - One folder per repository under your home',
      ],
      relatedSettings: ['worktree.editorCommand'],
    },
    {
      key: 'worktree.editorCommand',
      description: 'Command used by `kunj worktree open` to open a worktree',
      type: 'string',
      defaultValue: 'code',
      category: 'worktree',
      detailedDescription:
        'The worktree path is appended as the last argument. For VS Code-style editors (code, cursor, codium, windsurf) kunj adds -r to reuse the current window, or -n with --new-window. Set to an empty string to disable opening an editor.',
      examples: [
        'code - Open in Visual Studio Code (default)',
        'code -n - Always open a new VS Code window',
        'cursor - Open in Cursor',
        '(empty) - Do not open an editor',
      ],
      relatedSettings: ['worktree.baseDir'],
    },
  ]);
}
