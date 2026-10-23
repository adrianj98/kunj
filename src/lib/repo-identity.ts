import * as fs from 'fs';
import * as path from 'path';
import { getOriginUrl, getRepoCommonRoot, getRepoName, repoNameFromUrl } from './config';
import { repoIdFromUrl } from './container/names';
import { stripUserinfo } from './container/seed';

export interface RepoIdentity {
  root: string;
  name: string;
  id: string;
  originUrl: string;
}

// Origin's url from <commonDir>/config, without a git call (the worktree listing is on the fast path)
export function readOriginUrl(commonDir: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(commonDir, 'config'), 'utf8');
  } catch {
    return '';
  }
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\s*\]/.test(line);
    } else if (inOrigin) {
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (m) return m[1].trim();
    }
  }
  return '';
}

// Who this repository is, for names derived from it (containers, agent sessions).
// With `where` the answer comes from files alone; without it, from git in the current directory.
export function repoIdentity(where?: { commonDir: string; repoRoot: string }): RepoIdentity {
  if (where) {
    const originUrl = stripUserinfo(readOriginUrl(where.commonDir));
    const name = (originUrl && repoNameFromUrl(originUrl)) || path.basename(where.repoRoot).replace(/\.git$/, '');
    return { root: where.repoRoot, name, id: repoIdFromUrl(originUrl || where.repoRoot), originUrl };
  }
  const root = getRepoCommonRoot();
  if (!root) throw new Error('Not in a git repository');
  // Credentials in the remote URL stay on the host (seed.ts strips them too)
  const originUrl = stripUserinfo(getOriginUrl() || '');
  return { root, name: getRepoName() || path.basename(root), id: repoIdFromUrl(originUrl || root), originUrl };
}
