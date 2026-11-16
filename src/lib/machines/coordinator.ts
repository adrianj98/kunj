// The coordinator's machine lifecycle (docs/specs/cloud-machines.md): finds a branch's machine by
// its labels, creates one, wakes a sleeping one, pairs with its kunj serve and waits until it
// answers. Cloud-agnostic: everything about the cloud goes through the MachineProvider. Runs inside
// `kunj serve --machines`, on a laptop or a coordinator VM.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import {
  Labels,
  MACHINE_LABEL,
  Machine,
  MachineError,
  MachineProvider,
  isAwake,
  isKunjMachine,
  machineLabels,
  machineName,
} from './provider';

export const MACHINE_SERVE_PORT = 7433;

// ---- machine tokens ----------------------------------------------------------------------------

export interface MachineTokenStore {
  get(name: string): string | undefined;
  set(name: string, token: string): void;
  delete(name: string): void;
  has(name: string): boolean;
}

/** `machine-tokens.json` (0600) in the coordinator's directory: machine name → its serve token. */
export function fileTokenStore(file: string, provider: string): MachineTokenStore {
  type Entry = { provider: string; token: string; pairedAt: string };
  const read = (): Record<string, Entry> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed.machines === 'object' && parsed.machines ? parsed.machines : {};
    } catch {
      return {};
    }
  };
  const write = (machines: Record<string, Entry>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ machines }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const key = (name: string) => `${provider}/${name}`;
  return {
    get: name => read()[key(name)]?.token,
    has: name => !!read()[key(name)],
    set: (name, token) => write({ ...read(), [key(name)]: { provider, token, pairedAt: new Date().toISOString() } }),
    delete: name => {
      const all = read();
      if (!(key(name) in all)) return;
      delete all[key(name)];
      write(all);
    },
  };
}

export function memoryTokenStore(): MachineTokenStore & { all: Map<string, string> } {
  const all = new Map<string, string>();
  return { all, get: n => all.get(n), has: n => all.has(n), set: (n, t) => void all.set(n, t), delete: n => void all.delete(n) };
}

// ---- reaching a machine's serve ----------------------------------------------------------------

export interface Endpoint {
  baseUrl: string;
  release(): Promise<void>;
}

/** Opens a provider tunnel argv listening on a local port (tunnel.ts in production). */
export type TunnelOpener = (argv: string[], localPort: number) => Promise<{ close(): Promise<void> }>;

export interface ServeReply {
  status: number;
  body: any;
}

/** One HTTP call to a machine's serve; connection failures reject (the caller retries). */
export type ServeCaller = (baseUrl: string, method: string, route: string, token?: string) => Promise<ServeReply>;

