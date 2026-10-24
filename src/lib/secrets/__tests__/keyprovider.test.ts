import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecretError } from '../errors';
import { getUnlock, Runner } from '../keyprovider';
import { readVault, writeVault, SecretEntry } from '../vault';

// Tests never touch the real Keychain: every call goes through a recording Runner fake.
interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

function fakeRunner(respond: (call: Call) => { code: number; stdout: string }): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, input) => {
    const call = { cmd, args, input };
    calls.push(call);
    return respond(call);
  };
  return { run, calls };
}

const HEX = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const LOOKUP = ['find-generic-password', '-s', 'kunj-secrets', '-a', 'kunj', '-w'];

// A fake macOS keychain holding at most one item, written only through `security -i`.
function fakeKeychain(initial?: string) {
  let stored = initial;
  return fakeRunner(({ cmd, args, input }) => {
    if (cmd !== 'security') return { code: 127, stdout: '' };
    if (args[0] === 'find-generic-password') return stored ? { code: 0, stdout: stored + '\n' } : { code: 44, stdout: '' };
    if (args[0] === '-i' && input) {
      const m = /add-generic-password .*-w ([0-9a-f]{64})/.exec(input);
      if (m) stored = m[1];
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  });
}

async function locked(p: Promise<unknown>): Promise<SecretError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SecretError);
  expect((err as SecretError).jsonCode).toBe('secrets-locked');
  return err as SecretError;
}

const base = { mode: 'auto' as const, env: {}, platform: 'darwin' as NodeJS.Platform, create: false };

describe('KUNJ_SECRETS_KEY', () => {
  it('wins over the keychain and runs nothing', async () => {
    const { run, calls } = fakeKeychain();
    const unlock = await getUnlock({ ...base, env: { KUNJ_SECRETS_KEY: HEX }, run, create: true });
    expect(unlock.kdf).toBe('keychain');
    expect((await unlock.keyFor(Buffer.alloc(16))).toString('hex')).toBe(HEX);
    expect(calls).toEqual([]);
  });

  it('gives secrets-locked when malformed, and runs nothing', async () => {
    const { run, calls } = fakeKeychain(HEX);
    const err = await locked(getUnlock({ ...base, env: { KUNJ_SECRETS_KEY: 'abc123' }, run }));
    expect(err.message).not.toContain('abc123');
    expect(calls).toEqual([]);
  });
});

describe('macOS Keychain', () => {
  it('reads the key with security find-generic-password', async () => {
    const { run, calls } = fakeKeychain(HEX);
    const unlock = await getUnlock({ ...base, run, existingKdf: 'keychain' });
    expect(unlock.kdf).toBe('keychain');
    expect((await unlock.keyFor(Buffer.alloc(16))).toString('hex')).toBe(HEX);
    expect(calls).toEqual([{ cmd: 'security', args: LOOKUP, input: undefined }]);
  });

  it('creates a key on a miss through security -i with the command on stdin, never in argv', async () => {
    const { run, calls } = fakeKeychain();
    const unlock = await getUnlock({ ...base, run, create: true });
    const key = (await unlock.keyFor(Buffer.alloc(16))).toString('hex');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const write = calls.find((c) => c.args[0] === '-i');
    expect(write).toBeDefined();
    expect(write!.args).toEqual(['-i']);
    expect(write!.input).toContain('add-generic-password');
    expect(write!.input).toContain('-s kunj-secrets -a kunj');
    expect(write!.input).toContain(key);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(key);
    // Read back after writing: `security` exits 0 even when a write did not take.
    expect(calls[calls.length - 1].args).toEqual(LOOKUP);
  });

  it('gives secrets-locked when the written key does not read back', async () => {
    const { run } = fakeRunner(({ args }) => (args[0] === '-i' ? { code: 0, stdout: '' } : { code: 44, stdout: '' }));
    await locked(getUnlock({ ...base, run, create: true }));
  });

  it('gives secrets-locked on a miss when create is false', async () => {
    const { run, calls } = fakeKeychain();
    await locked(getUnlock({ ...base, run }));
    expect(calls.some((c) => c.args[0] === '-i')).toBe(false);
  });

  it('never creates a new key for an existing keychain file whose key is gone', async () => {
    const { run, calls } = fakeKeychain();
    await locked(getUnlock({ ...base, run, existingKdf: 'keychain', create: true }));
    expect(calls.some((c) => c.args[0] === '-i')).toBe(false);
  });

  it('gives secrets-locked when the item is not a 64-hex key', async () => {
    const { run } = fakeKeychain('not-a-key');
    await locked(getUnlock({ ...base, run, existingKdf: 'keychain' }));
  });
});

describe('libsecret', () => {
  it('reads the key with secret-tool lookup on linux auto', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0, stdout: HEX }));
    const unlock = await getUnlock({ ...base, platform: 'linux', run, existingKdf: 'keychain' });
    expect((await unlock.keyFor(Buffer.alloc(16))).toString('hex')).toBe(HEX);
    expect(calls).toEqual([{ cmd: 'secret-tool', args: ['lookup', 'service', 'kunj-secrets'], input: undefined }]);
  });

  it('stores a new key with the key on stdin, never in argv', async () => {
    let stored: string | undefined;
    const { run, calls } = fakeRunner(({ args, input }) => {
      if (args[0] === 'store') {
        stored = input;
        return { code: 0, stdout: '' };
      }
      return stored ? { code: 0, stdout: stored } : { code: 1, stdout: '' };
    });
    const unlock = await getUnlock({ ...base, platform: 'linux', run, create: true });
    const key = (await unlock.keyFor(Buffer.alloc(16))).toString('hex');
    expect(stored).toBe(key);
    const store = calls.find((c) => c.args[0] === 'store')!;
    expect(store.cmd).toBe('secret-tool');
    expect(store.args).toEqual(expect.arrayContaining(['service', 'kunj-secrets']));
    for (const c of calls) expect(c.args.join(' ')).not.toContain(key);
  });

  it('falls back to the passphrase on auto when secret-tool is missing', async () => {
    const { run } = fakeRunner(() => ({ code: 127, stdout: '' }));
    const unlock = await getUnlock({ ...base, platform: 'linux', run, create: true, prompt: async () => 'pw' });
    expect(unlock.kdf).toBe('passphrase');
  });

  it('gives secrets-locked when libsecret is asked for and secret-tool is missing', async () => {
    const { run } = fakeRunner(() => ({ code: 127, stdout: '' }));
    await locked(getUnlock({ ...base, mode: 'libsecret', platform: 'linux', run, create: true, prompt: async () => 'pw' }));
  });
});

