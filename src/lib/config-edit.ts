// The settings list as JSON and the exact, checked edits behind `kunj config --schema`,
// `--set-json` and `--unset` (docs/specs/workspace-settings.md). Pure functions: the command loads
// and saves the files.

import { UserError } from './errors';
import type { SettingDefinition } from './settings-registry';
import type { ConfigSchemaJson, ConfigSettingJson } from './json-types';

export class ConfigEditError extends UserError {
  constructor(message: string, code: 'unknown-setting' | 'bad-value', hint?: string) {
    super(message, hint, code);
    // Stays 'UserError' so it prints without a stack trace
  }
}

// Category titles, in the order the workspace app lists them
export const CATEGORY_TITLES: Record<string, string> = {
  general: 'General',
  worktree: 'Worktrees',
  agent: 'Agents',
  container: 'Containers',
  lsp: 'Language servers',
  repos: 'Repositories',
  secrets: 'Secrets',
  ai: 'AI',
  flow: 'Git flow',
  jira: 'Jira',
  slack: 'Slack',
  hooks: 'Hooks',
  filtering: 'Branch filtering',
  stash: 'Stash',
};

export function buildConfigSchema(settings: SettingDefinition[]): ConfigSchemaJson {
  const used = new Set(settings.map(s => s.category || 'general'));
  const ids = [
    ...Object.keys(CATEGORY_TITLES).filter(id => used.has(id)),
    ...[...used].filter(id => !(id in CATEGORY_TITLES)),
  ];
  return {
    categories: ids.map(id => ({ id, title: CATEGORY_TITLES[id] ?? id.charAt(0).toUpperCase() + id.slice(1) })),
    settings: settings.map(s => {
      const out: ConfigSettingJson = {
        key: s.key,
        category: s.category || 'general',
        type: s.type,
        default: s.defaultValue ?? null,
        description: s.description,
      };
      if (s.detailedDescription) out.detailedDescription = s.detailedDescription;
      if (s.options) out.options = s.options;
      if (s.examples) out.examples = s.examples;
      if (s.sensitive) out.sensitive = true;
      return out;
    }),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// What a value of this setting must be, for the error message
function expected(setting: SettingDefinition): string {
  switch (setting.type) {
    case 'boolean': return 'true or false';
    case 'number': return 'a number';
    case 'enum': return `one of ${(setting.options ?? []).join(', ')}`;
    case 'array': return 'a list';
    case 'object': return 'an object';
    default: return setting.key.startsWith('hooks.') ? 'a string or a list of strings' : 'a string';
  }
}

export function checkSettingValue(setting: SettingDefinition, value: unknown): void {
  let ok: boolean;
  switch (setting.type) {
    case 'boolean': ok = typeof value === 'boolean'; break;
    case 'number': ok = typeof value === 'number' && Number.isFinite(value); break;
    case 'enum': ok = typeof value === 'string' && (!setting.options || setting.options.includes(value)); break;
    case 'array': ok = Array.isArray(value); break;
    case 'object': ok = isPlainObject(value); break;
    default:
      ok = typeof value === 'string' ||
        (setting.key.startsWith('hooks.') && Array.isArray(value) && value.every(v => typeof v === 'string'));
  }
  if (!ok) throw new ConfigEditError(`${setting.key} must be ${expected(setting)}.`, 'bad-value');
  if (setting.validate) {
    let valid = false;
    try {
      valid = setting.validate(value) === true;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new ConfigEditError(`That value is not allowed for ${setting.key}.`, 'bad-value', setting.description);
    }
  }
}

// "<key>=<json>", split at the first "=": a key never contains one, and the value may
export function parseSetJson(input: string, settings: SettingDefinition[]): { key: string; value: unknown } {
  const at = input.indexOf('=');
  const key = at === -1 ? input : input.slice(0, at);
  const setting = settings.find(s => s.key === key);
  if (!setting) {
    throw new ConfigEditError(`${key} is not a kunj setting.`, 'unknown-setting', 'List them with `kunj config --schema`.');
  }
  if (at === -1) {
    throw new ConfigEditError(`${key} needs a value.`, 'bad-value', `Write it as \`kunj config --set-json '${key}=<json>'\`.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(input.slice(at + 1));
  } catch {
    throw new ConfigEditError(`The value for ${key} is not JSON.`, 'bad-value', 'A string needs double quotes: \'agent.command="claude"\'.');
  }
  checkSettingValue(setting, value);
  return { key, value };
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function segments(key: string): string[] {
  const parts = key.split('.');
  if (parts.some(p => p === '' || FORBIDDEN.has(p))) {
    throw new ConfigEditError(`${key} is not a valid setting key.`, 'bad-value');
  }
  return parts;
}

export function setConfigPath(config: Record<string, any>, key: string, value: unknown): void {
  const parts = segments(key);
  let current = config;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

// Removes the key and every parent it leaves empty; false when it was not there
export function unsetConfigPath(config: Record<string, any>, key: string): boolean {
  const parts = segments(key);
  const chain: Record<string, any>[] = [config];
  for (const part of parts.slice(0, -1)) {
    const next = chain[chain.length - 1][part];
    if (!isPlainObject(next) || !Object.prototype.hasOwnProperty.call(chain[chain.length - 1], part)) return false;
    chain.push(next);
  }
  const last = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(chain[chain.length - 1], last)) return false;
  delete chain[chain.length - 1][last];
  for (let i = chain.length - 1; i > 0 && Object.keys(chain[i]).length === 0; i--) {
    delete chain[i - 1][parts[i - 1]];
  }
  return true;
}
