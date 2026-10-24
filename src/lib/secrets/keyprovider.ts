// Where the vault key comes from: KUNJ_SECRETS_KEY, the macOS Keychain (`security`), libsecret
// (`secret-tool`) or a passphrase (scrypt). A key or secret value is never put in argv: the Keychain
// item is written by piping the command into `security -i`, and `secret-tool store` reads it from stdin.
// Tests inject `run` and `prompt`, so they never touch a real keychain or terminal.

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { SecretError } from './errors';
import type { Kdf, Unlock } from './vault';

export type Runner = (cmd: string, args: string[], input?: string) => Promise<{ code: number; stdout: string }>;

export type KeyProviderMode = 'auto' | 'keychain' | 'libsecret' | 'passphrase';

export interface GetUnlockOptions {
  mode: KeyProviderMode;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  run?: Runner;
  prompt?: (msg: string) => Promise<string>;
  // The kdf of the vault file(s) to open; undefined when none exists yet.
  existingKdf?: Kdf;
  // Make a new key when the store has none (only when no vault file exists yet).
  create: boolean;
  // Whether a hidden prompt can be shown when `prompt` is not given; defaults to stdin and stderr being TTYs.
  tty?: boolean;
}

export const PASSPHRASE_TRIES = 3;
const SERVICE = 'kunj-secrets';
const ACCOUNT = 'kunj';
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
// The runner's exit code for a command that is not installed.
const NOT_INSTALLED = 127;
// `security find-generic-password`: the item could not be found.
const SECURITY_NOT_FOUND = 44;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const defaultRunner: Runner = (cmd, args, input) =>
  new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    child.on('error', (err: NodeJS.ErrnoException) => resolve({ code: err.code === 'ENOENT' ? NOT_INSTALLED : 1, stdout: '' }));
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });

export async function getUnlock(opts: GetUnlockOptions): Promise<Unlock> {
  // A passphrase file is opened with its passphrase whatever the setting; KUNJ_SECRETS_KEY opens keychain files only.
  if (opts.existingKdf === 'passphrase') return passphraseUnlock(opts, false);

  const wantsKeychainKdf = opts.existingKdf === 'keychain' || opts.mode !== 'passphrase';
  const envKey = opts.env.KUNJ_SECRETS_KEY;
  if (envKey && wantsKeychainKdf) {
    if (!HEX_KEY.test(envKey)) throw locked('KUNJ_SECRETS_KEY must be 64 hex characters (a 32-byte key)');
    return keyUnlock(Buffer.from(envKey, 'hex'));
  }
  if (!wantsKeychainKdf) return passphraseUnlock(opts, opts.create);

  const run = opts.run ?? defaultRunner;
  const store = storeFor(opts.mode, opts.platform);
  const found = await store.read(run);
  if (found.status === 'not-installed') {
    if (opts.mode === 'auto' && !opts.existingKdf) return passphraseUnlock(opts, opts.create);
    throw locked(`${store.name} is not available (${store.tool} not found); set secrets.keyProvider or KUNJ_SECRETS_KEY`);
  }
  if (found.status === 'found') return keyUnlock(found.key);
  if (found.status === 'failed') throw locked(`Could not read the secrets key from ${store.name}`);

  // No item. A new key is made only for a new vault: a keychain file whose key is gone stays locked.
  if (!opts.create || opts.existingKdf) throw locked(`No secrets key in ${store.name} (service ${SERVICE})`);
  const key = crypto.randomBytes(32);
  await store.write(run, key.toString('hex'));
  // `security` can exit 0 without storing; only a key that reads back is used.
  const back = await store.read(run);
  if (back.status !== 'found' || !back.key.equals(key)) throw locked(`Could not store a new secrets key in ${store.name}`);
  return keyUnlock(key);
}

function keyUnlock(key: Buffer): Unlock {
  return { kdf: 'keychain', keyFor: async () => Buffer.from(key) };
}

type ReadResult = { status: 'found'; key: Buffer } | { status: 'missing' | 'not-installed' | 'failed' };

