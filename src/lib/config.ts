// Configuration management for Kunj CLI

import * as fs from 'fs';
import * as path from 'path';
import { KunjConfig } from '../types';
import { defaultConfig, KUNJ_DIR, CONFIG_FILE } from '../constants';

// Helper function to get .kunj directory path
export function getKunjDir(): string {
  return path.join(process.cwd(), KUNJ_DIR);
}

// Helper function to get config file path
export function getConfigPath(): string {
  return path.join(getKunjDir(), CONFIG_FILE);
}

// Initialize .kunj directory if it doesn't exist
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

// Load configuration
export function loadConfig(): KunjConfig {
  try {
    initKunjDirectory();
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const loadedConfig = JSON.parse(data);
      // Deep merge to ensure all default fields exist
      return deepMerge(defaultConfig, loadedConfig) as KunjConfig;
    }
    return defaultConfig;
  } catch {
    return defaultConfig;
  }
}

// Save configuration
export function saveConfig(config: KunjConfig): void {
  try {
    initKunjDirectory();
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}