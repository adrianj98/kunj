import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeBackend } from '../../container/__tests__/fake-backend';
import { createServeServer, ServeServer } from '../../serve/server';
import { machineRoutes } from '../../serve/machines';
import { Coordinator, memoryTokenStore } from '../coordinator';
import { coordinatorPaths } from '../config';
import { ensureLocalCoordinator, readRecord, removeRecord, resolveCoordinator, writeRecord } from '../local-coordinator';
import { FakeProvider } from './fake-provider';
import { KunjConfig } from '../../../types';

const CONFIG = { machine: { provider: 'fake' } } as unknown as KunjConfig;

/** A coordinator serving in this process, as the detached `kunj serve --machines` would. */
async function startCoordinator(dir: string, opts: { machines?: boolean } = {}): Promise<ServeServer> {
  const paths = coordinatorPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(paths.token, 'local-token-0123456789\n', { mode: 0o600 });
  const coordinator = new Coordinator({
    provider: new FakeProvider(),
    network: 'tunnel',
    tokens: memoryTokenStore(),
    version: '1',
    defaults: { size: 'medium', diskGb: 30, spot: false, selfSuspend: true, bootTimeoutMs: 1000 },
  });
  const server = createServeServer({ backend: new FakeBackend(), token: 'local-token-0123456789', version: '1', extend: opts.machines === false ? undefined : machineRoutes(coordinator) });
  const { port } = await server.listen('127.0.0.1', 0);
  writeRecord(paths.record, { pid: process.pid, port, version: '1', startedAt: new Date().toISOString() });
  return server;
}

describe('the local coordinator', () => {
  let dir: string;
  const servers: ServeServer[] = [];
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-local-')), 'coordinator');
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('starts kunj serve --machines on loopback with an idle exit, then reuses the running one', async () => {
    const started: string[][] = [];
    const start = (argv: string[], log: string) => {
      started.push(argv);
      expect(log).toBe(path.join(dir, 'serve.log'));
      void startCoordinator(dir).then(s => servers.push(s));
    };
    const first = await ensureLocalCoordinator({ ...CONFIG, machine: { provider: 'fake', coordinatorIdleMinutes: 15 } } as KunjConfig, { dir, start });
    expect(first.kind).toBe('local');
    expect(started).toHaveLength(1);
    expect(started[0].slice(-6)).toEqual(['serve', '--machines', '--listen', '127.0.0.1:0', '--idle-exit', '15']);
    expect((await first.client.providers()).provider).toBe('fake');

    const second = await ensureLocalCoordinator(CONFIG, { dir, start });
    expect(started).toHaveLength(1);
    expect((await second.client.list()).length).toBe(0);
  });

  it('starts one coordinator when two commands ask at once, and takes over a dead start\'s lock', async () => {
    const started: string[][] = [];
    const start = (argv: string[]) => {
      started.push(argv);
      void startCoordinator(dir).then(s => servers.push(s));
    };
    const [a, b] = await Promise.all([ensureLocalCoordinator(CONFIG, { dir, start }), ensureLocalCoordinator(CONFIG, { dir, start })]);
    expect(started).toHaveLength(1);
    expect(a.client.opts.baseUrl).toBe(b.client.opts.baseUrl);
    expect(fs.existsSync(path.join(dir, 'start.lock'))).toBe(false);

    // a lock left by a start that died long ago does not block the next start
    for (const s of servers.splice(0)) await s.close();
    fs.rmSync(path.join(dir, 'coordinator.json'), { force: true });
    fs.writeFileSync(path.join(dir, 'start.lock'), '1');
    fs.utimesSync(path.join(dir, 'start.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await ensureLocalCoordinator(CONFIG, { dir, start, waitMs: 5000 });
    expect(started).toHaveLength(2);
  });

  it('says so, with the log, when the coordinator does not come up', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'serve.log'), 'Error: machine.gce.project is not set\n');
    await expect(ensureLocalCoordinator(CONFIG, { dir, start: () => {}, waitMs: 300 })).rejects.toMatchObject({
      code: 'coordinator-start-failed',
      message: expect.stringContaining('machine.gce.project is not set'),
    });
  });

  it('keeps its record only while its process lives and removes only its own', () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'coordinator.json');
    writeRecord(file, { pid: 999999, port: 1, version: '1', startedAt: '' });
    expect(readRecord(file)).toBeNull();
    writeRecord(file, { pid: process.pid, port: 1, version: '1', startedAt: '' });
    expect(readRecord(file)?.pid).toBe(process.pid);
    removeRecord(file, 12345);
    expect(fs.existsSync(file)).toBe(true);
    removeRecord(file, process.pid);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('resolveCoordinator', () => {
  let dir: string;
  const servers: ServeServer[] = [];
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-resolve-')), 'coordinator');
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  async function remoteAt(machines: boolean): Promise<string> {
    const s = await startCoordinator(path.join(path.dirname(dir), machines ? 'remote-coord' : 'remote-plain'), { machines });
    servers.push(s);
    const record = readRecord(coordinatorPaths(path.join(path.dirname(dir), machines ? 'remote-coord' : 'remote-plain')).record)!;
    return `http://127.0.0.1:${record.port}`;
  }

  it('uses a remote that coordinates machines', async () => {
    const url = await remoteAt(true);
    const access = await resolveCoordinator({ remote: 'cloud', config: {} as KunjConfig, remotes: () => ({ url, token: 'local-token-0123456789', addedAt: '' }) });
    expect(access).toMatchObject({ kind: 'remote', name: 'cloud' });
  });

  it('refuses a plain Docker remote named with --remote, and falls back to the local coordinator from container.remote', async () => {
    const url = await remoteAt(false);
    const remotes = () => ({ url, token: 'local-token-0123456789', addedAt: '' });
    await expect(resolveCoordinator({ remote: 'box', config: CONFIG, remotes })).rejects.toMatchObject({ code: 'coordinator-no-machines' });
    const start = () => void startCoordinator(dir).then(s => servers.push(s));
    const access = await resolveCoordinator({ config: { ...CONFIG, container: { remote: 'box' } } as KunjConfig, remotes, local: { dir, start } });
    expect(access.kind).toBe('local');
    await expect(resolveCoordinator({ config: { container: { remote: 'box' } } as KunjConfig, remotes })).rejects.toMatchObject({ code: 'coordinator-no-machines' });
  });

  it('asks for machine.provider when there is no coordinator at all', async () => {
    await expect(resolveCoordinator({ config: {} as KunjConfig })).rejects.toMatchObject({ code: 'machine-provider' });
    await expect(resolveCoordinator({ remote: 'local', config: {} as KunjConfig })).rejects.toMatchObject({ code: 'machine-provider' });
  });
});
