import { describe, it, expect } from '@jest/globals';
import { parseWorktreeList, branchToDirName, isSessionAlive, summarizeChecks, pickPullRequest, parseStatusV2, isCacheFresh, WorktreeSession, PullRequestInfo } from '../worktree';

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

  describe('summarizeChecks', () => {
    it('returns null without checks', () => {
      expect(summarizeChecks([])).toBeNull();
      expect(summarizeChecks(undefined)).toBeNull();
    });

    it('reports failure when any check failed', () => {
      expect(summarizeChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ])).toBe('failure');
      expect(summarizeChecks([{ state: 'ERROR' }])).toBe('failure');
    });

    it('reports pending while checks are running', () => {
      expect(summarizeChecks([{ status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending');
      expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending');
    });

    it('reports success when everything passed', () => {
      expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('success');
    });
  });

  describe('pickPullRequest', () => {
    const pr = (n: number, headBranch: string, state: PullRequestInfo['state'], updatedAt: string): PullRequestInfo => ({
      provider: 'github', number: n, title: `PR ${n}`, state, url: `https://x/pull/${n}`, draft: false,
      baseBranch: 'main', headBranch, reviewDecision: null, checks: null, updatedAt,
    });

    it('prefers the open PR for the branch', () => {
      const prs = [pr(1, 'feat', 'closed', '2026-09-01'), pr(2, 'feat', 'open', '2026-01-01'), pr(3, 'other', 'open', '2026-09-02')];
      expect(pickPullRequest(prs, 'feat')?.number).toBe(2);
    });

    it('falls back to the most recently updated PR', () => {
      const prs = [pr(1, 'feat', 'closed', '2026-09-01'), pr(2, 'feat', 'merged', '2026-09-03')];
      expect(pickPullRequest(prs, 'feat')?.number).toBe(2);
      expect(pickPullRequest(prs, 'none')).toBeNull();
    });
  });

  describe('parseStatusV2', () => {
    it('reads upstream, ahead/behind and changed files from one status call', () => {
      const out = [
        '# branch.oid 1234567',
        '# branch.head feature/one',
        '# branch.upstream origin/feature/one',
        '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 abc def src/a.ts',
        '2 R. N... 100644 100644 100644 abc def R100 src/b.ts\tsrc/c.ts',
        '? untracked.txt',
        '',
      ].join('\n');
      expect(parseStatusV2(out)).toEqual({ dirty: true, changedFiles: 3, ahead: 2, behind: 1, upstream: 'origin/feature/one' });
    });

    it('handles a clean branch without upstream', () => {
      expect(parseStatusV2('# branch.oid abc\n# branch.head main\n')).toEqual({ dirty: false, changedFiles: 0, ahead: null, behind: null, upstream: null });
    });
  });

  describe('isCacheFresh', () => {
    const entry = { fetchedAt: 1_000_000, provider: 'github' as const, pullRequests: [] };
    it('respects the max age', () => {
      expect(isCacheFresh(entry, 60, 1_000_000 + 30_000)).toBe(true);
      expect(isCacheFresh(entry, 60, 1_000_000 + 61_000)).toBe(false);
      expect(isCacheFresh(entry, 0, 1_000_000)).toBe(false);
      expect(isCacheFresh(undefined, 60)).toBe(false);
    });
  });
});
