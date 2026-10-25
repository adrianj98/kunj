import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecretCommand, SecretCommandDeps } from '../secret';
import { isFastCommand } from '../fast';
import type { SecretListJson } from '../../lib/json-types';
import { readVault, SecretEntry, Unlock, vaultFiles } from '../../lib/secrets/vault';

// Paths come from the temp HOME set up in beforeEach; keep.ts reads the same mocked getKunjDir.
const dirs: { home: string; kunj: string; global: string; repoName: string | null } = { home: '', kunj: '', global: '', repoName: 'app' };
jest.mock('../../lib/config', () => ({
  getKunjDir: jest.fn(() => dirs.kunj),
  getRepoName: jest.fn(() => dirs.repoName),
  getGlobalKunjDir: jest.fn(() => dirs.global),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

// A fixed raw key: KUNJ_SECRETS_KEY opens keychain-kdf vaults, so no test reaches a real keychain.
const KEY = 'ab'.repeat(32);
const fixedUnlock: Unlock = { kdf: 'keychain', keyFor: async () => Buffer.from(KEY, 'hex') };
const keychainRun = jest.fn(async () => {
  throw new Error('the real keychain must not be touched');
});

let stdout: string[];
let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(name: string, ignore = '.env\n'): string {
  const dir = path.join(dirs.home, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  return fs.realpathSync(dir);
}

function deps(extra: Partial<SecretCommandDeps> = {}): SecretCommandDeps {
  return {
    unlock: { mode: 'auto', env: { KUNJ_SECRETS_KEY: KEY }, platform: 'darwin', run: keychainRun },
    isTTY: () => false,
    stdin: async () => 'v\n',
    currentBranch: async () => 'main',
    worktreeRoot: async () => root,
    worktrees: async () => [{ path: root, branch: 'main' }],
    ...extra,
  };
}

function cmd(extra: Partial<SecretCommandDeps> = {}): SecretCommand {
  return new SecretCommand(deps(extra));
}

async function repoEntries(): Promise<SecretEntry[]> {
  return readVault(vaultFiles(dirs.kunj, dirs.global).repo, fixedUnlock);
}

async function globalEntries(): Promise<SecretEntry[]> {
  return readVault(vaultFiles(dirs.kunj, dirs.global).global, fixedUnlock);
}

function out(): string {
  return stdout.join('');
}

beforeEach(() => {
  dirs.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-secret-cmd-')));
  dirs.global = path.join(dirs.home, '.kunj');
  dirs.kunj = path.join(dirs.global, 'app');
  dirs.repoName = 'app';
  root = makeRepo('wt');
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(' ') + '\n');
  });
  keychainRun.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dirs.home, { recursive: true, force: true });
});

test('secret is a fast-path command', () => {
  expect(isFastCommand('secret')).toBe(true);
});

