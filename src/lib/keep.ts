// "Keep" files: local files (e.g. .env) saved outside git and restored into every worktree

import * as fs from 'fs';
import * as path from 'path';
import { getKunjDir } from './config';

export const KEEP_DIR = 'keep';

// Directory where kept files are stored: ~/.kunj/{reponame}/keep
export function getKeepDir(): string {
  return path.join(getKunjDir(), KEEP_DIR);
}

// Normalise a user-supplied file path into a path relative to the worktree root
export function toRelativeKeepPath(filePath: string, worktreeRoot: string, cwd: string = process.cwd()): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const relative = path.relative(worktreeRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`File must be inside the worktree: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function toKeepPath(relative: string): string {
  return path.join(getKeepDir(), ...relative.split('/'));
}

// Save a copy of a file (or directory) from a worktree into the keep store
export function keepFile(relative: string, worktreeRoot: string): string {
  const source = path.join(worktreeRoot, ...relative.split('/'));
  if (!fs.existsSync(source)) {
    throw new Error(`File not found: ${source}`);
  }
  const dest = toKeepPath(relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, { recursive: true });
  return dest;
}

// Walk the keep store and return relative paths of every kept entry.
// Directories that were kept as a unit are returned as a single entry with a trailing "/".
export function listKeptFiles(): string[] {
  const keepDir = getKeepDir();
  if (!fs.existsSync(keepDir)) {
    return [];
  }
  const entries: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(keepDir, '');
  return entries.sort();
}

// Copy all kept files into a worktree, overwriting existing files
export function applyKeptFiles(worktreeRoot: string): string[] {
  const applied: string[] = [];
  for (const relative of listKeptFiles()) {
    const source = toKeepPath(relative);
    const dest = path.join(worktreeRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    applied.push(relative);
  }
  return applied;
}

// Delete a kept file (or directory) from the keep store
export function deleteKeptFile(relative: string): boolean {
  const target = toKeepPath(relative);
  if (!fs.existsSync(target)) {
    return false;
  }
  fs.rmSync(target, { recursive: true, force: true });
  // Prune now-empty parent directories up to the keep root
  let parent = path.dirname(target);
  const keepDir = getKeepDir();
  while (parent.startsWith(keepDir) && parent !== keepDir) {
    if (fs.readdirSync(parent).length > 0) {
      break;
    }
    fs.rmdirSync(parent);
    parent = path.dirname(parent);
  }
  return true;
}

// Does the keep store contain this entry (file, or directory prefix)?
export function hasKeptFile(relative: string): boolean {
  return fs.existsSync(toKeepPath(relative));
}
