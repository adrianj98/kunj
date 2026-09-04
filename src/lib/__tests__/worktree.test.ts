import { describe, it, expect } from '@jest/globals';
import { parseWorktreeList, branchToDirName, isSessionAlive, WorktreeSession } from '../worktree';

describe('worktree utilities', () => {
  describe('parseWorktreeList', () => {
    it('parses main, branch, detached, locked and prunable worktrees', () => {
      const porcelain = [
        'worktree /repo',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /repo-worktrees/feature-one',
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/feature/one',
        'locked because I said so',
        '',
        'worktree /repo-worktrees/detached',
        'HEAD 3333333333333333333333333333333333333333',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n');

      const result = parseWorktreeList(porcelain);
      expect(result).toHaveLength(3);

      expect(result[0]).toMatchObject({ path: '/repo', branch: 'main', name: 'main', isMain: true, detached: false });
      expect(result[1]).toMatchObject({
        path: '/repo-worktrees/feature-one',
        branch: 'feature/one',
        name: 'feature/one',
        isMain: false,
        locked: true,
        lockedReason: 'because I said so',
      });
      expect(result[2]).toMatchObject({
        path: '/repo-worktrees/detached',
        branch: null,
        detached: true,
        name: 'detached@3333333',
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      });
    });

    it('handles bare repositories and empty input', () => {
      expect(parseWorktreeList('')).toEqual([]);
      const [bare] = parseWorktreeList('worktree /repo.git\nbare\n');
      expect(bare).toMatchObject({ path: '/repo.git', bare: true, name: 'repo.git' });
    });
  });

  describe('branchToDirName', () => {
    it('replaces path separators and unsafe characters', () => {
      expect(branchToDirName('feature/one')).toBe('feature-one');
      expect(branchToDirName('refs/heads/fix/ABC-123 foo')).toBe('fix-ABC-123-foo');
      expect(branchToDirName('///')).toBe('worktree');
    });
  });

  describe('isSessionAlive', () => {
    const base: WorktreeSession = {
      id: 's1',
      path: '/repo',
      pid: 123,
      host: 'host-a',
      editor: 'vscode',
      registeredAt: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
    };
    const now = Date.parse('2026-01-01T01:00:00.000Z');

    it('uses the pid check on the same host', () => {
      expect(isSessionAlive(base, now, 'host-a', () => true)).toBe(true);
      expect(isSessionAlive(base, now, 'host-a', () => false)).toBe(false);
    });

    it('falls back to staleness on a different host', () => {
      expect(isSessionAlive(base, now, 'host-b', () => false)).toBe(true);
      const stale = { ...base, lastSeen: '2025-12-01T00:00:00.000Z' };
      expect(isSessionAlive(stale, now, 'host-b', () => true)).toBe(false);
    });
  });
});
