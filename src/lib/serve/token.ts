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
