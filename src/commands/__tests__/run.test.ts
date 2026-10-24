import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunCommand, RunCommandDeps } from '../run';
import { isFastCommand } from '../fast';
import { addWorktree } from '../../lib/worktree';
import * as keyprovider from '../../lib/secrets/keyprovider';
import { SecretEntry, Unlock, vaultFiles, writeVault } from '../../lib/secrets/vault';

// Paths come from the temp HOME set up in beforeEach.
const dirs = { home: '', kunj: '', global: '' };
jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  getKunjDir: jest.fn(() => dirs.kunj),
  getGlobalKunjDir: jest.fn(() => dirs.global),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

// A fixed raw key: KUNJ_SECRETS_KEY opens keychain-kdf vaults, so no test reaches a real keychain.
const KEY = 'cd'.repeat(32);
const fixedUnlock: Unlock = { kdf: 'keychain', keyFor: async () => Buffer.from(KEY, 'hex') };
const keychainRun = jest.fn(async () => {
  throw new Error('the real keychain must not be touched');
});
const unlockSeam = { mode: 'auto' as const, env: { KUNJ_SECRETS_KEY: KEY }, platform: 'darwin' as const, run: keychainRun };

let root: string;
let stderr: string[];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(name: string, ignore = '.env\n'): string {
  const dir = path.join(dirs.home, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  return fs.realpathSync(dir);
}

function entry(name: string, value: string, extra: Partial<SecretEntry> = {}): SecretEntry {
  return { name, value, targets: ['host', 'container'], delivery: { env: true }, updatedAt: '2026-10-24T00:00:00Z', ...extra };
}

async function repoVault(entries: SecretEntry[]): Promise<void> {
  fs.mkdirSync(dirs.kunj, { recursive: true });
  await writeVault(vaultFiles(dirs.kunj, dirs.global).repo, entries, fixedUnlock);
}

function cmd(extra: Partial<RunCommandDeps> = {}): RunCommand {
  return new RunCommand({ unlock: unlockSeam, currentBranch: async () => 'main', worktreeRoot: async () => root, ...extra });
}

// node -e <script>: the script decides the exit code from what it sees
async function runNode(script: string, opts: Record<string, unknown> = {}, extra: Partial<RunCommandDeps> = {}): Promise<number | undefined> {
  await cmd(extra).execute([process.execPath, '-e', script], opts);
  return process.exitCode as number | undefined;
}

beforeEach(() => {
  dirs.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-run-')));
  dirs.global = path.join(dirs.home, '.kunj');
  dirs.kunj = path.join(dirs.global, 'app');
  root = makeRepo('wt');
  stderr = [];
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  });
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' ') + '\n');
  });
  keychainRun.mockClear();
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(dirs.home, { recursive: true, force: true });
});

test('run is a fast-path command', () => {
  expect(isFastCommand('run')).toBe(true);
});

test('the command gets the host secret in its environment and its exit code is passed through', async () => {
  await repoVault([entry('FOO', 'v')]);
  expect(await runNode("process.exit(process.env.FOO==='v'?3:4)")).toBe(3);
  expect(keychainRun).not.toHaveBeenCalled();
});

test('a container-only secret is absent', async () => {
  await repoVault([entry('FOO', 'v'), entry('BAR', 'c', { targets: ['container'] })]);
  expect(await runNode("process.exit(process.env.BAR===undefined&&process.env.FOO==='v'?3:4)")).toBe(3);
});

test('resolves for the current branch, or the one --branch names', async () => {
  await repoVault([entry('FOO', 'repo'), entry('FOO', 'branch', { scope: { branch: 'feature/x' } })]);
  expect(await runNode("process.exit(process.env.FOO==='repo'?3:4)")).toBe(3);
  expect(await runNode("process.exit(process.env.FOO==='branch'?3:4)", { branch: 'feature/x' })).toBe(3);
  expect(await runNode("process.exit(process.env.FOO==='branch'?3:4)", {}, { currentBranch: async () => 'feature/x' })).toBe(3);
});

test('file deliveries are rendered into the worktree before the command starts', async () => {
  await repoVault([entry('DB', 'postgres://x', { delivery: { env: false, file: '.env' } })]);
  const env = path.join(root, '.env');
  const script = `const fs=require('fs');process.exit(fs.readFileSync(${JSON.stringify(env)},'utf8')==='DB="postgres://x"\\n'&&process.env.DB===undefined?3:4)`;
  expect(await runNode(script)).toBe(3);
  expect(fs.statSync(env).mode & 0o777).toBe(0o600);
});

