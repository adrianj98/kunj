// Reaching a coordinator (docs/specs/cloud-machines.md): a cloud one named by --remote or
// container.remote, or the local one, which kunj starts on its own when machine.provider is set on
// this machine and none is running. The local coordinator is an ordinary `kunj serve --machines` on
// loopback; it writes its pid and port to coordinator.json and exits after an idle hour.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KunjConfig } from '../../types';
import { isAlive } from '../container/pidregistry';
import { DEFAULT_SERVE_PORT, requireRemote } from '../remotes';
import { coordinatorPaths, machineSettings } from './config';
import { MachineClient } from './client';
import { MachineError } from './provider';

export interface CoordinatorRecord {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

export function readRecord(file: string): CoordinatorRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(r?.pid) && r.pid > 0 && Number.isInteger(r?.port) && r.port > 0 && isAlive(r.pid)) return r as CoordinatorRecord;
  } catch {
    // missing or unreadable: no coordinator
  }
  return null;
}

export function writeRecord(file: string, record: CoordinatorRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Removes the record only when it is this process's (a newer coordinator may have replaced it). */
export function removeRecord(file: string, pid: number): void {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (r?.pid === pid) fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

export interface CoordinatorAccess {
  client: MachineClient;
  /** 'local' (this machine's auto-started coordinator) or the remote's name */
  name: string;
  kind: 'local' | 'remote';
  close(): Promise<void>;
}

export interface LocalCoordinatorDeps {
  /** ~/.kunj/coordinator (tests: a temp dir) */
  dir?: string;
  /** Starts the coordinator process (default: this kunj, detached, logging to serve.log) */
  start?: (argv: string[], logFile: string) => void;
  /** How long to wait for a started coordinator (default 20 s) */
  waitMs?: number;
}

/** The argv of this kunj: node and the CLI script it was started with. */
export function kunjArgv(): string[] {
  return [process.execPath, ...process.execArgv.filter(a => !a.startsWith('--inspect')), process.argv[1]];
}

function detachedStart(argv: string[], logFile: string): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logFile, 'a', 0o600);
  // From the home directory: outside a repository, so it reads only the global config
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', log, log], cwd: os.homedir(), env: process.env });
  child.unref();
  fs.closeSync(log);
}

function lastLines(file: string, n: number): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

