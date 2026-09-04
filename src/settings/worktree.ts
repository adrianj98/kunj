// Worktree settings - used by the `kunj tree` command

import { registerSettings } from '../lib/settings-registry';

export function registerWorktreeSettings(): void {
  registerSettings([
    {
      key: 'worktree.dir',
      description: 'Directory where worktrees are created',
      detailedDescription: 'Base directory for worktrees created by `kunj tree`. Each worktree is placed in a folder named after its branch with "/" replaced by "_" (e.g. feature/bob -> feature_bob). Leave empty to use ~/.kunj/{reponame}/worktrees. Supports "~" and a "{repo}" placeholder; relative paths resolve from the repository root.',
      type: 'string',
      defaultValue: '',
      category: 'worktree',
      examples: [
        '(empty) - Use ~/.kunj/{reponame}/worktrees (default)',
        '~/worktrees/{repo} - One folder per repository under your home',
        '../{repo}-worktrees - Sibling folder next to the repository'
      ],
      relatedSettings: ['worktree.openCommand']
    },
    {
      key: 'worktree.openCommand',
      description: 'Editor command used to open a worktree',
      detailedDescription: 'Command run to open a worktree after creating or switching to it. For VS Code-style editors (code, cursor, codium) kunj adds -r to reuse the current window or -n with --new-window. Set to an empty string to disable opening an editor.',
      type: 'string',
      defaultValue: 'code',
      category: 'worktree',
      examples: [
        'code - Open in Visual Studio Code (default)',
        'cursor - Open in Cursor',
        '(empty) - Do not open an editor, just print the path'
      ],
      relatedSettings: ['worktree.dir']
    }
  ]);
}
