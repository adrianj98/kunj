import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  branchRefs, commitLogArgs, grepArgs, grepContainer, grepRefs, grepWorktree, locate, mapLimit, parseCommitLog,
  parseGrepOutput, searchCommits, searchRegExp, searchWorkLogs,
} from '../search';
import type { SearchQuery } from '../search';
import { FakeBackend } from '../container/__tests__/fake-backend';

const q = (pattern: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern, ignoreCase: false, fixed: false, word: false, paths: [], maxCount: 200, ...extra,
});

describe('grepArgs', () => {
  it('puts the pattern after -e and the paths after --, so neither is read as an option', () => {
    expect(grepArgs(q('-x', { paths: ['src/'] }))).toEqual(['grep', '-n', '--column', '-z', '-I', '--no-color', '-E', '-e', '-x', '--', 'src/']);
  });

  it('maps the flags and puts revs before --', () => {
    const args = grepArgs(q('a', { ignoreCase: true, word: true, fixed: true }), { revs: ['refs/heads/x'], untracked: true });
    expect(args).toEqual(['grep', '-n', '--column', '-z', '-I', '--no-color', '--untracked', '-i', '-w', '-F', '-e', 'a', 'refs/heads/x', '--']);
  });
});

describe('searchRegExp and locate', () => {
  it('escapes a fixed string', () => {
    expect(locate('call a.b(c)', searchRegExp(q('a.b(', { fixed: true })), 1)).toEqual({ column: 6, length: 4 });
  });

  it('matches whole words only with word', () => {
    const re = searchRegExp(q('foo', { word: true }));
    expect(locate('foobar foo', re, 1)).toEqual({ column: 8, length: 3 });
  });

  it('reads POSIX classes and ignores case', () => {
    expect(locate('Version 42', searchRegExp(q('version [[:digit:]]+', { ignoreCase: true })), 1)).toEqual({ column: 1, length: 10 });
  });

  it('counts columns in characters, not bytes', () => {
    expect(locate('héllo wörld', searchRegExp(q('wörld')), 99)).toEqual({ column: 7, length: 5 });
  });

  it("falls back to git's column when JS cannot read the pattern", () => {
    expect(searchRegExp(q('a(')) ).toBeNull();
    expect(locate('xa(', null, 2)).toEqual({ column: 2, length: 0 });
  });
});

describe('parseGrepOutput', () => {
  it('splits -z records and strips a known rev prefix, keeping colons in the path', () => {
    const out = 'refs/heads/x:a:b.txt\x003\x005\x00hello: world\nrefs/heads/y:c.ts\x001\x001\x00x\n';
    expect(parseGrepOutput(out, ['refs/heads/x', 'refs/heads/y'])).toEqual([
      { rev: 'refs/heads/x', path: 'a:b.txt', line: 3, column: 5, text: 'hello: world' },
      { rev: 'refs/heads/y', path: 'c.ts', line: 1, column: 1, text: 'x' },
    ]);
  });

  it('skips lines that are not records (the container exit marker)', () => {
    expect(parseGrepOutput('a.ts\x001\x002\x00t\nkunj-grep-exit=0\n')).toEqual([{ rev: undefined, path: 'a.ts', line: 1, column: 2, text: 't' }]);
  });
});

