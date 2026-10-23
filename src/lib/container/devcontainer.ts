import * as path from 'path';
import { isImageRef } from './backend';

export interface DevcontainerSpec {
  image?: string;
  build?: { dockerfile: string; context: string; args: Record<string, string> };
  containerEnv: Record<string, string>;
  remoteUser?: string;
  forwardPorts: number[];
  postCreateCommand?: string;
  postStartCommand?: string;
  hasComposeFile: boolean;
  /** dockerComposeFile, relative to the repository root */
  composeFiles?: string[];
  /** The compose service the devcontainer itself is; not started as a sidecar */
  service?: string;
  ignoredKeys: string[];
}

export const DEVCONTAINER_PATHS = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

const SUPPORTED_KEYS = new Set([
  'image',
  'build',
  'containerEnv',
  'remoteUser',
  'forwardPorts',
  'postCreateCommand',
  'postStartCommand',
  'dockerComposeFile',
  'service',
]);

/** Remove // and block comments outside strings, then trailing commas, and parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(stripTrailingCommas(out));
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += c;
    } else {
      out += c;
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(v)) return result;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') result[k] = val;
  }
  return result;
}

/** A file in the repo can be edited by an agent, so root is never accepted. */
function validateRemoteUser(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === 'string' ? value : String(value);
  const user = raw.trim().split(':')[0].toLowerCase();
  if (user === 'root' || (/^\d+$/.test(user) && Number(user) === 0)) {
    throw new Error(`remoteUser must be a non-root user (got "${raw}")`);
  }
  if (typeof value !== 'string') return undefined;
  return raw;
}

function command(v: unknown): { value?: string; ignored: boolean } {
  if (typeof v === 'string') return { value: v, ignored: false };
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return { value: v.join(' '), ignored: false };
  return { ignored: v !== undefined };
}

export function parseDevcontainer(text: string, filePath: string): DevcontainerSpec {
  const doc = parseJsonc(text);
  if (!isRecord(doc)) throw new Error(`${filePath}: expected a JSON object`);

  const dir = path.posix.dirname(filePath.replace(/\\/g, '/'));
  const rel = (p: string, key: string) => {
    const resolved = path.posix.normalize(path.posix.join(dir, p));
    const absolute = path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
    if (absolute || resolved === '..' || resolved.startsWith('../')) {
      throw new Error(`${filePath}: ${key} must stay inside the repository (got "${p}")`);
    }
    return resolved;
  };

  const ignored = new Set(Object.keys(doc).filter(k => !SUPPORTED_KEYS.has(k)));

  const spec: DevcontainerSpec = {
    containerEnv: stringMap(doc.containerEnv),
    forwardPorts: Array.isArray(doc.forwardPorts)
      ? doc.forwardPorts.filter((p): p is number => typeof p === 'number')
      : [],
    hasComposeFile: doc.dockerComposeFile !== undefined,
    ignoredKeys: [],
  };

  if (typeof doc.image === 'string') {
    // It reaches docker as an argument: a value starting with '-' would be read as a flag
    if (!isImageRef(doc.image)) throw new Error(`${filePath}: image "${doc.image}" is not a valid image reference`);
    spec.image = doc.image;
  }

  if (isRecord(doc.build) && typeof doc.build.dockerfile === 'string') {
    spec.build = {
      dockerfile: rel(doc.build.dockerfile, 'build.dockerfile'),
      context: rel(typeof doc.build.context === 'string' ? doc.build.context : '.', 'build.context'),
      args: stringMap(doc.build.args),
    };
  }

  spec.remoteUser = validateRemoteUser(doc.remoteUser);

  const compose = typeof doc.dockerComposeFile === 'string' ? [doc.dockerComposeFile] : doc.dockerComposeFile;
  if (Array.isArray(compose) && compose.every(f => typeof f === 'string')) {
    spec.composeFiles = compose.map(f => rel(f, 'dockerComposeFile'));
  } else if (compose !== undefined) {
    ignored.add('dockerComposeFile');
  }
  if (typeof doc.service === 'string') spec.service = doc.service;

  for (const key of ['postCreateCommand', 'postStartCommand'] as const) {
    const { value, ignored: skip } = command(doc[key]);
    if (value !== undefined) spec[key] = value;
    if (skip) ignored.add(key);
  }

  spec.ignoredKeys = [...ignored].sort();
  return spec;
}
