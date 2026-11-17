import { PassThrough } from 'stream';
import { FakeBackend } from '../../container/__tests__/fake-backend';
import { RemoteKunjBackend } from '../../container/remote';
import { selectBackend } from '../../container/select-backend';
import { ServeServer, createServeServer } from '../../serve/server';
import { machineRoutes } from '../../serve/machines';
import { proxyRoute } from '../../serve/proxy';
import { Coordinator, memoryTokenStore } from '../coordinator';
import { FakeProvider } from './fake-provider';
import { KunjConfig } from '../../../types';

const REPO = 'github.com/acme/app';
const CLIENT_TOKEN = 'client-token-0123456789';

/**
 * A coordinator in front of one machine serve, both in this process: the provider's "tunnel" to any
 * machine leads to the machine serve's port, and that serve pairs like a real first boot.
 */
async function fleet() {
  const machineBackend = new FakeBackend();
  let machineToken = '';
  const machineServe = createServeServer({ backend: machineBackend, version: 'm', pairing: { until: Date.now() + 60_000, onPaired: t => (machineToken = t) } });
  const machinePort = (await machineServe.listen('127.0.0.1', 0)).port;

  const provider = new FakeProvider();
  const tokens = memoryTokenStore();
  let tunnels = 0;
  let clock = Date.now();
  const coordinator = new Coordinator({
    provider,
    network: 'tunnel',
    tokens,
    version: '1',
    defaults: { size: 'medium', diskGb: 30, spot: false, selfSuspend: false, bootTimeoutMs: 5000 },
    freePort: async () => machinePort,
    openTunnel: async () => {
      tunnels++;
      return { close: async () => {} };
    },
    sleep: async () => {},
    now: () => clock,
  });
  const coordServe = createServeServer({ backend: new FakeBackend(), token: CLIENT_TOKEN, version: 'c', extend: machineRoutes(coordinator) });
  const coordPort = (await coordServe.listen('127.0.0.1', 0)).port;
  const servers: ServeServer[] = [machineServe, coordServe];
  return {
    machineBackend,
    provider,
    coordinator,
    tokens,
    baseUrl: `http://127.0.0.1:${coordPort}`,
    machineToken: () => machineToken,
    tunnels: () => tunnels,
    advance: (ms: number) => (clock += ms),
    close: async () => {
      await coordinator.close();
      for (const s of servers) await s.close();
    },
  };
}

const select = (f: Awaited<ReturnType<typeof fleet>>, machine: { branch: string; wake: boolean; create: boolean }) =>
  selectBackend({
    remote: 'cloud',
    config: {} as KunjConfig,
    remotes: () => ({ url: f.baseUrl, token: CLIENT_TOKEN, addedAt: '' }),
    machine: { repo: REPO, repoName: 'app', ...machine },
  });

describe('proxyRoute', () => {
  it('recognises only a machine serve path', () => {
    expect(proxyRoute('/v1/machines/kunj-app-x-abc123/serve/v1/containers')).toEqual({ name: 'kunj-app-x-abc123', path: '/v1/containers' });
    expect(proxyRoute('/v1/machines/kunj-app-x-abc123/suspend')).toBeNull();
    expect(proxyRoute('/v1/machines/Bad_Name/serve/v1/info')).toBeNull();
    expect(proxyRoute('/v1/machines/a/serve/other')).toBeNull();
  });
});

