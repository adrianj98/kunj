// The personal blueprint: what of the user goes into a branch container, declared in
// ~/.kunj/blueprint.json (every repository) and ~/.kunj/<repo>/blueprint.json (one repository), in the
// repository blueprint's file format. Nothing is copied unless it is named here, and what can be named
// is bounded by allowlists: a copied .gitconfig, settings.json or .zshrc would break the container
// (credential helper, insteadOf, hooks calling host binaries, host paths). Applied into the home volume
// as the sandbox user on every start and resume, never into a snapshot. Spec: docs/specs/personal-blueprint.md.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerBackend } from './backend';
import { ALIAS_NAME, PERSONAL_KEYS, REPO_BLUEPRINT_KEYS } from './blueprint';
import { parseJsonc } from './devcontainer';
import { ContainerError } from './errors';
import { tarEntries } from './image';

export const PERSONAL_FILE = 'blueprint.json';
/** Where the layer lands in the container home: the rc sourced by the sandbox zshrc, the record and the stamp */
export const RC_PATH = '.kunj/rc';
export const RECORD_PATH = '.kunj/personal.json';
export const STAMP_PATH = '.kunj/personal.stamp';
const SETTINGS_PATH = '.claude/settings.json';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 500;
const MAX_RC_BYTES = 64 * 1024;
const MAX_GIT_VALUE = 1000;

/** Git config keys a container may take from the host; everything else is refused with a reason */
export const GIT_ALLOWED = new Set([
  'user.name',
  'user.email',
  'pull.rebase',
  'pull.ff',
  'push.default',
  'push.autoSetupRemote',
  'init.defaultBranch',
  'fetch.prune',
  'rerere.enabled',
  'rerere.autoupdate',
  'diff.algorithm',
  'diff.colorMoved',
  'merge.conflictstyle',
  'log.date',
  'color.ui',
  'core.pager',
  'core.autocrlf',
]);

const GIT_REFUSED: Array<[RegExp, string]> = [
  [/^credential\./i, 'it would shadow kunj\'s credential helper'],
  [/^core\.hooksPath$/i, 'it is a host path'],
  [/^core\.sshCommand$/i, 'the container has no SSH key'],
  [/^core\.editor$/i, 'the host\'s editor is not in the image'],
  [/^include(If)?\./i, 'it is a host path'],
  [/^url\./i, 'an insteadOf rewrite would break the token-based origin'],
  [/^(gpg\.|commit\.gpgsign$|tag\.gpgsign$|user\.signingkey$)/i, 'the container has no signing key'],
  [/^(http|remote|safe)\./i, 'it is not a per-user preference'],
];

export interface ClaudeSelection {
  claudeMd?: boolean;
  skills?: true | string[];
  agents?: true | string[];
  commands?: true | string[];
  settings?: { model?: string; permissions?: { deny?: string[] } };
}

export interface PersonalFile {
  /** Host path as written (`~` allowed) */
  from: string;
  /** Relative to the container home */
  to: string;
}

export interface PersonalBlueprint {
  git: Record<string, string>;
  claude?: ClaudeSelection;
  shell?: { rc?: string; rcFile?: string };
  /** Undefined when the file has no `files` key (a merge keeps the other file's) */
  files?: PersonalFile[];
  aliases: Record<string, string>;
  ignoredKeys: string[];
}

export interface ResolvedPersonal {
  blueprint: PersonalBlueprint;
  /** The files that exist, global first */
  sources: Array<{ path: string; scope: 'global' | 'repo' }>;
  /** The host home (`~` in `files`, the home check) and Claude Code's config directory */
  home: string;
  claudeDir: string;
}

// ---------------------------------------------------------------------------------------------
// parse

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const NAME = /^[A-Za-z0-9_.-]+$/;

function parseNames(v: unknown, key: string, source: string): true | string[] | undefined {
  if (v === undefined) return undefined;
  if (v === true) return true;
  if (!isStringArray(v)) throw new ContainerError(`${source}: ${key} must be true (every one) or an array of names, e.g. ["handoff"].`);
  v.forEach((name, i) => {
    if (!NAME.test(name) || name === '.' || name === '..') throw new ContainerError(`${source}: ${key}[${i}] ${JSON.stringify(name)} is not a name (letters, digits, _ . -; no path).`);
  });
  return v;
}

