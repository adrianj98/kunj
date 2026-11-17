// The coordinator's machine lifecycle (docs/specs/cloud-machines.md): finds a branch's machine by
// its labels, creates one, wakes a sleeping one, pairs with its kunj serve and waits until it
// answers. Cloud-agnostic: everything about the cloud goes through the MachineProvider. Runs inside
// `kunj serve --machines`, on a laptop or a coordinator VM.

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import {
  CacheSync,
  IMAGE_BUILD_BRANCH,
  IMAGE_ROLE,
  Labels,
  MACHINE_LABEL,
  Machine,
  MachineError,
  MachineImage,
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
export type ServeCaller = (baseUrl: string, method: string, route: string, token?: string, body?: unknown) => Promise<ServeReply>;

export const httpCaller: ServeCaller = (baseUrl, method, route, token, body) =>
  new Promise((resolve, reject) => {
    const target = new URL(route, baseUrl);
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
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
    req.end(data);
  });

// ---- the coordinator ---------------------------------------------------------------------------

export interface MachineDefaults {
  size: string;
  diskGb: number;
  spot: boolean;
  selfSuspend: boolean;
  bootTimeoutMs: number;
  /** A machine image to boot ('' = the provider's stock image) */
  image?: string;
}

export interface CoordinatorOptions {
  provider: MachineProvider;
  network: 'private' | 'tunnel';
  tokens: MachineTokenStore;
  /** kunj's version, the kunj.version label of a new machine */
  version: string;
  defaults: MachineDefaults;
  servePort?: number;
  /** The script a new machine runs at boot to install and start kunj serve (bootstrap.ts) */
  startupScript?: string;
  /** The cache store of machine.cache as this provider's machines reach it; none when unset */
  cache?: CacheSync;
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
const SHARED_IDLE_MS = 60_000;

interface SharedEndpoint {
  endpoint: Endpoint;
  url: URL;
  users: number;
  idle?: NodeJS.Timeout;
  /** Taken out of use (a connection through it failed): released when its last user is done */
  retired?: boolean;
  released?: boolean;
}

export class Coordinator {
  readonly provider: MachineProvider;
  private readonly port: number;
  private readonly call: ServeCaller;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** One endpoint per machine for proxied requests, kept while in use and a minute after */
  private readonly shared = new Map<string, Promise<SharedEndpoint>>();
  /** Proxied exchanges open per machine, on whichever endpoint (a retired one still counts) */
  private readonly inUse = new Map<string, number>();
  /** When each machine last served a proxied request or had an open stream or a working agent */
  private readonly lastBusy = new Map<string, number>();
  /** One ensure per branch at a time: two clients starting the same branch get one machine */
  private readonly inFlight = new Map<string, Promise<LocateResult>>();
  /** Machines a locate is creating or waking right now (by name, counted) */
  private readonly starting = new Map<string, number>();

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
    // A machine being created or woken is in use by definition: the idle loop must not put it back to
    // sleep while it boots, whatever machine.idleMinutes is
    const name = machineName(req.repoName, req.repo, req.branch);
    const starting = !!(req.wake || req.create);
    if (starting) this.starting.set(name, (this.starting.get(name) ?? 0) + 1);
    const work = this.locateNow(req).finally(() => {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      if (starting) {
        const left = (this.starting.get(name) ?? 1) - 1;
        if (left > 0) this.starting.set(name, left);
        else this.starting.delete(name);
        // Its quiet spell starts when it is ready, not when it was asked for
        this.lastBusy.set(name, this.now());
      }
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

  /** The repository's golden images, newest first. */
  async images(repo: string): Promise<MachineImage[]> {
    if (!this.provider.features.images) return [];
    // No repository: every golden image this coordinator's cloud holds (kunj resources)
    const found = await this.provider.images.list({ ...(repo ? { [MACHINE_LABEL.repo]: repo } : {}), [MACHINE_LABEL.role]: IMAGE_ROLE });
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }

  /**
   * The image a new machine boots: machine.image when set, else the repository's newest golden
   * image, else the provider's stock one. The builder of a golden image always starts from stock,
   * so an image never carries what an older one had. A listing that fails costs boot time, not the
   * machine.
   */
  private async imageFor(req: LocateRequest): Promise<string> {
    const d = this.opts.defaults;
    if (d.image) return d.image;
    if (req.branch === IMAGE_BUILD_BRANCH) return '';
    try {
      return (await this.images(req.repo))[0]?.name ?? '';
    } catch (err) {
      this.log(`could not list golden images, using the stock image: ${(err as Error).message}`);
      return '';
    }
  }

  /**
   * Bakes a golden image from a machine: stops it, images its disk, and deletes the repository's
   * older images. The machine is left stopped; the caller deletes the builder.
   */
  async bake(name: string, opts: { blueprint?: string } = {}): Promise<MachineImage> {
    if (!this.provider.features.images) throw new MachineError(`The ${this.provider.name} provider cannot make machine images.`, 'bad-machine-config');
    const machine = await this.get(name);
    // Only the builder: a branch's machine holds that branch's containers, and Docker keeps their
    // environment (tokens, secrets) on the disk an image would copy to every new machine
    if (machine.labels[MACHINE_LABEL.branch] !== IMAGE_BUILD_BRANCH) {
      throw new MachineError(`${name} is a branch's machine, not an image builder; kunj machine image build makes one.`, 'bad-machine-config');
    }
    const repo = machine.labels[MACHINE_LABEL.repo] ?? '';
    await this.dropShared(name);
    await this.provider.stop(name);
    const stopped = await this.waitForState(name, 'stopped');
    const stem = name.replace(/-[a-z0-9]+$/, '').slice(0, 40).replace(/-+$/, '');
    const imageName = `${stem}-img-${new Date(this.now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    const before = await this.images(repo);
    this.log(`baking image ${imageName} from ${name}`);
    const image = await this.provider.images.createFrom(stopped, imageName, {
      [MACHINE_LABEL.repo]: repo,
      [MACHINE_LABEL.role]: IMAGE_ROLE,
      [MACHINE_LABEL.version]: this.opts.version,
      ...(opts.blueprint ? { [MACHINE_LABEL.blueprint]: opts.blueprint } : {}),
    });
    for (const old of before) {
      if (old.name === image.name) continue;
      await this.provider.images.delete(old.name).catch(err => this.log(`could not delete old image ${old.name}: ${(err as Error).message}`));
    }
    return image;
  }

  /** Deletes one of kunj's golden images; anything else is refused. */
  /** A line in the coordinator's log */
  note(line: string): void {
    this.log(line);
  }

  /** How machines sync their caches with the store, when this coordinator has one. */
  get cache(): CacheSync | undefined {
    return this.opts.cache;
  }

  async deleteImage(name: string): Promise<void> {
    const ours = await this.provider.images.list({ [MACHINE_LABEL.role]: IMAGE_ROLE });
    if (!ours.some(i => i.name === name)) throw new MachineError(`No kunj machine image named ${name}.`, 'machine-not-found');
    await this.provider.images.delete(name);
  }

  private async create(req: LocateRequest): Promise<Machine> {
    const d = this.opts.defaults;
    const name = machineName(req.repoName, req.repo, req.branch);
    const image = await this.imageFor(req);
    const labels = machineLabels(req.repo, req.branch, {
      [MACHINE_LABEL.version]: this.opts.version,
      [MACHINE_LABEL.image]: image,
      [MACHINE_LABEL.owner]: req.owner ?? '',
    });
    this.log(`creating machine ${name} for ${req.branch}${image ? ` from image ${image}` : ''}`);
    let machine = await this.provider.create({ name, labels, size: req.size || d.size, image, diskGb: d.diskGb, spot: d.spot, selfSuspend: d.selfSuspend, startupScript: this.opts.startupScript, cacheStore: !!this.opts.cache });
    // A token left from an earlier machine of the same name would never match the new one. Only
    // after the create succeeded: a create refused with machine-exists (another coordinator made
    // it meanwhile) must leave that live machine's token alone
    this.opts.tokens.delete(name);
    machine = await this.waitForState(machine.name, 'running');
    await this.pair(machine);
    await this.ready(machine);
    return (await this.provider.get(machine.name)) ?? machine;
  }

  /** Resumes (or starts) a machine and waits until its serve answers. */
  async wake(machine: Machine): Promise<Machine> {
    // On its way to sleep (a `ct stop` that did not wait): a cloud refuses to resume it until it is there
    if (machine.state === 'suspending') machine = await this.waitForState(machine.name, 'suspended');
    else if (machine.state === 'stopping') machine = await this.waitForState(machine.name, 'stopped');
    if (machine.state === 'suspended' || machine.state === 'suspending') await this.provider.resume(machine.name);
    else if (machine.state === 'stopped' || machine.state === 'stopping') await this.provider.start(machine.name);
    const awake = await this.waitForState(machine.name, 'running');
    if (!this.isPaired(awake.name)) await this.pair(awake);
    await this.ready(awake);
    return awake;
  }

  async suspend(name: string): Promise<void> {
    await this.get(name);
    await this.dropShared(name);
    await this.provider.suspend(name);
  }

  async resume(name: string): Promise<Machine> {
    return this.wake(await this.get(name));
  }

  async stop(name: string): Promise<void> {
    await this.get(name);
    await this.dropShared(name);
    await this.provider.stop(name);
  }

  async start(name: string): Promise<Machine> {
    return this.wake(await this.get(name));
  }

  async delete(name: string, opts: { disks: boolean }): Promise<void> {
    const m = await this.provider.get(name);
    if (m && !isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    await this.dropShared(name);
    await this.provider.delete(name, opts);
    this.opts.tokens.delete(name);
  }

  // ---- the proxy ---------------------------------------------------------------------------------

  /**
   * Where a proxied request for `name` goes. The endpoint (a tunnel, from a laptop) is shared by
   * every request to the machine and closed a minute after the last one; a failed connection drops
   * it, so the next request asks the provider whether the machine is asleep.
   */
  proxyTarget(name: string, use = true): Promise<{ host: string; port: number; token: string; done(failed: boolean): void }> {
    // A listing (a passive request) goes through like any other but is not someone using the machine:
    // an open workspace app must not keep every machine awake
    return this.acquire(name, use);
  }

  /** `use` false: the idle loop's own question, which must not count as someone using the machine */
  private async acquire(name: string, use: boolean): Promise<{ host: string; port: number; token: string; done(failed: boolean): void }> {
    const token = this.opts.tokens.get(name);
    if (!token) throw new MachineError(`This coordinator has no token for ${name}. Delete the machine and start the branch again.`, 'machine-token');
    let pending = this.shared.get(name);
    if (!pending) {
      pending = (async (): Promise<SharedEndpoint> => {
        const machine = await this.get(name);
        if (!isAwake(machine.state)) throw new MachineError(`Machine ${name} is ${machine.state}. An acting command (kunj ct start, shell, agent) wakes it.`, 'machine-asleep');
        const endpoint = await this.endpoint(machine);
        return { endpoint, url: new URL(endpoint.baseUrl), users: 0 };
      })();
      this.shared.set(name, pending);
      pending.catch(() => {
        if (this.shared.get(name) === pending) this.shared.delete(name);
      });
    }
    const entry = await pending;
    entry.users++;
    if (use) this.inUse.set(name, (this.inUse.get(name) ?? 0) + 1);
    if (entry.idle) clearTimeout(entry.idle);
    if (use) this.lastBusy.set(name, this.now());
    let done = false;
    return {
      host: entry.url.hostname,
      port: Number(entry.url.port),
      token,
      done: failed => {
        if (done) return;
        done = true;
        entry.users--;
        if (use) {
          const left = (this.inUse.get(name) ?? 1) - 1;
          if (left > 0) this.inUse.set(name, left);
          else this.inUse.delete(name);
          this.lastBusy.set(name, this.now());
        }
        // A failed connection takes this endpoint out of use for new requests; the exchanges still
        // on it keep it until they end
        if (failed) this.retire(name, pending!, entry);
        if (entry.users > 0) return;
        if (entry.retired) return void this.release(entry);
        entry.idle = setTimeout(() => {
          this.retire(name, pending!, entry);
          if (entry.users === 0) void this.release(entry);
        }, SHARED_IDLE_MS);
        entry.idle.unref?.();
      },
    };
  }

  /** Stops handing `entry` to new requests. By identity: a newer endpoint of the same machine stays. */
  private retire(name: string, pending: Promise<SharedEndpoint>, entry: SharedEndpoint): void {
    entry.retired = true;
    if (this.shared.get(name) === pending) this.shared.delete(name);
  }

  private async release(entry: SharedEndpoint): Promise<void> {
    if (entry.released) return;
    entry.released = true;
    if (entry.idle) clearTimeout(entry.idle);
    await entry.endpoint.release().catch(() => {});
  }

  /** The machine is going away or to sleep: its endpoint is closed now, whoever is on it. */
  private async dropShared(name: string): Promise<void> {
    const pending = this.shared.get(name);
    if (!pending) return;
    this.shared.delete(name);
    const entry = await pending.catch(() => null);
    if (!entry) return;
    entry.retired = true;
    await this.release(entry);
  }

  /** Proxied exchanges open now (a terminal, a build): a coordinator with any must not exit. */
  async openProxies(): Promise<number> {
    let n = 0;
    for (const users of this.inUse.values()) n += users;
    return n;
  }

  /** Closes every shared endpoint (the server is stopping). */
  async close(): Promise<void> {
    await Promise.all([...this.shared.keys()].map(n => this.dropShared(n)));
  }

  // ---- idle ---------------------------------------------------------------------------------------

  /**
   * Suspends machines nobody is using: no proxied request, no open stream and no agent in the
   * `running` state for `idleMs`. `agentBusy` asks a machine's serve (the idle loop gives one that
   * reads STATUS_SCRIPT); a machine that cannot be asked is not thereby busy.
   */
  async idleTick(idleMs: number, agentBusy: (baseUrl: string, token: string) => Promise<boolean>): Promise<string[]> {
    const suspended: string[] = [];
    for (const machine of await this.list()) {
      if (!isAwake(machine.state)) {
        this.lastBusy.delete(machine.name);
        continue;
      }
      const now = this.now();
      if (!this.lastBusy.has(machine.name)) this.lastBusy.set(machine.name, now);
      let busy = (this.inUse.get(machine.name) ?? 0) > 0 || this.starting.has(machine.name);
      const token = this.opts.tokens.get(machine.name);
      if (!busy && token) {
        try {
          const target = await this.acquire(machine.name, false);
          try {
            busy = await agentBusy(`http://${target.host}:${target.port}`, token);
          } finally {
            target.done(false);
          }
        } catch {
          // Its serve does not answer: not proof of use. Suspend keeps memory, so a machine nobody
          // has reached for the whole quiet spell is put to sleep rather than left billing
        }
      }
      if (busy) {
        this.lastBusy.set(machine.name, now);
        continue;
      }
      if (now - (this.lastBusy.get(machine.name) ?? now) >= idleMs) {
        this.log(`suspending idle machine ${machine.name}`);
        await this.dropShared(machine.name);
        await this.provider.suspend(machine.name).catch(err => this.log(`could not suspend ${machine.name}: ${(err as Error).message}`));
        this.lastBusy.delete(machine.name);
        suspended.push(machine.name);
      }
    }
    return suspended;
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
   * Runs `step` against the machine's serve until it gives a result, up to the boot timeout. The
   * endpoint is opened inside the loop: while a machine boots its port is closed, and a provider
   * tunnel then fails to come up (gcloud's IAP tunnel tests the port and exits), which is one more
   * "not yet", not a failure. A tunnel that broke is reopened.
   */
  private async poll<T>(machine: Machine, step: (baseUrl: string) => Promise<T | undefined>): Promise<T> {
    const deadline = this.now() + this.opts.defaults.bootTimeoutMs;
    let endpoint: Endpoint | undefined;
    let last = '';
    try {
      for (;;) {
        try {
          endpoint ??= await this.endpoint(machine);
          const result = await step(endpoint.baseUrl);
          if (result !== undefined) return result;
        } catch (err) {
          if (err instanceof MachineError && err.code === 'machine-token') throw err;
          last = err instanceof Error ? err.message : String(err);
          await endpoint?.release().catch(() => {});
          endpoint = undefined;
        }
        if (this.now() >= deadline) {
          throw new MachineError(`kunj serve on ${machine.name} did not answer within ${Math.round(this.opts.defaults.bootTimeoutMs / 1000)} s.${last ? ` Last error: ${last}` : ''}`, 'machine-timeout');
        }
        await this.sleep(POLL_MS);
      }
    } finally {
      await endpoint?.release().catch(() => {});
    }
  }

  /**
   * Gets the machine's serve token with the one-time POST /v1/pair, retrying while the machine boots.
   * A machine whose pairing already happened elsewhere (or closed) cannot be used: `machine-token`.
   */
  private async pair(machine: Machine): Promise<void> {
    // One nonce for every try: the machine answers a repeat from the same caller with the same token
    const nonce = randomBytes(24).toString('base64url');
    await this.poll(machine, async baseUrl => {
      const reply = await this.call(baseUrl, 'POST', '/v1/pair', undefined, { nonce });
      if (reply.status === 200 && typeof reply.body?.token === 'string') {
        this.opts.tokens.set(machine.name, reply.body.token);
        this.log(`paired with ${machine.name}`);
        return true;
      }
      if (reply.status === 403) {
        throw new MachineError(`Machine ${machine.name} no longer accepts pairing and this coordinator has no token for it. Delete it (kunj machine delete) and start the branch again; its work is on origin.`, 'machine-token');
      }
      return undefined;
    });
  }

  /** Waits until the machine's serve answers GET /v1/info with our token. */
  async ready(machine: Machine): Promise<void> {
    const token = this.opts.tokens.get(machine.name);
    if (!token) {
      throw new MachineError(`This coordinator has no token for ${machine.name} (it was paired by another coordinator, or the token file was lost). Delete the machine and start the branch again.`, 'machine-token');
    }
    await this.poll(machine, async baseUrl => {
      const reply = await this.call(baseUrl, 'GET', '/v1/info', token);
      if (reply.status === 200) return true;
      if (reply.status === 401) {
        this.opts.tokens.delete(machine.name);
        throw new MachineError(`kunj serve on ${machine.name} refused this coordinator's token. Delete the machine and start the branch again.`, 'machine-token');
      }
      return undefined;
    });
  }
}
