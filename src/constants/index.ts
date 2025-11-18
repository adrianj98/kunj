// Constants and default values for Kunj CLI

import { KunjConfig } from '../types';
import { initializeSettings, settingsRegistry } from '../settings';

// Initialize settings registry
initializeSettings();

// Generate default config from registered settings
const generatedDefaults = settingsRegistry.getDefaultConfig();

export const defaultConfig: KunjConfig = {
  ...generatedDefaults,
  aliases: {} // Aliases are not part of settings registry
};

export const KUNJ_DIR = ".kunj";
export const CONFIG_FILE = "config.json";
export const BRANCHES_FILE = "branches.json";