describe('branchRefs', () => {
  const refs = ['refs/heads/main', 'refs/heads/a', 'refs/heads/b', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/a', 'refs/remotes/origin/c', 'refs/remotes/origin/main'].join('\n');

  it('lists local branches without a worktree', () => {
    expect(branchRefs(refs, new Set(['main', 'b']), false)).toEqual([{ branch: 'a', ref: 'refs/heads/a', remote: false }]);
  });

  it("adds origin's branches with neither a worktree nor a local branch", () => {
    expect(branchRefs(refs, new Set(['main']), true).map(r => r.ref)).toEqual(['refs/heads/a', 'refs/heads/b', 'refs/remotes/origin/c']);
  });
});

describe('commit messages', () => {
  it('asks git log for all branches, or the given ones', () => {
    expect(commitLogArgs(q('x', { maxCount: 5 }), [])).toEqual(expect.arrayContaining(['--grep=x', '--extended-regexp', '--max-count=5', '--branches', '--remotes=origin']));
    expect(commitLogArgs(q('x', { word: true, maxCount: 5 }), ['feat']).slice(-3)).toEqual(['--max-count=20', 'feat', '--']);
  });

  it('reports the first matching line and filters -w misses', () => {
    const out = 'aaa\x1fAnn\x1f2026-10-01T00:00:00Z\x1fSubject\n\nbody has foobar\n\x1e\nbbb\x1fBo\x1f2026-10-02T00:00:00Z\x1ffoo fix\n\x1e';
    const re = searchRegExp(q('foo', { word: true }));
    expect(parseCommitLog(out, re, 10, true)).toEqual([
      { sha: 'bbb', author: 'Bo', date: '2026-10-02T00:00:00Z', subject: 'foo fix', line: 1, column: 1, length: 3, text: 'foo fix' },
    ]);
    const body = parseCommitLog(out, searchRegExp(q('foobar')), 10, false);
    expect(body[0]).toMatchObject({ sha: 'aaa', line: 3, column: 10, text: 'body has foobar' });
  });
});

describe('searchWorkLogs', () => {
  it('searches the logs newest first and stops at maxCount', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-logs-'));
    fs.writeFileSync(path.join(dir, '2026-10-01.md'), '# day\n- fixed the firewall\n');
    fs.writeFileSync(path.join(dir, '2026-10-02.md'), '- Firewall again\n- firewall tests\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'firewall');
    const found = searchWorkLogs(dir, q('firewall', { ignoreCase: true, maxCount: 2 }));
    expect(found.map(f => `${f.date}:${f.line}`)).toEqual(['2026-10-02:1', '2026-10-02:2']);
    expect(searchWorkLogs(path.join(dir, 'missing'), q('x'))).toEqual([]);
  });
});

describe('mapLimit', () => {
  it('keeps the order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async n => {
      peak = Math.max(peak, ++running);
      await new Promise(r => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });
});

describe('against a real repository', () => {
  let repo: string;
  let other: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-search-'));
    repo = path.join(root, 'repo');
    other = path.join(root, 'other');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'needle one\nhay\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'first needle');
    git(repo, 'branch', 'side');
    git(repo, 'branch', 'idle');
    git(repo, 'worktree', 'add', '-q', other, 'side');
    // Uncommitted work: an untracked file is found, an ignored one is not
    fs.writeFileSync(path.join(repo, 'new.txt'), 'needle untracked\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'needle ignored\n');
    fs.writeFileSync(path.join(other, 'a.txt'), 'nothing here\n');
  });

  it('finds tracked and untracked files of a worktree, not ignored ones', async () => {
    const r = await grepWorktree(repo, q('needle'));
    expect(r.matches.map(m => `${m.path}:${m.line}:${m.column}`).sort()).toEqual(['a.txt:1:1', 'new.txt:1:1']);
    expect(r.truncated).toBe(false);
    expect((await grepWorktree(other, q('needle'))).matches).toEqual([]);
  });

  it('caps the matches and says so', async () => {
    const r = await grepWorktree(repo, q('needle', { maxCount: 1 }));
    expect(r.matches).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('honours pathspecs', async () => {
    expect((await grepWorktree(repo, q('needle', { paths: ['new.txt'] }))).matches.map(m => m.path)).toEqual(['new.txt']);
  });

  it('reports a git error instead of throwing', async () => {
    const r = await grepWorktree(repo, q('needle', { paths: ['../outside'] }));
    expect(r.error).toMatch(/outside/);
  });

  it('searches committed trees of several refs in one call', async () => {
    const { results, error } = await grepRefs(repo, ['refs/heads/idle', 'refs/heads/side'], q('needle'));
    expect(error).toBeUndefined();
    expect([...results.keys()].sort()).toEqual(['refs/heads/idle', 'refs/heads/side']);
    expect(results.get('refs/heads/idle')!.matches).toEqual([{ path: 'a.txt', line: 1, column: 1, length: 6, text: 'needle one' }]);
  });

  it("one ref's cap never hides another ref's matches", async () => {
    git(repo, 'checkout', '-q', 'idle');
    fs.writeFileSync(path.join(repo, 'many.txt'), 'needle\n'.repeat(20));
    git(repo, 'add', 'many.txt');
    git(repo, 'commit', '-qm', 'many');
    git(repo, 'checkout', '-q', 'main');
    // refs/heads/idle sorts first: its 21 matches come before side's one
    const { results } = await grepRefs(repo, ['refs/heads/idle', 'refs/heads/side'], q('needle', { maxCount: 2 }));
    expect(results.get('refs/heads/idle')).toMatchObject({ truncated: true });
    expect(results.get('refs/heads/idle')!.matches).toHaveLength(2);
    expect(results.get('refs/heads/side')).toMatchObject({ truncated: false, matches: [expect.objectContaining({ path: 'a.txt' })] });
  });

  it('searches commit messages', async () => {
    expect((await searchCommits(repo, q('NEEDLE', { ignoreCase: true }), [])).map(c => c.subject)).toEqual(['first needle']);
    expect(await searchCommits(repo, q('absent'), ['side'])).toEqual([]);
  });
});

describe('grepContainer', () => {
  it('runs git grep in /workspace as the user, its argv outside the shell script', async () => {
    const backend = new FakeBackend();
    backend.execHandler = async () => ({ exitCode: 0, stdout: 'src/a.ts\x002\x003\x00a needle\nkunj-grep-exit=0\n' });
    const r = await grepContainer(backend, 'c1', 'vscode', q('$(rm -rf /)', { maxCount: 5 }));
    expect(r).toEqual({ matches: [{ path: 'src/a.ts', line: 2, column: 3, length: 0, text: 'a needle' }], truncated: false });
    const [, cmd, io] = backend.calls.find(c => c.method === 'exec')!.args as [string, string[], any];
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(cmd[2]).not.toContain('rm');
    expect(cmd.slice(3, 5)).toEqual(['6', 'git']);
    expect(cmd).toContain('$(rm -rf /)');
    expect(io).toMatchObject({ user: 'vscode', workdir: '/workspace' });
  });

  it('says truncated past maxCount and treats SIGPIPE as fine', async () => {
    const backend = new FakeBackend();
    backend.execHandler = async () => ({ exitCode: 0, stdout: 'a\x001\x001\x00x\nb\x001\x001\x00x\nkunj-grep-exit=141\n' });
    const r = await grepContainer(backend, 'c1', undefined, q('x', { maxCount: 1 }));
    expect(r.matches.map(m => m.path)).toEqual(['a']);
    expect(r.truncated).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("reports git's failure", async () => {
    const backend = new FakeBackend();
    backend.execHandler = async () => ({ exitCode: 0, stdout: 'kunj-grep-exit=128\n' });
    expect((await grepContainer(backend, 'c1', undefined, q('x'))).error).toMatch(/exit 128/);
  });
});