function parseClaude(v: unknown, source: string): ClaudeSelection | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) throw new ContainerError(`${source}: claude must be an object, e.g. {"skills": true, "claudeMd": true}.`);
  const out: ClaudeSelection = {};
  for (const key of Object.keys(v)) {
    if (!['claudeMd', 'skills', 'agents', 'commands', 'settings'].includes(key)) {
      throw new ContainerError(`${source}: claude.${key} is not a known key (claudeMd, skills, agents, commands, settings).`);
    }
  }
  if (v.claudeMd !== undefined) {
    if (typeof v.claudeMd !== 'boolean') throw new ContainerError(`${source}: claude.claudeMd must be true or false.`);
    out.claudeMd = v.claudeMd;
  }
  for (const key of ['skills', 'agents', 'commands'] as const) {
    const names = parseNames(v[key], `claude.${key}`, source);
    if (names !== undefined) out[key] = names;
  }
  if (v.settings !== undefined) {
    if (!isObject(v.settings)) throw new ContainerError(`${source}: claude.settings must be an object with model and/or permissions.deny.`);
    const settings: NonNullable<ClaudeSelection['settings']> = {};
    for (const key of Object.keys(v.settings)) {
      if (key !== 'model' && key !== 'permissions') {
        throw new ContainerError(`${source}: claude.settings.${key} is not copied into containers (only model and permissions.deny are).`);
      }
    }
    if (v.settings.model !== undefined) {
      if (typeof v.settings.model !== 'string' || !v.settings.model.trim() || /[\n\r]/.test(v.settings.model)) {
        throw new ContainerError(`${source}: claude.settings.model must be a model name.`);
      }
      settings.model = v.settings.model;
    }
    if (v.settings.permissions !== undefined) {
      if (!isObject(v.settings.permissions)) throw new ContainerError(`${source}: claude.settings.permissions must be an object with deny.`);
      for (const key of Object.keys(v.settings.permissions)) {
        if (key !== 'deny') throw new ContainerError(`${source}: claude.settings.permissions.${key} is not copied into containers (only model and permissions.deny are).`);
      }
      if (v.settings.permissions.deny !== undefined) {
        if (!isStringArray(v.settings.permissions.deny)) throw new ContainerError(`${source}: claude.settings.permissions.deny must be an array of rules.`);
        settings.permissions = { deny: v.settings.permissions.deny };
      }
    }
    if (Object.keys(settings).length) out.settings = settings;
  }
  return out;
}

function parseGit(v: unknown, source: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) throw new ContainerError(`${source}: git must be an object of config key to value, e.g. {"pull.rebase": "true"}.`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (key === '__proto__') throw new ContainerError(`${source}: git.${JSON.stringify(key)} is not a git config key.`);
    const alias = /^alias\.(.+)$/.exec(key);
    if (alias) {
      if (!ALIAS_NAME.test(alias[1])) throw new ContainerError(`${source}: git.${JSON.stringify(key)} is not a valid alias name.`);
    } else if (!GIT_ALLOWED.has(key)) {
      const refused = GIT_REFUSED.find(([re]) => re.test(key));
      const why = refused ? refused[1] : 'only a fixed set of per-user keys is copied';
      throw new ContainerError(`${source}: git.${JSON.stringify(key)} is not allowed in a container (${why}). Allowed: ${[...GIT_ALLOWED].join(', ')} and alias.*.`);
    }
    if (typeof value !== 'string' || /[\n\r]/.test(value) || value.length > MAX_GIT_VALUE) {
      throw new ContainerError(`${source}: git.${JSON.stringify(key)} must be one line (a string of at most ${MAX_GIT_VALUE} characters).`);
    }
    if (alias && value.trimStart().startsWith('!')) {
      throw new ContainerError(`${source}: git.${JSON.stringify(key)} runs a shell command, which is not allowed (it would run on the host's path).`);
    }
    out[key] = value;
  }
  return out;
}

