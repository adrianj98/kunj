import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecretError } from '../errors';
import { readVault, writeVault, vaultFiles, vaultStamp, SecretEntry, Unlock } from '../vault';

// Tests never touch the real Keychain: fixed-key and scrypt passphrase unlocks only.
const fixedKey = (key: Buffer = crypto.randomBytes(32)): Unlock => ({
  kdf: 'keychain',
  keyFor: async () => key,
});

const passphrase = (secret: string): Unlock => ({
  kdf: 'passphrase',
  keyFor: (salt) =>
    new Promise((resolve, reject) =>
      crypto.scrypt(secret, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key),
      ),
    ),
});

const entries: SecretEntry[] = [
  {
    name: 'DATABASE_URL',
    value: 'postgres://user:hunter2@db/app',
    scope: { branch: 'feature/x' },
    targets: ['host', 'container'],
    delivery: { env: true, file: '.env' },
    updatedAt: '2026-10-23T10:00:00.000Z',
  },
  {
    name: 'GH_TOKEN',
    value: 'ghp_secretvalue123',
    targets: ['host'],
    delivery: { env: true },
    updatedAt: '2026-10-23T11:00:00.000Z',
  },
];

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-vault-'));
  file = path.join(dir, 'repo', 'secrets.enc');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const envelope = (): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8'));

async function expectCode(p: Promise<unknown>, code: string): Promise<SecretError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SecretError);
  expect((err as SecretError).jsonCode).toBe(code);
  return err as SecretError;
}

describe('SecretError', () => {
  it('carries its jsonCode and name', () => {
    const err = new SecretError('nope', 'bad-name');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SecretError');
    expect(err.jsonCode).toBe('bad-name');
    expect(err.message).toBe('nope');
  });
});

