// Stash settings - used by stash-related functionality

import { registerSettings } from '../lib/settings-registry';

export function registerStashSettings(): void {
  registerSettings([
    {
      key: 'preferences.showStashDetails',
      description: 'Show stash file/line counts',
      type: 'boolean',
      defaultValue: true,
      category: 'stash'
    },
    {
      key: 'preferences.stashAgeDays',
      description: 'Days for recent stashes',
      type: 'number',
      defaultValue: 30,
      category: 'stash',
      validate: (value: number) => value > 0
    }
  ]);
}