describe('set', () => {
  test('stores the stdin value (one trailing newline stripped) at repo scope for host and container, as env', async () => {
    await cmd({ stdin: async () => 'v\n\n' }).execute('set', ['FOO'], {});
    const [e] = await repoEntries();
    expect(e).toMatchObject({ name: 'FOO', value: 'v\n', targets: ['host', 'container'], delivery: { env: true } });
    expect(e.scope).toBeUndefined();
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).global)).toBe(false);
    expect(keychainRun).not.toHaveBeenCalled();
  });

  test('reads the value from the hidden prompt on a terminal', async () => {
    const hidden = jest.fn(async () => 'typed');
    const stdin = jest.fn(async () => 'piped');
    await cmd({ isTTY: () => true, hiddenPrompt: hidden, stdin }).execute('set', ['FOO'], {});
    expect((await repoEntries())[0].value).toBe('typed');
    expect(stdin).not.toHaveBeenCalled();
  });

  test('--branch with no value scopes to the current branch, --targets and --file are kept', async () => {
    await cmd({ currentBranch: async () => 'feature/x' }).execute('set', ['FOO'], { branch: true, targets: 'container', file: 'config/.env', env: true });
    expect((await repoEntries())[0]).toMatchObject({ scope: { branch: 'feature/x' }, targets: ['container'], delivery: { env: true, file: 'config/.env' } });
  });

  test('replaces an entry of the same name and scope, keeps the others', async () => {
    await cmd({ stdin: async () => 'one' }).execute('set', ['FOO'], {});
    await cmd({ stdin: async () => 'b' }).execute('set', ['FOO'], { branch: 'b' });
    await cmd({ stdin: async () => 'two' }).execute('set', ['FOO'], {});
    const entries = await repoEntries();
    expect(entries.map((e) => [e.value, e.scope?.branch])).toEqual(expect.arrayContaining([['two', undefined], ['b', 'b']]));
    expect(entries).toHaveLength(2);
  });

  test('--global stores in the global vault', async () => {
    await cmd().execute('set', ['GH_TOKEN'], { global: true });
    expect((await globalEntries()).map((e) => e.name)).toEqual(['GH_TOKEN']);
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).repo)).toBe(false);
  });

  test('outside a repository repo and branch scope are refused, and nothing is written', async () => {
    // getKunjDir falls back to ./.kunj, which in the home directory is the global vault's directory
    dirs.repoName = null;
    dirs.kunj = dirs.global;
    await expect(cmd().execute('set', ['DB_URL'], { branch: 'feature' })).rejects.toThrow(/not in a git repository.*--global/i);
    await expect(cmd().execute('set', ['DB_URL'], {})).rejects.toThrow(/not in a git repository/i);
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).global)).toBe(false);
    await cmd().execute('set', ['GH_TOKEN'], { global: true });
    expect((await globalEntries()).map((e) => e.name)).toEqual(['GH_TOKEN']);
  });

  test('a new repo vault next to a passphrase global one checks the passphrase on the global file first', async () => {
    const answers = ['right', 'right'];
    const prompt = jest.fn(async () => answers.shift() ?? 'right');
    const pp = { mode: 'passphrase' as const, env: {}, platform: 'darwin' as const, run: keychainRun, prompt };
    await cmd({ unlock: pp }).execute('set', ['A'], { global: true });
    const wrong = jest.fn(async () => 'typo');
    await expect(cmd({ unlock: { ...pp, prompt: wrong } }).execute('set', ['B'], {})).rejects.toThrow(/did not decrypt/);
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).repo)).toBe(false);
  });

  test('a new global vault next to a repo one made with another key is refused', async () => {
    await cmd().execute('set', ['A'], {});
    const other = 'cd'.repeat(32);
    await expect(cmd({ unlock: { mode: 'auto', env: { KUNJ_SECRETS_KEY: other }, platform: 'darwin', run: keychainRun } })
      .execute('set', ['B'], { global: true })).rejects.toThrow(/does not decrypt/);
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).global)).toBe(false);
  });

  test('--global with --file is refused (globals are env only), and nothing is written', async () => {
    await expect(cmd().execute('set', ['FOO'], { global: true, file: '.env' })).rejects.toThrow(/env only/);
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).global)).toBe(false);
  });

  test('an invalid name gives bad-name before reading a value', async () => {
    const stdin = jest.fn(async () => 'v');
    await expect(cmd({ stdin }).execute('set', ['1BAD'], {})).rejects.toMatchObject({ jsonCode: 'bad-name' });
    expect(stdin).not.toHaveBeenCalled();
  });

  test('--no-env without --file, and an unknown target, are refused', async () => {
    await expect(cmd().execute('set', ['FOO'], { env: false })).rejects.toThrow(/nothing to deliver/);
    await expect(cmd().execute('set', ['FOO'], { targets: 'host,cloud' })).rejects.toThrow(/targets/);
  });

  test('a file path outside the worktree is refused', async () => {
    await expect(cmd().execute('set', ['FOO'], { file: '../x.env' })).rejects.toThrow(/inside the worktree/);
    await expect(cmd().execute('set', ['FOO'], { file: '/etc/x.env' })).rejects.toThrow(/inside the worktree/);
  });

  test('--json prints the name and scope, never the value', async () => {
    await cmd({ stdin: async () => 'sekrit' }).execute('set', ['FOO'], { json: true });
    expect(JSON.parse(out())).toEqual({ success: true, name: 'FOO', scope: 'repo' });
    expect(out()).not.toContain('sekrit');
  });
});

