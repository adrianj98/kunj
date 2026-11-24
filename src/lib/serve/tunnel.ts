// The SSH tunnel to a remote added with --ssh. The server on the box listens on its loopback, so the
// laptop reaches it only through this. SSH does the encryption, the host identity and the user's keys;
// a prompt (passphrase, unknown host) shows on this process's stdin when it has a terminal, which is
// why `kunj remote add --ssh` suggests one interactive ping first.
//
// Shared (the default with the real ssh): one master connection per destination, kept by ssh itself
// (`ControlMaster`, `ControlPersist` 10 min after its last use) behind a control socket in
// ~/.kunj/ssh, and every kunj process adds its own forward to it (`ssh -O forward -L`) and removes it
// on close or exit (`-O cancel`). A connection costs a login and, behind a ProxyCommand such as
// `gcloud compute start-iap-tunnel`, a helper process: one per process left dozens of them alive at
// once when the workspace app listed often. Without a master (it could not start) a process falls back
// to its own `ssh -N -L <free local port>:127.0.0.1:<port> <destination>`, ended with the process.

import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
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
  /**
   * Share one master connection per destination (default: true with the real ssh, false when a test
   * gives sshPath); `controlDir` holds the control sockets (default ~/.kunj/ssh).
   */
  share?: boolean;
  controlDir?: string;
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

const LIFETIME_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Ends the tunnel with this process: on 'exit', and on the signals that end a process without an
 * 'exit' event when nothing handles them. A signal handler of ours kills ssh, steps aside and, when
 * no other handler is installed, re-raises the signal so the default action still happens
 * (SIGKILL cannot be caught: that one orphans ssh). Returns the release for a normal close().
 */
export function bindLifetime(kill: () => void, reRaise: (signal: NodeJS.Signals) => void = s => process.kill(process.pid, s)): () => void {
  const onExit = () => kill();
  const handlers = new Map<NodeJS.Signals, () => void>();
  const release = () => {
    process.off('exit', onExit);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
  process.once('exit', onExit);
  for (const signal of LIFETIME_SIGNALS) {
    const handler = () => {
      release();
      kill();
      if (process.listenerCount(signal) === 0) reRaise(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return release;
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

interface TunnelMessages {
  /** spawn failed (ENOENT…) */
  spawnFailed(err: Error): ContainerError;
  /** the process exited before the port accepted */
  exitedEarly(detail: string): ContainerError;
  /** the port did not accept in time */
  timedOut(seconds: number, detail: string): ContainerError;
}

/** Runs `cmd args`, which listens on 127.0.0.1:localPort, and waits until that port accepts. */
async function spawnTunnel(cmd: string, args: string[], localPort: number, timeoutMs: number, messages: TunnelMessages): Promise<Tunnel> {
  const stderr: string[] = [];
  const child: ChildProcess = spawn(cmd, args, {
    // stdin stays ours so ssh (or gcloud) can ask (a passphrase, a new host key) when there is a terminal
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
  const release = bindLifetime(kill);

  const firstLine = () => stderr.join('').trim().split('\n').find(l => l.trim()) ?? '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (spawnError) {
      release();
      throw messages.spawnFailed(spawnError);
    }
    if (exited) {
      release();
      throw messages.exitedEarly(firstLine());
    }
    if (await accepts(localPort)) break;
    if (Date.now() >= deadline) {
      kill();
      release();
      // ssh's own helper (a ProxyCommand) may outlive it holding this pipe: neither may keep the command alive
      child.stderr?.destroy();
      child.unref();
      throw messages.timedOut(Math.round(timeoutMs / 1000), firstLine());
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
      release();
      kill();
      await exit;
    },
  };
}

/** How long ssh keeps a shared master after its last use */
export const CONTROL_PERSIST = '10m';

/** The control socket of a destination: short (a unix socket path is limited to about 100 bytes). */
export function controlPath(dir: string, destination: string): string {
  return path.join(dir, crypto.createHash('sha256').update(destination).digest('hex').slice(0, 16));
}

/** Runs ssh to completion (argv only), within `timeoutMs`. */
function runSsh(ssh: string, args: string[], timeoutMs: number, stdin: 'inherit' | 'ignore' = 'ignore'): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(ssh, args, { stdio: [stdin, 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, stderr: err.message }); });
    // a master that went to the background (-f) keeps the pipe: it must not keep this process alive
    child.on('exit', code => { clearTimeout(timer); child.stderr?.destroy(); resolve({ code, stderr }); });
  });
}

/** How long a destination whose master could not start is reported down without trying again */
export const DOWN_FOR_MS = 30_000;

/**
 * A forward on the destination's shared master, starting the master when none answers (one starter
 * at a time: a lock file next to the socket). A master that could not log in is an error, remembered
 * for `DOWN_FOR_MS` (`<socket>.down`) so the commands that follow fail at once instead of each
 * trying for a minute (an IAP ProxyCommand to a stopped box takes that long). Null when sharing is not
 * possible here; the caller then opens its own connection.
 */
async function openShared(opts: TunnelOptions, ssh: string, localPort: number, unreachable: (detail: string) => Error): Promise<Tunnel | null> {
  const dir = opts.controlDir ?? path.join(os.homedir(), '.kunj', 'ssh');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  const ctl = controlPath(dir, opts.ssh);
  const control = ['-o', `ControlPath=${ctl}`];
  const down = `${ctl}.down`;
  const recentlyDown = (): string | null => {
    try {
      if (Date.now() - fs.statSync(down).mtimeMs < DOWN_FOR_MS) return fs.readFileSync(down, 'utf8').trim();
    } catch { /* not down */ }
    return null;
  };
  const alive = async () => (await runSsh(ssh, [...control, '-O', 'check', '--', opts.ssh], 10_000)).code === 0;
  const timeoutMs = opts.timeoutMs ?? 120000;

  if (!(await alive())) {
    const known = recentlyDown();
    if (known !== null) throw unreachable(known);
    const lock = `${ctl}.lock`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let mine = false;
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
        mine = true;
      } catch {
        // another process is starting it; a lock older than the wait is from one that died
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > timeoutMs) fs.rmSync(lock, { force: true });
        } catch { /* gone meanwhile */ }
      }
      if (mine) {
        try {
          if (!(await alive())) {
            // a socket that does not answer is left from a master that died (a reboot, a kill): ssh
            // will not replace it (ControlMaster=yes would run without sharing), so it goes first
            fs.rmSync(ctl, { force: true });
            // -f: ssh goes to the background once logged in (prompts first, on this terminal)
            const started = await runSsh(ssh, [
              ...control, '-o', 'ControlMaster=yes', '-o', `ControlPersist=${CONTROL_PERSIST}`,
              '-o', 'ServerAliveInterval=30', '-N', '-f', '--', opts.ssh,
            ], timeoutMs, 'inherit');
            if (started.code !== 0 || !(await alive())) {
              const detail = started.stderr.trim().split('\n').find(l => l.trim()) ?? '';
              try { fs.writeFileSync(down, detail, { mode: 0o600 }); } catch { /* not remembered */ }
              throw unreachable(detail);
            }
            fs.rmSync(down, { force: true });
          }
        } finally {
          fs.rmSync(lock, { force: true });
        }
        break;
      }
      if (await alive()) break;
      // the starter failed meanwhile: its reason, not another try
      const failed = recentlyDown();
      if (failed !== null) throw unreachable(failed);
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  const spec = `127.0.0.1:${localPort}:127.0.0.1:${opts.port}`;
  const added = await runSsh(ssh, [...control, '-O', 'forward', '-L', spec, '--', opts.ssh], 30_000);
  if (added.code !== 0) return null;
  // Removed on close and when this process ends (a SIGKILL leaves it until the master ends)
  let cancelled = false;
  const cancelSync = () => {
    if (cancelled) return;
    cancelled = true;
    spawnSync(ssh, [...control, '-O', 'cancel', '-L', spec, '--', opts.ssh], { stdio: 'ignore', timeout: 5000 });
  };
  const release = bindLifetime(cancelSync);
  const deadline = Date.now() + 10_000;
  while (!(await accepts(localPort))) {
    if (Date.now() >= deadline) {
      release();
      cancelSync();
      return null;
    }
    await new Promise(r => setTimeout(r, READY_POLL_MS));
  }
  return {
    localPort,
    pid: 0,
    close: async () => {
      release();
      if (cancelled) return;
      cancelled = true;
      await runSsh(ssh, [...control, '-O', 'cancel', '-L', spec, '--', opts.ssh], 5000);
    },
  };
}

