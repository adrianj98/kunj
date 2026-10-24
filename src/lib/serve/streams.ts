// The streaming half of `kunj serve`: exec, logs and events over WebSocket, copyIn and buildImage
// as chunked request bodies. Frames and control messages are protocol.ts's; backpressure is the
// socket's: output is written with the send callback (so the backend's writer waits for the socket
// to drain) and the socket is paused while the backend's reader is behind.

import * as http from 'http';
import { Duplex, PassThrough, Writable } from 'stream';
import { URL } from 'url';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { BuildOptions, ContainerBackend, ExecIO, ExecTimeoutError, TtySession } from '../container/backend';
import { Guard } from './guard';
import {
  CHANNEL,
  Channel,
  ExecControl,
  ExecRequest,
  HIGH_WATER,
  ServeError,
  TTY_ENV_NAMES,
  decodeFrame,
  encodeFrame,
  parseControl,
  parseLabelQuery,
} from './protocol';
import { bearerOf } from './http';
import { tokenMatches } from './token';

export interface StreamOptions {
  backend: ContainerBackend;
  guard: Guard;
  token: string;
  log: (line: string) => void;
}

/** A Writable that sends each chunk as a frame and completes the write when the socket took it. */
export function frameWriter(ws: WebSocket, channel: Channel): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (ws.readyState !== WebSocket.OPEN) return cb();
      ws.send(encodeFrame(channel, chunk), { binary: true }, err => cb(err ?? undefined));
    },
  });
}

/** Sends a control message; a closed socket is not an error (the client has gone). */
export function sendControl(ws: WebSocket, control: ExecControl): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(control));
}

/** Stdin frames are written into this stream (EOF on the empty frame); the socket pauses while the reader is behind. */
export function frameReader(ws: WebSocket): Duplex {
  const out = new PassThrough({ highWaterMark: HIGH_WATER });
  out.on('drain', () => ws.resume());
  return out;
}

export function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function checkExecRequest(body: unknown): ExecRequest {
  const r = body as Record<string, unknown>;
  if (!r || typeof r !== 'object' || !Array.isArray(r.cmd) || !r.cmd.every(c => typeof c === 'string') || r.cmd.length === 0) {
    throw new ServeError(400, 'bad-request', 'exec request needs cmd: string[]');
  }
  for (const key of ['user', 'workdir'] as const) {
    if (r[key] !== undefined && typeof r[key] !== 'string') throw new ServeError(400, 'bad-request', `exec ${key} must be a string`);
  }
  if (r.env !== undefined && (typeof r.env !== 'object' || Object.values(r.env as object).some(v => typeof v !== 'string'))) {
    throw new ServeError(400, 'bad-request', 'exec env must be string values');
  }
  if (r.timeoutMs !== undefined && typeof r.timeoutMs !== 'number') throw new ServeError(400, 'bad-request', 'exec timeoutMs must be a number');
  if (r.tty) {
    for (const name of Object.keys((r.env as object) ?? {})) {
      if (!TTY_ENV_NAMES.includes(name)) throw new ServeError(403, 'remote-refused', `a TTY exec may not set ${name} (only ${TTY_ENV_NAMES.join(', ')})`);
    }
  }
  return {
    cmd: r.cmd as string[],
    user: r.user as string | undefined,
    workdir: r.workdir as string | undefined,
    env: r.env as Record<string, string> | undefined,
    tty: !!r.tty,
    stdin: !!r.stdin,
    timeoutMs: r.timeoutMs as number | undefined,
  };
}

/** Waits for the first text frame: the request. */
function firstMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData, binary: boolean) => {
      cleanup();
      if (binary) return reject(new ServeError(400, 'bad-request', 'the first frame must be the request'));
      resolve(rawToBuffer(data).toString());
    };
    const onClose = () => {
      cleanup();
      reject(new ServeError(400, 'bad-request', 'closed before the request'));
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.once('message', onMessage);
    ws.once('close', onClose);
  });
}

