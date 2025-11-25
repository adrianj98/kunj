// Core settings - general preferences used across multiple commands

import { registerSettings } from '../lib/settings-registry';

export function registerCoreSettings(): void {
  registerSettings([
    {
      key: 'preferences.autoStash',
      description: 'Auto-stash changes when switching',
      detailedDescription: 'Automatically stash uncommitted changes when switching branches. When enabled, Kunj will save your work-in-progress before switching and restore it when you return to the branch. This prevents losing uncommitted changes when moving between branches.',
      type: 'boolean',
      defaultValue: true,
      category: 'general',
      examples: [
        'true - Automatically stash changes (recommended)',
        'false - Never stash, require clean working tree'
      ],
      relatedSettings: ['preferences.showStashDetails']
    },
    {
      key: 'preferences.branchSort',
      description: 'Sort: recent/alphabetical',
      detailedDescription: 'Determines how branches are sorted in lists and menus. "recent" sorts by last activity (most recently used first), while "alphabetical" sorts branches by name in A-Z order.',
      type: 'enum',
      defaultValue: 'recent',
      options: ['recent', 'alphabetical'],
      category: 'general',
      examples: [
        'recent - Show most recently used branches first',
        'alphabetical - Sort branches by name'
      ]
    },
    {
      key: 'preferences.pageSize',
      description: 'Items per page',
      detailedDescription: 'Number of items to display per page in interactive menus. Larger values show more items at once but may be harder to navigate. Smaller values require more scrolling but are easier to scan.',
      type: 'number',
      defaultValue: 15,
      category: 'general',
      validate: (value: number) => value > 0 && value <= 100,
      examples: [
        '10 - Compact view',
        '15 - Balanced (default)',
        '20 - Show more items at once',
        '30 - Maximum visibility'
      ]
    }
  ]);
}
