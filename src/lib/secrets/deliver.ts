// File deliveries: secrets with delivery.file rendered as NAME="value" lines, and written into a host
// worktree only where git ignores them (nothing is ever written into what the repository tracks).

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SecretError } from './errors';
import type { SecretEntry } from './vault';

// Relative file -> its content. Values are double-quoted with \\, " and newlines escaped, so
// parseDotenv reads them back (a raw \r is not kept: parseDotenv turns it into \n).
export function renderFiles(entries: SecretEntry[]): Map<string, string> {
  const byFile = new Map<string, SecretEntry[]>();
  for (const e of entries) {
    const file = e.delivery.file;
    if (!file) continue;
    const list = byFile.get(file) ?? [];
    list.push(e);
    byFile.set(file, list);
  }
  const out = new Map<string, string>();
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    out.set(file, sorted.map((e) => `${e.name}="${quote(e.value)}"\n`).join(''));
  }
  return out;
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Writes each file (mode 0600) under worktreeRoot and returns the relative paths written. Every path
// is checked first: one outside the root is refused, and one git does not ignore is refused with
// not-ignored unless force; then nothing is written.
export async function writeHostFiles(worktreeRoot: string, files: Map<string, string>, opts: { force?: boolean }): Promise<string[]> {
  const root = fs.realpathSync(worktreeRoot);
  const targets = [...files.keys()].map((rel) => ({ rel, abs: insideRoot(root, rel) }));
  // A symlinked directory on the way must not lead out of the worktree: checked for every file before
  // anything is created, since mkdir would otherwise follow the link.
  for (const t of targets) realInside(root, t.abs);
  if (!opts.force) {
    for (const t of targets) {
      if (!(await gitIgnores(root, t.abs))) {
        throw new SecretError(`${t.rel} is not ignored by git in ${root}; add it to .gitignore, or pass --force`, 'not-ignored');
      }
    }
  }
  const written: string[] = [];
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    realInside(root, t.abs);
    // Temp file + rename: atomic, created 0600, and replaces a symlink rather than writing through it.
    const tmp = `${t.abs}.kunj-tmp-${process.pid}`;
    try {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, files.get(t.rel)!, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, t.abs);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    written.push(t.rel);
  }
  return written;
}

function insideRoot(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (!rel || path.isAbsolute(rel) || !back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) {
    throw new Error(`Secret file path must be inside the worktree: ${JSON.stringify(rel)}`);
  }
  // git's own files are not the worktree, whatever .gitignore says (`check-ignore` matches `*` there too).
  if (back.split(path.sep).some((part) => part.toLowerCase() === '.git')) {
    throw new Error(`Secret file path must not be inside a .git directory: ${JSON.stringify(rel)}`);
  }
  return abs;
}

// Resolves the deepest existing entry above abs (a dangling symlink makes realpath throw) and refuses abs
// when that leads outside root.
function realInside(root: string, abs: string): void {
  let dir = path.dirname(abs);
  const rest: string[] = [path.basename(abs)];
  while (!fs.lstatSync(dir, { throwIfNoEntry: false })) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  insideRoot(root, path.relative(root, path.join(fs.realpathSync(dir), ...rest)));
}

// `git check-ignore -q`: exit 0 when ignored, 1 when not; anything else (not a repository) is not ignored.
function gitIgnores(root: string, abs: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', path.relative(root, abs)], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err) =>
      resolve(!err),
    );
  });
}
