import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Labels } from './backend';
import { parseJsonc } from './devcontainer';
import { imageRepoName } from './image';
import { LABEL } from './names';

const execFileAsync = promisify(execFile);

export const BLUEPRINT_PATH = '.kunj/blueprint.json';
export const SEED_DIR = '/opt/kunj/seed';
export const KNOWN_LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock',
];

export type ToolValue = string | string[] | true;

/** One word of a tool value: no leading -, no /, no whitespace or shell metacharacters. */
export const TOOL_WORD = /^[A-Za-z0-9][A-Za-z0-9._+:=~@-]*$/;

export interface Blueprint {
  tools: Record<string, ToolValue>;
  setup: string[];
  maintain: string[];
  lockfiles: string[];
  notes?: string;
  ignoredKeys: string[];
}

const KNOWN_KEYS = new Set(['tools', 'setup', 'maintain', 'lockfiles', 'notes']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function commandList(raw: Record<string, unknown>, key: string, source: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!isStringArray(v) || v.some(x => x.trim() === '')) throw new Error(`${source}: ${key} must be an array of strings`);
  return v;
}

export function parseBlueprint(text: string, source: string): Blueprint {
  const raw = parseJsonc(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: blueprint must be a JSON object`);
  const obj = raw as Record<string, unknown>;

  const tools: Record<string, ToolValue> = {};
  if (obj.tools !== undefined) {
    if (!obj.tools || typeof obj.tools !== 'object' || Array.isArray(obj.tools)) {
      throw new Error(`${source}: tools must be an object`);
    }
    for (const [key, value] of Object.entries(obj.tools as Record<string, unknown>)) {
      if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`${source}: tools.${key} is not a valid preset name`);
      if (typeof value !== 'string' && value !== true && !isStringArray(value)) {
        throw new Error(`${source}: tools.${key} must be a string, an array of strings or true`);
      }
      // Values reach root-run preset scripts as words: none may look like an option or a path
      const words = value === true ? [] : Array.isArray(value) ? value : value.trim().split(/\s+/);
      const bad = words.find(w => !TOOL_WORD.test(w));
      if (bad !== undefined) throw new Error(`${source}: tools.${key} contains an invalid value "${bad}"`);
      tools[key] = value as ToolValue;
    }
  }

  let lockfiles: string[] = [];
  if (obj.lockfiles !== undefined) {
    if (!isStringArray(obj.lockfiles)) throw new Error(`${source}: lockfiles must be an array of strings`);
    lockfiles = obj.lockfiles;
  }
  if (obj.notes !== undefined && typeof obj.notes !== 'string') throw new Error(`${source}: notes must be a string`);

  return {
    tools,
    setup: commandList(obj, 'setup', source),
    maintain: commandList(obj, 'maintain', source),
    lockfiles,
    notes: obj.notes as string | undefined,
    ignoredKeys: Object.keys(obj).filter(k => !KNOWN_KEYS.has(k)).sort(),
  };
}

export interface ResolvedBlueprint {
  blueprint: Blueprint;
  /** file: --blueprint; worktree: <repoRoot>/.kunj/blueprint.json; repo: origin/<default>; host: ~/.kunj/<repo>/ */
  source: 'file' | 'worktree' | 'repo' | 'host';
  path: string;
  text: string;
  ref?: string;
}

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/** The override, else the working tree kunj runs in (user-controlled, so safe, and a blueprint works
 * before it is pushed), else origin/<default branch>, else the host copy. */
export async function resolveBlueprint(opts: {
  cwd: string;
  /** The working tree's root; its .kunj/blueprint.json wins over origin's */
  repoRoot?: string;
  repoKunjDir: string;
  defaultBranch?: string;
  override?: string;
}): Promise<ResolvedBlueprint | null> {
  if (opts.override) {
    const text = fs.readFileSync(opts.override, 'utf8');
    return { blueprint: parseBlueprint(text, opts.override), source: 'file', path: opts.override, text };
  }
  if (opts.repoRoot) {
    const worktreePath = path.join(opts.repoRoot, BLUEPRINT_PATH);
    if (fs.existsSync(worktreePath)) {
      const text = fs.readFileSync(worktreePath, 'utf8');
      return { blueprint: parseBlueprint(text, worktreePath), source: 'worktree', path: worktreePath, text };
    }
  }
  if (opts.defaultBranch) {
    const ref = `origin/${opts.defaultBranch}`;
    const text = await gitOut(opts.cwd, ['show', `${ref}:${BLUEPRINT_PATH}`]);
    if (text !== null) {
      const where = `${ref}:${BLUEPRINT_PATH}`;
      return { blueprint: parseBlueprint(text, where), source: 'repo', path: where, text, ref };
    }
  }
  const hostPath = path.join(opts.repoKunjDir, 'blueprint.json');
  if (fs.existsSync(hostPath)) {
    const text = fs.readFileSync(hostPath, 'utf8');
    return { blueprint: parseBlueprint(text, hostPath), source: 'host', path: hostPath, text };
  }
  return null;
}

export async function lockfileIds(
  lockfiles: string[],
  ref: string,
  cwd: string
): Promise<Array<{ path: string; id: string }>> {
  let paths = lockfiles;
  if (paths.length === 0) {
    const root = (await gitOut(cwd, ['ls-tree', '--name-only', ref])) ?? '';
    const names = root.split('\n').filter(Boolean);
    paths = [
      ...KNOWN_LOCKFILES,
      ...names.filter(n => /^requirements.*\.txt$/.test(n)),
    ];
  }
  const out: Array<{ path: string; id: string }> = [];
  for (const p of paths) {
    const id = await gitOut(cwd, ['rev-parse', '--verify', '-q', `${ref}:${p}`]);
    if (id && id.trim()) out.push({ path: p, id: id.trim() });
  }
  return out;
}

/** Where lockfiles are read for the hash: the blueprint's own ref, else origin/<default>, else HEAD.
 * Start and snapshot both use this, so the hash does not depend on the worktree kunj runs in. */
export function blueprintRef(resolved: Pick<ResolvedBlueprint, 'ref'>, defaultBranch?: string): string {
  if (resolved.ref) return resolved.ref;
  const branch = defaultBranch?.replace(/^origin\//, '');
  return branch ? `origin/${branch}` : 'HEAD';
}

export function blueprintHash(input: {
  text: string;
  lockfiles: Array<{ path: string; id: string }>;
  baseImage: string;
  presetHashes: string[];
}): string {
  const body =
    input.text + '\n' + input.lockfiles.map(l => `${l.path}:${l.id}`).join('\n') + '\n' + input.baseImage + '\n' + input.presetHashes.join('\n');
  return createHash('sha1').update(body).digest('hex').slice(0, 12);
}

/** The one hash a start looks up and a snapshot is tagged with: the blueprint text, its lockfiles at
 * blueprintRef(), the base image and the presets. Start, snapshot, status and list all call this. */
export async function computeBlueprintHash(input: {
  resolved: Pick<ResolvedBlueprint, 'blueprint' | 'text' | 'ref'>;
  defaultBranch?: string;
  cwd: string;
  baseImage: string;
  presets: Array<{ hash: string }>;
}): Promise<string> {
  const ref = blueprintRef(input.resolved, input.defaultBranch);
  return blueprintHash({
    text: input.resolved.text,
    lockfiles: await lockfileIds(input.resolved.blueprint.lockfiles, ref, input.cwd),
    baseImage: input.baseImage,
    presetHashes: input.presets.map(p => p.hash),
  });
}

export const SNAPSHOT_REPO = (repoName: string): string => `kunj-blueprint-${imageRepoName(repoName)}`;

export function snapshotTag(repoName: string, hash: string): string {
  return `${SNAPSHOT_REPO(repoName)}:${hash}`;
}

export function blueprintLabels(input: {
  repoId: string;
  hash: string;
  ref: string;
  base: string;
  user: string;
  now?: Date;
}): Labels {
  return {
    [LABEL.repo]: input.repoId,
    [LABEL.blueprintHash]: input.hash,
    [LABEL.blueprintRef]: input.ref,
    [LABEL.blueprintBase]: input.base,
    [LABEL.blueprintUser]: input.user,
    [LABEL.blueprintCreatedAt]: (input.now ?? new Date()).toISOString(),
  };
}