export async function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const localPort = opts.localPort ?? (await findFreePort(0));
  const ssh = opts.sshPath ?? 'ssh';
  const share = opts.share ?? (opts.sshPath === undefined && process.platform !== 'win32');
  const exitedEarly = (detail: string) =>
    new ContainerError(
      `ssh to ${opts.ssh} ended before the tunnel was up${detail ? `: ${detail}` : ''}` +
        ` (is kunj serve listening on 127.0.0.1:${opts.port} there? try: ssh ${opts.ssh} kunj serve token).`,
      'remote-unreachable',
    );
  if (share) {
    const shared = await openShared(opts, ssh, localPort, exitedEarly).catch(err => {
      if (err instanceof ContainerError) throw err;
      return null;
    });
    if (shared) return shared;
  }
  return spawnTunnel(ssh, sshArgs({ ssh: opts.ssh, port: opts.port, localPort }), localPort, opts.timeoutMs ?? 120000, {
    spawnFailed: err => new ContainerError(`Could not run ${ssh}: ${err.message}. Install OpenSSH and make sure ssh is on your PATH.`, 'bad-remote'),
    exitedEarly,
    timedOut: (seconds, detail) =>
      new ContainerError(
        `ssh to ${opts.ssh} did not bring the tunnel up within ${seconds} s${detail ? `: ${detail}` : ''}.` +
          ` Check that ssh ${opts.ssh} logs in from a terminal without a prompt (host key, passphrase).`,
        'bad-remote',
      ),
  });
}

/**
 * A tunnel from any port forwarder a machine provider names (`gcloud compute start-iap-tunnel …`,
 * `aws ssm start-session …`): `argv` must listen on 127.0.0.1:localPort.
 */
export async function openCommandTunnel(opts: { argv: string[]; localPort: number; describe: string; timeoutMs?: number }): Promise<Tunnel> {
  const [cmd, ...args] = opts.argv;
  return spawnTunnel(cmd, args, opts.localPort, opts.timeoutMs ?? 120000, {
    spawnFailed: err => new ContainerError(`Could not run ${cmd} for ${opts.describe}: ${err.message}. Install it and make sure it is on your PATH.`, 'remote-unreachable'),
    exitedEarly: detail => new ContainerError(`${cmd} ended before ${opts.describe} was up${detail ? `: ${detail}` : ''}.`, 'remote-unreachable'),
    timedOut: (seconds, detail) => new ContainerError(`${opts.describe} did not come up within ${seconds} s${detail ? `: ${detail}` : ''}.`, 'remote-unreachable'),
  });
}