describe('passphrase', () => {
  let dir: string;
  let file: string;
  const entries: SecretEntry[] = [
    { name: 'API_KEY', value: 'sk-123', targets: ['host'], delivery: { env: true }, updatedAt: '2026-10-24T00:00:00.000Z' },
  ];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-keyprovider-'));
    file = path.join(dir, 'secrets.enc');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const answers = (...list: string[]) => {
    const asked: string[] = [];
    const prompt = async (msg: string) => {
      asked.push(msg);
      if (!list.length) throw new Error('prompted too often');
      return list.shift()!;
    };
    return { prompt, asked };
  };

  async function seed(pass: string) {
    const { prompt } = answers(pass, pass);
    const unlock = await getUnlock({ ...base, mode: 'passphrase', prompt, create: true });
    await writeVault(file, entries, unlock);
  }

  it('creates a passphrase vault, confirming the new passphrase', async () => {
    const { prompt, asked } = answers('pw', 'pw');
    const unlock = await getUnlock({ ...base, mode: 'passphrase', prompt, create: true });
    await writeVault(file, entries, unlock);
    expect(asked).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).kdf).toBe('passphrase');
  });

  it('gives secrets-locked when the new passphrase is not confirmed', async () => {
    const { prompt } = answers('pw', 'other');
    const unlock = await getUnlock({ ...base, mode: 'passphrase', prompt, create: true });
    await locked(writeVault(file, entries, unlock));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('opens with the right passphrase after a wrong one, prompting again', async () => {
    await seed('right');
    const { prompt, asked } = answers('wrong', 'right');
    const unlock = await getUnlock({ ...base, prompt, existingKdf: 'passphrase' });
    expect(await readVault(file, unlock)).toEqual(entries);
    expect(asked).toHaveLength(2);
  });

  it('gives secrets-locked after three wrong passphrases and leaves the file byte-identical', async () => {
    await seed('right');
    const before = fs.readFileSync(file);
    const { prompt, asked } = answers('a', 'b', 'c');
    const unlock = await getUnlock({ ...base, prompt, existingKdf: 'passphrase' });
    await locked(readVault(file, unlock));
    expect(asked).toHaveLength(3);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('retries on writeVault too, and asks once per command', async () => {
    await seed('right');
    const { prompt, asked } = answers('wrong', 'right');
    const unlock = await getUnlock({ ...base, prompt, existingKdf: 'passphrase' });
    await readVault(file, unlock);
    await writeVault(file, [...entries, { ...entries[0], name: 'OTHER' }], unlock);
    expect(asked).toHaveLength(2);
    expect((await readVault(file, unlock)).map((e) => e.name)).toEqual(['API_KEY', 'OTHER']);
  });

  it('does not retry a malformed envelope: secrets-corrupt at once', async () => {
    fs.writeFileSync(file, '{"version":1,"kdf":"passphrase"');
    const { prompt, asked } = answers('a', 'b', 'c');
    const unlock = await getUnlock({ ...base, prompt, existingKdf: 'passphrase' });
    const err = await readVault(file, unlock).catch((e) => e);
    expect((err as SecretError).jsonCode).toBe('secrets-corrupt');
    expect(asked).toHaveLength(0);
  });

  it('gives secrets-locked with no prompt and no terminal', async () => {
    const unlock = getUnlock({ ...base, mode: 'passphrase', create: true, tty: false });
    await locked(unlock.then((u) => u.keyFor(Buffer.alloc(16))));
  });

  it('never touches the keychain for an existing passphrase file, even with KUNJ_SECRETS_KEY', async () => {
    const { run, calls } = fakeKeychain(HEX);
    const unlock = await getUnlock({
      ...base,
      env: { KUNJ_SECRETS_KEY: HEX },
      run,
      existingKdf: 'passphrase',
      prompt: async () => 'pw',
    });
    expect(unlock.kdf).toBe('passphrase');
    await unlock.keyFor(Buffer.alloc(16));
    expect(calls).toEqual([]);
  });

  it('refuses an empty passphrase', async () => {
    const { prompt } = answers('', '');
    const unlock = await getUnlock({ ...base, mode: 'passphrase', prompt, create: true });
    await locked(unlock.keyFor(Buffer.alloc(16)));
  });
});

describe('secrets.keyProvider setting', () => {
  it('is registered with default auto and validates its values', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { initializeSettings, settingsRegistry } = require('../../../settings');
    initializeSettings();
    const s = settingsRegistry.get('secrets.keyProvider');
    expect(s).toMatchObject({ type: 'string', defaultValue: 'auto', category: 'secrets' });
    for (const v of ['auto', 'keychain', 'libsecret', 'passphrase']) expect(s.validate(v)).toBe(true);
    expect(s.validate('vault')).toBe(false);
    expect(settingsRegistry.getDefaultConfig().secrets).toEqual({ keyProvider: 'auto' });
  });
});