describe('containers on a machine, through the coordinator', () => {
  let f: Awaited<ReturnType<typeof fleet>>;
  beforeEach(async () => {
    f = await fleet();
  });
  afterEach(() => f.close());

  it('creates the branch\'s machine and runs backend calls, an exec stream and an upload on it', async () => {
    const sel = await select(f, { branch: 'feature/x', wake: true, create: true });
    try {
      expect(sel.kind).toBe('remote');
      expect(f.provider.machines.size).toBe(1);

      // unary: lands on the machine's backend, not the coordinator's
      await sel.backend.createVolume('kunj-app-x-ws', { 'kunj.repo': REPO });
      expect(f.machineBackend.callsOf('createVolume')).toHaveLength(1);
      expect(await sel.backend.list({ 'kunj.repo': REPO })).toEqual([]);

      // a WebSocket exec, both directions
      const id = await sel.backend.run({
        name: 'kunj-app-x-abc',
        image: 'kunj-sandbox:1-a',
        labels: { 'kunj.repo': REPO, 'kunj.branch': 'feature/x' },
        env: { SECRET: 's3cret' },
        network: 'n',
        workdir: '/workspace',
        volumes: [],
        publish: [],
        command: ['sleep', 'infinity'],
      });
      f.machineBackend.execResults.set('echo hello', { exitCode: 0, stdout: 'hello\n' });
      const out = await sel.backend.exec(id, ['echo', 'hello']);
      expect(out).toEqual({ exitCode: 0, stdout: 'hello\n' });

      // a streamed body
      const tar = new PassThrough();
      tar.end(Buffer.alloc(300_000, 7));
      await sel.backend.copyIn(id, '/workspace', tar);
      expect(f.machineBackend.callsOf('copyIn')).toHaveLength(1);

      // one tunnel served all of it (pairing and readiness opened their own before)
      const before = f.tunnels();
      await sel.backend.list({});
      await sel.backend.list({});
      expect(f.tunnels()).toBe(before);
    } finally {
      await sel.close();
    }
  });

  it('never hands the client the machine\'s token, and refuses a client without the coordinator\'s', async () => {
    const sel = await select(f, { branch: 'b', wake: true, create: true });
    await sel.close();
    const name = [...f.provider.machines.keys()][0];
    expect(f.machineToken()).not.toBe('');
    const direct = new RemoteKunjBackend({ baseUrl: f.baseUrl, token: 'wrong-token-000000000', name: 'x', basePath: `/v1/machines/${name}/serve` });
    await expect(direct.ready()).rejects.toMatchObject({ code: 'remote-unauthorized' });
    const withMachineToken = new RemoteKunjBackend({ baseUrl: f.baseUrl, token: f.machineToken(), name: 'x', basePath: `/v1/machines/${name}/serve` });
    await expect(withMachineToken.ready()).rejects.toMatchObject({ code: 'remote-unauthorized' });
  });

  it('does not wake a sleeping machine for a command that only looks, and wakes it for one that acts', async () => {
    (await select(f, { branch: 'b', wake: true, create: true })).close();
    const name = [...f.provider.machines.keys()][0];
    await f.coordinator.suspend(name);
    await expect(select(f, { branch: 'b', wake: false, create: false })).rejects.toThrow(/is suspended/);
    expect(f.provider.methods()).not.toContain('resume');
    const sel = await select(f, { branch: 'b', wake: true, create: false });
    await sel.close();
    expect(f.provider.methods()).toContain('resume');
  });

  it('says a coordinator needs a branch, and that a branch has no machine', async () => {
    await expect(selectBackend({ remote: 'cloud', config: {} as KunjConfig, remotes: () => ({ url: f.baseUrl, token: CLIENT_TOKEN, addedAt: '' }) })).rejects.toThrow(/needs a branch/);
    await expect(select(f, { branch: 'none', wake: true, create: false })).rejects.toMatchObject({ code: 'machine-not-found' });
  });

  it('answers machine-asleep when the proxied machine is not running', async () => {
    (await select(f, { branch: 'b', wake: true, create: true })).close();
    const name = [...f.provider.machines.keys()][0];
    await f.coordinator.suspend(name);
    const direct = new RemoteKunjBackend({ baseUrl: f.baseUrl, token: CLIENT_TOKEN, name: 'x', basePath: `/v1/machines/${name}/serve` });
    await expect(direct.ready()).rejects.toThrow(/suspended/);
  });

  it('uses this machine\'s own coordinator for --remote machines', async () => {
    const sel = await selectBackend({
      remote: 'machines',
      config: {} as KunjConfig,
      localCoordinator: async () => ({ baseUrl: f.baseUrl, token: CLIENT_TOKEN }),
      machine: { repo: REPO, repoName: 'app', branch: 'local-one', wake: true, create: true },
    });
    await sel.close();
    expect(sel.remote).toBe('machines');
    expect(f.provider.machines.size).toBe(1);
  });
});

