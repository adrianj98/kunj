// Configuration management for Kunj CLI

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
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

function gitSync(args: string): string | null {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// Extract a repository name from a remote URL (ssh, https, or local path)
export function repoNameFromUrl(url: string): string {
  let name = url.trim().replace(/[\/\\]+$/, '');
  name = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'), name.lastIndexOf(':')) + 1);
  return name.replace(/\.git$/, '');
}

// Get the main (common) directory of the repository, shared across all worktrees
let commonRootCache: string | null | undefined;
export function getRepoCommonRoot(): string | null {
  if (commonRootCache !== undefined) {
    return commonRootCache;
  }
  const commonDir = gitSync('rev-parse --path-format=absolute --git-common-dir');
  if (!commonDir) {
    commonRootCache = null;
    return null;
  }
  // Non-bare repos: <root>/.git. Bare repos: the directory itself.
  commonRootCache = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return commonRootCache;
}

// Resolve the repository name used to namespace ~/.kunj/{reponame}
let repoNameCache: string | null | undefined;
export function getRepoName(): string | null {
  if (repoNameCache !== undefined) {
    return repoNameCache;
  }
  const origin = gitSync('remote get-url origin');
  if (origin) {
    const fromUrl = repoNameFromUrl(origin);
    if (fromUrl) {
      repoNameCache = fromUrl;
      return repoNameCache;
    }
  }
  const root = getRepoCommonRoot();
  repoNameCache = root ? path.basename(root).replace(/\.git$/, '') : null;
  return repoNameCache;
}

// Test/refresh helper: clear cached repo resolution
export function resetRepoCache(): void {
  commonRootCache = undefined;
  repoNameCache = undefined;
  migrationChecked = false;
}

// Helper function to get the per-repository kunj directory path.
// Lives in ~/.kunj/{reponame} so every worktree of a repo shares it.
// Outside a git repository, falls back to ./.kunj in the current directory.
let migrationChecked = false;
export function getKunjDir(): string {
  const repoName = getRepoName();
  if (!repoName) {
    return path.join(process.cwd(), KUNJ_DIR);
  }
  const dir = path.join(getGlobalKunjDir(), repoName);
  if (!migrationChecked) {
    migrationChecked = true;
    migrateLegacyKunjDir(dir);
  }
  return dir;
}

// One-time migration: copy a legacy ./.kunj directory into the new location
function migrateLegacyKunjDir(newDir: string): void {
  try {
    if (fs.existsSync(newDir)) {
      return;
    }
    const candidates = [path.join(process.cwd(), KUNJ_DIR)];
    const toplevel = gitSync('rev-parse --show-toplevel');
    if (toplevel) {
      candidates.push(path.join(toplevel, KUNJ_DIR));
    }
    const legacy = candidates.find(c => fs.existsSync(path.join(c, CONFIG_FILE)) || fs.existsSync(path.join(c, 'branches.json')));
    if (!legacy) {
      return;
    }
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.cpSync(legacy, newDir, { recursive: true });
    console.error(`kunj: migrated ${legacy} -> ${newDir}`);
  } catch {
    // Migration is best-effort
  }
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