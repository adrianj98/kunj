// The coordinator's proxy (docs/specs/cloud-machines.md): a request to
// /v1/machines/<name>/serve/v1/<route> is passed to that machine's own kunj serve as /v1/<route>,
// with the coordinator's token for the machine in place of the client's. Bodies and WebSocket
// frames are piped as bytes, never parsed and never logged.

import * as http from 'http';
import * as net from 'net';
import { Duplex } from 'stream';
import { ServeError } from './protocol';

export interface ProxyTarget {
  host: string;
  port: number;
  /** The machine's serve token */
  token: string;
  /** Called once the exchange ends; `failed` when the machine could not be reached */
  done(failed: boolean): void;
}

/** Resolves a machine name to where its serve answers; throws a ServeError (machine-asleep…) */
export type ProxyResolver = (name: string) => Promise<ProxyTarget>;

const PROXY_PATH = /^\/v1\/machines\/([a-z][-a-z0-9]{0,62})\/serve(\/v1\/.*)$/;

/** `{ name, path }` when the path addresses a machine's serve. */
export function proxyRoute(pathname: string): { name: string; path: string } | null {
  const m = PROXY_PATH.exec(pathname);
  return m ? { name: m[1], path: m[2] } : null;
}

// Hop-by-hop headers and the client's credentials stay on this side
const DROP = new Set(['host', 'authorization', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

export function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, target: ProxyTarget, path: string): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k) && v !== undefined) headers[k] = v;
  headers.authorization = `Bearer ${target.token}`;
  let finished = false;
  const finish = (failed: boolean) => {
    if (finished) return;
    finished = true;
    target.done(failed);
  };
  const upstream = http.request({ host: target.host, port: target.port, method: req.method, path, headers }, up => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
    up.on('end', () => finish(false));
    up.on('error', () => finish(true));
  });
  upstream.on('error', (err: NodeJS.ErrnoException) => {
    finish(true);
    if (res.headersSent) return res.destroy();
    const text = JSON.stringify({ error: { code: 'machine-asleep', message: `The machine does not answer (${err.code ?? err.message}); it may be asleep or still starting.` } });
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
  res.on('close', () => {
    upstream.destroy();
    finish(false);
  });
  req.pipe(upstream);
}

/** Passes a WebSocket upgrade through as raw bytes; resolves when both ends are closed. */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget, path: string): void {
  let finished = false;
  let connected = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    target.done(!connected);
  };
  const up = net.connect(target.port, target.host);
  up.on('connect', () => {
    connected = true;
    const lines = [`${req.method} ${path} HTTP/1.1`, `Host: ${target.host}:${target.port}`, `Authorization: Bearer ${target.token}`, 'Connection: Upgrade', 'Upgrade: websocket'];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!DROP.has(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => {
    if (!connected) socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    socket.destroy();
    finish();
  });
  up.on('close', () => {
    socket.destroy();
    finish();
  });
  socket.on('error', () => up.destroy());
  socket.on('close', () => {
    up.destroy();
    finish();
  });
}

/** A resolver's MachineError-like failure as the HTTP refusal of an upgrade. */
export function refuseUpgrade(socket: Duplex, err: unknown): void {
  const status = err instanceof ServeError ? err.status : 502;
  const text = JSON.stringify({ error: { code: err instanceof ServeError ? err.code : 'backend', message: err instanceof Error ? err.message : String(err) } });
  socket.write(`HTTP/1.1 ${status} Refused\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  socket.destroy();
}