/** The local coordinator: the running one when it answers, else a newly started one. */
export async function ensureLocalCoordinator(config: KunjConfig, deps: LocalCoordinatorDeps = {}): Promise<CoordinatorAccess> {
  const paths = coordinatorPaths(deps.dir);
  const settings = machineSettings(config);
  const tryRecord = async (): Promise<MachineClient | null> => {
    const record = readRecord(paths.record);
    if (!record) return null;
    let token: string;
    try {
      token = fs.readFileSync(paths.token, 'utf8').trim();
    } catch {
      return null;
    }
    const client = new MachineClient({ baseUrl: `http://127.0.0.1:${record.port}`, token, name: 'the local coordinator' });
    try {
      const info = await client.info();
      return info.machines ? client : null;
    } catch {
      return null;
    }
  };

  const running = await tryRecord();
  if (running) return { client: running, name: 'local', kind: 'local', close: async () => {} };

  // Two commands at once must not start two coordinators (two idle loops, two sets of tunnels):
  // whoever creates the lock file starts one, the other waits for its record. A lock older than
  // the wait is from a start that died, and is taken over.
  const waitMs = deps.waitMs ?? 20_000;
  const lock = path.join(path.dirname(paths.record), 'start.lock');
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  const takeLock = (): boolean => {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let stale = false;
        let seen = '';
        try {
          seen = fs.readFileSync(lock, 'utf8').trim();
          const holder = Number(seen);
          // An empty file is a holder between creating it and writing its pid: only age makes it stale
          stale = Date.now() - fs.statSync(lock).mtimeMs > waitMs || (holder > 0 && !alive(holder));
        } catch {
          continue; // gone meanwhile: try again
        }
        if (!stale) return false;
        // Taken over by renaming, then checked: if what was moved aside is not the stale lock that
        // was judged (another command took it over in between), it is put back and this one waits
        const aside = `${lock}.${process.pid}`;
        try {
          fs.renameSync(lock, aside);
          if (fs.readFileSync(aside, 'utf8').trim() !== seen) {
            try {
              fs.linkSync(aside, lock); // fails when a third lock already exists, which then stands
            } catch {
              // nothing to restore over
            }
            fs.rmSync(aside, { force: true });
            return false;
          }
          fs.rmSync(aside, { force: true });
        } catch {
          return false;
        }
      }
    }
    return false;
  };
  const mine = takeLock();
  // Only its own: after a takeover the file is someone else's
  const unlock = () => {
    if (!mine) return;
    try {
      if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { force: true });
    } catch {
      // already gone
    }
  };
  if (mine) {
    const argv = [...kunjArgv(), 'serve', '--machines', '--listen', '127.0.0.1:0', '--idle-exit', String(settings.coordinatorIdleMinutes)];
    try {
      (deps.start ?? detachedStart)(argv, paths.log);
    } catch (err) {
      unlock();
      throw err;
    }
  }
  // The one that waits gives the starter its whole wait, and a little more
  const deadline = Date.now() + waitMs + (mine ? 0 : 2000);
  for (;;) {
    const client = await tryRecord();
    if (client) {
      unlock();
      return { client, name: 'local', kind: 'local', close: async () => {} };
    }
    if (Date.now() >= deadline) {
      unlock();
      const tail = lastLines(paths.log, 5);
      throw new MachineError(`The local coordinator (kunj serve --machines) did not start.${tail ? `\n${tail}` : ''}\nIts log is ${paths.log}.`, 'coordinator-start-failed');
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

export interface ResolveOptions {
  /** --remote <name>; 'local' forces the local coordinator */
  remote?: string;
  config: KunjConfig;
  local?: LocalCoordinatorDeps;
  /** Test seams */
  remotes?: typeof requireRemote;
  tunnel?: (opts: { ssh: string; port: number }) => Promise<{ localPort: number; close(): Promise<void> }>;
}

/**
 * The coordinator a `kunj machine` command talks to: --remote names one; else container.remote when
 * that remote coordinates machines; else the local one when machine.provider is set here.
 */
export async function resolveCoordinator(opts: ResolveOptions): Promise<CoordinatorAccess> {
  const explicit = opts.remote && opts.remote !== 'local' ? opts.remote : undefined;
  const configured = !opts.remote ? opts.config.container?.remote || undefined : undefined;
  const name = explicit ?? (configured && configured !== 'local' ? configured : undefined);
  const hasProvider = !!machineSettings(opts.config).provider;

  if (name) {
    const entry = (opts.remotes ?? requireRemote)(name);
    let baseUrl = entry.url;
    let close = async () => {};
    if (!baseUrl && entry.ssh) {
      const open = opts.tunnel ?? (await import('../serve/tunnel')).openTunnel;
      const tunnel = await open({ ssh: entry.ssh, port: entry.port ?? DEFAULT_SERVE_PORT });
      baseUrl = `http://127.0.0.1:${tunnel.localPort}`;
      close = () => tunnel.close();
    }
    if (!baseUrl) throw new MachineError(`Remote "${name}" has neither a url nor an ssh destination.`, 'coordinator-no-machines');
    const client = new MachineClient({ baseUrl, token: entry.token, name });
    try {
      const info = await client.info();
      if (info.machines) return { client, name, kind: 'remote', close };
    } catch (err) {
      await close();
      throw err;
    }
    await close();
    // container.remote is a plain Docker remote: the local coordinator, when there is a provider here
    if (explicit || !hasProvider) {
      throw new MachineError(`Remote ${name} runs kunj serve without --machines, so it does not coordinate machines. Start it with kunj serve --machines, or use --remote local.`, 'coordinator-no-machines');
    }
  }
  if (!hasProvider) {
    throw new MachineError('No coordinator: set machine.provider here (kunj config --set machine.provider=gce --global, with machine.gce) or point container.remote at a kunj serve --machines.', 'machine-provider');
  }
  return ensureLocalCoordinator(opts.config, opts.local);
}