describe('list', () => {
  test('--json matches SecretListJson for every scope and holds no value', async () => {
    await cmd({ stdin: async () => 'g-value' }).execute('set', ['G'], { global: true });
    await cmd({ stdin: async () => 'r-value' }).execute('set', ['R'], { file: '.env' });
    await cmd({ stdin: async () => 'b-value' }).execute('set', ['B'], { branch: 'feature/x', targets: 'host' });
    stdout = [];
    await cmd().execute('list', [], { json: true });
    const json = JSON.parse(out()) as SecretListJson;
    expect(json.secrets.map((s) => ({ ...s, updatedAt: typeof s.updatedAt }))).toEqual([
      { name: 'G', scope: 'global', targets: ['host', 'container'], delivery: { env: true }, updatedAt: 'string' },
      { name: 'R', scope: 'repo', targets: ['host', 'container'], delivery: { env: true, file: '.env' }, updatedAt: 'string' },
      { name: 'B', scope: 'branch', branch: 'feature/x', targets: ['host'], delivery: { env: true }, updatedAt: 'string' },
    ]);
    expect(out()).not.toMatch(/g-value|r-value|b-value/);
  });

  test('--global and --branch narrow the listing; text output has no values', async () => {
    await cmd({ stdin: async () => 'g-value' }).execute('set', ['G'], { global: true });
    await cmd({ stdin: async () => 'r-value' }).execute('set', ['R'], {});
    await cmd({ stdin: async () => 'b-value' }).execute('set', ['B'], { branch: 'feature/x' });
    stdout = [];
    await cmd().execute('list', [], { global: true, json: true });
    expect((JSON.parse(out()) as SecretListJson).secrets.map((s) => s.name)).toEqual(['G']);
    stdout = [];
    await cmd().execute('list', [], { branch: 'feature/x', json: true });
    expect((JSON.parse(out()) as SecretListJson).secrets.map((s) => s.name)).toEqual(['B']);
    stdout = [];
    await cmd().execute('list', [], {});
    expect(out()).toMatch(/G[\s\S]*R[\s\S]*B/);
    expect(out()).not.toMatch(/g-value|r-value|b-value/);
  });

  describe('the kept .env import hint', () => {
    function keepEnv(): string {
      const kept = path.join(dirs.kunj, 'keep', '.env');
      fs.mkdirSync(path.dirname(kept), { recursive: true });
      fs.writeFileSync(kept, 'A=1\n');
      return kept;
    }

    test('with no secrets and a kept .env, text output suggests the import', async () => {
      const kept = keepEnv();
      await cmd().execute('list', [], {});
      expect(out()).toContain(`Found a kept .env: kunj secret import ${kept} --delete`);
    });

    test('a path under the home directory is shown with ~', async () => {
      keepEnv();
      await cmd({ home: () => dirs.home }).execute('list', [], {});
      expect(out()).toContain('Found a kept .env: kunj secret import ~/.kunj/app/keep/.env --delete');
    });

    test('a path with a space is shell-quoted so the printed command pastes', async () => {
      dirs.kunj = path.join(dirs.global, 'my app');
      keepEnv();
      await cmd({ home: () => dirs.home }).execute('list', [], {});
      expect(out()).toContain(`Found a kept .env: kunj secret import ~/'.kunj/my app/keep/.env' --delete`);
    });

    test('--json prints only the bare SecretListJson', async () => {
      keepEnv();
      await cmd().execute('list', [], { json: true });
      expect(JSON.parse(out())).toEqual({ secrets: [] });
      expect(out()).not.toMatch(/kept/);
    });

    test('no hint once the repo has a secret, without a kept .env, or with --global/--branch', async () => {
      await cmd().execute('list', [], {});
      expect(out()).not.toMatch(/kept \.env/);
      keepEnv();
      stdout = [];
      await cmd().execute('list', [], { global: true });
      await cmd().execute('list', [], { branch: 'feature/x' });
      expect(out()).not.toMatch(/kept \.env/);
      await cmd().execute('set', ['R'], {});
      stdout = [];
      await cmd().execute('list', [], {});
      expect(out()).not.toMatch(/kept \.env/);
    });

    test('a global secret alone does not hide the hint (the repo still has none)', async () => {
      const kept = keepEnv();
      await cmd().execute('set', ['G'], { global: true });
      stdout = [];
      await cmd().execute('list', [], {});
      expect(out()).toContain(`kunj secret import ${kept} --delete`);
    });
  });

  test('with no vault it lists nothing and unlocks nothing', async () => {
    const getUnlock = jest.fn();
    await cmd({ unlock: { mode: 'auto', env: {}, platform: 'darwin', run: keychainRun, prompt: getUnlock } }).execute('list', [], { json: true });
    expect(JSON.parse(out())).toEqual({ secrets: [] });
    expect(keychainRun).not.toHaveBeenCalled();
    expect(getUnlock).not.toHaveBeenCalled();
  });
});

