import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecretError } from '../errors';
import { Runner } from '../keyprovider';
import { envOf, loadSecrets, openVaults, resolveSecrets } from '../resolve';
import { SecretEntry, Unlock, vaultFiles, writeVault } from '../vault';

const at = '2026-10-24T00:00:00.000Z';
function entry(name: string, value: string, extra: Partial<SecretEntry> = {}): SecretEntry {
  return { name, value, targets: ['host', 'container'], delivery: { env: true }, updatedAt: at, ...extra };
}

describe('resolveSecrets', () => {
  const repo = [entry('X', 'repo'), entry('Y', 'repo-y')];
  const branchX = entry('X', 'branch', { scope: { branch: 'feature/x' } });

  it('lets a branch entry override the repo entry of the same name for that branch only', () => {
    const forX = resolveSecrets([], [...repo, branchX], 'feature/x', 'host');
    expect(forX.find((e) => e.name === 'X')?.value).toBe('branch');
    expect(forX.find((e) => e.name === 'Y')?.value).toBe('repo-y');
    const forMain = resolveSecrets([], [...repo, branchX], 'main', 'host');
    expect(forMain.find((e) => e.name === 'X')?.value).toBe('repo');
    expect(resolveSecrets([], [...repo, branchX], undefined, 'host').find((e) => e.name === 'X')?.value).toBe('repo');
  });

  it('applies global, then repo, then branch (most specific wins)', () => {
    const global = [entry('X', 'global'), entry('G', 'global-g')];
    expect(resolveSecrets(global, [], 'main', 'host').find((e) => e.name === 'X')?.value).toBe('global');
    expect(resolveSecrets(global, repo, 'main', 'host').find((e) => e.name === 'X')?.value).toBe('repo');
    expect(resolveSecrets(global, [...repo, branchX], 'feature/x', 'host').find((e) => e.name === 'X')?.value).toBe('branch');
    expect(resolveSecrets(global, repo, 'main', 'host').map((e) => e.name)).toEqual(['G', 'X', 'Y']);
  });

  it('leaves out a host-only entry for the container target, and a container-only one for the host', () => {
    const list = [entry('H', 'h', { targets: ['host'] }), entry('C', 'c', { targets: ['container'] })];
    expect(resolveSecrets([], list, 'main', 'container').map((e) => e.name)).toEqual(['C']);
    expect(resolveSecrets([], list, 'main', 'host').map((e) => e.name)).toEqual(['H']);
    expect(resolveSecrets([entry('GH', 'g', { targets: ['host'] })], [], 'main', 'container')).toEqual([]);
  });

  it('filters by target after the override, so a host-only branch entry hides the repo one from containers', () => {
    const branchHost = entry('X', 'branch', { scope: { branch: 'b' }, targets: ['host'] });
    expect(resolveSecrets([], [...repo, branchHost], 'b', 'container').map((e) => e.name)).toEqual(['Y']);
  });

  it('ignores delivery.file on a global entry (globals are env only)', () => {
    const [g] = resolveSecrets([entry('G', 'g', { delivery: { env: true, file: '.env' } })], [], 'main', 'host');
    expect(g.delivery).toEqual({ env: true });
  });

  it('treats a branch-scoped entry in the global vault as global', () => {
    const g = entry('G', 'g', { scope: { branch: 'other' } });
    expect(resolveSecrets([g], [], 'main', 'host').map((e) => e.name)).toEqual(['G']);
  });

  it('does not change the entries it was given', () => {
    const g = entry('G', 'g', { delivery: { env: true, file: '.env' } });
    resolveSecrets([g], [], 'main', 'host');
    expect(g.delivery.file).toBe('.env');
  });
});

describe('envOf', () => {
  it('maps env-delivered entries only', () => {
    const list = [entry('A', '1'), entry('B', '2', { delivery: { env: false, file: '.env' } })];
    expect(envOf(list)).toEqual({ A: '1' });
  });
});

