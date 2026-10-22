import * as net from 'net';
import { findFreePort, forwardPort, parseForwardSpec, tunnelCommand } from '../forward';
import { FakeBackend } from './fake-backend';

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** Connects, writes `text`, half-closes and resolves with everything received. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.end(text));
    socket.on('data', d => chunks.push(d));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
  });
}

describe('parseForwardSpec', () => {
  it('parses a container port', () => {
    expect(parseForwardSpec('3000')).toEqual({ container: 3000 });
  });

  it('parses a host:container pair', () => {
    expect(parseForwardSpec('8080:3000')).toEqual({ host: 8080, container: 3000 });
  });

  it.each(['abc', '0', '65536', '1:2:3', '', '30a0', '8080:'])('rejects %p', text => {
    expect(() => parseForwardSpec(text)).toThrow(
      `Invalid port "${text}": expected <port> or <hostPort>:<port>`,
    );
  });
});

describe('findFreePort', () => {
  it('findFreePort returns preferred when free and another when taken', async () => {
    const probe = await listen(0);
    const port = (probe.address() as net.AddressInfo).port;
    await closeServer(probe);
    expect(await findFreePort(port)).toBe(port);

    const taken = await listen(port);
    try {
      const other = await findFreePort(port);
      expect(other).not.toBe(port);
      expect(other).toBeGreaterThan(0);
    } finally {
      await closeServer(taken);
    }
  });
});

describe('tunnelCommand', () => {
  it('uses socat when available', () => {
    expect(tunnelCommand(3000, true)).toEqual(['socat', '-t', '10', '-', 'TCP:127.0.0.1:3000']);
  });

  it('falls back to bash /dev/tcp', () => {
    expect(tunnelCommand(3000, false)).toEqual([
      'bash',
      '-c',
      'exec 3<>/dev/tcp/127.0.0.1/3000; cat <&3 & cat >&3; kill $! 2>/dev/null',
    ]);
  });
});

describe('forwardPort', () => {
  it('forwardPort pipes bytes through the backend exec', async () => {
    const backend = new FakeBackend();
    backend.echoUpper = true;
    let connections = 0;
    const forwarder = await forwardPort(backend, 'ctr-1', { container: 3000, host: 0 }, {
      hasSocat: true,
      onConnection: () => connections++,
    });
    try {
      expect(await roundTrip(forwarder.hostPort, 'hello')).toBe('HELLO');
      expect(connections).toBe(1);
      const [[id, cmd]] = backend.callsOf('exec');
      expect(id).toBe('ctr-1');
      expect(cmd).toEqual(tunnelCommand(3000, true));
      expect(backend.stdinData).toEqual(['hello']);
    } finally {
      await forwarder.close();
    }
  });

  it('close() stops accepting', async () => {
    const backend = new FakeBackend();
    const forwarder = await forwardPort(backend, 'ctr-1', { container: 3000, host: 0 }, { hasSocat: true });
    await forwarder.close();
    await expect(roundTrip(forwarder.hostPort, 'x')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('close() ends connections that are still open', async () => {
    const backend = new FakeBackend();
    const forwarder = await forwardPort(backend, 'ctr-1', { container: 3000, host: 0 }, { hasSocat: true });
    const closed = new Promise<void>((resolve, reject) => {
      const socket = net.connect(forwarder.hostPort, '127.0.0.1', async () => {
        while (backend.callsOf('exec').length === 0) await new Promise(r => setImmediate(r));
        await forwarder.close();
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve());
      setTimeout(() => reject(new Error('socket stayed open')), 2000).unref();
    });
    await closed;
  });

  it('a socket error does not crash the process', async () => {
    const backend = new FakeBackend();
    backend.echoUpper = true;
    const forwarder = await forwardPort(backend, 'ctr-1', { container: 3000, host: 0 }, { hasSocat: true });
    try {
      await new Promise<void>(resolve => {
        const socket = net.connect(forwarder.hostPort, '127.0.0.1', () => {
          socket.write('partial');
          socket.resetAndDestroy();
        });
        socket.on('error', () => {});
        socket.on('close', () => resolve());
      });
      while (backend.callsOf('exec').length === 0) await new Promise(r => setImmediate(r));
      expect(await roundTrip(forwarder.hostPort, 'again')).toBe('AGAIN');
    } finally {
      await forwarder.close();
    }
  });
});
