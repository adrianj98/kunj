// The SSH tunnel to a remote added with --ssh: `ssh -N -L <free local port>:127.0.0.1:<port>
// <destination>`, one per kunj process, ended when the process exits. The server on the box listens
// on its loopback, so the laptop reaches it only through this. SSH does the encryption, the host
// identity and the user's keys; a prompt (passphrase, unknown host) shows on this process's stdin
// when it has a terminal, which is why `kunj remote add --ssh` suggests one interactive ping first.

import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import { ContainerError } from '../container/errors';
import { findFreePort } from '../container/forward';

export interface TunnelOptions {
  /** user@host (or host) */
  ssh: string;
  /** The server's port on the box */
  port: number;
  /** The ssh binary (tests give a script) */
  sshPath?: string;
  /** How long to wait for the forward to accept connections; prompts need time (default 120 s) */
  timeoutMs?: number;
  /** A fixed local port (tests); default: a free one */
  localPort?: number;
}

export interface Tunnel {
  localPort: number;
  pid: number;
  close(): Promise<void>;
}

const READY_POLL_MS = 100;

/** Resolves when 127.0.0.1:port accepts a connection (ssh listens once the session is up). */
function accepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export function sshArgs(opts: { ssh: string; port: number; localPort: number }): string[] {
  return [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-L', `127.0.0.1:${opts.localPort}:127.0.0.1:${opts.port}`,
    '--',
    opts.ssh,
  ];
}

export async function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const localPort = opts.localPort ?? (await findFreePort(0));
  const timeoutMs = opts.timeoutMs ?? 120000;
  const stderr: string[] = [];
  const child: ChildProcess = spawn(opts.sshPath ?? 'ssh', sshArgs({ ssh: opts.ssh, port: opts.port, localPort }), {
    // stdin stays ours so ssh can ask (a passphrase, a new host key) when there is a terminal
    stdio: ['inherit', 'ignore', 'pipe'],
  });
  child.stderr!.on('data', (d: Buffer) => {
    if (stderr.length < 20) stderr.push(d.toString());
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exit = new Promise<void>(resolve => {
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      resolve();
    });
    child.on('error', () => resolve());
  });
  let spawnError: Error | undefined;
  child.on('error', err => (spawnError = err));
  const kill = () => {
    if (!exited) child.kill('SIGTERM');
  };
  process.once('exit', kill);

  const firstLine = () => stderr.join('').trim().split('\n').find(l => l.trim()) ?? '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (spawnError) {
      process.off('exit', kill);
      throw new ContainerError(`Could not run ${opts.sshPath ?? 'ssh'}: ${spawnError.message}`, 'bad-remote');
    }
    if (exited) {
      process.off('exit', kill);
      const detail = firstLine();
      throw new ContainerError(
        `ssh to ${opts.ssh} ended before the tunnel was up${detail ? `: ${detail}` : ''}` +
          ` (is kunj serve listening on 127.0.0.1:${opts.port} there? try: ssh ${opts.ssh} kunj serve token)`,
        'remote-unreachable',
      );
    }
    if (await accepts(localPort)) break;
    if (Date.now() >= deadline) {
      kill();
      process.off('exit', kill);
      throw new ContainerError(`ssh to ${opts.ssh} did not bring the tunnel up within ${Math.round(timeoutMs / 1000)} s${firstLine() ? `: ${firstLine()}` : ''}`, 'bad-remote');
    }
    await new Promise(r => setTimeout(r, READY_POLL_MS));
  }

  // The tunnel must not keep a finished command alive: the process's exit kills it
  child.unref();
  (child.stderr as net.Socket).unref?.();

  return {
    localPort,
    pid: child.pid ?? 0,
    close: async () => {
      process.off('exit', kill);
      kill();
      await exit;
    },
  };
}
