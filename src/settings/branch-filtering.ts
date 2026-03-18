// Branch filtering settings - used by switch and list commands

import { registerSettings } from '../lib/settings-registry';

export function registerBranchFilteringSettings(): void {
  registerSettings([
    {
      key: 'preferences.showOnlyWIP',
      description: 'Filter to WIP branches',
      type: 'boolean',
      defaultValue: false,
      category: 'filtering'
    },
    {
      key: 'preferences.showOnlyConfigured',
      description: 'Filter to configured branches',
      type: 'boolean',
      defaultValue: false,
      category: 'filtering'
    },
    {
      key: 'preferences.personalWIPMode',
      description: 'Personal WIP detection',
      type: 'boolean',
      defaultValue: true,
      category: 'filtering'
    },
    {
      key: 'preferences.recentDays',
      description: 'Days for recent branches',
      type: 'number',
      defaultValue: 7,
      category: 'filtering',
      validate: (value: number) => value > 0
    },
    {
      key: 'preferences.wipTags',
      description: 'WIP tags',
      type: 'array',
      defaultValue: ['wip', 'in-progress', 'working', 'draft'],
      category: 'filtering'
    },
    {
      key: 'preferences.doneTags',
      description: 'Done tags',
      type: 'array',
      defaultValue: ['done', 'completed', 'merged', 'ready'],
      category: 'filtering'
    }
  ]);
}
