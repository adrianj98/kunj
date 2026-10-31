// Repository settings - used by `kunj repos clone`

import { registerSettings } from '../lib/settings-registry';
import { DEFAULT_CLONE_DIR } from '../lib/clone-defaults';

export function registerReposSettings(): void {
  registerSettings([
    {
      key: 'repos.cloneDir',
      description: 'Directory `kunj repos clone` clones repositories into',
      type: 'string',
      defaultValue: DEFAULT_CLONE_DIR,
      category: 'repos',
      detailedDescription:
        'The repository is cloned to <cloneDir>/<name> (<name>.git with repos.cloneBare). ' +
        'A leading ~ and ${home} are expanded; --dir overrides it for one clone.',
      examples: [DEFAULT_CLONE_DIR, '~/src', '~/code/github'],
      relatedSettings: ['repos.cloneBare', 'worktree.baseDir'],
    },
    {
      key: 'repos.cloneBare',
      description: 'Clone as a bare repository with a worktree for the default branch',
      type: 'boolean',
      defaultValue: false,
      category: 'repos',
      detailedDescription:
        'When true, `kunj repos clone` makes <cloneDir>/<name>.git bare, fetching origin into refs/remotes/origin, ' +
        'and adds a worktree for the default branch where worktree.baseDir puts it. --bare / --no-bare override it for one clone.',
      relatedSettings: ['repos.cloneDir', 'worktree.baseDir'],
    },
  ]);
}
