// Central settings registration - import and register all settings

import { registerCoreSettings } from './core';
import { registerBranchFilteringSettings } from './branch-filtering';
import { registerStashSettings } from './stash';
import { registerAISettings } from './ai';
import { settingsRegistry } from '../lib/settings-registry';

let initialized = false;

// Initialize all settings - call this once at app startup
export function initializeSettings(): void {
  if (initialized) {
    return;
  }

  // Register all settings
  registerCoreSettings();
  registerBranchFilteringSettings();
  registerStashSettings();
  registerAISettings();

  initialized = true;
}

// Export the registry for use in other modules
export { settingsRegistry };
export * from '../lib/settings-registry';