function closeWithError(ws: WebSocket, err: unknown, log: (line: string) => void, what: string): void {
  const message = err instanceof ServeError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  if (err instanceof ServeError && err.code === 'remote-refused') log(`refused ${what}: ${err.message}`);
  sendControl(ws, { error: err instanceof ExecTimeoutError ? 'timeout' : message });
  ws.close();
}

async function serveExec(ws: WebSocket, id: string, opts: StreamOptions): Promise<void> {
  // Listening from the first moment: stdin frames follow the request at once, and a frame that
  // arrives while the request is checked or the guard inspects would otherwise be dropped
  const stdin = frameReader(ws);
  const stdout = frameWriter(ws, CHANNEL.stdout);
  const stderr = frameWriter(ws, CHANNEL.stderr);
  let closed = false;
  // Aborted when the client leaves: ends a command that does not read stdin (sleep) too
  const gone = new AbortController();
  let tty: TtySession | undefined;
  // The newest resize, kept until the pty exists
  let size: { cols: number; rows: number } | undefined;
  const requestText = firstMessage(ws);

  ws.on('message', (data: RawData, binary: boolean) => {
    if (!binary) {
      // Control frames from the client after the request: resize (a non-TTY exec ignores it)
      try {
        const control = parseControl(rawToBuffer(data).toString());
        if ('resize' in control) {
          size = control.resize;
          tty?.resize(size.cols, size.rows).catch(() => undefined);
        }
      } catch {
        /* the request itself, or junk */
      }
      return;
    }
    const { channel, data: bytes } = decodeFrame(rawToBuffer(data));
    if (channel !== CHANNEL.stdin) return;
    if (bytes.length === 0) {
      stdin.end();
      return;
    }
    if (!stdin.write(bytes)) ws.pause();
  });
  ws.on('close', () => {
    closed = true;
    // The client went away mid-exec: stdin ends, the exec is aborted (killed), a pty is hung up
    stdin.destroy();
    gone.abort();
    tty?.close();
  });

  const request = checkExecRequest(JSON.parse(await requestText));
  await opts.guard.container(id);

  if (request.tty) {
    if (!opts.backend.execTty) throw new ServeError(400, 'bad-request', 'this server cannot run a TTY exec');
    tty = await opts.backend.execTty(id, request.cmd, {
      user: request.user,
      workdir: request.workdir,
      env: request.env,
      cols: size?.cols ?? 80,
      rows: size?.rows ?? 24,
    });
    if (closed) {
      tty.close();
      return;
    }
    stdin.pipe(tty.stdin);
    // pipe() ends `stdout` when the pty's stream ends, after every queued byte was sent; the exit
    // frame waits for that, else a burst of output before `exit` would be cut (a pty stream that
    // never ends is given a moment, then ended)
    const drained = new Promise<void>(resolve => stdout.once('finish', resolve));
    tty.stdout.pipe(stdout);
    const exitCode = await tty.wait();
    await Promise.race([drained, new Promise<void>(resolve => setTimeout(resolve, 2000))]);
    if (!stdout.writableFinished) await new Promise<void>(resolve => stdout.end(resolve));
    if (!closed) {
      sendControl(ws, { exit: exitCode });
      ws.close();
    }
    return;
  }
  if (!request.stdin) stdin.end();
  // The client left while the request was checked: nothing starts
  if (closed) return;

  const io: ExecIO = {
    stdin: request.stdin ? stdin : 'ignore',
    stdout,
    stderr,
    user: request.user,
    workdir: request.workdir,
    env: request.env,
    timeoutMs: request.timeoutMs,
    signal: gone.signal,
  };
  const result = await opts.backend.exec(id, request.cmd, io);
  // A backend that answered in the result rather than the stream (the fake does): same bytes, same channel
  if (result.stdout) await new Promise<void>((resolve, reject) => stdout.write(result.stdout, err => (err ? reject(err) : resolve())));
  // Everything written before the exit was sent with a callback, so it is on the wire before this
  await new Promise<void>(resolve => stdout.end(resolve));
  await new Promise<void>(resolve => stderr.end(resolve));
  if (!closed) {
    sendControl(ws, { exit: result.exitCode });
    ws.close();
  }
}