// loadSecrets with temp dirs and fake key providers: never the real Keychain or terminal.
describe('loadSecrets', () => {
  const HEX = 'b'.repeat(64);
  let tmp: string;
  let kunjDir: string;
  let globalDir: string;
  let files: { global: string; repo: string };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-resolve-'));
    globalDir = path.join(tmp, 'global');
    kunjDir = path.join(globalDir, 'repo');
    files = vaultFiles(kunjDir, globalDir);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const keyUnlock: Unlock = { kdf: 'keychain', keyFor: async () => Buffer.from(HEX, 'hex') };
  const noRunner: Runner = async () => {
    throw new Error('the keychain must not be touched');
  };
  const keychainRunner = (): { run: Runner; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return args[0] === 'find-generic-password' ? { code: 0, stdout: HEX + '\n' } : { code: 1, stdout: '' };
      },
    };
  };
  const base = { env: {}, platform: 'darwin' as NodeJS.Platform, mode: 'auto' as const };

  it('returns [] without unlocking when no secrets.enc exists', async () => {
    const prompt = jest.fn();
    const got = await loadSecrets({ ...base, kunjDir, globalDir, target: 'host', run: noRunner, prompt });
    expect(got).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('opens both files with one keychain read and resolves them for the branch and target', async () => {
    await writeVault(files.global, [entry('G', 'global'), entry('X', 'global-x')], keyUnlock);
    await writeVault(files.repo, [entry('X', 'repo'), entry('X', 'branch', { scope: { branch: 'b' } }), entry('H', 'h', { targets: ['host'] })], keyUnlock);
    const { run, calls } = keychainRunner();
    const got = await loadSecrets({ ...base, kunjDir, globalDir, branch: 'b', target: 'container', run });
    expect(got.map((e) => [e.name, e.value])).toEqual([
      ['G', 'global'],
      ['X', 'branch'],
    ]);
    expect(calls).toEqual([['security', 'find-generic-password', '-s', 'kunj-secrets', '-a', 'kunj', '-w']]);
  });

  it('outside a repository the global vault is not read a second time as the repo one', async () => {
    // getKunjDir falls back to ./.kunj, which in the home directory is the global one
    await writeVault(files.global, [entry('X', 'global'), entry('X', 'leaked', { scope: { branch: 'b' } })], keyUnlock);
    const got = await openVaults({ ...base, kunjDir: globalDir, globalDir, run: keychainRunner().run });
    expect(got.repo).toEqual([]);
    expect(got.global.map((e) => e.name)).toEqual(['X', 'X']);
  });

  it('never makes a new key: a keychain file whose item is missing is secrets-locked', async () => {
    await writeVault(files.repo, [entry('A', '1')], keyUnlock);
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 44, stdout: '' };
    };
    const err = await loadSecrets({ ...base, kunjDir, globalDir, target: 'host', run }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect((err as SecretError).jsonCode).toBe('secrets-locked');
    expect(calls.some((c) => c[1] === '-i')).toBe(false);
  });

  it('uses KUNJ_SECRETS_KEY for keychain-kdf files without running anything', async () => {
    await writeVault(files.repo, [entry('A', '1')], keyUnlock);
    const got = await loadSecrets({ ...base, env: { KUNJ_SECRETS_KEY: HEX }, kunjDir, globalDir, target: 'host', run: noRunner });
    expect(envOf(got)).toEqual({ A: '1' });
  });

  it('asks a passphrase once for two passphrase files', async () => {
    const pass = await passphraseUnlock('pw');
    await writeVault(files.global, [entry('G', 'g')], pass);
    await writeVault(files.repo, [entry('R', 'r')], pass);
    const prompt = jest.fn(async () => 'pw');
    const got = await loadSecrets({ ...base, kunjDir, globalDir, target: 'host', run: noRunner, prompt });
    expect(got.map((e) => e.name)).toEqual(['G', 'R']);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('opens a keychain global file and a passphrase repo file each with its own unlock', async () => {
    await writeVault(files.global, [entry('G', 'g')], keyUnlock);
    await writeVault(files.repo, [entry('R', 'r')], await passphraseUnlock('pw'));
    const { run, calls } = keychainRunner();
    const prompt = jest.fn(async () => 'pw');
    const got = await loadSecrets({ ...base, kunjDir, globalDir, target: 'host', run, prompt });
    expect(got.map((e) => e.name)).toEqual(['G', 'R']);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('gives secrets-corrupt and does not unlock when a file is not an envelope', async () => {
    fs.mkdirSync(kunjDir, { recursive: true });
    fs.writeFileSync(files.repo, 'not json');
    const prompt = jest.fn();
    const err = await loadSecrets({ ...base, kunjDir, globalDir, target: 'host', run: noRunner, prompt }).catch((e: unknown) => e);
    expect((err as SecretError).jsonCode).toBe('secrets-corrupt');
    expect(prompt).not.toHaveBeenCalled();
  });
});

// A passphrase Unlock built through getUnlock's own scrypt parameters (a fake prompt).
async function passphraseUnlock(pw: string): Promise<Unlock> {
  const { getUnlock } = await import('../keyprovider');
  return getUnlock({ mode: 'passphrase', env: {}, platform: 'linux', create: true, prompt: async () => pw });
}
