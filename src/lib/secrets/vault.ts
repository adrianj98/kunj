// The encrypted secret store: a JSON envelope { version, kdf, salt, iv, ciphertext, tag } (base64
// fields) around AES-256-GCM. The envelope's version, kdf and salt are bound as additional
// authenticated data, so editing any of them fails like a flipped ciphertext byte. A file that does not
// decrypt is never overwritten: it is reported as secrets-corrupt and left as it is.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isSecretName } from './dotenv';
import { SecretError } from './errors';

export interface SecretEntry {
  name: string;
  value: string;
  scope?: { branch?: string };
  targets: Array<'host' | 'container'>;
  delivery: { env: boolean; file?: string };
  updatedAt: string;
}

export type Kdf = 'keychain' | 'passphrase';

// How a vault file is opened. The keychain kdf ignores the salt; the passphrase kdf derives from it.
export interface Unlock {
  kdf: Kdf;
  keyFor(salt: Buffer): Promise<Buffer>;
}

interface Envelope {
  version: 1;
  kdf: Kdf;
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function vaultFiles(kunjDir: string, globalDir: string): { global: string; repo: string } {
  return { global: path.join(globalDir, 'secrets.enc'), repo: path.join(kunjDir, 'secrets.enc') };
}

// Ruling 2: a short hash of the vault files' bytes, read without unlocking. '' when none exists.
export function vaultStamp(files: string[]): string {
  const hash = crypto.createHash('sha256');
  let any = false;
  files.forEach((file, i) => {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return;
    }
    any = true;
    hash.update(`${i}:${bytes.length}:`);
    hash.update(bytes);
  });
  return any ? hash.digest('hex').slice(0, 12) : '';
}

export async function readVault(file: string, unlock: Unlock): Promise<SecretEntry[]> {
  const env = readEnvelope(file);
  if (!env) return [];
  checkKdf(file, env, unlock);
  const key = await keyOf(unlock, Buffer.from(env.salt, 'base64'));
  let plain: string;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    decipher.setAAD(aad(env.kdf, env.salt));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw corrupt(file, 'it does not decrypt (wrong key, or the file was modified)');
  }
  let entries: unknown;
  try {
    entries = JSON.parse(plain);
  } catch {
    throw corrupt(file, 'its decrypted content is not JSON');
  }
  if (!Array.isArray(entries) || !entries.every(isEntry)) throw corrupt(file, 'its decrypted content is not a list of secrets');
  return entries;
}

// Keeps the existing file's salt and kdf; refuses to replace a file that does not parse.
export async function writeVault(file: string, entries: SecretEntry[], unlock: Unlock): Promise<void> {
  for (const e of entries) {
    if (!isSecretName(e.name)) throw new SecretError(`Invalid secret name ${JSON.stringify(e.name)}: names must match [A-Za-z_][A-Za-z0-9_]*`, 'bad-name');
  }
  const existing = readEnvelope(file);
  if (existing) checkKdf(file, existing, unlock);
  const kdf = existing ? existing.kdf : unlock.kdf;
  const salt = existing ? existing.salt : crypto.randomBytes(SALT_BYTES).toString('base64');
  const key = await keyOf(unlock, Buffer.from(salt, 'base64'));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(kdf, salt));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
  const env: Envelope = {
    version: VERSION,
    kdf,
    salt,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(env) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function aad(kdf: string, salt: string): Buffer {
  return Buffer.from(`kunj-secrets:${VERSION}:${kdf}:${salt}`);
}

function corrupt(file: string, why: string): SecretError {
  return new SecretError(`${file}: ${why}. The file was left untouched.`, 'secrets-corrupt');
}

async function keyOf(unlock: Unlock, salt: Buffer): Promise<Buffer> {
  const key = await unlock.keyFor(salt);
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new SecretError(`The secrets key must be ${KEY_BYTES} bytes`, 'secrets-locked');
  }
  return key;
}

function checkKdf(file: string, env: Envelope, unlock: Unlock): void {
  if (env.kdf !== unlock.kdf) {
    throw new SecretError(`${file} is locked with the ${env.kdf} kdf, not ${unlock.kdf}`, 'secrets-locked');
  }
}

// null when the file does not exist; secrets-corrupt when it exists but is not a v1 envelope.
function readEnvelope(file: string): Envelope | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    throw corrupt(file, 'it is not valid JSON');
  }
  if (!isEnvelope(env)) throw corrupt(file, 'it is not a version 1 secrets envelope');
  return env;
}

function isEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    e.version === VERSION &&
    (e.kdf === 'keychain' || e.kdf === 'passphrase') &&
    isB64(e.salt, SALT_BYTES) &&
    isB64(e.iv, IV_BYTES) &&
    isB64(e.tag, TAG_BYTES) &&
    isB64(e.ciphertext)
  );
}

function isB64(v: unknown, bytes?: number): boolean {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return false;
  return bytes === undefined || Buffer.from(v, 'base64').length === bytes;
}

function isEntry(v: unknown): v is SecretEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  const delivery = e.delivery as Record<string, unknown> | undefined;
  const scope = e.scope as Record<string, unknown> | undefined;
  return (
    typeof e.name === 'string' &&
    typeof e.value === 'string' &&
    typeof e.updatedAt === 'string' &&
    Array.isArray(e.targets) &&
    e.targets.every((t) => t === 'host' || t === 'container') &&
    !!delivery &&
    typeof delivery === 'object' &&
    typeof delivery.env === 'boolean' &&
    (delivery.file === undefined || typeof delivery.file === 'string') &&
    (scope === undefined || (typeof scope === 'object' && scope !== null && (scope.branch === undefined || typeof scope.branch === 'string')))
  );
}
