import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cloneRepo, expandCloneDir, GitHubError, listGitHubRepos, localReposByRemote, parseRepoArg, remoteKey } from '../github-repos';
import type { Exec } from '../github-repos';

const fail = (props: object): Exec => async () => {
  throw Object.assign(new Error('failed'), props);
};

describe('remoteKey', () => {
  it.each([
    ['https://github.com/Owner/Repo.git', 'github.com/owner/repo'],
    ['https://x-access-token:t@github.com/owner/repo', 'github.com/owner/repo'],
    ['git@github.com:owner/repo.git', 'github.com/owner/repo'],
    ['ssh://git@github.com:22/owner/repo', 'github.com/owner/repo'],
    ['https://github.com/owner/repo/', 'github.com/owner/repo'],
  ])('%s', (url, key) => expect(remoteKey(url)).toBe(key));

  it('is null for a path or a deeper URL', () => {
    expect(remoteKey('/srv/git/repo.git')).toBeNull();
    expect(remoteKey('https://gitlab.com/group/sub/repo')).toBeNull();
  });
});

describe('parseRepoArg', () => {
  it('takes owner/name and GitHub URLs', () => {
    expect(parseRepoArg('adrianj98/kunj')).toEqual({ spec: 'adrianj98/kunj', name: 'kunj' });
    expect(parseRepoArg('git@github.com:a/b.git').name).toBe('b');
    expect(parseRepoArg('https://github.com/a/b').name).toBe('b');
  });

  it.each(['--upload-pack=x/y', '-a/b', 'a/..', 'a/-b', 'just-a-name', 'a/b/c', '/etc/passwd'])('refuses %s', arg => {
    expect(() => parseRepoArg(arg)).toThrow(GitHubError);
  });
});

describe('listGitHubRepos', () => {
  it('parses one JSON object per line, newest push first', async () => {
    const exec: Exec = async (file, args) => {
      expect(file).toBe('gh');
      expect(args.slice(0, 2)).toEqual(['api', '--paginate']);
      return {
        stdout: '{"fullName":"a/old","pushedAt":"2020-01-01T00:00:00Z"}\nnoise\n{"fullName":"a/new","pushedAt":"2026-01-01T00:00:00Z"}\n',
        stderr: '',
      };
    };
    expect((await listGitHubRepos(exec)).map(r => r.fullName)).toEqual(['a/new', 'a/old']);
  });

  it('tells a missing gh from a logged-out one', async () => {
    await expect(listGitHubRepos(fail({ code: 'ENOENT' }))).rejects.toMatchObject({ code: 'gh-missing' });
    await expect(listGitHubRepos(fail({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' })))
      .rejects.toMatchObject({ code: 'gh-auth' });
    await expect(listGitHubRepos(fail({ code: 1, stderr: 'HTTP 502' }))).rejects.toMatchObject({ code: 'gh-failed' });
  });
});

describe('cloning', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-clone-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('clones owner/name to <cloneDir>/<name> with gh', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => { calls.push([file, ...args]); return { stdout: '', stderr: '' }; };
    const result = await cloneRepo('a/b', { cloneDir: path.join(tmp, 'src'), bare: false, worktreePathFor: () => '', exec });
    expect(calls).toEqual([['gh', 'repo', 'clone', 'a/b', path.join(tmp, 'src', 'b')]]);
    expect(result).toEqual({ path: path.join(tmp, 'src', 'b'), commonDir: path.join(tmp, 'src', 'b', '.git'), bare: false, worktree: null });
  });

  it('removes a bare clone whose setup failed, so a retry is not refused', async () => {
    const exec: Exec = async (file, args) => {
      if (file === 'gh') { fs.mkdirSync(args[3]); return { stdout: '', stderr: '' }; }
      throw Object.assign(new Error('fetch failed'), { stderr: 'fatal: unable to access' });
    };
    await expect(cloneRepo('a/b', { cloneDir: tmp, bare: true, worktreePathFor: () => '', exec }))
      .rejects.toMatchObject({ code: 'clone-failed' });
    expect(fs.existsSync(path.join(tmp, 'b.git'))).toBe(false);
  });

  it('refuses a target that exists, before running gh', async () => {
    fs.mkdirSync(path.join(tmp, 'b'));
    const exec = jest.fn();
    await expect(cloneRepo('a/b', { cloneDir: tmp, bare: false, worktreePathFor: () => '', exec }))
      .rejects.toMatchObject({ code: 'clone-exists' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('expands ~ and ${home} in the clone dir', () => {
    expect(expandCloneDir(undefined)).toBe(path.join(os.homedir(), 'projects'));
    expect(expandCloneDir('${HOME}/src')).toBe(path.join(os.homedir(), 'src'));
  });

  it('maps known repositories by origin', () => {
    const git = path.join(tmp, 'r', '.git');
    fs.mkdirSync(git, { recursive: true });
    fs.writeFileSync(path.join(git, 'config'), '[remote "origin"]\n\turl = git@github.com:A/B.git\n');
    expect(localReposByRemote([{ root: path.join(tmp, 'r'), gitCommonDir: git }]).get('github.com/a/b')).toBe(path.join(tmp, 'r'));
  });
});
