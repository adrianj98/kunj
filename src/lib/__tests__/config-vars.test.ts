import * as os from 'os';
import {
  expandConfigStrings,
  expandVariables,
  hasVariables,
  repoVariables,
  treeHasVariables,
} from '../config-vars';

describe('repoVariables', () => {
  it('treats a .git directory as the config dir and its parent as the root', () => {
    const vars = repoVariables('/home/me/projects/app/.git');
    expect(vars.repoconfig).toBe('/home/me/projects/app/.git');
    expect(vars.repoRoot).toBe('/home/me/projects/app');
    expect(vars.repoName).toBe('app');
  });

  it('treats a bare repository as both the config dir and the root', () => {
    const vars = repoVariables('/home/me/projects/app.git');
    expect(vars.repoconfig).toBe('/home/me/projects/app.git');
    expect(vars.repoRoot).toBe('/home/me/projects/app.git');
    expect(vars.repoName).toBe('app.git');
  });

  it('exposes the home directory', () => {
    expect(repoVariables('/tmp/x/.git').home).toBe(os.homedir());
  });
});

describe('expandVariables', () => {
  const vars = repoVariables('/repo/.git');

  it('expands a known variable', () => {
    expect(expandVariables('${repoconfig}/kunj/worktrees', vars)).toBe('/repo/.git/kunj/worktrees');
  });

  it('matches names case-insensitively', () => {
    expect(expandVariables('${REPOROOT}/a', vars)).toBe('/repo/a');
    expect(expandVariables('${reporoot}/a', vars)).toBe('/repo/a');
  });

  it('expands several variables in one string', () => {
    expect(expandVariables('${repoRoot}/../${repoName}-worktrees', vars)).toBe('/repo/../repo-worktrees');
  });

  it('leaves an unknown variable verbatim', () => {
    expect(expandVariables('a ${nope} b', vars)).toBe('a ${nope} b');
  });

  it('leaves shell-style and unclosed braces alone', () => {
    expect(expandVariables('$repoRoot and ${unclosed', vars)).toBe('$repoRoot and ${unclosed');
  });

  it('returns strings without variables untouched', () => {
    expect(expandVariables('/plain/path', vars)).toBe('/plain/path');
  });
});

describe('hasVariables / treeHasVariables', () => {
  it('detects a variable reference', () => {
    expect(hasVariables('${a}')).toBe(true);
    expect(hasVariables('plain')).toBe(false);
  });

  it('walks nested objects and arrays', () => {
    expect(treeHasVariables({ a: { b: ['x', '${home}'] } })).toBe(true);
    expect(treeHasVariables({ a: { b: ['x', 'y'] }, n: 1, t: true })).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(treeHasVariables(null)).toBe(false);
    expect(treeHasVariables(undefined)).toBe(false);
  });
});

describe('expandConfigStrings', () => {
  const vars = repoVariables('/repo/.git');

  it('expands strings anywhere in the tree and preserves other types', () => {
    const input = {
      worktree: { baseDir: '${repoconfig}/kunj/worktrees', editorCommand: 'code' },
      list: ['${repoName}', 2, false],
      nested: { deep: { value: '${home}' } },
      count: 7,
      flag: true,
      empty: null,
    };
    expect(expandConfigStrings(input, vars)).toEqual({
      worktree: { baseDir: '/repo/.git/kunj/worktrees', editorCommand: 'code' },
      list: ['repo', 2, false],
      nested: { deep: { value: os.homedir() } },
      count: 7,
      flag: true,
      empty: null,
    });
  });

  it('does not mutate the input', () => {
    const input = { a: '${repoName}' };
    expandConfigStrings(input, vars);
    expect(input.a).toBe('${repoName}');
  });
});
