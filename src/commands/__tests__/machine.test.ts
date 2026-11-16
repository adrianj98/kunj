import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeBackend } from '../../lib/container/__tests__/fake-backend';
import { FakeProvider } from '../../lib/machines/__tests__/fake-provider';
import { MachineClient } from '../../lib/machines/client';
import { Coordinator, ServeCaller, memoryTokenStore } from '../../lib/machines/coordinator';
import { writeRecord } from '../../lib/machines/local-coordinator';
import { ServeServer, createServeServer } from '../../lib/serve/server';
import { machineRoutes } from '../../lib/serve/machines';
import { isFastCommand } from '../fast';
import { MachineCommand } from '../machine';

jest.mock('../../lib/config', () => ({
  getGlobalKunjDir: jest.fn(() => '/nowhere/.kunj'),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

const REPO = { id: 'github.com/acme/app', name: 'app' };

describe('kunj machine', () => {
  let server: ServeServer;
  let provider: FakeProvider;
  let client: MachineClient;
  let stdout: string[];

  beforeEach(async () => {
    provider = new FakeProvider();
    // every machine's serve pairs at once and answers
    const tokens = new Map<string, string>();
    const call: ServeCaller = async (baseUrl, method, route, token) => {
      const host = new URL(baseUrl).hostname;
      if (method === 'POST' && route === '/v1/pair') {
        tokens.set(host, `t-${host}`);
        return { status: 200, body: { token: `t-${host}` } };
      }
      return token === tokens.get(host) ? { status: 200, body: {} } : { status: 401, body: {} };
    };
    const coordinator = new Coordinator({
      provider,
      network: 'private',
      tokens: memoryTokenStore(),
      version: '1.2.3',
      defaults: { size: 'medium', diskGb: 30, spot: false, selfSuspend: false, bootTimeoutMs: 1000 },
      call,
      sleep: async () => {},
    });
    server = createServeServer({ backend: new FakeBackend(), token: 'cli-token-0123456789', version: '1', extend: machineRoutes(coordinator) });
    const { port } = await server.listen('127.0.0.1', 0);
    client = new MachineClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'cli-token-0123456789', name: 'the local coordinator' });
    stdout = [];
    jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.close();
  });

  const cmd = (extra: Partial<ConstructorParameters<typeof MachineCommand>[0]> = {}) =>
    new MachineCommand({
      coordinator: async () => ({ client, name: 'local', kind: 'local', close: async () => {} }),
      repo: () => REPO,
      branch: async () => 'feature/x',
      ...extra,
    });
  const json = () => JSON.parse(stdout.pop()!);

  it('is on the fast path', () => {
    expect(isFastCommand('machine')).toBe(true);
  });

  it('creates the current branch\'s machine, then lists, suspends, resumes and deletes it', async () => {
    await cmd().execute('create', { json: true, size: 'large' });
    const created = json();
    expect(created).toMatchObject({ coordinator: 'local', created: true, machine: { repo: REPO.id, branch: 'feature/x', size: 'fake-16', state: 'running', paired: true } });

    await cmd().execute('create', { json: true });
    expect(json().created).toBe(false);

    await cmd().execute('list', { json: true });
    expect(json()).toEqual({ coordinator: 'local', repo: REPO.id, machines: [expect.objectContaining({ name: created.machine.name })] });

    await cmd().execute('suspend', { json: true });
    expect(json().machine.state).toBe('suspended');
    await cmd().execute('status', 'feature/x', { json: true });
    expect(json().machine.state).toBe('suspended');
    await cmd().execute('resume', { json: true });
    expect(json()).toMatchObject({ woke: true, machine: { state: 'running' } });

    await expect(cmd().execute('delete', { json: true })).rejects.toThrow(/--yes/);
    await cmd().execute('delete', { json: true, yes: true, keepDisks: true });
    expect(json()).toEqual({ coordinator: 'local', deleted: created.machine.name });
    expect(provider.callsOf('delete')[0].args[1]).toEqual({ disks: false });
  });

  it('asks before deleting on a terminal and deletes nothing on no', async () => {
    await cmd().execute('create', {});
    const asked: string[] = [];
    await cmd({ confirm: async m => (asked.push(m), false) }).execute('delete', {});
    expect(asked[0]).toMatch(/Delete machine kunj-app-feature-x-.* and its disks\?/);
    expect(provider.machines.size).toBe(1);
    await cmd({ confirm: async () => true }).execute('delete', {});
    expect(provider.machines.size).toBe(0);
  });

  it('lists in text, says when there is nothing, and shows the provider', async () => {
    await cmd().execute('list', {});
    expect(stdout.pop()).toMatch(/No machines for app/);
    await cmd().execute('create', 'b2', {});
    stdout.length = 0;
    await cmd().execute({});
    expect(stdout.join('\n')).toMatch(/running\s+b2\s+kunj-app-b2-/);
    await cmd().execute('providers', {});
    expect(stdout.join('\n')).toMatch(/fake via the local coordinator \(private network\)/);
    expect(stdout.join('\n')).toMatch(/medium\s+fake-8/);
  });

  it('passes machine errors on with their code', async () => {
    await expect(cmd().execute('status', 'nothing-here', { json: true })).rejects.toMatchObject({ code: 'machine-not-found' });
    await expect(cmd().execute('frobnicate', {})).rejects.toThrow(/Unknown machine action/);
    await expect(cmd({ branch: async () => '' }).execute('status', {})).rejects.toThrow(/not on a branch/);
  });

  it('reports and stops the local coordinator from its record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-mc-'));
    try {
      await cmd({ coordinatorDir: dir }).execute('coordinator', { json: true });
      expect(json()).toEqual({ running: false, log: path.join(dir, 'serve.log') });
      const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      writeRecord(path.join(dir, 'coordinator.json'), { pid: child.pid, port: 4242, version: '1', startedAt: 'then' });
      await cmd({ coordinatorDir: dir }).execute('coordinator', 'status', { json: true });
      expect(json()).toMatchObject({ running: true, pid: child.pid, port: 4242 });
      const exited = new Promise(r => child.on('exit', r));
      await cmd({ coordinatorDir: dir }).execute('coordinator', 'stop', { json: true });
      expect(json()).toMatchObject({ running: true, stopped: true, pid: child.pid });
      await exited;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