describe('the shared endpoint', () => {
  it('survives one failed request while another is still on it, and an old timer never closes a newer one', async () => {
    jest.useFakeTimers();
    const released: number[] = [];
    let opened = 0;
    const provider = new FakeProvider();
    const tokens = memoryTokenStore();
    const coordinator = new Coordinator({
      provider,
      network: 'tunnel',
      tokens,
      version: '1',
      defaults: { size: 'medium', diskGb: 30, spot: false, selfSuspend: false, bootTimeoutMs: 1000 },
      freePort: async () => 40000 + opened,
      openTunnel: async () => {
        const id = ++opened;
        return { close: async () => void released.push(id) };
      },
    });
    try {
      await provider.create({ name: 'kunj-app-a-111111', labels: { 'kunj.repo': 'r', 'kunj.branch': 'a', 'kunj.role': 'machine' }, size: 'small', image: '', diskGb: 30, spot: false, selfSuspend: false });
      tokens.set('kunj-app-a-111111', 't');
      const a = await coordinator.proxyTarget('kunj-app-a-111111');
      const b = await coordinator.proxyTarget('kunj-app-a-111111');
      expect(opened).toBe(1);
      b.done(true); // B's connection failed
      await Promise.resolve();
      expect(released).toEqual([]); // A is still on tunnel 1
      // A, on the retired tunnel, still counts: the machine is in use and must not be suspended
      expect(await coordinator.openProxies()).toBe(1);
      expect(await coordinator.idleTick(0, async () => false)).toEqual([]);
      expect(provider.methods()).not.toContain('suspend');
      const c = await coordinator.proxyTarget('kunj-app-a-111111'); // a new request gets a new tunnel
      expect(opened).toBe(2);
      a.done(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(released).toEqual([1]);
      jest.advanceTimersByTime(120_000); // nothing left of tunnel 1 may touch tunnel 2
      await Promise.resolve();
      expect(released).toEqual([1]);
      c.done(false);
      jest.advanceTimersByTime(61_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(released).toEqual([1, 2]);
      expect(await coordinator.openProxies()).toBe(0);
    } finally {
      jest.useRealTimers();
      await coordinator.close();
    }
  });
});

describe('idle machines', () => {
  let f: Awaited<ReturnType<typeof fleet>>;
  beforeEach(async () => {
    f = await fleet();
  });
  afterEach(() => f.close());

  it('suspends a machine only after a quiet spell with no agent working, and never one in use', async () => {
    const sel = await select(f, { branch: 'b', wake: true, create: true });
    const name = [...f.provider.machines.keys()][0];
    const IDLE = 30 * 60_000;
    let agent = true;
    const busy = async () => agent;

    f.advance(IDLE + 1);
    expect(await f.coordinator.idleTick(IDLE, busy)).toEqual([]); // an agent is working
    agent = false;
    expect(await f.coordinator.idleTick(IDLE, busy)).toEqual([]); // quiet only since now
    f.advance(IDLE - 60_000);
    await sel.backend.list({}); // someone used it
    f.advance(IDLE - 60_000);
    expect(await f.coordinator.idleTick(IDLE, busy)).toEqual([]);
    f.advance(2 * 60_000);
    expect(await f.coordinator.idleTick(IDLE, busy)).toEqual([name]);
    expect(f.provider.machines.get(name)?.state).toBe('suspended');
    expect(await f.coordinator.idleTick(IDLE, busy)).toEqual([]); // asleep: nothing to do
    await sel.close();
  });

  it('does not keep a machine awake because its serve cannot be asked', async () => {
    (await select(f, { branch: 'b', wake: true, create: true })).close();
    const name = [...f.provider.machines.keys()][0];
    const unreachable = async () => {
      throw new Error('no answer');
    };
    expect(await f.coordinator.idleTick(60_000, unreachable)).toEqual([]);
    f.advance(61_000);
    expect(await f.coordinator.idleTick(60_000, unreachable)).toEqual([name]);
  });
});