test('a file git does not ignore is not written: a warning, and the command still runs with the env', async () => {
  root = makeRepo('plain', '');
  await repoVault([entry('FOO', 'v', { delivery: { env: true, file: '.env' } })]);
  expect(await runNode("process.exit(process.env.FOO==='v'?3:4)")).toBe(3);
  expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  expect(stderr.join('')).toMatch(/not ignored/);
  expect(stderr.join('')).not.toContain('FOO="v"');
});

test('with no vault file the command runs and nothing is unlocked', async () => {
  const spy = jest.spyOn(keyprovider, 'getUnlock');
  expect(await runNode('process.exit(5)')).toBe(5);
  expect(spy).not.toHaveBeenCalled();
});

test('a command killed by a signal exits 128 + the signal number', async () => {
  expect(await runNode("process.kill(process.pid,'SIGTERM')")).toBe(128 + os.constants.signals.SIGTERM);
});

test('a missing command exits 127 with a message', async () => {
  await cmd().execute(['kunj-no-such-command-xyz'], {});
  expect(process.exitCode).toBe(127);
  expect(stderr.join('')).toMatch(/kunj-no-such-command-xyz/);
});

test('a vault that cannot be unlocked fails the run, without starting the command', async () => {
  await repoVault([entry('FOO', 'v')]);
  const marker = path.join(dirs.home, 'ran');
  // A fake keychain without the item (exit 44): the vault's key is gone
  const missingItem = jest.fn(async () => ({ code: 44, stdout: '' }));
  await expect(
    runNode(`require('fs').writeFileSync(${JSON.stringify(marker)},'x')`, {}, { unlock: { ...unlockSeam, env: {}, run: missingItem, tty: false } }),
  ).rejects.toMatchObject({ jsonCode: 'secrets-locked' });
  expect(fs.existsSync(marker)).toBe(false);
});

// In a tmux pane (hostRunArgv passes --hold) the pane closes with the process, taking the message with it
test('with --hold, a vault that cannot be unlocked shows the error and waits for Enter before failing', async () => {
  await repoVault([entry('FOO', 'v')]);
  const missingItem = jest.fn(async () => ({ code: 44, stdout: '' }));
  const waitForEnter = jest.fn(async () => {
    expect(stderr.join('')).toMatch(/No secrets key/);
  });
  await expect(
    runNode('process.exit(0)', { hold: true }, { unlock: { ...unlockSeam, env: {}, run: missingItem, tty: false }, waitForEnter }),
  ).rejects.toMatchObject({ jsonCode: 'secrets-locked' });
  expect(waitForEnter).toHaveBeenCalledTimes(1);
  expect(stderr.join('')).toMatch(/Press Enter/);
});

test('without --hold a failed unlock does not wait, and --hold does not wait when the command runs', async () => {
  await repoVault([entry('FOO', 'v')]);
  const missingItem = jest.fn(async () => ({ code: 44, stdout: '' }));
  const waitForEnter = jest.fn(async () => undefined);
  await expect(runNode('process.exit(0)', {}, { unlock: { ...unlockSeam, env: {}, run: missingItem, tty: false }, waitForEnter })).rejects.toMatchObject({ jsonCode: 'secrets-locked' });
  expect(await runNode('process.exit(4)', { hold: true }, { waitForEnter })).toBe(4);
  expect(waitForEnter).not.toHaveBeenCalled();
});

describe('worktree add', () => {
  test('renders the new branch\'s file deliveries into the new worktree', async () => {
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(root, 'add', '.gitignore');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore');
    await repoVault([
      entry('DB', 'repo', { delivery: { env: false, file: '.env' } }),
      entry('DB', 'branch', { scope: { branch: 'feature/x' }, delivery: { env: false, file: '.env' } }),
      entry('ENV_ONLY', 'e'),
    ]);
    const target = path.join(dirs.home, 'wts', 'feature-x');
    const result = await addWorktree({ branch: 'feature/x', path: target, newBranch: true, cwd: root, secretsUnlock: unlockSeam });
    expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toBe('DB="branch"\n');
    expect(result.secretFiles).toEqual(['.env']);
    expect(result.secretWarnings).toEqual([]);
    expect(keychainRun).not.toHaveBeenCalled();
  });

  test('a secret failure is a warning, never a failed worktree', async () => {
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    await repoVault([entry('DB', 'repo', { delivery: { env: false, file: '.env' } })]);
    const target = path.join(dirs.home, 'wts', 'b');
    // .gitignore is not committed, so the new worktree does not ignore .env
    const result = await addWorktree({ branch: 'b', path: target, newBranch: true, cwd: root, secretsUnlock: unlockSeam });
    expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
    expect(result.secretFiles).toEqual([]);
    expect(result.secretWarnings.join('\n')).toMatch(/not ignored/);
  });
});
