import { describe, it, expect } from '@jest/globals';
import { repoIdFromUrl, nameHash, containerNames, labelsFor, labelsMatch, LABEL } from '../names';

describe('container names', () => {
  // Repo id
  describe('repoIdFromUrl', () => {
    it('derives one repo id from ssh and https forms', () => {
      expect(repoIdFromUrl('git@github.com:Org/Repo.git')).toBe('github.com/org/repo');
      expect(repoIdFromUrl('https://user@github.com/Org/Repo/')).toBe('github.com/org/repo');
      expect(repoIdFromUrl('/Users/a/repo.git')).toBe('/users/a/repo');
    });

    it('handles ssh:// urls with a port-less host', () => {
      expect(repoIdFromUrl('ssh://git@github.com/Org/Repo.git')).toBe('github.com/org/repo');
    });
  });

  // Names
  describe('containerNames', () => {
    it('names differ when branchToDirName collides', () => {
      const a = containerNames('kunj', 'github.com/o/kunj', 'feature/x');
      const b = containerNames('kunj', 'github.com/o/kunj', 'feature-x');
      expect(a.container).toMatch(/^kunj-kunj-feature-x-[0-9a-f]{6}$/);
      expect(a.container).not.toBe(b.container);
      expect(a.helper).toBe(`${a.container}-net-helper`);
      expect(a.workspaceVolume).toBe(`${a.container}-ws`);
      expect(a.network).toBe(`${a.container}-net`);
    });

    it('names differ for the same repo name under different repo ids', () => {
      const a = containerNames('kunj', 'github.com/a/kunj', 'main');
      const b = containerNames('kunj', 'github.com/b/kunj', 'main');
      expect(a.container).not.toBe(b.container);
    });

    it('produces valid docker names for awkward branches', () => {
      for (const b of ['fix#12', 'feat/café', 'user@x']) {
        const n = containerNames('kunj', 'github.com/o/kunj', b);
        for (const name of Object.values(n)) {
          expect(name).toMatch(/^kunj-[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
        }
        expect(n.container).not.toMatch(/[#@]|[^\x00-\x7f]/);
      }
    });

    it('caps long names and keeps distinct long branches distinct', () => {
      const a = containerNames('kunj', 'github.com/o/kunj', 'a'.repeat(200));
      const b = containerNames('kunj', 'github.com/o/kunj', 'a'.repeat(199) + 'b');
      expect(a.container.length).toBeLessThanOrEqual(63);
      expect(a.helper.length).toBeLessThanOrEqual(63);
      expect(a.container).not.toBe(b.container);
    });

    it('gives the home volume its own name', () => {
      const n = containerNames('kunj', 'github.com/o/kunj', 'main');
      expect(n.homeVolume).toBe(`${n.container}-home`);
    });

    it('nameHash is 6 hex chars and stable', () => {
      expect(nameHash('r', 'b')).toMatch(/^[0-9a-f]{6}$/);
      expect(nameHash('r', 'b')).toBe(nameHash('r', 'b'));
    });
  });

  // Labels
  describe('labels', () => {
    it('labelsMatch requires repo and branch', () => {
      const labels = labelsFor('github.com/o/kunj', 'feature/x');
      expect(labelsMatch(labels, 'github.com/o/kunj', 'feature/x')).toBe(true);
      expect(labelsMatch(labels, 'github.com/o/kunj', 'feature-x')).toBe(false);
      expect(labelsMatch(undefined, 'github.com/o/kunj', 'feature/x')).toBe(false);
    });

    it('labelsFor carries only repo, branch and extras', () => {
      expect(labelsFor('r', 'b', { [LABEL.role]: 'main' })).toEqual({
        'kunj.repo': 'r',
        'kunj.branch': 'b',
        'kunj.role': 'main',
      });
      expect(Object.keys(labelsFor('r', 'b'))).toEqual(['kunj.repo', 'kunj.branch']);
    });
  });
});