describe('get', () => {
  test('prints the value and a newline; the branch entry wins for its branch, the repo one elsewhere', async () => {
    await cmd({ stdin: async () => 'repo' }).execute('set', ['FOO'], {});
    await cmd({ stdin: async () => 'branch' }).execute('set', ['FOO'], { branch: 'feature/x' });
    stdout = [];
    await cmd().execute('get', ['FOO'], {});
    expect(out()).toBe('repo\n');
    stdout = [];
    await cmd({ currentBranch: async () => 'feature/x' }).execute('get', ['FOO'], {});
    expect(out()).toBe('branch\n');
    stdout = [];
    await cmd().execute('get', ['FOO'], { branch: 'feature/x' });
    expect(out()).toBe('branch\n');
  });

  test('falls back to a global entry, and --global reads only the global one', async () => {
    await cmd({ stdin: async () => 'g' }).execute('set', ['FOO'], { global: true });
    stdout = [];
    await cmd().execute('get', ['FOO'], {});
    expect(out()).toBe('g\n');
    await cmd({ stdin: async () => 'r' }).execute('set', ['FOO'], {});
    stdout = [];
    await cmd().execute('get', ['FOO'], { global: true });
    expect(out()).toBe('g\n');
  });

  test('--json is refused before anything is unlocked', async () => {
    await cmd().execute('set', ['FOO'], {});
    stdout = [];
    await expect(cmd().execute('get', ['FOO'], { json: true })).rejects.toThrow(/--json/);
    expect(out()).toBe('');
  });

  test('a missing name gives secret-not-found', async () => {
    await expect(cmd().execute('get', ['NOPE'], {})).rejects.toMatchObject({ jsonCode: 'secret-not-found' });
    await cmd().execute('set', ['FOO'], {});
    await expect(cmd().execute('get', ['NOPE'], {})).rejects.toMatchObject({ jsonCode: 'secret-not-found' });
  });
});

describe('rm', () => {
  test('removes the entry of that scope only', async () => {
    await cmd({ stdin: async () => 'repo' }).execute('set', ['FOO'], {});
    await cmd({ stdin: async () => 'branch' }).execute('set', ['FOO'], { branch: 'b' });
    await cmd().execute('rm', ['FOO'], { branch: 'b' });
    expect((await repoEntries()).map((e) => [e.name, e.scope?.branch])).toEqual([['FOO', undefined]]);
    await cmd().execute('rm', ['FOO'], {});
    expect(await repoEntries()).toEqual([]);
  });

  test('a missing name gives secret-not-found', async () => {
    await expect(cmd().execute('rm', ['FOO'], {})).rejects.toMatchObject({ jsonCode: 'secret-not-found' });
    await cmd().execute('set', ['FOO'], { branch: 'b' });
    await expect(cmd().execute('rm', ['FOO'], {})).rejects.toMatchObject({ jsonCode: 'secret-not-found' });
  });
});

