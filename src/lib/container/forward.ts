// `kunj container forward`: a 127.0.0.1 listener on the host whose connections are tunnelled into
// the container through `docker exec -i … socat`, so no port is published on the container.
import * as net from 'net';
import { PassThrough } from 'stream';
import { ContainerBackend } from './backend';

export interface ForwardSpec {
  container: number;
  host?: number;
}

export interface Forwarder {
  hostPort: number;
  close(): Promise<void>;
}

function parsePort(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** '3000' forwards the same port; '8080:3000' forwards host 8080 to container 3000. */
export function parseForwardSpec(text: string): ForwardSpec {
  const parts = text.split(':');
  const ports = parts.map(parsePort);
  if (parts.length <= 2 && ports.every(p => p !== undefined)) {
    return ports.length === 1 ? { container: ports[0]! } : { host: ports[0]!, container: ports[1]! };
  }
  throw new Error(`Invalid port "${text}": expected <port> or <hostPort>:<port>`);
}

const NEXT_FREE_TRIES = 100;

/**
 * Listens on 127.0.0.1:preferred, or when that one is taken on the next free port above it
 * (`nextFree`, up to 100 tries) or an OS-assigned one.
 */
function listenLocal(server: net.Server, preferred: number, nextFree = false): Promise<number> {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  const next = (port: number) => (nextFree && port < Math.min(preferred + NEXT_FREE_TRIES, 65535) ? port + 1 : 0);
  const tryFrom = (port: number): Promise<number> =>
    attempt(port).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE' || port === 0) throw err;
      return tryFrom(next(port));
    });
  return tryFrom(preferred);
}

/** `preferred` when it is free on 127.0.0.1, else a port the OS picks. */
export async function findFreePort(preferred: number): Promise<number> {
  const probe = net.createServer();
  const port = await listenLocal(probe, preferred);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

export type TunnelTool = 'socat' | 'bash' | 'nc';

/** Prints the first of socat, bash and nc the container has (nothing when it has none). */
export const TUNNEL_PROBE = 'for t in socat bash nc; do command -v $t >/dev/null 2>&1 && { echo $t; exit 0; }; done; exit 1';

export function parseTunnelProbe(stdout: string): TunnelTool | null {
  const tool = stdout.trim().split('\n')[0];
  return tool === 'socat' || tool === 'bash' || tool === 'nc' ? tool : null;
}

/**
 * The command run in the container for one connection: it copies its stdin to 127.0.0.1:<port>
 * and the replies to stdout. The bash fallback (images without socat) cannot half-close: when the
 * client finishes sending it stops reading replies too. `true` and `false` mean socat and bash.
 */
export function tunnelCommand(port: number, tool: boolean | TunnelTool): string[] {
  const t = tool === true ? 'socat' : tool === false ? 'bash' : tool;
  if (t === 'socat') return ['socat', '-t', '10', '-', `TCP:127.0.0.1:${port}`];
  if (t === 'nc') return ['nc', '127.0.0.1', String(port)];
  return ['bash', '-c', `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3 & cat >&3; kill $! 2>/dev/null`];
}

export async function forwardPort(
  backend: ContainerBackend,
  containerId: string,
  spec: ForwardSpec,
  /** nextFree: when the host port is taken use the next free one above it, not any port */
  opts: { hasSocat: boolean; tool?: TunnelTool; nextFree?: boolean; onConnection?: () => void },
): Promise<Forwarder> {
  const sockets = new Set<net.Socket>();
  const command = tunnelCommand(spec.container, opts.tool ?? opts.hasSocat);

  // allowHalfOpen: a client that finishes sending still gets the container's replies.
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // The backend attaches no error listener to a stream given as stdin; a reset client must not
    // become an uncaught exception.
    socket.on('error', () => socket.destroy());
    opts.onConnection?.();

    const stderr = new PassThrough();
    stderr.resume();
    // stdout is piped without ending the socket, so end it here once the exec is over, letting the
    // last replies flush before the socket is torn down.
    const finish = () => {
      if (socket.destroyed) return;
      socket.end(() => socket.destroy());
    };
    // pipe() ends exec's stdin only on the socket's 'end'; a reset or destroyed socket never
    // emits it, which would leave docker exec and socat running. Ending stdin on 'close' covers both.
    const stdin = new PassThrough();
    socket.pipe(stdin);
    socket.on('close', () => {
      socket.unpipe(stdin);
      if (!stdin.writableEnded) stdin.end();
    });
    backend.exec(containerId, command, { stdin, stdout: socket, stderr }).then(finish, finish);
  });

  const hostPort = await listenLocal(server, spec.host ?? spec.container, opts.nextFree);

  return {
    hostPort,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
