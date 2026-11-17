import * as http from 'http';
import { FakeBackend } from '../../container/__tests__/fake-backend';
import { ServeServer, createServeServer } from '../../serve/server';
import { machineRoutes } from '../../serve/machines';
import { Coordinator, CoordinatorOptions, ServeCaller, memoryTokenStore } from '../coordinator';
import { MachineError, machineLabels, machineName } from '../provider';
import { FakeProvider } from './fake-provider';

const REPO = 'github.com/acme/app';

/** Every machine's kunj serve, by internal address: up or not, pairing open or closed. */
class FakeServes {
  readonly serves = new Map<string, { up: boolean; pairing: boolean; token?: string }>();
  readonly calls: string[] = [];

  boot(host: string, opts: { pairing?: boolean; token?: string } = {}): void {
    this.serves.set(host, { up: true, pairing: opts.pairing ?? true, token: opts.token });
  }

  caller: ServeCaller = async (baseUrl, method, route, token) => {
    const host = new URL(baseUrl).hostname;
    this.calls.push(`${method} ${route} ${host}`);
    const s = this.serves.get(host);
    if (!s?.up) throw new Error('ECONNREFUSED');
    if (method === 'POST' && route === '/v1/pair') {
      if (!s.pairing) return { status: 403, body: { error: { code: 'pairing-closed' } } };
      s.pairing = false;
      s.token = `tok-${host}`;
      return { status: 200, body: { token: s.token } };
    }
    if (route === '/v1/info') return token && token === s.token ? { status: 200, body: { kunj: '1' } } : { status: 401, body: {} };
    return { status: 404, body: {} };
  };
}

function setup(over: Partial<CoordinatorOptions> = {}) {
  const provider = new FakeProvider();
  const serves = new FakeServes();
  const tokens = memoryTokenStore();
  let clock = 0;
  // A machine's serve comes up as soon as the provider has given it an address
  const create = provider.create.bind(provider);
  provider.create = async spec => {
    const m = await create(spec);
    serves.boot(m.addresses.internal!);
    return m;
  };
  const coordinator = new Coordinator({
    provider,
    network: 'private',
    tokens,
    version: '1.2.3',
    defaults: { size: 'medium', diskGb: 30, spot: false, selfSuspend: false, bootTimeoutMs: 60_000 },
    call: serves.caller,
    sleep: async ms => {
      clock += ms;
    },
    now: () => clock,
    ...over,
  });
  return { provider, serves, tokens, coordinator };
}

