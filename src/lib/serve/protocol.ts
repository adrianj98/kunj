// The wire format shared by `kunj serve` (the server on the Docker host) and RemoteKunjBackend
// (the client on the laptop): routes are JSON over HTTP, streams are WebSocket frames. Spec:
// docs/specs/remote-containers.md. Nothing here touches Docker or the filesystem.

import { Labels } from '../container/backend';

/** Bumped on an incompatible change; the client refuses a server with another version. */
export const PROTOCOL_VERSION = 1;

/** JSON request bodies above this are refused (streaming tar bodies are not JSON and not limited). */
export const MAX_JSON_BODY = 1024 * 1024;

/** Stop reading a stream's source while this much is buffered on the socket; resume when it drains. */
export const HIGH_WATER = 1024 * 1024;

/** The env a TTY exec may carry (what ContainerCommand.interactive() sets); never a secret. */
export const TTY_ENV_NAMES = ['TERM', 'COLORTERM', 'LANG'];

/** Image tags the server will build, commit or remove. */
export const IMAGE_TAG_PREFIX = 'kunj-';

export type ServeErrorCode =
  | 'unauthorized'
  | 'not-found'
  | 'bad-request'
  | 'too-large'
  | 'remote-refused'
  | 'backend';

/** An error the server sends as { error: { code, message } } with `status`. */
export class ServeError extends Error {
  constructor(readonly status: number, readonly code: ServeErrorCode, message: string) {
    super(message);
    this.name = 'ServeError';
  }
}

export interface ErrorBody {
  error: { code: ServeErrorCode; message: string };
}

/** GET /v1/info */
export interface InfoJson {
  kunj: string;
  protocol: number;
  features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  /** The Docker context the server uses (asked once, at its first request) */
  context: string;
}

/** GET /v1/engine (the EngineInfo); GET /v1/engine/context gives { context } */
export interface EngineJson {
  serverVersion: string;
  runtimes: string[];
  operatingSystem: string;
}

// ---- exec channel ----------------------------------------------------------------------------

/** The first byte of a binary frame on the exec WebSocket. */
export const CHANNEL = { stdin: 0, stdout: 1, stderr: 2 } as const;
export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

/** The first text frame the client sends on an exec WebSocket. */
export interface ExecRequest {
  cmd: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  tty?: boolean;
  /** Whether the client will send stdin frames (an EOF frame is still expected when true) */
  stdin: boolean;
  timeoutMs?: number;
}

/** Text frames after the request, both directions. */
export type ExecControl =
  | { resize: { cols: number; rows: number } }
  | { exit: number }
  | { error: string };

export function encodeFrame(channel: Channel, data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from([channel]), body]);
}

export function decodeFrame(frame: Buffer): { channel: Channel; data: Buffer } {
  if (frame.length === 0) throw new ServeError(400, 'bad-request', 'empty frame');
  const channel = frame[0];
  if (channel !== CHANNEL.stdin && channel !== CHANNEL.stdout && channel !== CHANNEL.stderr) {
    throw new ServeError(400, 'bad-request', `unknown channel ${channel}`);
  }
  return { channel, data: frame.subarray(1) };
}

export function parseControl(text: string): ExecControl {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServeError(400, 'bad-request', 'control frame is not JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new ServeError(400, 'bad-request', 'control frame is not an object');
  const c = parsed as Record<string, unknown>;
  if (typeof c.exit === 'number') return { exit: c.exit };
  if (typeof c.error === 'string') return { error: c.error };
  const r = c.resize as Record<string, unknown> | undefined;
  if (r && Number.isInteger(r.cols) && Number.isInteger(r.rows) && (r.cols as number) > 0 && (r.rows as number) > 0) {
    return { resize: { cols: r.cols as number, rows: r.rows as number } };
  }
  throw new ServeError(400, 'bad-request', 'unknown control frame');
}

// ---- label filters in query strings -------------------------------------------------------------

/** `label=k=v` once per label; a '' value stays `label=k=` (events: any value of that label). */
export function labelQuery(labels: Labels): string {
  const params = new URLSearchParams();
  for (const k of Object.keys(labels).sort()) params.append('label', `${k}=${labels[k]}`);
  return params.toString();
}

export function parseLabelQuery(params: URLSearchParams): Labels {
  const labels: Labels = {};
  for (const entry of params.getAll('label')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new ServeError(400, 'bad-request', 'label filter must be key=value');
    labels[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return labels;
}
