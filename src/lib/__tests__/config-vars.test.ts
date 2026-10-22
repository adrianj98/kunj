import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  expandConfigStrings,
  expandVariables,
  expandVariablesQuoted,
  shellQuote,
  hasVariables,
  repoVariables,
  treeHasVariables,
} from '../config-vars';

const posixOnly = process.platform === 'win32' ? it.skip : it;

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

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded ones', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('expandVariablesQuoted', () => {
  it('quotes substituted values only', () => {
    expect(expandVariablesQuoted('echo ${branch} ${nope}', { branch: 'x$(id)' })).toBe("echo 'x$(id)' ${nope}");
  });

  it('escapes for double quotes inside "..." and keeps single-quoted values literal', () => {
    const vars = { branch: 'x$(id)', worktree: '/a b/c', name: `it's "q" \\ \`x\`` };
    expect(expandVariablesQuoted('echo "${branch}"', vars)).toBe('echo "x\\$(id)"');
    expect(expandVariablesQuoted('cd "${worktree}" && ls ${worktree}', vars)).toBe(`cd "/a b/c" && ls '/a b/c'`);
    expect(expandVariablesQuoted('echo "${name}"', vars)).toBe('echo "it\'s \\"q\\" \\\\ \\`x\\`"');
    expect(expandVariablesQuoted("echo '${name}'", vars)).toBe(`echo 'it'\\''s "q" \\ \`x\`'`);
    // An escaped quote does not open a string; a quote inside single quotes does not either
    expect(expandVariablesQuoted('echo \\" ${branch}', vars)).toBe(`echo \\" 'x$(id)'`);
    expect(expandVariablesQuoted(`echo '"' \${branch}`, vars)).toBe(`echo '"' 'x$(id)'`);
  });

  posixOnly('quotes values inside $(...) and backticks as bare, even within "..."', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-quote-'));
    try {
      // `sh<f` would run the file f, which leaves a marker
      fs.writeFileSync(path.join(dir, 'f'), `touch '${path.join(dir, 'pwned')}'\n`);
      const vars = { branch: 'x;sh<f' };
      expect(expandVariablesQuoted('echo "$(basename ${branch})"', vars)).toBe(`echo "$(basename 'x;sh<f')"`);
      for (const template of ['echo "$(basename ${branch})"', 'echo "`basename ${branch}`"', 'echo `basename ${branch}`', 'echo $(echo "$(basename ${branch})")']) {
        const out = execFileSync('sh', ['-c', expandVariablesQuoted(template, vars)], { cwd: dir, encoding: 'utf8' });
        expect(out.trim()).toBe('x;sh<f');
        expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands to values the shell reads back literally in every quoting context', () => {
    const vars = { v: `a'b"c$(echo pwned)\`x\`\\d $HOME` };
    for (const template of ['printf %s ${v}', 'printf %s "${v}"', "printf %s '${v}'", 'printf %s "pre ${v} post"', 'printf %s "$(printf %s ${v})"', 'printf %s "`printf %s ${v}`"', 'printf %s "$( (printf %s "${v}") )"']) {
      const out = execFileSync('sh', ['-c', expandVariablesQuoted(template, vars)], { encoding: 'utf8' });
      expect(out).toBe(template.includes('pre') ? `pre ${vars.v} post` : vars.v);
    }
  });
});
