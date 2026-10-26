// The remotes the laptop knows: ~/.kunj/remotes.json, one entry per `kunj serve` with how it is
// reached (a URL behind the user's TLS, or an SSH tunnel kunj opens) and its token. 0600 like gh's
// hosts.yml; not in the secrets vault, because the listings that use it most never unlock the vault.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerError } from './container/errors';

export const REMOTES_FILE = 'remotes.json';
export const DEFAULT_SERVE_PORT = 7433;

export interface RemoteEntry {
  /** user@host (or host) for `ssh -L`; the server listens on the box's loopback */
  ssh?: string;
  /** The server's port on the box (default 7433), with `ssh` */
  port?: number;
  /** http(s) URL of the server; plain http only to a loopback address, unless `insecure` */
  url?: string;
  /** Added with --allow-insecure-http: a plain http URL to a non-loopback address (a tailnet, a trusted LAN) */
  insecure?: boolean;
  token: string;
  addedAt: string;
}

export type Remotes = Record<string, RemoteEntry>;

export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

export function getRemotesPath(home: string = os.homedir()): string {
  return path.join(home, '.kunj', REMOTES_FILE);
}

export function readRemotes(file: string = getRemotesPath()): Remotes {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ContainerError(`${file} is not valid JSON; fix or delete it`, 'bad-remote');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ContainerError(`${file} must hold an object of remotes`, 'bad-remote');
  return parsed as Remotes;
}

/** Written atomically with mode 0600; the directory is created 0700. */
export function writeRemotes(remotes: Remotes, file: string = getRemotesPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(remotes, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function checkRemoteName(name: string): void {
  if (!REMOTE_NAME.test(name)) throw new ContainerError(`Remote name "${name}": letters, digits, _ . and -, up to 32, starting with a letter or digit`, 'bad-remote');
  if (name === 'local') throw new ContainerError('"local" means the laptop\'s own Docker and cannot be a remote name', 'bad-remote');
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/;

/** Whether the URL is plain http to a non-loopback address (the case --allow-insecure-http allows). */
export function isInsecureUrl(url: URL): boolean {
  return url.protocol === 'http:' && !LOOPBACK.test(url.hostname);
}

/**
 * https anywhere; http only to loopback, so a plaintext LAN connection cannot be configured by accident.
 * `allowInsecureHttp` (--allow-insecure-http) accepts http to any host, for networks that already
 * encrypt (Tailscale, WireGuard) or that the user trusts.
 */
export function checkRemoteUrl(url: string, opts: { allowInsecureHttp?: boolean } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ContainerError(`"${url}" is not a URL`, 'bad-remote');
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:') {
    if (LOOPBACK.test(parsed.hostname) || opts.allowInsecureHttp) return parsed;
    throw new ContainerError(`http:// is only accepted to a loopback address (${parsed.hostname} is not): use https://, add the remote with --ssh and let kunj tunnel to it, or pass --allow-insecure-http on a network that already encrypts (Tailscale, WireGuard)`, 'bad-remote');
  }
  throw new ContainerError(`"${url}": expected http:// or https://`, 'bad-remote');
}

/** `user@host` or `host`: one word ssh will take as a destination, never an option. */
export function checkSshDestination(ssh: string): void {
  if (!ssh || /\s/.test(ssh) || ssh.startsWith('-')) throw new ContainerError(`"${ssh}" is not an SSH destination (user@host)`, 'bad-remote');
}

export function checkToken(token: string): void {
  if (!token || /\s/.test(token)) throw new ContainerError('The token must be one word', 'bad-remote');
}

export function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ContainerError(`Port ${port} is not between 1 and 65535`, 'bad-remote');
}

/** The entry for `name`, else `remote-unknown` naming the file. */
export function requireRemote(name: string, file: string = getRemotesPath()): RemoteEntry {
  const entry = readRemotes(file)[name];
  if (!entry) throw new ContainerError(`No remote named "${name}" (kunj remote add ${name} --ssh user@host | --url https://…; the known ones are in ${file})`, 'remote-unknown');
  return entry;
}

/** How a remote is reached, for listings: never the token. */
export function describeRemote(entry: RemoteEntry): string {
  if (entry.url) return entry.insecure ? `${entry.url} (unencrypted)` : entry.url;
  return `ssh ${entry.ssh} (port ${entry.port ?? DEFAULT_SERVE_PORT})`;
}
