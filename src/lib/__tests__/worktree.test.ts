import { describe, it, expect } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { worktreeFolderName, parseWorktreeList, expandWorktreePath, buildOpenCommand } from '../worktree';
import { repoNameFromUrl } from '../config';

describe('worktree helpers', () => {
  describe('worktreeFolderName', () => {
    it('replaces slashes with underscores', () => {
      expect(worktreeFolderName('feature/bob')).toBe('feature_bob');
      expect(worktreeFolderName('a/b/c')).toBe('a_b_c');
    });

    it('strips refs/heads prefix and sanitises odd characters', () => {
      expect(worktreeFolderName('refs/heads/fix/x')).toBe('fix_x');
      expect(worktreeFolderName('fix bug#1')).toBe('fix_bug_1');
      expect(worktreeFolderName('release-1.2.3')).toBe('release-1.2.3');
    });
  });

  describe('repoNameFromUrl', () => {
    it('handles ssh, https and local urls', () => {
      expect(repoNameFromUrl('git@github.com:adrianj98/kunj.git')).toBe('kunj');
      expect(repoNameFromUrl('https://github.com/adrianj98/kunj.git')).toBe('kunj');
      expect(repoNameFromUrl('https://github.com/adrianj98/kunj')).toBe('kunj');
      expect(repoNameFromUrl('/Users/me/projects/kunj.git/')).toBe('kunj');
      expect(repoNameFromUrl('ssh://git@host:2222/org/my-repo.git')).toBe('my-repo');
    });
  });

  describe('expandWorktreePath', () => {
    it('expands ~ and {repo} and resolves relative paths from the base dir', () => {
      expect(expandWorktreePath('~/wt/{repo}', 'kunj', '/base')).toBe(path.join(os.homedir(), 'wt', 'kunj'));
      expect(expandWorktreePath('../{repo}-wt', 'kunj', '/base/repo')).toBe(path.resolve('/base/repo', '../kunj-wt'));
      expect(expandWorktreePath('/abs/dir', 'kunj', '/base')).toBe('/abs/dir');
    });
  });

  describe('parseWorktreeList', () => {
    it('parses porcelain output including bare and detached entries', () => {
      const output = [
        'worktree /repo.git',
        'bare',
        '',
        'worktree /repo.git/main',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /wt/feature_bob',
        'HEAD def456',
        'branch refs/heads/feature/bob',
        'locked',
        '',
        'worktree /wt/detached',
        'HEAD 0123456',
        'detached',
        '',
      ].join('\n');
      const list = parseWorktreeList(output);
      expect(list).toHaveLength(4);
      expect(list[0]).toMatchObject({ path: '/repo.git', bare: true });
      expect(list[1]).toMatchObject({ path: '/repo.git/main', branch: 'main', head: 'abc123' });
      expect(list[2]).toMatchObject({ path: '/wt/feature_bob', branch: 'feature/bob', locked: true });
      expect(list[3]).toMatchObject({ path: '/wt/detached', branch: null });
    });
  });

  describe('buildOpenCommand', () => {
    it('adds -r for vscode-like editors on new worktrees', () => {
      expect(buildOpenCommand('code', '/wt/x')).toEqual(['code', '-r', '/wt/x']);
    });
    it('adds -n with newWindow', () => {
      expect(buildOpenCommand('cursor', '/wt/x', { newWindow: true })).toEqual(['cursor', '-n', '/wt/x']);
    });
    it('uses no flag for existing worktrees so the editor focuses its window', () => {
      expect(buildOpenCommand('code', '/wt/x', { existing: true })).toEqual(['code', '/wt/x']);
    });
    it('leaves other commands untouched and returns null when empty', () => {
      expect(buildOpenCommand('open -a Terminal', '/wt/x')).toEqual(['open', '-a', 'Terminal', '/wt/x']);
      expect(buildOpenCommand('  ', '/wt/x')).toBeNull();
    });
  });
});
