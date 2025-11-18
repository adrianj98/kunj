// Core settings - general preferences used across multiple commands

import { registerSettings } from '../lib/settings-registry';

export function registerCoreSettings(): void {
  registerSettings([
    {
      key: 'preferences.autoStash',
      description: 'Auto-stash changes when switching',
      type: 'boolean',
      defaultValue: true,
      category: 'general'
    },
    {
      key: 'preferences.branchSort',
      description: 'Sort: recent/alphabetical',
      type: 'enum',
      defaultValue: 'recent',
      options: ['recent', 'alphabetical'],
      category: 'general'
    },
    {
      key: 'preferences.pageSize',
      description: 'Items per page',
      type: 'number',
      defaultValue: 15,
      category: 'general',
      validate: (value: number) => value > 0 && value <= 100
    }
  ]);
}