interface KeyStore {
  name: string;
  tool: string;
  read(run: Runner): Promise<ReadResult>;
  write(run: Runner, hex: string): Promise<void>;
}

function storeFor(mode: KeyProviderMode, platform: NodeJS.Platform): KeyStore {
  if (mode === 'keychain' || (mode !== 'libsecret' && platform === 'darwin')) return KEYCHAIN;
  return LIBSECRET;
}

function parseKey(stdout: string, name: string): ReadResult {
  const value = stdout.trim();
  // The message never repeats the item's value.
  if (!HEX_KEY.test(value)) throw locked(`The secrets key in ${name} is not 64 hex characters`);
  return { status: 'found', key: Buffer.from(value, 'hex') };
}

const KEYCHAIN: KeyStore = {
  name: 'the macOS Keychain',
  tool: 'security',
  async read(run) {
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    if (r.code === 0) return parseKey(r.stdout, this.name);
    if (r.code === NOT_INSTALLED) return { status: 'not-installed' };
    // Any other failure (access denied, keychain locked) is not a miss: never make a new key over it.
    return { status: r.code === SECURITY_NOT_FOUND ? 'missing' : 'failed' };
  },
  async write(run, hex) {
    // The command on stdin, not argv. No -U: an existing item is never replaced (the read-back catches it).
    await run('security', ['-i'], `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -w ${hex}\n`);
  },
};

const LIBSECRET: KeyStore = {
  name: 'libsecret',
  tool: 'secret-tool',
  async read(run) {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE]);
    if (r.code === NOT_INSTALLED) return { status: 'not-installed' };
    if (r.code === 0 && r.stdout.trim()) return parseKey(r.stdout, this.name);
    // secret-tool exits 1 with no output when nothing matches.
    return { status: r.code === 0 || (r.code === 1 && !r.stdout.trim()) ? 'missing' : 'failed' };
  },
  async write(run, hex) {
    await run('secret-tool', ['store', '--label=kunj secrets', 'service', SERVICE], hex);
  },
};

// Prompted once per command (the passphrase is kept for later files); the vault asks again, with the
// next attempt number, while the file does not decrypt, up to PASSPHRASE_TRIES.
function passphraseUnlock(opts: GetUnlockOptions, isNew: boolean): Unlock {
  const canPrompt = opts.tty ?? (!!process.stdin.isTTY && !!process.stderr.isTTY);
  const prompt = opts.prompt ?? (canPrompt ? hiddenPrompt : undefined);
  if (!prompt) {
    throw locked('The secrets vault needs a passphrase and there is no terminal to ask for it; set KUNJ_SECRETS_KEY or use a keychain');
  }
  let passphrase: string | undefined;
  return {
    kdf: 'passphrase',
    attempts: PASSPHRASE_TRIES,
    async keyFor(salt, attempt = 1) {
      if (attempt > 1 || passphrase === undefined) {
        const first = passphrase === undefined && attempt === 1;
        const answer = await prompt(attempt > 1 ? 'Wrong passphrase. Secrets passphrase: ' : isNew && first ? 'New secrets passphrase: ' : 'Secrets passphrase: ');
        if (!answer) throw locked('An empty passphrase cannot unlock the secrets vault');
        if (isNew && first && (await prompt('Repeat the passphrase: ')) !== answer) throw locked('The passphrases do not match');
        passphrase = answer;
      }
      return scrypt(passphrase, salt);
    },
  };
}

function scrypt(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(passphrase, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

// A prompt on stderr whose typing is not echoed: readline writes the echo to a muted stream.
function hiddenPrompt(msg: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require('readline') as typeof import('readline');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Writable } = require('stream') as typeof import('stream');
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  process.stderr.write(msg);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.on('SIGINT', () => {
      rl.close();
      process.stderr.write('\n');
      reject(locked('No passphrase given'));
    });
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

function locked(message: string): SecretError {
  return new SecretError(message, 'secrets-locked');
}
