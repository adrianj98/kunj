// Simple tests for git utilities

import { describe, it, expect } from '@jest/globals';
import { getMainBranch } from '../git';

describe('Git Utilities', () => {
  describe('getMainBranch', () => {
    it('should return a valid branch name', async () => {
      const branch = await getMainBranch();
      expect(['main', 'master']).toContain(branch);
    });

    it('should return main or master', async () => {
      const branch = await getMainBranch();
      expect(branch).toMatch(/^(main|master)$/);
    });
  });

  // Simple test to verify the test runner is working
  describe('Basic Tests', () => {
    it('should pass a simple test', () => {
      expect(true).toBe(true);
    });

    it('should do basic math', () => {
      expect(2 + 2).toBe(4);
    });

    it('should handle strings', () => {
      const str = 'Kunj CLI';
      expect(str).toContain('Kunj');
      expect(str.length).toBe(8);
    });
  });
});