async function serveLogs(ws: WebSocket, id: string, url: URL, opts: StreamOptions): Promise<void> {
  await opts.guard.container(id);
  const follow = url.searchParams.get('follow') === '1';
  const tailParam = url.searchParams.get('tail');
  const tail = tailParam === null ? undefined : Number(tailParam);
  const controller = new AbortController();
  ws.on('close', () => controller.abort());
  await opts.backend.logs(id, {
    follow,
    tail,
    signal: controller.signal,
    onLine: (stream, line) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ stream, line }));
    },
  });
  ws.close();
}

async function serveEvents(ws: WebSocket, url: URL, opts: StreamOptions): Promise<void> {
  const filter = parseLabelQuery(url.searchParams);
  opts.guard.filter(filter);
  const controller = new AbortController();
  ws.on('close', () => controller.abort());
  await opts.backend.events(filter, e => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  }, controller.signal);
  // The backend resolved: either the client left (aborted) or the stream ended on its own
  if (!controller.signal.aborted) {
    sendControl(ws, { error: 'event stream ended' });
    ws.close();
  }
}

/** Installs the WebSocket routes on the server's listener; the result ends every open socket. */
export function attachWebSockets(server: http.Server, opts: StreamOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://kunj.invalid');
    if (!tokenMatches(bearerOf(req), opts.token)) {
      opts.log(`unauthorized upgrade from ${req.socket.remoteAddress ?? '?'}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
    const route = (() => {
      if (segments[0] !== 'v1') return undefined;
      if (segments.length === 4 && segments[1] === 'containers' && segments[3] === 'exec') return { kind: 'exec' as const, id: segments[2] };
      if (segments.length === 4 && segments[1] === 'containers' && segments[3] === 'logs') return { kind: 'logs' as const, id: segments[2] };
      if (segments.length === 2 && segments[1] === 'events') return { kind: 'events' as const, id: '' };
      return undefined;
    })();
    if (!route) {
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const started = Date.now();
      const what = `${route.kind} ${url.pathname}`;
      const done = (status: string) => opts.log(`WS ${url.pathname} ${status} ${Date.now() - started}ms`);
      const run =
        route.kind === 'exec' ? serveExec(ws, route.id, opts)
        : route.kind === 'logs' ? serveLogs(ws, route.id, url, opts)
        : serveEvents(ws, url, opts);
      run.then(() => done('ok'), err => {
        closeWithError(ws, err, opts.log, what);
        done('error');
      });
    });
  });
  // Upgraded sockets are not the http server's connections any more, so close() must end them itself
  return { close: () => wss.clients.forEach(ws => ws.terminate()) };
}

// ---- chunked bodies ----------------------------------------------------------------------------

/** POST /v1/containers/:id/copy?dir=…: the body is the tar. */
export async function serveCopyIn(req: http.IncomingMessage, id: string, url: URL, opts: StreamOptions): Promise<unknown> {
  const dir = url.searchParams.get('dir');
  if (!dir) throw new ServeError(400, 'bad-request', 'copy needs ?dir=');
  await opts.guard.container(id);
  await opts.backend.copyIn(id, dir, req);
  return {};
}

/** POST /v1/images/:tag/build: the body is the build context, the options in x-kunj-build. */
export async function serveBuild(req: http.IncomingMessage, tag: string, opts: StreamOptions): Promise<unknown> {
  opts.guard.image(tag);
  const header = req.headers['x-kunj-build'];
  let build: BuildOptions = {};
  if (typeof header === 'string' && header) {
    try {
      build = JSON.parse(header);
    } catch {
      throw new ServeError(400, 'bad-request', 'x-kunj-build is not JSON');
    }
  }
  await opts.backend.buildImage(tag, req, build);
  return {};
}