describe('env', () => {
  test("prints export lines for the resolved host env secrets, ' escaped as '\\''", async () => {
    await cmd({ stdin: async () => "it's" }).execute('set', ['FOO'], {});
    await cmd({ stdin: async () => 'c' }).execute('set', ['CONT'], { targets: 'container' });
    await cmd({ stdin: async () => 'f' }).execute('set', ['FILEONLY'], { env: false, file: '.env' });
    stdout = [];
    await cmd().execute('env', [], {});
    expect(out()).toBe("export FOO='it'\\''s'\n");
  });

  test('--target container picks the container secrets', async () => {
    await cmd({ stdin: async () => 'h' }).execute('set', ['HOST'], { targets: 'host' });
    await cmd({ stdin: async () => 'c' }).execute('set', ['CONT'], { targets: 'container' });
    stdout = [];
    await cmd().execute('env', [], { target: 'container' });
    expect(out()).toBe("export CONT='c'\n");
  });

  test('uses the current branch layer', async () => {
    await cmd({ stdin: async () => 'repo' }).execute('set', ['FOO'], {});
    await cmd({ stdin: async () => 'branch' }).execute('set', ['FOO'], { branch: 'feature/x' });
    stdout = [];
    await cmd({ currentBranch: async () => 'feature/x' }).execute('env', [], {});
    expect(out()).toBe("export FOO='branch'\n");
  });

  test('--json is refused', async () => {
    await expect(cmd().execute('env', [], { json: true })).rejects.toThrow(/--json/);
  });
});

describe('import', () => {
  test('--yes adds every name with the defaults: repo scope, host and container, env plus .env', async () => {
    const src = path.join(root, 'fixture.env');
    fs.writeFileSync(src, 'A=1\nexport B="two words"\n');
    await cmd().execute('import', [src], { yes: true });
    const entries = await repoEntries();
    expect(entries.map((e) => [e.name, e.value])).toEqual([['A', '1'], ['B', 'two words']]);
    for (const e of entries) {
      expect(e).toMatchObject({ targets: ['host', 'container'], delivery: { env: true, file: '.env' } });
      expect(e.scope).toBeUndefined();
    }
    expect(fs.existsSync(src)).toBe(true);
  });

  test('--json prints the names only', async () => {
    const src = path.join(root, 'fixture.env');
    fs.writeFileSync(src, 'A=secret-a\nB=secret-b\n');
    await cmd().execute('import', [src], { json: true });
    expect(JSON.parse(out())).toEqual({ imported: ['A', 'B'] });
    expect(out()).not.toContain('secret-');
  });

  test('on a terminal it lists the names with add or replace and asks once; no stops it', async () => {
    await cmd({ stdin: async () => 'old' }).execute('set', ['A'], {});
    const src = path.join(root, 'fixture.env');
    fs.writeFileSync(src, 'A=1\nB=2\n');
    const confirm = jest.fn(async () => false);
    await cmd({ isTTY: () => true, confirm }).execute('import', [src], {});
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out()).toMatch(/A.*replace/);
    expect(out()).toMatch(/B.*add/);
    expect(out()).not.toMatch(/=1|=2/);
    expect((await repoEntries()).map((e) => e.value)).toEqual(['old']);
  });

  test('--global imports env only', async () => {
    const src = path.join(root, 'fixture.env');
    fs.writeFileSync(src, 'G=1\n');
    await cmd().execute('import', [src], { global: true, yes: true });
    expect((await globalEntries())[0].delivery).toEqual({ env: true });
  });

  test('a malformed line gives bad-dotenv naming the file and line, never its text', async () => {
    const src = path.join(root, 'bad.env');
    fs.writeFileSync(src, 'A=1\nB="unterminated-secret\n');
    const err = (await cmd().execute('import', [src], { yes: true }).catch((e: Error) => e)) as Error;
    expect(err).toMatchObject({ name: 'SecretError', jsonCode: 'bad-dotenv' });
    expect(err.message).toContain(`${src}: line 2`);
    expect(err.message).not.toContain('unterminated-secret');
    expect(fs.existsSync(vaultFiles(dirs.kunj, dirs.global).repo)).toBe(false);
  });

  test('--delete removes the source and its keep copy', async () => {
    const src = path.join(root, '.env');
    fs.writeFileSync(src, 'A=1\n');
    const kept = path.join(dirs.kunj, 'keep', '.env');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, 'A=1\n');
    await cmd({ cwd: () => root }).execute('import', ['.env'], { yes: true, delete: true });
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(kept)).toBe(false);
    expect((await repoEntries()).map((e) => e.name)).toEqual(['A']);
  });

  test('--delete of a symlinked source removes the link, not the file it points to', async () => {
    const shared = path.join(dirs.home, 'shared.env');
    fs.writeFileSync(shared, 'A=1\n');
    const link = path.join(root, '.env');
    fs.symlinkSync(shared, link);
    await cmd({ cwd: () => root }).execute('import', ['.env'], { yes: true, delete: true });
    expect(fs.existsSync(shared)).toBe(true);
    expect(() => fs.lstatSync(link)).toThrow();
  });

  test('--delete of a symlink into the keep store removes the keep copy and the link', async () => {
    const kept = path.join(dirs.kunj, 'keep', '.env');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, 'A=1\n');
    const link = path.join(root, '.env');
    fs.symlinkSync(kept, link);
    await cmd({ cwd: () => root }).execute('import', ['.env'], { yes: true, delete: true });
    expect(fs.existsSync(kept)).toBe(false);
    expect(() => fs.lstatSync(link)).toThrow();
  });

  test('--delete of the keep file itself removes it from the keep store', async () => {
    const kept = path.join(dirs.kunj, 'keep', 'config', '.env');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, 'A=1\n');
    await cmd().execute('import', [kept], { yes: true, delete: true });
    expect(fs.existsSync(kept)).toBe(false);
    expect(fs.existsSync(path.join(dirs.kunj, 'keep', 'config'))).toBe(false);
  });
});

