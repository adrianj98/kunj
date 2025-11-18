// Configuration management for Kunj CLI

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KunjConfig } from '../types';
import { defaultConfig, KUNJ_DIR, CONFIG_FILE } from '../constants';

// Helper function to get global .kunj directory path
export function getGlobalKunjDir(): string {
  return path.join(os.homedir(), '.kunj');
}

// Helper function to get global config file path
export function getGlobalConfigPath(): string {
  return path.join(getGlobalKunjDir(), 'config.json');
}

// Helper function to get local .kunj directory path
export function getKunjDir(): string {
  return path.join(process.cwd(), KUNJ_DIR);
}

// Helper function to get local config file path
export function getConfigPath(): string {
  return path.join(getKunjDir(), CONFIG_FILE);
}

// Initialize global .kunj directory if it doesn't exist
export function initGlobalKunjDirectory(): void {
  const globalKunjDir = getGlobalKunjDir();
  if (!fs.existsSync(globalKunjDir)) {
    fs.mkdirSync(globalKunjDir, { recursive: true });
  }
}

// Initialize local .kunj directory if it doesn't exist
export function initKunjDirectory(): void {
  const kunjDir = getKunjDir();
  if (!fs.existsSync(kunjDir)) {
    fs.mkdirSync(kunjDir, { recursive: true });
  }
}

// Deep merge function for config objects
function deepMerge(target: any, source: any): any {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === 'object' && !Array.isArray(item);
}

// Load global configuration
export function loadGlobalConfig(): Partial<KunjConfig> {
  try {
    initGlobalKunjDirectory();
    const globalConfigPath = getGlobalConfigPath();
    if (fs.existsSync(globalConfigPath)) {
      const data = fs.readFileSync(globalConfigPath, 'utf8');
      return JSON.parse(data);
    }
    return {};
  } catch {
    return {};
  }
}

// Load local configuration
export function loadLocalConfig(): Partial<KunjConfig> {
  try {
    initKunjDirectory();
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
    return {};
  } catch {
    return {};
  }
}

// Load merged configuration (global -> local override)
export function loadConfig(): KunjConfig {
  try {
    // Start with defaults
    let config = { ...defaultConfig };

    // Merge global config
    const globalConfig = loadGlobalConfig();
    config = deepMerge(config, globalConfig) as KunjConfig;

    // Merge local config (overrides global)
    const localConfig = loadLocalConfig();
    config = deepMerge(config, localConfig) as KunjConfig;

    return config;
  } catch {
    return defaultConfig;
  }
}

// Save global configuration
export function saveGlobalConfig(config: Partial<KunjConfig>): void {
  try {
    initGlobalKunjDirectory();
    const globalConfigPath = getGlobalConfigPath();
    fs.writeFileSync(globalConfigPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Failed to save global config:', error);
  }
}

// Save local configuration
export function saveLocalConfig(config: Partial<KunjConfig>): void {
  try {
    initKunjDirectory();
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Failed to save local config:', error);
  }
}

// Save configuration (for backward compatibility - saves to local)
export function saveConfig(config: KunjConfig): void {
  saveLocalConfig(config);
}