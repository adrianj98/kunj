// The server's bearer token: one per `kunj serve`, in a 0600 file, compared in constant time.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function writeToken(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The token in `file`, created when the file does not exist; `created` says which. */
export function loadOrCreateToken(file: string): { token: string; created: boolean } {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token) return { token, created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = newToken();
  writeToken(file, token);
  return { token, created: true };
}

export function rotateToken(file: string): string {
  const token = newToken();
  writeToken(file, token);
  return token;
}

/** Constant time for equal lengths; a length mismatch is a mismatch (and not secret). */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- named client tokens (docs/specs/cloud-machines.md, "Per-client tokens") ----------------------
//
// A server can accept several tokens, one per client, so each can be revoked alone and the log says
// who called. They live in tokens.json next to the legacy single token, which keeps working as the
// client named `default`. Both files are read again whenever they change, so `kunj serve token add`
// and `remove` take effect on a running server without a restart.

/** Returns the name of the client a bearer token belongs to, or null. */
export type Authenticator = (given: string | undefined) => string | null;

export interface ClientToken {
  name: string;
  token: string;
  createdAt: string;
}

export const DEFAULT_CLIENT = 'default';
export const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

function readClients(file: string): ClientToken[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.clients) ? parsed.clients : [];
    return list.filter(
      (c: any): c is ClientToken => !!c && typeof c.name === 'string' && typeof c.token === 'string' && c.token.length > 0 && typeof c.createdAt === 'string',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function writeClients(file: string, clients: ClientToken[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ clients }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listClients(file: string): Array<{ name: string; createdAt: string }> {
  return readClients(file).map(c => ({ name: c.name, createdAt: c.createdAt }));
}

/** Adds a client (or, with `rotate`, replaces its token); returns the token, shown once. */
export function addClient(file: string, name: string, opts: { rotate?: boolean } = {}): string {
  if (!CLIENT_NAME.test(name) || name === DEFAULT_CLIENT) {
    throw new Error(`"${name}" cannot name a client: use letters, digits, ".", "_" or "-" (up to 32), and not "${DEFAULT_CLIENT}".`);
  }
  const clients = readClients(file);
  const existing = clients.find(c => c.name === name);
  if (existing && !opts.rotate) throw new Error(`A client named ${name} exists. Pass --rotate to replace its token.`);
  const token = newToken();
  const next = clients.filter(c => c.name !== name);
  next.push({ name, token, createdAt: new Date().toISOString() });
  writeClients(file, next);
  return token;
}

export function removeClient(file: string, name: string): boolean {
  const clients = readClients(file);
  const next = clients.filter(c => c.name !== name);
  if (next.length === clients.length) return false;
  writeClients(file, next);
  return true;
}

function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return 'missing';
  }
}

/**
 * The legacy token file (client `default`) and the clients file, re-read when either changes. Every
 * stored token is compared, so the time taken does not say which one matched.
 */
export function fileAuthenticator(legacyFile: string, clientsFile: string): Authenticator {
  let key = '';
  let entries: Array<{ name: string; token: string }> = [];
  const load = () => {
    const next = `${stamp(legacyFile)}|${stamp(clientsFile)}`;
    if (next === key) return;
    key = next;
    entries = readClients(clientsFile).map(c => ({ name: c.name, token: c.token }));
    try {
      const legacy = fs.readFileSync(legacyFile, 'utf8').trim();
      if (legacy) entries.unshift({ name: DEFAULT_CLIENT, token: legacy });
    } catch {
      // no legacy token: only the named clients
    }
  };
  return given => {
    load();
    let found: string | null = null;
    for (const e of entries) if (tokenMatches(given, e.token) && found === null) found = e.name;
    return found;
  };
}

/** One fixed token, as client `default` (tests, and servers given --token by a harness). */
export function singleTokenAuthenticator(token: string): Authenticator {
  return given => (tokenMatches(given, token) ? DEFAULT_CLIENT : null);
}