describe('apply', () => {
  test('renders file deliveries into the current worktree with the current branch layer', async () => {
    await cmd({ stdin: async () => 'repo' }).execute('set', ['A'], { file: '.env' });
    await cmd({ stdin: async () => 'branch' }).execute('set', ['A'], { branch: 'feature/x', file: '.env' });
    await cmd({ stdin: async () => 'e' }).execute('set', ['ENVONLY'], {});
    await cmd().execute('apply', [], {});
    const file = path.join(root, '.env');
    expect(fs.readFileSync(file, 'utf8')).toBe('A="repo"\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test('-a renders into every worktree with that worktree\'s branch', async () => {
    const other = makeRepo('wt2');
    await cmd({ stdin: async () => 'repo' }).execute('set', ['A'], { file: '.env' });
    await cmd({ stdin: async () => 'branch' }).execute('set', ['A'], { branch: 'feature/x', file: '.env' });
    stdout = [];
    const worktrees = async () => [{ path: root, branch: 'main' }, { path: other, branch: 'feature/x' }, { path: path.join(dirs.home, 'gone'), branch: 'gone' }];
    await cmd({ worktrees }).execute('apply', [], { all: true, json: true });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A="repo"\n');
    expect(fs.readFileSync(path.join(other, '.env'), 'utf8')).toBe('A="branch"\n');
    expect(JSON.parse(out())).toEqual({ applied: { [root]: ['.env'], [other]: ['.env'] } });
  });

  test('a file git does not ignore gives not-ignored and is not written, unless --force', async () => {
    root = makeRepo('plain', '');
    await cmd().execute('set', ['A'], { file: '.env' });
    await expect(cmd().execute('apply', [], {})).rejects.toMatchObject({ jsonCode: 'not-ignored' });
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    await cmd().execute('apply', [], { force: true });
    expect(fs.existsSync(path.join(root, '.env'))).toBe(true);
  });
});