describe('Coordinator', () => {
  it('creates a labelled machine, pairs with its serve and waits until it answers', async () => {
    const { provider, tokens, coordinator, serves } = setup();
    const r = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'feature/x', create: true, owner: 'laptop-a' });
    const name = machineName('app', REPO, 'feature/x');
    expect(r).toMatchObject({ created: true, woke: false, paired: true, machine: { name, state: 'running' } });
    expect(provider.specs.get(name)).toMatchObject({
      size: 'medium',
      diskGb: 30,
      image: '',
      labels: machineLabels(REPO, 'feature/x', { 'kunj.version': '1.2.3', 'kunj.image': '', 'kunj.owner': 'laptop-a' }),
    });
    expect(tokens.all.get(name)).toBe(`tok-${r.machine.addresses.internal}`);
    expect(serves.calls.map(c => c.split(' ').slice(0, 2).join(' '))).toEqual(['POST /v1/pair', 'GET /v1/info']);
  });

  it('finds the existing machine instead of making a second, also when two clients ask at once', async () => {
    const { provider, coordinator } = setup();
    const [a, b] = await Promise.all([
      coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b', create: true }),
      coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b', create: true }),
    ]);
    expect(a.machine.name).toBe(b.machine.name);
    const again = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b', create: true });
    expect(again.created).toBe(false);
    expect(provider.callsOf('create')).toHaveLength(1);
  });

  it('wakes a suspended or stopped machine only when asked to', async () => {
    const { provider, coordinator } = setup();
    const { machine } = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b', create: true });
    provider.setState(machine.name, 'suspended');
    const looked = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b' });
    expect(looked).toMatchObject({ woke: false, machine: { state: 'suspended' } });
    expect(provider.methods()).not.toContain('resume');
    const woken = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b', wake: true });
    expect(woken).toMatchObject({ woke: true, machine: { state: 'running' } });
    expect(provider.methods()).toContain('resume');
    provider.setState(machine.name, 'stopped');
    await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'b', wake: true });
    expect(provider.methods()).toContain('start');
  });

  it('says when a branch has no machine, or two', async () => {
    const { provider, coordinator } = setup();
    await expect(coordinator.locate({ repo: REPO, repoName: 'app', branch: 'none' })).rejects.toMatchObject({ code: 'machine-not-found' });
    await provider.create({ name: 'kunj-app-x-1', labels: machineLabels(REPO, 'x'), size: 'small', image: '', diskGb: 30, spot: false, selfSuspend: false });
    await provider.create({ name: 'kunj-app-x-2', labels: machineLabels(REPO, 'x'), size: 'small', image: '', diskGb: 30, spot: false, selfSuspend: false });
    await expect(coordinator.locate({ repo: REPO, repoName: 'app', branch: 'x' })).rejects.toMatchObject({ code: 'machine-ambiguous' });
  });

  it('gives up on a machine it cannot pair with, or whose serve refuses its token', async () => {
    const { provider, serves, tokens, coordinator } = setup();
    const create = provider.create.bind(provider);
    provider.create = async spec => {
      const m = await create(spec);
      serves.boot(m.addresses.internal!, { pairing: false });
      return m;
    };
    await expect(coordinator.locate({ repo: REPO, repoName: 'app', branch: 'p', create: true })).rejects.toMatchObject({ code: 'machine-token' });

    const ok = setup();
    const { machine } = await ok.coordinator.locate({ repo: REPO, repoName: 'app', branch: 'q', create: true });
    ok.serves.serves.get(machine.addresses.internal!)!.token = 'rotated';
    await expect(ok.coordinator.locate({ repo: REPO, repoName: 'app', branch: 'q', wake: true })).rejects.toMatchObject({ code: 'machine-token' });
    expect(ok.tokens.all.has(machine.name)).toBe(false);
    expect(tokens.all.size).toBe(0);
  });

  it('keeps a live machine\'s token when a create is refused because the name exists', async () => {
    const { provider, tokens, coordinator } = setup();
    const name = machineName('app', REPO, 'raced');
    tokens.set(name, 'token-of-the-live-machine');
    // another coordinator created it between this one's find and its create
    provider.create = async () => {
      throw new MachineError(`A machine named ${name} already exists.`, 'machine-exists');
    };
    await expect(coordinator.locate({ repo: REPO, repoName: 'app', branch: 'raced', create: true })).rejects.toMatchObject({ code: 'machine-exists' });
    expect(tokens.all.get(name)).toBe('token-of-the-live-machine');
  });

  it('survives a lost pairing reply: the retry carries the same nonce and gets the same token', async () => {
    const { provider, serves, tokens, coordinator } = setup();
    const nonces: string[] = [];
    const real = serves.caller;
    const granted = new Map<string, string>();
    let dropped = false;
    serves.caller = async (baseUrl, method, route, token, body) => {
      if (route !== '/v1/pair') return real(baseUrl, method, route, token, body);
      const nonce = (body as { nonce: string }).nonce;
      nonces.push(nonce);
      const host = new URL(baseUrl).hostname;
      const s = serves.serves.get(host)!;
      if (!granted.has(nonce)) {
        if (s.token) return { status: 403, body: {} };
        s.token = `tok-${host}`;
        granted.set(nonce, s.token);
      }
      if (!dropped) {
        dropped = true;
        throw new Error('ECONNRESET');
      }
      return { status: 200, body: { token: granted.get(nonce) } };
    };
    const c = new Coordinator({ ...(coordinator as any).opts, call: (...a: Parameters<typeof serves.caller>) => serves.caller(...a) });
    const r = await c.locate({ repo: REPO, repoName: 'app', branch: 'lossy', create: true });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
    expect(nonces[0].length).toBeGreaterThanOrEqual(16);
    expect(tokens.all.get(r.machine.name)).toBe(`tok-${r.machine.addresses.internal}`);
    void provider;
  });

  it('gives a new machine the startup script and the configured image', async () => {
    const { provider, coordinator } = setup();
    const c = new Coordinator({ ...(coordinator as any).opts, startupScript: '#!/bin/bash\n', defaults: { ...(coordinator as any).opts.defaults, image: 'kunj-img-1' } });
    const r = await c.locate({ repo: REPO, repoName: 'app', branch: 'img', create: true });
    expect(provider.specs.get(r.machine.name)).toMatchObject({ startupScript: '#!/bin/bash\n', image: 'kunj-img-1' });
    expect(r.machine.labels['kunj.image']).toBe('kunj-img-1');
  });

  it('keeps trying when the tunnel cannot come up yet (the port is closed while the machine installs)', async () => {
    let stored = '';
    const machineServe = createServeServer({ backend: new FakeBackend(), version: '1', pairing: { until: Date.now() + 60_000, onPaired: t => (stored = t) } });
    const { port } = await machineServe.listen('127.0.0.1', 0);
    let opens = 0;
    try {
      const { coordinator, tokens } = setup({
        network: 'tunnel',
        call: undefined,
        freePort: async () => port,
        openTunnel: async () => {
          if (++opens <= 3) throw new Error('gcloud ended before the tunnel was up');
          return { close: async () => {} };
        },
        sleep: async () => {},
        now: Date.now,
      });
      const r = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'booting', create: true });
      expect(opens).toBeGreaterThan(3);
      expect(tokens.all.get(r.machine.name)).toBe(stored);
    } finally {
      await machineServe.close();
    }
  });

  it('times out on a machine that never answers', async () => {
    const { provider, coordinator } = setup();
    // created, but its serve never comes up
    provider.create = FakeProvider.prototype.create.bind(provider);
    await expect(coordinator.locate({ repo: REPO, repoName: 'app', branch: 't', create: true })).rejects.toMatchObject({ code: 'machine-timeout', message: expect.stringContaining('Last error: ECONNREFUSED') });
  });

  it('deletes a machine with its token and refuses another tool\'s machine', async () => {
    const { provider, tokens, coordinator } = setup();
    const { machine } = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'd', create: true });
    await coordinator.delete(machine.name, { disks: true });
    expect(provider.machines.has(machine.name)).toBe(false);
    expect(tokens.all.has(machine.name)).toBe(false);
    provider.addForeign('their-vm');
    await expect(coordinator.delete('their-vm', { disks: true })).rejects.toMatchObject({ code: 'machine-not-kunj' });
    await expect(coordinator.suspend('their-vm')).rejects.toMatchObject({ code: 'machine-not-kunj' });
    expect((await coordinator.list()).map(m => m.name)).not.toContain('their-vm');
  });

  it('pairs with a real kunj serve through a provider tunnel', async () => {
    let stored = '';
    const machineServe = createServeServer({ backend: new FakeBackend(), version: '1', pairing: { until: Date.now() + 60_000, onPaired: t => (stored = t) } });
    const { port } = await machineServe.listen('127.0.0.1', 0);
    const opened: string[][] = [];
    try {
      const { coordinator, tokens } = setup({
        network: 'tunnel',
        call: undefined,
        freePort: async () => port,
        openTunnel: async argv => {
          opened.push(argv);
          return { close: async () => {} };
        },
        sleep: async () => {},
        now: Date.now,
      });
      const r = await coordinator.locate({ repo: REPO, repoName: 'app', branch: 'real', create: true });
      expect(stored).not.toBe('');
      expect(tokens.all.get(r.machine.name)).toBe(stored);
      expect(opened[0]).toEqual(['fake-tunnel', r.machine.name, '7433', String(port)]);
    } finally {
      await machineServe.close();
    }
  });
});