describe('vault', () => {
  it('returns [] when the file is missing', async () => {
    await expect(readVault(file, fixedKey())).resolves.toEqual([]);
  });

  it('round-trips entries with a fixed key', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    await expect(readVault(file, unlock)).resolves.toEqual(entries);
  });

  it('round-trips entries with a passphrase', async () => {
    await writeVault(file, entries, passphrase('correct horse'));
    await expect(readVault(file, passphrase('correct horse'))).resolves.toEqual(entries);
    expect(envelope().kdf).toBe('passphrase');
  });

  it('writes a v1 envelope with mode 0600 that reveals no name or value', async () => {
    await writeVault(file, entries, fixedKey());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const raw = fs.readFileSync(file, 'utf8');
    for (const e of entries) {
      expect(raw).not.toContain(e.name);
      expect(raw).not.toContain(e.value);
    }
    const env = envelope();
    expect(Object.keys(env).sort()).toEqual(['ciphertext', 'iv', 'kdf', 'salt', 'tag', 'version']);
    expect(env.version).toBe(1);
    expect(env.kdf).toBe('keychain');
    expect(Buffer.from(env.salt as string, 'base64')).toHaveLength(16);
    expect(Buffer.from(env.iv as string, 'base64')).toHaveLength(12);
    expect(Buffer.from(env.tag as string, 'base64')).toHaveLength(16);
  });

  it('leaves no temp file behind', async () => {
    await writeVault(file, entries, fixedKey());
    expect(fs.readdirSync(path.dirname(file))).toEqual(['secrets.enc']);
  });

  it('uses a fresh iv per write and keeps the salt of an existing file', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    const first = envelope();
    await writeVault(file, entries, unlock);
    const second = envelope();
    expect(second.iv).not.toBe(first.iv);
    expect(second.salt).toBe(first.salt);
    expect(second.kdf).toBe(first.kdf);
  });

  it('keeps the passphrase salt so the same passphrase still opens it', async () => {
    await writeVault(file, entries, passphrase('pw'));
    const salt = envelope().salt;
    await writeVault(file, entries.slice(1), passphrase('pw'));
    expect(envelope().salt).toBe(salt);
    await expect(readVault(file, passphrase('pw'))).resolves.toEqual(entries.slice(1));
  });

  it('gives secrets-corrupt naming the file, and leaves the bytes untouched, when one ciphertext byte flips', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    const env = envelope();
    const ct = Buffer.from(env.ciphertext as string, 'base64');
    ct[0] ^= 0x01;
    fs.writeFileSync(file, JSON.stringify({ ...env, ciphertext: ct.toString('base64') }));
    const before = fs.readFileSync(file);
    const err = await expectCode(readVault(file, unlock), 'secrets-corrupt');
    expect(err.message).toContain(file);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('gives secrets-corrupt for truncated JSON', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    const raw = fs.readFileSync(file);
    fs.writeFileSync(file, raw.subarray(0, Math.floor(raw.length / 2)));
    const err = await expectCode(readVault(file, unlock), 'secrets-corrupt');
    expect(err.message).toContain(file);
  });

  it('gives secrets-corrupt for an unknown version or kdf', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    const env = envelope();
    fs.writeFileSync(file, JSON.stringify({ ...env, version: 2 }));
    await expectCode(readVault(file, unlock), 'secrets-corrupt');
    fs.writeFileSync(file, JSON.stringify({ ...env, kdf: 'rot13' }));
    await expectCode(readVault(file, unlock), 'secrets-corrupt');
  });

  it('gives secrets-corrupt for a wrong key', async () => {
    await writeVault(file, entries, fixedKey());
    await expectCode(readVault(file, fixedKey()), 'secrets-corrupt');
  });

  it('gives secrets-corrupt for a wrong passphrase', async () => {
    await writeVault(file, entries, passphrase('right'));
    await expectCode(readVault(file, passphrase('wrong')), 'secrets-corrupt');
  });

  it('detects a kdf field swapped in the envelope (authenticated)', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    fs.writeFileSync(file, JSON.stringify({ ...envelope(), kdf: 'passphrase' }));
    await expectCode(readVault(file, { ...unlock, kdf: 'passphrase' }), 'secrets-corrupt');
  });

  it('refuses to overwrite a corrupt file and leaves it byte-identical', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":1,');
    const before = fs.readFileSync(file);
    const err = await expectCode(writeVault(file, [], fixedKey()), 'secrets-corrupt');
    expect(err.message).toContain(file);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to overwrite a tampered file (valid envelope, bad tag) and leaves it byte-identical', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    const env = envelope();
    const ct = Buffer.from(env.ciphertext as string, 'base64');
    ct[0] ^= 0x01;
    fs.writeFileSync(file, JSON.stringify({ ...env, ciphertext: ct.toString('base64') }));
    const before = fs.readFileSync(file);
    const err = await expectCode(writeVault(file, [], unlock), 'secrets-corrupt');
    expect(err.message).toContain(file);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to overwrite a file encrypted under another key and leaves it byte-identical', async () => {
    await writeVault(file, entries, fixedKey());
    const before = fs.readFileSync(file);
    await expectCode(writeVault(file, [], fixedKey()), 'secrets-corrupt');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses to write with a provider of another kdf than the file', async () => {
    await writeVault(file, entries, passphrase('pw'));
    const before = fs.readFileSync(file);
    await expectCode(writeVault(file, entries, fixedKey()), 'secrets-locked');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('gives secrets-locked when the provider returns a key that is not 32 bytes', async () => {
    await expectCode(writeVault(file, entries, fixedKey(Buffer.alloc(16))), 'secrets-locked');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a bad name with bad-name and writes nothing', async () => {
    const bad = { ...entries[1], name: 'NOT-OK' };
    const err = await expectCode(writeVault(file, [bad], fixedKey()), 'bad-name');
    expect(err.message).not.toContain(bad.value);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('gives secrets-corrupt when the decrypted content is not a list of entries', async () => {
    const key = crypto.randomBytes(32);
    await writeVault(file, entries, fixedKey(key));
    // Re-encrypt a valid envelope around a non-entry payload with the same key and AAD.
    const env = envelope();
    const salt = Buffer.from(env.salt as string, 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`kunj-secrets:1:keychain:${salt.toString('base64')}`));
    const ct = Buffer.concat([cipher.update('{"not":"a list"}'), cipher.final()]);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...env, iv: iv.toString('base64'), ciphertext: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') }),
    );
    await expectCode(readVault(file, fixedKey(key)), 'secrets-corrupt');
  });
});

describe('vaultFiles', () => {
  it('puts the global vault in the global dir and the repo vault in the repo dir', () => {
    expect(vaultFiles('/h/.kunj/repo', '/h/.kunj')).toEqual({
      global: path.join('/h/.kunj', 'secrets.enc'),
      repo: path.join('/h/.kunj/repo', 'secrets.enc'),
    });
  });
});

describe('vaultStamp', () => {
  it('is empty when no file exists', () => {
    expect(vaultStamp([])).toBe('');
    expect(vaultStamp([path.join(dir, 'missing.enc')])).toBe('');
  });

  it('is 12 hex chars and changes after a write, without unlocking', async () => {
    const unlock = fixedKey();
    const global = path.join(dir, 'secrets.enc');
    await writeVault(file, entries, unlock);
    const first = vaultStamp([global, file]);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(vaultStamp([global, file])).toBe(first);
    await writeVault(file, entries, unlock);
    expect(vaultStamp([global, file])).not.toBe(first);
  });

  it('tells which file the bytes came from', async () => {
    const unlock = fixedKey();
    await writeVault(file, entries, unlock);
    const other = path.join(dir, 'other.enc');
    expect(vaultStamp([file, other])).not.toBe(vaultStamp([other, file]));
  });
});
