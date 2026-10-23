// `kunj container forward --auto`: polls the container's TCP listeners (`ss -ltnH`, one exec every
// 2 s) and forwards each new one to 127.0.0.1 on the host with forwardPort, dropping it when the
// listener goes away. Running forwarders are recorded in ~/.kunj/container-forwards.json so that
// `kunj ct list` can show them and `kunj ct agent` does not start a second one.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerBackend } from './backend';
import { Forwarder, forwardPort } from './forward';

const POLL_MS = 2000;
const STATE_POLL_MS = 5000;
const LOWEST_PORT = 1024;

/**
 * Ports with a listener the tunnel can reach, i.e. bound to a wildcard or loopback address (the
 * tunnel connects to 127.0.0.1). 127.0.0.11 is Docker's embedded DNS, never an application.
 */
export function parseSsListen(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    const m = local && /^(.*):(\d+)$/.exec(local);
    if (!m) continue;
    const address = m[1].replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '').replace(/^::ffff:/, '');
    const port = Number(m[2]);
    const wildcard = address === '*' || address === '0.0.0.0' || address === '::';
    const loopback = (/^127\./.test(address) && address !== '127.0.0.11') || address === '::1';
    if ((wildcard || loopback) && port >= 1 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** container.forward.ignore as ports: a list, or the single value `kunj config --set` stores. */
export function ignoredPorts(value: unknown): number[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return list.map(Number).filter(n => Number.isInteger(n) && n > 0);
}

/** What to forward and drop: listeners below 1024 and ignored ports are never forwarded. */
export function diffPorts(current: Set<number>, next: number[], ignore: number[]): { add: number[]; remove: number[] } {
  const wanted = new Set(next.filter(p => p >= LOWEST_PORT && !ignore.includes(p)));
  return {
    add: [...wanted].filter(p => !current.has(p)),
    remove: [...current].filter(p => !wanted.has(p)),
  };
}

// ---------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------

/**
 * One forwarded port of a running forwarder. Port 0 marks a forwarder that is running for the
 * container (with or without ports), so it can be found before its first listener appears.
 */
export interface ForwardRecord {
  pid: number;
  container: string;
  port: number;
  hostPort: number;
  kind: 'forward';
}

export function forwardsFile(): string {
  return path.join(os.homedir(), '.kunj', 'container-forwards.json');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(r: any): r is ForwardRecord {
  return (
    !!r && Number.isInteger(r.pid) && r.pid > 0 && typeof r.container === 'string' &&
    Number.isInteger(r.port) && Number.isInteger(r.hostPort) && r.kind === 'forward'
  );
}

/** The live forwards; entries of dead processes are pruned (and the file rewritten without them). */
export function readForwards(file: string = forwardsFile()): ForwardRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const all = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  const live = all.filter(r => isAlive(r.pid));
  if (live.length !== (Array.isArray(parsed) ? parsed.length : -1)) {
    try {
      writeForwards(live, file);
    } catch {
      // read-only home: the pruned list is still right for this caller
    }
  }
  return live;
}

/** Written to a temp file and renamed, so concurrent forwarders never see a half-written file. */
export function writeForwards(records: ForwardRecord[], file: string = forwardsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function updateForwards(change: (records: ForwardRecord[]) => ForwardRecord[], file: string = forwardsFile()): ForwardRecord[] {
  const next = change(readForwards(file));
  writeForwards(next, file);
  return next;
}

/** The pid of a live forwarder for `container`, if one is registered. */
export function forwarderFor(container: string, file: string = forwardsFile()): number | undefined {
  return readForwards(file).find(r => r.container === container)?.pid;
}

/** Runs this CLI again in the background (`kunj <args>`), detached from our terminal; returns its pid. */
export function spawnDetached(args: string[]): number {
  const child = spawn(process.execPath, [process.argv[1], ...args], { detached: true, stdio: 'ignore', cwd: process.cwd() });
  child.unref();
  if (!child.pid) throw new Error('Could not start the background forwarder');
  return child.pid;
}

// ---------------------------------------------------------------------
// the forwarder
// ---------------------------------------------------------------------

export interface AutoForwardChange {
  event: 'add' | 'remove';
  port: number;
  hostPort: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * Forwards the container's listeners until `signal` aborts or the container stops running, then
 * closes every forward. A failed poll keeps the current forwards.
 */
export async function runAutoForward(
  backend: ContainerBackend,
  containerId: string,
  opts: {
    ignore: number[];
    intervalMs?: number;
    stateIntervalMs?: number;
    user?: string;
    onChange?: (change: AutoForwardChange) => void;
    onError?: (message: string) => void;
    signal: AbortSignal;
  },
): Promise<void> {
  const { signal } = opts;
  const intervalMs = opts.intervalMs ?? POLL_MS;
  const stateIntervalMs = opts.stateIntervalMs ?? STATE_POLL_MS;
  const user = opts.user || undefined;
  const forwards = new Map<number, Forwarder>();
  // Ports that could not be forwarded: not retried until their listener goes away
  const failed = new Set<number>();
  const hasSocat = (await backend.exec(containerId, ['sh', '-c', 'command -v socat'], { user })).exitCode === 0;
  let lastStateCheck = Date.now();

  try {
    while (!signal.aborted) {
      if (Date.now() - lastStateCheck >= stateIntervalMs) {
        lastStateCheck = Date.now();
        if ((await backend.containerState(containerId)) !== 'running') return;
      }

      let listening: number[] | undefined;
      try {
        const r = await backend.exec(containerId, ['ss', '-ltnH'], { user });
        if (r.exitCode === 0) listening = parseSsListen(r.stdout);
      } catch {
        // the container is going away; the state check ends the loop
      }

      if (listening && !signal.aborted) {
        for (const port of failed) if (!listening.includes(port)) failed.delete(port);
        const { add, remove } = diffPorts(new Set(forwards.keys()), listening, opts.ignore);
        for (const port of remove) {
          const forwarder = forwards.get(port)!;
          forwards.delete(port);
          await forwarder.close();
          opts.onChange?.({ event: 'remove', port, hostPort: forwarder.hostPort });
        }
        for (const port of add) {
          if (failed.has(port)) continue;
          try {
            const forwarder = await forwardPort(backend, containerId, { container: port }, { hasSocat, nextFree: true });
            forwards.set(port, forwarder);
            opts.onChange?.({ event: 'add', port, hostPort: forwarder.hostPort });
          } catch (err) {
            failed.add(port);
            opts.onError?.(`Could not forward port ${port}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      await sleep(intervalMs, signal);
    }
  } finally {
    await Promise.all([...forwards.values()].map(f => f.close()));
  }
}
