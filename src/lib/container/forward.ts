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

/** Listens on 127.0.0.1:preferred, or on an OS-assigned port when that one is taken. */
function listenLocal(server: net.Server, preferred: number): Promise<number> {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  return attempt(preferred).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    return attempt(0);
  });
}

/** `preferred` when it is free on 127.0.0.1, else a port the OS picks. */
export async function findFreePort(preferred: number): Promise<number> {
  const probe = net.createServer();
  const port = await listenLocal(probe, preferred);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

/**
 * The command run in the container for one connection: it copies its stdin to 127.0.0.1:<port>
 * and the replies to stdout. The bash fallback (images without socat) cannot half-close: when the
 * client finishes sending it stops reading replies too.
 */
export function tunnelCommand(port: number, hasSocat: boolean): string[] {
  if (hasSocat) return ['socat', '-t', '10', '-', `TCP:127.0.0.1:${port}`];
  return ['bash', '-c', `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3 & cat >&3; kill $! 2>/dev/null`];
}

export async function forwardPort(
  backend: ContainerBackend,
  containerId: string,
  spec: ForwardSpec,
  opts: { hasSocat: boolean; onConnection?: () => void },
): Promise<Forwarder> {
  const sockets = new Set<net.Socket>();
  const command = tunnelCommand(spec.container, opts.hasSocat);

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
    backend.exec(containerId, command, { stdin: socket, stdout: socket, stderr }).then(finish, finish);
  });

  const hostPort = await listenLocal(server, spec.host ?? spec.container);

  return {
    hostPort,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