function parseShell(v: unknown, source: string): PersonalBlueprint['shell'] {
  if (v === undefined) return undefined;
  if (!isObject(v)) throw new ContainerError(`${source}: shell must be an object with rc (text) or rcFile (a path under your home).`);
  for (const key of Object.keys(v)) {
    if (key !== 'rc' && key !== 'rcFile') throw new ContainerError(`${source}: shell.${key} is not a known key (rc, rcFile).`);
  }
  const hasRc = v.rc !== undefined;
  const hasFile = v.rcFile !== undefined;
  if (hasRc === hasFile) throw new ContainerError(`${source}: shell needs rc or rcFile, not both.`);
  if (hasRc) {
    if (typeof v.rc !== 'string') throw new ContainerError(`${source}: shell.rc must be a string.`);
    if (Buffer.byteLength(v.rc) > MAX_RC_BYTES) throw new ContainerError(`${source}: shell.rc is over ${MAX_RC_BYTES / 1024} KB.`);
    return { rc: v.rc };
  }
  if (typeof v.rcFile !== 'string' || !v.rcFile.trim()) throw new ContainerError(`${source}: shell.rcFile must be a path under your home directory.`);
  return { rcFile: v.rcFile };
}

/** The container-side path of a `files` entry: relative, inside the home, not kunj's or the claude key's */
function checkTarget(to: string, where: string, source: string): string {
  const norm = to.replace(/^\.\//, '').replace(/\/+$/, '');
  const parts = norm.split('/');
  if (!norm || path.posix.isAbsolute(norm) || parts.some(p => p === '..' || p === '' || p === '.') || /[\n\r\0]/.test(norm)) {
    throw new ContainerError(`${source}: ${where} must be a path inside the container home (no .., not under .kunj or .claude).`);
  }
  if (parts[0] === '.kunj' || parts[0] === '.claude') {
    throw new ContainerError(`${source}: ${where} must be a path inside the container home (no .., not under .kunj or .claude).`);
  }
  return norm;
}

function parseFiles(v: unknown, source: string): PersonalFile[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ContainerError(`${source}: files must be an array of "~/path" or {"from": "~/path", "to": "path"}.`);
  return v.map((entry, i) => {
    let from: string;
    let to: string | undefined;
    if (typeof entry === 'string') {
      from = entry;
    } else if (isObject(entry) && typeof entry.from === 'string') {
      for (const key of Object.keys(entry)) {
        if (key !== 'from' && key !== 'to') throw new ContainerError(`${source}: files[${i}].${key} is not a known key (from, to).`);
      }
      from = entry.from;
      if (entry.to !== undefined) {
        if (typeof entry.to !== 'string') throw new ContainerError(`${source}: files[${i}].to must be a string.`);
        to = entry.to;
      }
    } else {
      throw new ContainerError(`${source}: files[${i}] must be "~/path" or {"from": "~/path", "to": "path"}.`);
    }
    if (!from.trim() || /[\n\r\0]/.test(from)) throw new ContainerError(`${source}: files[${i}].from must be a path under your home directory.`);
    if (to === undefined) {
      // Default: the same place relative to the home
      const rel = from.replace(/^~\//, '');
      if (rel === from || !rel) throw new ContainerError(`${source}: files[${i}] "${from}" needs "to" unless it starts with ~/.`);
      to = rel;
    }
    return { from, to: checkTarget(to, `files[${i}].to`, source) };
  });
}

function parseAliases(v: unknown, source: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) throw new ContainerError(`${source}: aliases must be an object of name to command, e.g. {"t": "npm test"}.`);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(v)) {
    if (!ALIAS_NAME.test(name) || name === '__proto__') throw new ContainerError(`${source}: aliases.${name} is not a valid alias name; use letters, digits and _ . + -.`);
    if (typeof value !== 'string' || value.trim() === '' || /[\n\r]/.test(value)) throw new ContainerError(`${source}: aliases.${name} must be a one-line command.`);
    out[name] = value;
  }
  return out;
}

/**
 * Parse the personal keys of a blueprint file. `global` (~/.kunj/blueprint.json) refuses the repository
 * keys; `host` (~/.kunj/<repo>/blueprint.json, also the host copy of the repository blueprint) leaves
 * them to parseBlueprint.
 */
