// GitHub repositories you can clone (`kunj repos github`) and cloning one (`kunj repos clone`).
//
// Everything goes through the gh CLI, so its login, host and git protocol preference apply:
// one `gh api --paginate user/repos` call lists every repository you own, collaborate on or can
// see through an organisation, and `gh repo clone` clones. A listed repository is marked with
// the local root of a known repository (repos.json) whose origin points at it, read from each
// repository's config file without a git call.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KnownRepo } from './repos';
import { readOriginUrl } from './repo-identity';
import { DEFAULT_CLONE_DIR } from './clone-defaults';

export type GitHubErrorCode = 'gh-missing' | 'gh-auth' | 'gh-failed' | 'bad-repo' | 'clone-exists' | 'clone-failed';

export class GitHubError extends Error {
  constructor(public code: GitHubErrorCode, message: string) {
    super(message);
    this.name = 'GitHubError';
  }

  get jsonCode(): GitHubErrorCode {
    return this.code;
  }
}

export interface GitHubRepo {
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushedAt: string | null;
  url: string;
  defaultBranch: string;
}

export interface Exec {
  (file: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }>;
}

export const execFileAsync: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

// What a failed gh call means: not installed, not logged in, or anything else (its stderr)
function ghError(error: unknown, what: string): GitHubError {
  const e = error as { code?: unknown; stderr?: string; message?: string };
  if (e.code === 'ENOENT') {
    return new GitHubError('gh-missing', 'The GitHub CLI (gh) is not installed: https://cli.github.com');
  }
  const stderr = (e.stderr || '').trim();
  if (/gh auth login|not logged in|authentication required|HTTP 401/i.test(stderr)) {
    return new GitHubError('gh-auth', "gh is not logged in to GitHub: run 'gh auth login'");
  }
  return new GitHubError('gh-failed', `${what} failed: ${stderr.split('\n').pop() || e.message || 'gh exited with an error'}`);
}

const LIST_JQ =
  '.[] | {fullName: .full_name, owner: .owner.login, name: .name, description: .description, private: .private, ' +
  'fork: .fork, archived: .archived, pushedAt: .pushed_at, url: .html_url, defaultBranch: .default_branch}';

// Every repository the gh login can clone, most recently pushed first
export async function listGitHubRepos(exec: Exec = execFileAsync): Promise<GitHubRepo[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec('gh', [
      'api', '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq', LIST_JQ,
    ]));
  } catch (error) {
    throw ghError(error, 'Listing your GitHub repositories');
  }
  const repos: GitHubRepo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      repos.push(JSON.parse(line));
    } catch {
      // A line that is not JSON is gh noise, not a repository
    }
  }
  // One page is sorted by push time; the pages are too, but say so rather than trust it
  return repos.sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || ''));
}

// `host/owner/name` (lower case) for a GitHub-style remote URL, or null: https (with or without
// userinfo), ssh://, and scp-like `git@host:owner/name`, with or without `.git`
export function remoteKey(url: string): string | null {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim()) ||
    /^[^@/:]+@([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
}

// The local root of each known repository, keyed by its origin's remoteKey
export function localReposByRemote(known: Pick<KnownRepo, 'root' | 'gitCommonDir'>[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const repo of known) {
    const key = remoteKey(readOriginUrl(repo.gitCommonDir));
    if (key && !byKey.has(key)) byKey.set(key, repo.root);
  }
  return byKey;
}

export function githubRepoKey(repo: Pick<GitHubRepo, 'url'>): string | null {
  return remoteKey(repo.url);
}

// `owner/name` or a GitHub URL, checked so neither can become an option or leave the clone dir
export function parseRepoArg(arg: string): { spec: string; name: string } {
  const value = arg.trim();
  const short = /^([A-Za-z0-9_.][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(value);
  if (short) return check(value, short[2]);
  const key = remoteKey(value);
  if (key && /^(https?|ssh|git):\/\/|^[^@/:-][^@/:]*@/i.test(value)) return check(value, key.split('/')[2]);
  throw new GitHubError('bad-repo', `Not a repository: '${arg}'. Expected owner/name or a GitHub URL`);
}

function check(spec: string, name: string): { spec: string; name: string } {
  if (!name || name === '.' || name === '..' || name.startsWith('-')) {
    throw new GitHubError('bad-repo', `Not a repository name: '${name}'`);
  }
  return { spec, name };
}

// ~ and ${home} in the clone directory setting
export function expandCloneDir(dir: string | undefined): string {
  const value = (dir || '').trim() || DEFAULT_CLONE_DIR;
  return path.resolve(value.replace(/\$\{home\}/gi, os.homedir()).replace(/^~(?=$|\/)/, os.homedir()));
}

export interface CloneOptions {
  cloneDir: string;
  bare: boolean;
  /** For a bare clone: where the default branch's worktree goes (worktree.baseDir applied) */
  worktreePathFor: (branch: string, commonDir: string) => string;
  exec?: Exec;
}

export interface CloneResult {
  /** The checkout, or the bare repository */
  path: string;
  /** The git common dir, to register */
  commonDir: string;
  bare: boolean;
  /** The default branch's worktree of a bare clone */
  worktree: string | null;
}

export async function cloneRepo(repoArg: string, opts: CloneOptions): Promise<CloneResult> {
  const exec = opts.exec ?? execFileAsync;
  const { spec, name } = parseRepoArg(repoArg);
  const target = path.join(opts.cloneDir, opts.bare ? `${name}.git` : name);
  if (fs.existsSync(target)) {
    throw new GitHubError('clone-exists', `${target} already exists`);
  }
  fs.mkdirSync(opts.cloneDir, { recursive: true });
  try {
    await exec('gh', ['repo', 'clone', spec, target, ...(opts.bare ? ['--', '--bare'] : [])]);
  } catch (error) {
    const e = ghError(error, `Cloning ${spec}`);
    throw e.code === 'gh-failed' ? new GitHubError('clone-failed', e.message) : e;
  }
  if (!opts.bare) {
    return { path: target, commonDir: path.join(target, '.git'), bare: false, worktree: null };
  }

  const git = (...args: string[]) => exec('git', ['-C', target, ...args]);
  try {
    // A bare clone copies origin's branches to local ones and fetches nothing into
    // refs/remotes: track origin like a normal clone, and keep only the default branch
    await git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git('fetch', '--quiet', 'origin');
    const branch = (await git('symbolic-ref', '--short', 'HEAD')).stdout.trim();
    const heads = (await git('for-each-ref', '--format=%(refname)', 'refs/heads')).stdout.split('\n').filter(Boolean);
    for (const ref of heads) {
      if (ref !== `refs/heads/${branch}`) await git('update-ref', '-d', ref);
    }
    const worktree = opts.worktreePathFor(branch, target);
    await git('worktree', 'add', '--quiet', worktree, branch);
    await exec('git', ['-C', worktree, 'branch', '--quiet', `--set-upstream-to=origin/${branch}`]);
    return { path: target, commonDir: target, bare: true, worktree };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    // The target did not exist before (checked above): remove the half-made clone so a retry
    // is not refused as clone-exists
    fs.rmSync(target, { recursive: true, force: true });
    throw new GitHubError('clone-failed',
      `Cloning ${spec} as a bare repository failed while setting up its worktree, and ${target} was removed: ${(e.stderr || e.message || '').trim()}`);
  }
}
