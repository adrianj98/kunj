import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { bindLifetime, controlPath, openTunnel, sshArgs } from '../tunnel';

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

// A stand-in for ssh with connection sharing: -O check/forward/cancel against a "master" kept as a
// file, each forward a detached node forwarder; a ControlMaster=yes start makes the master (and
// fails for nomaster@box); a plain -N -L run is the per-process tunnel. Every run is logged.
const fakeSharedSsh = (dir: string) => `
const net = require('net'), fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const dest = args[args.length - 1];
fs.appendFileSync(path.join(dir, 'log'), JSON.stringify(args) + '\\n');
const op = args.includes('-O') ? args[args.indexOf('-O') + 1] : null;
const spec = args.includes('-L') ? args[args.indexOf('-L') + 1] : null;
const master = path.join(dir, 'master-' + dest);
if (op === 'check') process.exit(fs.existsSync(master) ? 0 : 255);
if (args.includes('ControlMaster=yes')) {
  if (dest === 'nomaster@box') process.exit(255);
  fs.writeFileSync(master, '');
  process.exit(0);
}
const [, lport, , rport] = (spec || '').split(':');
const forwarder = "const net=require('net');net.createServer(s=>{const t=net.connect(" + rport + ",'127.0.0.1');s.pipe(t).pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy())}).listen(" + lport + ",'127.0.0.1')";
if (op === 'forward') {
  const child = cp.spawn(process.execPath, ['-e', forwarder], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'fwd-' + lport), String(child.pid));
  child.unref();
  process.exit(0);
}
if (op === 'cancel') {
  const f = path.join(dir, 'fwd-' + lport);
  try { process.kill(Number(fs.readFileSync(f, 'utf8'))); fs.rmSync(f); } catch {}
  process.exit(0);
}
cp.spawn(process.execPath, ['-e', forwarder], { stdio: 'inherit' });
process.on('SIGTERM', () => process.exit(0));
`;

describe('openTunnel, shared', () => {
  let dir: string;
  let sshPath: string;
  let target: net.Server;
  let targetPort: number;
  const log = () => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]);
  const read = (port: number) => new Promise<string>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', d => (out += d));
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-shared-'));
    sshPath = path.join(dir, 'ssh');
    fs.writeFileSync(sshPath, `#!${process.execPath}\n${fakeSharedSsh(dir)}`, { mode: 0o755 });
    target = net.createServer(s => s.end('hello from the box'));
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    for (const f of fs.readdirSync(dir).filter(f => f.startsWith('fwd-'))) {
      try { process.kill(Number(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* gone */ }
    }
    await new Promise<void>(r => target.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts one master for two tunnels at once, gives each its own forward, and cancels them on close', async () => {
    const controlDir = path.join(dir, 'ctl');
    const [a, b] = await Promise.all([
      openTunnel({ ssh: 'me@box', port: targetPort, sshPath, share: true, controlDir }),
      openTunnel({ ssh: 'me@box', port: targetPort, sshPath, share: true, controlDir }),
    ]);
    expect(a.localPort).not.toBe(b.localPort);
    expect(await read(a.localPort)).toBe('hello from the box');
    expect(await read(b.localPort)).toBe('hello from the box');
    expect(log().filter(args => args.includes('ControlMaster=yes'))).toHaveLength(1);
    expect(log().some(args => args.includes(`ControlPath=${controlPath(controlDir, 'me@box')}`))).toBe(true);
    await a.close();
    await b.close();
    expect(log().filter(args => args.includes('cancel'))).toHaveLength(2);
    expect(fs.readdirSync(dir).filter(f => f.startsWith('fwd-'))).toEqual([]);
  });

  it('a master that cannot log in is an error, remembered so the next command fails at once without trying', async () => {
    const controlDir = path.join(dir, 'ctl');
    await expect(openTunnel({ ssh: 'nomaster@box', port: targetPort, sshPath, share: true, controlDir })).rejects.toThrow(/ended before the tunnel was up/);
    const starts = () => log().filter(args => args.includes('ControlMaster=yes')).length;
    expect(starts()).toBe(1);
    await expect(openTunnel({ ssh: 'nomaster@box', port: targetPort, sshPath, share: true, controlDir })).rejects.toThrow(/ended before the tunnel was up/);
    expect(starts()).toBe(1);
    // and no per-process ssh behind it
    expect(log().some(args => args[0] === '-N')).toBe(false);
  });
});