export function parsePersonal(text: string, source: string, kind: 'global' | 'host'): PersonalBlueprint {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (err) {
    throw new ContainerError(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Fix the file, or write a new one with kunj ct blueprint init --personal.`);
  }
  if (!isObject(raw)) throw new ContainerError(`${source}: blueprint must be a JSON object.`);
  if (raw.kunj !== undefined) {
    throw new ContainerError(`${source}: "kunj" is not supported yet (it needs kunj installed in the sandbox image).`);
  }
  if (kind === 'global') {
    const repoKey = Object.keys(raw).find(k => REPO_BLUEPRINT_KEYS.has(k));
    if (repoKey) throw new ContainerError(`${source}: "${repoKey}" belongs in the repository's .kunj/blueprint.json (or ~/.kunj/<repo>/blueprint.json), not in the personal blueprint.`);
  }
  const known = new Set<string>([...PERSONAL_KEYS, 'aliases', ...(kind === 'host' ? REPO_BLUEPRINT_KEYS : [])]);
  return {
    git: parseGit(raw.git, source),
    ...(raw.claude !== undefined ? { claude: parseClaude(raw.claude, source) } : {}),
    ...(raw.shell !== undefined ? { shell: parseShell(raw.shell, source) } : {}),
    ...(raw.files !== undefined ? { files: parseFiles(raw.files, source) } : {}),
    aliases: parseAliases(raw.aliases, source),
    ignoredKeys: Object.keys(raw).filter(k => !known.has(k)).sort(),
  };
}

export function isEmptyPersonal(bp: PersonalBlueprint): boolean {
  return (
    Object.keys(bp.git).length === 0 &&
    bp.claude === undefined &&
    bp.shell === undefined &&
    !(bp.files && bp.files.length) &&
    Object.keys(bp.aliases).length === 0
  );
}

/** `over` wins per key: git and aliases by name, claude by sub-key, shell and files whole. */
export function mergePersonal(base: PersonalBlueprint, over: PersonalBlueprint): PersonalBlueprint {
  const claude = base.claude || over.claude ? { ...(base.claude ?? {}), ...(over.claude ?? {}) } : undefined;
  return {
    git: { ...base.git, ...over.git },
    ...(claude ? { claude } : {}),
    ...(over.shell ?? base.shell ? { shell: over.shell ?? base.shell } : {}),
    ...(over.files ?? base.files ? { files: over.files ?? base.files } : {}),
    aliases: { ...base.aliases, ...over.aliases },
    ignoredKeys: [...new Set([...base.ignoredKeys, ...over.ignoredKeys])].sort(),
  };
}

export function defaultClaudeDir(home: string = os.homedir()): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/**
 * The merged personal blueprint of ~/.kunj/blueprint.json and ~/.kunj/<repo>/blueprint.json; null when
 * neither names anything personal. A file that does not parse throws (named file and key).
 */
export function resolvePersonal(opts: { globalKunjDir: string; repoKunjDir: string; home?: string; claudeDir?: string }): ResolvedPersonal | null {
  const home = opts.home ?? os.homedir();
  const claudeDir = opts.claudeDir ?? defaultClaudeDir(home);
  const sources: ResolvedPersonal['sources'] = [];
  let merged: PersonalBlueprint = { git: {}, aliases: {}, ignoredKeys: [] };
  const globalPath = path.join(opts.globalKunjDir, PERSONAL_FILE);
  const repoPath = path.join(opts.repoKunjDir, PERSONAL_FILE);
  if (fs.existsSync(globalPath)) {
    merged = mergePersonal(merged, parsePersonal(fs.readFileSync(globalPath, 'utf8'), globalPath, 'global'));
    sources.push({ path: globalPath, scope: 'global' });
  }
  if (repoPath !== globalPath && fs.existsSync(repoPath)) {
    merged = mergePersonal(merged, parsePersonal(fs.readFileSync(repoPath, 'utf8'), repoPath, 'host'));
    sources.push({ path: repoPath, scope: 'repo' });
  }
  if (sources.length === 0 || isEmptyPersonal(merged)) return null;
  return { blueprint: merged, sources, home, claudeDir };
}

// ---------------------------------------------------------------------------------------------
// plan: the host side, read into memory before anything runs in the container

export interface PersonalEntry {
  /** Relative to the container home */
  path: string;
  content: Buffer;
  mode: number;
}

export interface PersonalSummary {
  git: string[];
  claude: { claudeMd: boolean; skills: string[]; agents: string[]; commands: string[]; settings: string[] };
  shell: boolean;
  files: string[];
  dropped: Array<{ entry: string; reason: string }>;
}

export interface PersonalPlan {
  stamp: string;
  entries: PersonalEntry[];
  git: Record<string, string>;
  settings?: { model?: string; deny?: string[] };
  summary: PersonalSummary;
}

function expandHome(p: string, home: string): string {
  return p.replace(/^~(?=$|\/)/, home);
}

/** Resolves a host path and checks it is inside the home (also through symlinks); null when not. */
function insideHome(p: string, home: string): string | null {
  let real: string;
  let realHome: string;
  try {
    real = fs.realpathSync(expandHome(p, home));
    realHome = fs.realpathSync(home);
  } catch {
    return null;
  }
  return real === realHome || real.startsWith(realHome + path.sep) ? real : null;
}

class Collector {
  entries: PersonalEntry[] = [];
  dropped: PersonalSummary['dropped'] = [];
  private count = 0;

  constructor(private warn: (m: string) => void) {}

  drop(entry: string, reason: string): void {
    this.dropped.push({ entry, reason });
    this.warn(`personal blueprint: ${entry} dropped (${reason})`);
  }

  /** Reads a file or a directory (recursively, symlinks and .git skipped) into entries under `to`; false when over a cap. */
  add(hostPath: string, to: string, entry: string): boolean {
    const staged: PersonalEntry[] = [];
    const walk = (full: string, rel: string): boolean => {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        this.warn(`personal blueprint: ${entry}: symlink ${rel} skipped`);
        return true;
      }
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(full).sort()) {
          if (name === '.git') continue;
          if (!walk(path.join(full, name), path.posix.join(rel, name))) return false;
        }
        return true;
      }
      if (!stat.isFile()) return true;
      if (stat.size > MAX_FILE_BYTES) {
        this.drop(entry, `${rel} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`);
        return false;
      }
      if (this.count + staged.length + 1 > MAX_FILES) {
        this.drop(entry, `more than ${MAX_FILES} files in all`);
        return false;
      }
      staged.push({ path: rel, content: fs.readFileSync(full), mode: stat.mode & 0o777 });
      return true;
    };
    if (!walk(hostPath, to)) return false;
    this.entries.push(...staged);
    this.count += staged.length;
    return true;
  }
}

