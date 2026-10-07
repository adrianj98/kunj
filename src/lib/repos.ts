// Registry of repositories kunj has been used in, kept in ~/.kunj/repos.json.
//
// ~/.kunj/{reponame}/ is keyed by name and does not say where the repository
// lives, so tools without a workspace (the macOS menu bar app) read this list
// to know which repositories to show. Repositories are recorded as kunj runs
// in them; `kunj repos add|remove` manage the list by hand. A removed
// repository is kept as hidden so running kunj there again does not bring it
// back.
//
// Recording is on the worktree fast path, so it only reads the file and
// writes when something changed or the entry is older than RECORD_INTERVAL_MS.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repoVariables } from './config-vars';

export const REPOS_FILE = 'repos.json';
const RECORD_INTERVAL_MS = 60 * 60 * 1000;

export interface KnownRepo {
  // Main worktree directory (the repository itself when bare)
  root: string;
  // The .git directory (the repository itself when bare)
  gitCommonDir: string;
  name: string;
  bare: boolean;
  hidden?: boolean;
  addedAt: string;
  lastSeen: string;
}

export interface KnownRepoInfo extends KnownRepo {
  exists: boolean;
}

interface ReposFile {
  repos: KnownRepo[];
}

// Resolved per call (not at import) so tests can point HOME elsewhere
export function getReposPath(): string {
  return path.join(os.homedir(), '.kunj', REPOS_FILE);
}

function readReposFile(file = getReposPath()): ReposFile {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { repos: Array.isArray(data?.repos) ? data.repos : [] };
  } catch {
    return { repos: [] };
  }
}

function writeReposFile(data: ReposFile, file = getReposPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function sameRepoPath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function makeEntry(commonDir: string, now: string): KnownRepo {
  const { repoRoot, repoName } = repoVariables(commonDir);
  return {
    root: repoRoot,
    gitCommonDir: commonDir,
    name: repoName,
    bare: repoRoot === commonDir,
    addedAt: now,
    lastSeen: now,
  };
}

// Note that kunj ran in the repository with this common dir. Never throws.
export function recordRepo(commonDir: string, now: Date = new Date(), file = getReposPath()): void {
  try {
    const data = readReposFile(file);
    const existing = data.repos.find(r => sameRepoPath(r.gitCommonDir, commonDir));
    if (existing) {
      const age = now.getTime() - Date.parse(existing.lastSeen);
      if (age >= 0 && age < RECORD_INTERVAL_MS) return;
      existing.lastSeen = now.toISOString();
    } else {
      data.repos.push(makeEntry(commonDir, now.toISOString()));
    }
    writeReposFile(data, file);
  } catch {
    // Best effort: a read-only home must not break the command
  }
}

// Add a repository by hand, or un-hide one that was removed
export function addRepo(commonDir: string, now: Date = new Date(), file = getReposPath()): KnownRepo {
  const data = readReposFile(file);
  let entry = data.repos.find(r => sameRepoPath(r.gitCommonDir, commonDir));
  if (entry) {
    delete entry.hidden;
    entry.lastSeen = now.toISOString();
  } else {
    entry = makeEntry(commonDir, now.toISOString());
    data.repos.push(entry);
  }
  writeReposFile(data, file);
  return entry;
}

// Hide a repository, matched by its root or common dir. Returns the entry, if any.
export function hideRepo(target: string, file = getReposPath()): KnownRepo | null {
  const data = readReposFile(file);
  const entry = data.repos.find(r => sameRepoPath(r.root, target) || sameRepoPath(r.gitCommonDir, target));
  if (!entry) return null;
  entry.hidden = true;
  writeReposFile(data, file);
  return entry;
}

// Known repositories, most recently used first. Hidden ones only with includeHidden.
export function listRepos(options: { includeHidden?: boolean } = {}, file = getReposPath()): KnownRepoInfo[] {
  return readReposFile(file)
    .repos.filter(r => options.includeHidden || !r.hidden)
    .map(r => ({ ...r, exists: fs.existsSync(r.gitCommonDir) }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

// Drop repositories whose directory no longer exists. Returns the removed entries.
export function pruneRepos(file = getReposPath()): KnownRepo[] {
  const data = readReposFile(file);
  const gone = data.repos.filter(r => !fs.existsSync(r.gitCommonDir));
  if (gone.length > 0) {
    writeReposFile({ repos: data.repos.filter(r => !gone.includes(r)) }, file);
  }
  return gone;
}