export const httpCaller: ServeCaller = (baseUrl, method, route, token) =>
  new Promise((resolve, reject) => {
    const target = new URL(route, baseUrl);
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const req = http.request(target, { method, headers, timeout: 10_000 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body: any;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });

// ---- the coordinator ---------------------------------------------------------------------------

export interface MachineDefaults {
  size: string;
  diskGb: number;
  spot: boolean;
  selfSuspend: boolean;
  bootTimeoutMs: number;
}

export interface CoordinatorOptions {
  provider: MachineProvider;
  network: 'private' | 'tunnel';
  tokens: MachineTokenStore;
  /** kunj's version, the kunj.version label of a new machine */
  version: string;
  defaults: MachineDefaults;
  servePort?: number;
  /** Test seams */
  call?: ServeCaller;
  openTunnel?: TunnelOpener;
  freePort?: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LocateRequest {
  repo: string;
  /** The readable repository name, for a new machine's name */
  repoName: string;
  branch: string;
  /** Resume or start a sleeping machine and wait for its serve */
  wake?: boolean;
  /** Create one when there is none (implies wake) */
  create?: boolean;
  size?: string;
  /** The client that asked (kunj.owner on a new machine) */
  owner?: string;
}

export interface LocateResult {
  machine: Machine;
  created: boolean;
  woke: boolean;
  /** Whether the coordinator holds this machine's serve token */
  paired: boolean;
}

const POLL_MS = 2000;

export class Coordinator {
  readonly provider: MachineProvider;
  private readonly port: number;
  private readonly call: ServeCaller;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** One ensure per branch at a time: two clients starting the same branch get one machine */
  private readonly inFlight = new Map<string, Promise<LocateResult>>();

  constructor(private readonly opts: CoordinatorOptions) {
    this.provider = opts.provider;
    this.port = opts.servePort ?? MACHINE_SERVE_PORT;
    this.call = opts.call ?? httpCaller;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  get network(): 'private' | 'tunnel' {
    return this.opts.network;
  }

  isPaired(name: string): boolean {
    return this.opts.tokens.has(name);
  }

  /** kunj's machines matching `filter` (any state); never another tool's instances. */
  async list(filter: Labels = {}): Promise<Machine[]> {
    const machines = await this.provider.list({ ...filter, [MACHINE_LABEL.role]: 'machine' });
    return machines.filter(isKunjMachine).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The branch's machine, or null; two is `machine-ambiguous`. */
  async find(repo: string, branch: string): Promise<Machine | null> {
    const found = await this.list({ [MACHINE_LABEL.repo]: repo, [MACHINE_LABEL.branch]: branch });
    if (found.length > 1) {
      throw new MachineError(`Branch ${branch} has ${found.length} machines (${found.map(m => m.name).join(', ')}). Delete the extra ones with kunj machine delete.`, 'machine-ambiguous');
    }
    return found[0] ?? null;
  }

  /** The named machine, refusing one kunj did not create. */
  async get(name: string): Promise<Machine> {
    const m = await this.provider.get(name);
    if (!m) throw new MachineError(`No machine named ${name}.`, 'machine-not-found');
    if (!isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    return m;
  }

  locate(req: LocateRequest): Promise<LocateResult> {
    const key = `${req.repo}\n${req.branch}`;
    const running = this.inFlight.get(key);
    if (running && (req.wake || req.create)) return running;
    const work = this.locateNow(req).finally(() => {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    });
    if (req.wake || req.create) this.inFlight.set(key, work);
    return work;
  }

  private async locateNow(req: LocateRequest): Promise<LocateResult> {
    let machine = await this.find(req.repo, req.branch);
    if (!machine) {
      if (!req.create) throw new MachineError(`Branch ${req.branch} has no machine. kunj machine create (or kunj ct start) makes one.`, 'machine-not-found');
      machine = await this.create(req);
      return { machine, created: true, woke: false, paired: this.isPaired(machine.name) };
    }
    if (!req.wake && !req.create) return { machine, created: false, woke: false, paired: this.isPaired(machine.name) };
    const woke = !isAwake(machine.state);
    if (woke) machine = await this.wake(machine);
    else await this.ready(machine);
    return { machine, created: false, woke, paired: this.isPaired(machine.name) };
  }

  private async create(req: LocateRequest): Promise<Machine> {
    const d = this.opts.defaults;
    const name = machineName(req.repoName, req.repo, req.branch);
    const labels = machineLabels(req.repo, req.branch, {
      [MACHINE_LABEL.version]: this.opts.version,
      [MACHINE_LABEL.image]: '',
      [MACHINE_LABEL.owner]: req.owner ?? '',
    });
    this.log(`creating machine ${name} for ${req.branch}`);
    // A token left from an earlier machine of the same name would never match the new one
    this.opts.tokens.delete(name);
    let machine = await this.provider.create({ name, labels, size: req.size || d.size, image: '', diskGb: d.diskGb, spot: d.spot, selfSuspend: d.selfSuspend });
    machine = await this.waitForState(machine.name, 'running');
    await this.pair(machine);
    await this.ready(machine);
    return (await this.provider.get(machine.name)) ?? machine;
  }

  /** Resumes (or starts) a machine and waits until its serve answers. */
  async wake(machine: Machine): Promise<Machine> {
    if (machine.state === 'suspended' || machine.state === 'suspending') await this.provider.resume(machine.name);
    else if (machine.state === 'stopped' || machine.state === 'stopping') await this.provider.start(machine.name);
    const awake = await this.waitForState(machine.name, 'running');
    if (!this.isPaired(awake.name)) await this.pair(awake);
    await this.ready(awake);
    return awake;
  }

  async suspend(name: string): Promise<void> {
    await this.get(name);
    await this.provider.suspend(name);
  }

  async resume(name: string): Promise<Machine> {
    return this.wake(await this.get(name));
  }

  async stop(name: string): Promise<void> {
    await this.get(name);
    await this.provider.stop(name);
  }

  async start(name: string): Promise<Machine> {
    return this.wake(await this.get(name));
  }

  async delete(name: string, opts: { disks: boolean }): Promise<void> {
    const m = await this.provider.get(name);
    if (m && !isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    await this.provider.delete(name, opts);
    this.opts.tokens.delete(name);
  }

  // ---- reaching a machine ----------------------------------------------------------------------

  /** Where the machine's serve answers: its private address, or a tunnel opened for the caller. */
  async endpoint(machine: Machine): Promise<Endpoint> {
    if (this.opts.network === 'private') {
      const address = this.provider.address(machine, this.port);
      if (!address) throw new MachineError(`Machine ${machine.name} has no internal address yet.`, 'machine-timeout');
      return { baseUrl: `http://${address.host}:${address.port}`, release: async () => {} };
    }
    const localPort = await (this.opts.freePort ?? (async () => (await import('../container/forward')).findFreePort(0)))();
    const spec = this.provider.tunnel(machine, this.port, localPort);
    const open = this.opts.openTunnel ?? (async (argv: string[], port: number) => (await import('../serve/tunnel')).openCommandTunnel({ argv, localPort: port, describe: `the tunnel to ${machine.name}` }));
    const tunnel = await open(spec.argv, localPort);
    return { baseUrl: `http://127.0.0.1:${localPort}`, release: () => tunnel.close() };
  }

  /** Waits until the provider reports `state`, up to the boot timeout. */
  private async waitForState(name: string, state: Machine['state']): Promise<Machine> {
    const deadline = this.now() + this.opts.defaults.bootTimeoutMs;
    for (;;) {
      const m = await this.provider.get(name);
      if (!m) throw new MachineError(`Machine ${name} disappeared while starting.`, 'machine-not-found');
      if (m.state === state) return m;
      if (this.now() >= deadline) throw new MachineError(`Machine ${name} is still ${m.state} after ${Math.round(this.opts.defaults.bootTimeoutMs / 1000)} s.`, 'machine-timeout');
      await this.sleep(POLL_MS);
    }
  }

  /**
   * Gets the machine's serve token with the one-time POST /v1/pair, retrying while the machine boots.
   * A machine whose pairing already happened elsewhere (or closed) cannot be used: `machine-token`.
   */
  private async pair(machine: Machine): Promise<void> {
    const endpoint = await this.endpoint(machine);
    try {
      const deadline = this.now() + this.opts.defaults.bootTimeoutMs;
      for (;;) {
        const reply = await this.call(endpoint.baseUrl, 'POST', '/v1/pair').catch(() => null);
        if (reply?.status === 200 && typeof reply.body?.token === 'string') {
          this.opts.tokens.set(machine.name, reply.body.token);
          this.log(`paired with ${machine.name}`);
          return;
        }
        if (reply?.status === 403) {
          throw new MachineError(`Machine ${machine.name} no longer accepts pairing and this coordinator has no token for it. Delete it (kunj machine delete) and start the branch again; its work is on origin.`, 'machine-token');
        }
        if (this.now() >= deadline) throw new MachineError(`kunj serve on ${machine.name} did not answer within ${Math.round(this.opts.defaults.bootTimeoutMs / 1000)} s.`, 'machine-timeout');
        await this.sleep(POLL_MS);
      }
    } finally {
      await endpoint.release();
    }
  }

  /** Waits until the machine's serve answers GET /v1/info with our token. */
  async ready(machine: Machine): Promise<void> {
    const token = this.opts.tokens.get(machine.name);
    if (!token) {
      throw new MachineError(`This coordinator has no token for ${machine.name} (it was paired by another coordinator, or the token file was lost). Delete the machine and start the branch again.`, 'machine-token');
    }
    const endpoint = await this.endpoint(machine);
    try {
      const deadline = this.now() + this.opts.defaults.bootTimeoutMs;
      for (;;) {
        const reply = await this.call(endpoint.baseUrl, 'GET', '/v1/info', token).catch(() => null);
        if (reply?.status === 200) return;
        if (reply?.status === 401) {
          this.opts.tokens.delete(machine.name);
          throw new MachineError(`kunj serve on ${machine.name} refused this coordinator's token. Delete the machine and start the branch again.`, 'machine-token');
        }
        if (this.now() >= deadline) throw new MachineError(`kunj serve on ${machine.name} did not answer within ${Math.round(this.opts.defaults.bootTimeoutMs / 1000)} s.`, 'machine-timeout');
        await this.sleep(POLL_MS);
      }
    } finally {
      await endpoint.release();
    }
  }
}
