import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { bindLifetime, openTunnel, sshArgs } from '../tunnel';

// A stand-in for ssh: reads the -L spec, listens on the local port and forwards to the target
// (or, told to, prints an error and exits). Written as a script so the tunnel spawns it like ssh.
const FAKE_SSH = `
const net = require('net');
const args = process.argv.slice(2);
const spec = args[args.indexOf('-L') + 1];
const dest = args[args.length - 1];
process.stderr.write('fake ssh ' + JSON.stringify(args) + '\\n');
if (dest === 'down@box') { process.stderr.write('ssh: connect to host box port 22: Connection refused\\n'); process.exit(255); }
if (dest === 'slow@box') { setTimeout(() => {}, 1 << 30); return; }
const [, lport, , rport] = spec.split(':');
const server = net.createServer(s => { const t = net.connect(Number(rport), '127.0.0.1'); s.pipe(t).pipe(s); s.on('error', () => t.destroy()); t.on('error', () => s.destroy()); });
setTimeout(() => server.listen(Number(lport), '127.0.0.1'), 150);
process.on('SIGTERM', () => process.exit(0));
`;

describe('bindLifetime', () => {
  it('kills on a signal, steps aside and re-raises when no other handler is installed', () => {
    const before = process.listenerCount('SIGTERM');
    const kill = jest.fn();
    const reRaise = jest.fn();
    bindLifetime(kill, reRaise);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    process.emit('SIGTERM', 'SIGTERM');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(reRaise).toHaveBeenCalledWith(before === 0 ? 'SIGTERM' : expect.anything());
  });

  it('does not re-raise when another handler owns the signal, and release() removes everything', () => {
    const other = jest.fn();
    process.on('SIGHUP', other);
    const kill = jest.fn();
    const reRaise = jest.fn();
    const release = bindLifetime(kill, reRaise);
    process.emit('SIGHUP', 'SIGHUP');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    expect(reRaise).not.toHaveBeenCalled();
    process.off('SIGHUP', other);

    const exitBefore = process.listenerCount('exit');
    const release2 = bindLifetime(jest.fn(), reRaise);
    expect(process.listenerCount('exit')).toBe(exitBefore + 1);
    release2();
    release();
    expect(process.listenerCount('exit')).toBe(exitBefore);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});

describe('openTunnel', () => {
  let dir: string;
  let sshPath: string;
  let target: net.Server;
  let targetPort: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-tunnel-'));
    sshPath = path.join(dir, 'ssh');
    fs.writeFileSync(sshPath, `#!${process.execPath}\n${FAKE_SSH}`, { mode: 0o755 });
    target = net.createServer(s => s.end('hello from the box'));
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(r => target.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds the ssh argv with the forward and no shell', () => {
    expect(sshArgs({ ssh: 'me@box', port: 7433, localPort: 51234 })).toEqual([
      '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', '127.0.0.1:51234:127.0.0.1:7433', '--', 'me@box',
    ]);
  });

  it('is up once the local port accepts, forwards to the box, and close() ends ssh', async () => {
    const tunnel = await openTunnel({ ssh: 'me@box', port: targetPort, sshPath });
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const s = net.connect(tunnel.localPort, '127.0.0.1');
      s.on('data', d => chunks.push(d));
      s.on('end', () => resolve(Buffer.concat(chunks).toString()));
      s.on('error', reject);
    });
    expect(text).toBe('hello from the box');
    expect(tunnel.pid).toBeGreaterThan(0);
    await tunnel.close();
    expect(() => process.kill(tunnel.pid, 0)).toThrow();
  });

  it('reports ssh ending before the tunnel is up, with its first stderr line', async () => {
    await expect(openTunnel({ ssh: 'down@box', port: 7433, sshPath })).rejects.toThrow(
      /ssh to down@box ended before the tunnel was up: fake ssh .*is kunj serve listening on 127\.0\.0\.1:7433 there/,
    );
  });

  it('gives up after the timeout and kills ssh', async () => {
    await expect(openTunnel({ ssh: 'slow@box', port: 7433, sshPath, timeoutMs: 400 })).rejects.toThrow(/did not bring the tunnel up within 0 s/);
  });

  it('reports a missing ssh binary', async () => {
    await expect(openTunnel({ ssh: 'me@box', port: 7433, sshPath: path.join(dir, 'nope') })).rejects.toThrow(/Could not run .*nope/);
  });
});