/** Entries of a ~/.claude subdirectory: directories, or <name>.md files (commands and agents) */
function claudeEntries(dir: string, names: true | string[], allowFiles: boolean): Array<{ name: string; full: string; missing?: true }> {
  if (names === true) {
    let listed: string[];
    try {
      listed = fs.readdirSync(dir).sort();
    } catch {
      return [];
    }
    return listed
      .filter(n => !n.startsWith('.'))
      .map(n => ({ name: n.replace(/\.md$/, ''), full: path.join(dir, n) }))
      .filter(e => {
        const stat = fs.statSync(e.full);
        return stat.isDirectory() || (allowFiles && stat.isFile() && e.full.endsWith('.md'));
      });
  }
  return names.map(name => {
    const asDir = path.join(dir, name);
    if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) return { name, full: asDir };
    const asFile = path.join(dir, `${name}.md`);
    if (allowFiles && fs.existsSync(asFile) && fs.statSync(asFile).isFile()) return { name, full: asFile };
    return { name, full: asDir, missing: true };
  });
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Everything the container will get, read from the host now: the file entries (Claude config, rc,
 * files), the git keys and the settings patch, with a summary and the dropped entries. The stamp
 * covers all of it, so `ct list` can tell a running container is behind.
 */
export function planPersonal(resolved: ResolvedPersonal, warn: (m: string) => void = () => {}): PersonalPlan {
  const bp = resolved.blueprint;
  const c = new Collector(warn);
  const summary: PersonalSummary = {
    git: Object.keys(bp.git).sort(),
    claude: { claudeMd: false, skills: [], agents: [], commands: [], settings: [] },
    shell: false,
    files: [],
    dropped: c.dropped,
  };

  if (bp.claude) {
    const dir = resolved.claudeDir;
    const short = dir.startsWith(resolved.home) ? '~' + dir.slice(resolved.home.length) : dir;
    if (bp.claude.claudeMd) {
      const file = path.join(dir, 'CLAUDE.md');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        if (c.add(file, '.claude/CLAUDE.md', 'claude.claudeMd')) summary.claude.claudeMd = true;
      } else {
        c.drop('claude.claudeMd', `no ${short}/CLAUDE.md`);
      }
    }
    for (const key of ['skills', 'agents', 'commands'] as const) {
      const names = bp.claude[key];
      if (names === undefined) continue;
      for (const e of claudeEntries(path.join(dir, key), names, key !== 'skills')) {
        if (e.missing) {
          c.drop(`claude.${key} ${e.name}`, `not in ${short}/${key}`);
          continue;
        }
        const to = path.posix.join('.claude', key, path.basename(e.full));
        if (c.add(e.full, to, `claude.${key} ${e.name}`)) summary.claude[key].push(e.name);
      }
    }
    if (bp.claude.settings) {
      if (bp.claude.settings.model !== undefined) summary.claude.settings.push('model');
      if (bp.claude.settings.permissions?.deny !== undefined) summary.claude.settings.push('permissions.deny');
    }
  }

  // The rc: personal aliases first, then the shell text, so the text can override them
  const rcParts: string[] = [];
  const aliasNames = Object.keys(bp.aliases).sort();
  if (aliasNames.length) {
    rcParts.push('# aliases from the personal blueprint');
    for (const name of aliasNames) rcParts.push(`alias ${name}='${bp.aliases[name].replace(/'/g, `'\\''`)}'`);
  }
  if (bp.shell) {
    let text: string | null = bp.shell.rc ?? null;
    if (bp.shell.rcFile !== undefined) {
      const real = insideHome(bp.shell.rcFile, resolved.home);
      if (!real || !fs.statSync(real).isFile()) {
        c.drop('shell.rcFile', real ? `${bp.shell.rcFile} is not a file` : `${bp.shell.rcFile} is not a file under your home directory`);
      } else {
        const bytes = fs.readFileSync(real);
        if (bytes.length > MAX_RC_BYTES) c.drop('shell.rcFile', `${bp.shell.rcFile} is over ${MAX_RC_BYTES / 1024} KB`);
        else {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            c.drop('shell.rcFile', `${bp.shell.rcFile} is not UTF-8`);
          }
        }
      }
    }
    if (text !== null) {
      rcParts.push('# shell from the personal blueprint');
      rcParts.push(text.endsWith('\n') ? text.slice(0, -1) : text);
      summary.shell = true;
    }
  }
  if (rcParts.length) c.entries.push({ path: RC_PATH, content: Buffer.from(rcParts.join('\n') + '\n'), mode: 0o600 });

  for (const f of bp.files ?? []) {
    const real = insideHome(f.from, resolved.home);
    if (!real) {
      c.drop(`files ${f.from}`, fs.existsSync(expandHome(f.from, resolved.home)) ? 'it is outside your home directory' : 'not found');
      continue;
    }
    const stat = fs.statSync(real);
    if (!stat.isFile() && !stat.isDirectory()) {
      c.drop(`files ${f.from}`, 'not a regular file or directory');
      continue;
    }
    if (c.add(real, f.to, `files ${f.from}`)) summary.files.push(f.to);
  }

  const settings = bp.claude?.settings
    ? {
        ...(bp.claude.settings.model !== undefined ? { model: bp.claude.settings.model } : {}),
        ...(bp.claude.settings.permissions?.deny !== undefined ? { deny: bp.claude.settings.permissions.deny } : {}),
      }
    : undefined;

  const hash = createHash('sha256');
  hash.update(stableJson({ git: bp.git, aliases: bp.aliases, claude: bp.claude ?? null, shell: bp.shell ?? null, files: bp.files ?? null }));
  for (const e of c.entries) {
    hash.update(`\0${e.path}\0${e.mode}\0${e.content.length}\0`);
    hash.update(e.content);
  }
  hash.update(`\0settings:${stableJson(settings ?? null)}`);

  return { stamp: hash.digest('hex').slice(0, 12), entries: c.entries, git: bp.git, ...(settings ? { settings } : {}), summary };
}

/** The stamp a start would write, computed on the host without a container; '' without a personal blueprint. */
export function personalStamp(resolved: ResolvedPersonal | null): string {
  return resolved ? planPersonal(resolved).stamp : '';
}

/** One line for `ct start` and `blueprint status`: `git 4 keys · claude 3 skills, settings · shell rc · 2 files` */
export function describePersonal(s: PersonalSummary): string {
  const parts: string[] = [];
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (s.git.length) parts.push(`git ${n(s.git.length, 'key')}`);
  const claude: string[] = [];
  if (s.claude.claudeMd) claude.push('CLAUDE.md');
  if (s.claude.skills.length) claude.push(n(s.claude.skills.length, 'skill'));
  if (s.claude.agents.length) claude.push(n(s.claude.agents.length, 'agent'));
  if (s.claude.commands.length) claude.push(n(s.claude.commands.length, 'command'));
  if (s.claude.settings.length) claude.push('settings');
  if (claude.length) parts.push(`claude ${claude.join(', ')}`);
  if (s.shell) parts.push('shell rc');
  if (s.files.length) parts.push(n(s.files.length, 'file'));
  return parts.join(' · ') || 'nothing';
}

// ---------------------------------------------------------------------------------------------
// apply

export interface PersonalRecord {
  version: 1;
  stamp: string;
  paths: string[];
  gitKeys: string[];
  settingsKeys: string[];
}

function parseRecord(text: string): PersonalRecord | null {
  if (!text.trim()) return null;
  try {
    const r = JSON.parse(text);
    if (!isObject(r) || r.version !== 1) return null;
    const strings = (v: unknown) => (isStringArray(v) ? v : []);
    return { version: 1, stamp: typeof r.stamp === 'string' ? r.stamp : '', paths: strings(r.paths), gitKeys: strings(r.gitKeys), settingsKeys: strings(r.settingsKeys) };
  } catch {
    return null;
  }
}

/** A recorded path kunj may delete: relative, no .., not the record or the stamp */
export function deletablePath(p: string): boolean {
  if (!p || path.posix.isAbsolute(p) || /[\n\r\0]/.test(p)) return false;
  const parts = p.split('/');
  if (parts.some(x => x === '' || x === '.' || x === '..')) return false;
  if (p === RECORD_PATH || p === STAMP_PATH) return false;
  return p.startsWith('.claude/') || p === RC_PATH || !p.startsWith('.kunj/');
}

/**
 * The container's settings.json with the patch applied and the keys of an earlier run that are gone now
 * removed; other keys kept. `text` null: no file yet. Returns null when there is nothing to write.
 */
export function mergeSettings(text: string | null, patch: PersonalPlan['settings'], previousKeys: string[]): { text: string; keys: string[] } | null {
  let settings: Record<string, unknown> = {};
  if (text !== null && text.trim()) {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error('not a JSON object');
    settings = parsed;
  }
  const keys: string[] = [];
  let changed = false;
  if (patch?.model !== undefined) {
    if (settings.model !== patch.model) changed = true;
    settings.model = patch.model;
    keys.push('model');
  } else if (previousKeys.includes('model') && 'model' in settings) {
    delete settings.model;
    changed = true;
  }
  const permissions = isObject(settings.permissions) ? { ...settings.permissions } : {};
  if (patch?.deny !== undefined) {
    if (JSON.stringify(permissions.deny) !== JSON.stringify(patch.deny)) changed = true;
    permissions.deny = patch.deny;
    keys.push('permissions.deny');
  } else if (previousKeys.includes('permissions.deny') && 'deny' in permissions) {
    delete permissions.deny;
    changed = true;
  }
  if (Object.keys(permissions).length) settings.permissions = permissions;
  else delete settings.permissions;
  if (!changed) return null;
  return { text: JSON.stringify(settings, null, 2) + '\n', keys };
}

const SEP = '---kunj-personal---';
// Reads the record and the container's settings.json, separated by a line; $1 is the home
const READ_SCRIPT = `cd "$1" || exit 2; [ ! -e ${RECORD_PATH} ] || cat ${RECORD_PATH}; printf '\\n%s\\n' "$2"; [ ! -e ${SETTINGS_PATH} ] || cat ${SETTINGS_PATH}`;
// $1 the home, then the paths to delete (checked again here), then the tar on stdin; private files chmod'ed after
const WRITE_SCRIPT =
  'cd "$1" || exit 2; shift; for p; do case "$p" in ""|/*|*..*) exit 3;; esac; rm -rf -- "$p"; ' +
  'case "$p" in .claude/*) rmdir -p -- "$(dirname -- "$p")" 2>/dev/null;; esac; done; ' +
  `tar -xf - && chmod 600 ${RC_PATH} ${SETTINGS_PATH} ${RECORD_PATH} ${STAMP_PATH} 2>/dev/null; true`;
// $1 the home, $2 the number of keys to unset, then those keys, then key value pairs
const GIT_SCRIPT =
  'cd "$1" || exit 2; n=$2; shift 2; i=0; while [ "$i" -lt "$n" ]; do git config --global --unset-all -- "$1" >/dev/null 2>&1; shift; i=$((i+1)); done; ' +
  'while [ $# -ge 2 ]; do git config --global -- "$1" "$2" || exit 4; shift 2; done';

/**
 * Apply a plan into the container home as the sandbox user: delete what an earlier run wrote and the
 * plan no longer has, extract the entries, merge the settings, set and unset the git keys, record it.
 * Throws ContainerError on a failed exec; the caller warns and the start goes on.
 */
export async function applyPersonal(backend: ContainerBackend, id: string, user: string, home: string, plan: PersonalPlan, warn: (m: string) => void = () => {}): Promise<void> {
  const as = user || undefined;
  const read = await backend.exec(id, ['sh', '-c', READ_SCRIPT, 'sh', home, SEP], { user: as });
  if (read.exitCode !== 0) throw new ContainerError(`Could not read the personal blueprint record in the container (exit ${read.exitCode})`);
  const sep = read.stdout.indexOf(`\n${SEP}\n`);
  const recordText = sep === -1 ? '' : read.stdout.slice(0, sep);
  const settingsText = sep === -1 ? '' : read.stdout.slice(sep + SEP.length + 2);
  const previous = parseRecord(recordText);

  const entries = [...plan.entries];
  // The keys this run owns, whether or not the file needs writing (its values may already match)
  const settingsKeys = [...(plan.settings?.model !== undefined ? ['model'] : []), ...(plan.settings?.deny !== undefined ? ['permissions.deny'] : [])];
  try {
    const merged = mergeSettings(settingsText.trim() ? settingsText : null, plan.settings, previous?.settingsKeys ?? []);
    if (merged) entries.push({ path: SETTINGS_PATH, content: Buffer.from(merged.text), mode: 0o600 });
  } catch {
    warn(`personal blueprint: ${SETTINGS_PATH} in the container is not valid JSON, so model and permissions.deny were not written`);
  }

  const written = new Set(entries.map(e => e.path));
  const toDelete = (previous?.paths ?? []).filter(p => !written.has(p) && deletablePath(p));
  const record: PersonalRecord = {
    version: 1,
    stamp: plan.stamp,
    paths: plan.entries.map(e => e.path).sort(),
    gitKeys: Object.keys(plan.git).sort(),
    settingsKeys,
  };
  entries.push({ path: RECORD_PATH, content: Buffer.from(JSON.stringify(record, null, 2) + '\n'), mode: 0o600 });
  entries.push({ path: STAMP_PATH, content: Buffer.from(plan.stamp + '\n'), mode: 0o600 });

  const write = await backend.exec(id, ['sh', '-c', WRITE_SCRIPT, 'sh', home, ...toDelete], { user: as, stdin: tarEntries(entries) });
  if (write.exitCode !== 0) throw new ContainerError(`Writing the personal blueprint into the container failed (exit ${write.exitCode})`);

  const unset = (previous?.gitKeys ?? []).filter(k => !(k in plan.git));
  const pairs = Object.keys(plan.git)
    .sort()
    .flatMap(k => [k, plan.git[k]]);
  if (unset.length || pairs.length) {
    const git = await backend.exec(id, ['sh', '-c', GIT_SCRIPT, 'sh', home, String(unset.length), ...unset, ...pairs], { user: as });
    if (git.exitCode !== 0) throw new ContainerError(`Setting the personal blueprint's git config in the container failed (exit ${git.exitCode})`);
  }
}