// ---- the routes -------------------------------------------------------------------------------

function call(port: number, method: string, p: string, body?: unknown, token = 'coord-token-0123456789'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('kunj serve --machines routes', () => {
  let server: ServeServer;
  let port: number;
  let env: ReturnType<typeof setup>;

  beforeEach(async () => {
    env = setup();
    server = createServeServer({ backend: new FakeBackend(), token: 'coord-token-0123456789', version: '1', extend: machineRoutes(env.coordinator) });
    port = (await server.listen('127.0.0.1', 0)).port;
  });
  afterEach(() => server.close());

  it('says it coordinates machines in /v1/info and lists its provider', async () => {
    const info = await call(port, 'GET', '/v1/info');
    expect(info.body.machines).toEqual({ provider: 'fake', network: 'private', features: env.provider.features });
    const providers = await call(port, 'GET', '/v1/machines/providers');
    expect(providers.body.sizes.map((s: any) => s.name)).toEqual(['small', 'medium', 'large']);
  });

  it('creates through locate, with the calling client as owner, then lists, suspends, resumes and deletes', async () => {
    const created = await call(port, 'POST', '/v1/machines/locate', { repo: REPO, repoName: 'app', branch: 'feature/x', create: true, size: 'large' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ created: true, machine: { repo: REPO, branch: 'feature/x', state: 'running', size: 'fake-16', owner: 'default', paired: true } });
    const name = created.body.machine.name;

    const listed = await call(port, 'GET', `/v1/machines?label=${encodeURIComponent(`kunj.repo=${REPO}`)}`);
    expect(listed.body.machines.map((m: any) => m.name)).toEqual([name]);

    expect((await call(port, 'POST', `/v1/machines/${name}/suspend`)).body.machine.state).toBe('suspended');
    expect((await call(port, 'POST', `/v1/machines/${name}/resume`)).body.machine.state).toBe('running');
    expect((await call(port, 'DELETE', `/v1/machines/${name}`)).body).toEqual({ deleted: name });
    expect(env.provider.callsOf('delete')[0].args[1]).toEqual({ disks: true });
  });

  it('maps machine errors to their codes and refuses bad input', async () => {
    const missing = await call(port, 'POST', '/v1/machines/locate', { repo: REPO, branch: 'none' });
    expect(missing).toEqual({ status: 404, body: { error: { code: 'machine-not-found', message: expect.stringContaining('has no machine') } } });
    expect((await call(port, 'POST', '/v1/machines/locate', { branch: 'x' })).status).toBe(400);
    expect((await call(port, 'POST', '/v1/machines/Not_A_Name/suspend')).status).toBe(400);
    env.provider.addForeign('their-vm');
    expect((await call(port, 'DELETE', '/v1/machines/their-vm')).body.error.code).toBe('machine-not-kunj');
    expect((await call(port, 'GET', '/v1/machines', undefined, 'wrong')).status).toBe(401);
  });
});
