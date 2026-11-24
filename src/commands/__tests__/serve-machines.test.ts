import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { FakeBackend } from '../../lib/container/__tests__/fake-backend';
import { FakeProvider } from '../../lib/machines/__tests__/fake-provider';
import { ServeCommand } from '../serve';

const mockConfig: { value: Record<string, unknown> } = { value: {} };
jest.mock('../../lib/config', () => ({
  getGlobalKunjDir: jest.fn(() => '/nowhere/.kunj'),
  loadResolvedConfig: jest.fn(async () => mockConfig.value),
}));

function request(port: number, method: string, pathname: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('kunj serve --machines and --allow-pairing', () => {
  let dir: string;
  let stderr: string[];
  let stdout: string[];
  let fake: FakeBackend;
  let provider: FakeProvider;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-coord-'));
    stderr = [];
    stdout = [];
    fake = new FakeBackend();
    provider = new FakeProvider();
    mockConfig.value = { machine: { provider: 'fake', fake: { project: 'p' } } };
    jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const command = (onListening?: (a: { host: string; port: number }, stop: () => void) => void, given: string[] = []) =>
    new ServeCommand({
      backend: async () => fake,
      coordinatorDir: path.join(dir, 'coordinator'),
      tokenFile: given.includes('tokenFile') ? path.join(dir, 'machine', 'token') : undefined,
      provider: async (name, cfg) => {
        expect(name).toBe('fake');
        expect(cfg).toEqual({ project: 'p' });
        return provider;
      },
      onListening,
      stderr: l => stderr.push(l),
    });

  it('coordinates machines: its own token dir, a record with its port, /v1/info and the machine routes; no Docker needed', async () => {
    fake.failOn = 'info';
    const record = path.join(dir, 'coordinator', 'coordinator.json');
    await command(async (a, stop) => {
      const written = JSON.parse(fs.readFileSync(record, 'utf8'));
      expect(written).toMatchObject({ pid: process.pid, port: a.port });
      const token = fs.readFileSync(path.join(dir, 'coordinator', 'token'), 'utf8').trim();
      const info = await request(a.port, 'GET', '/v1/info', token);
      expect(info.body.machines).toEqual({ provider: 'fake', network: 'tunnel', features: provider.features });
      expect((await request(a.port, 'GET', '/v1/machines', token)).body).toEqual({ machines: [] });
      stop();
    }).execute({ machines: true, listen: '127.0.0.1:0' });
    expect(fs.existsSync(record)).toBe(false);
    expect(stderr.join('\n')).toMatch(/coordinator for fake; no Docker here/);
  });

  it('refuses --machines without machine.provider, and with --allow-pairing', async () => {
    mockConfig.value = {};
    await expect(command(() => {}).execute({ machines: true, listen: '127.0.0.1:0' })).rejects.toThrow(/machine.provider/);
    await expect(command(() => {}).execute({ machines: true, allowPairing: true })).rejects.toThrow(/do not go together/);
  });

  it('exits on its own after --idle-exit with no request', async () => {
    const started = Date.now();
    await command(() => {}).execute({ machines: true, listen: '127.0.0.1:0', idleExit: '0.002' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stderr.join('\n')).toMatch(/no request for 0.002 min: exiting/);
  });

  it('an auto-started coordinator exits once coordinator.json names another one', async () => {
    const record = path.join(dir, 'coordinator', 'coordinator.json');
    const cmd = new ServeCommand({
      backend: async () => fake, coordinatorDir: path.join(dir, 'coordinator'), provider: async () => provider,
      onListening: () => {
        // a later start took over
        fs.writeFileSync(record, JSON.stringify({ pid: process.pid + 100000, port: 1, version: 'x', startedAt: 'x' }));
      },
      stderr: l => stderr.push(l), ownerCheckMs: 20,
    });
    const started = Date.now();
    await cmd.execute({ machines: true, listen: '127.0.0.1:0', idleExit: '60' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stderr.join('\n')).toMatch(/coordinator \d+ took over: exiting/);
    // the newer one's record is left alone
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).pid).toBe(process.pid + 100000);
  });

  it('a coordinator listens without waiting for a Docker that does not answer', async () => {
    fake.info = () => new Promise(() => {});
    let listened = false;
    const cmd = new ServeCommand({
      backend: async () => fake, coordinatorDir: path.join(dir, 'coordinator'), provider: async () => provider,
      onListening: (_a, stop) => { listened = true; stop(); },
      stderr: l => stderr.push(l), coordinatorDockerWaitMs: 20,
    });
    await cmd.execute({ machines: true, listen: '127.0.0.1:0' });
    expect(listened).toBe(true);
    expect(stderr.join('\n')).toMatch(/no Docker here/);
  });

  it('keeps named client tokens for the coordinator with token add|list|remove --machines', async () => {
    const cmd = command();
    await cmd.execute('token', 'add', 'laptop-a', { machines: true });
    const token = stdout.pop()!.trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const clients = path.join(dir, 'coordinator', 'tokens.json');
    expect(fs.statSync(clients).mode & 0o777).toBe(0o600);
    await cmd.execute('token', 'list', { machines: true, json: true });
    const listed = JSON.parse(stdout.pop()!);
    expect(listed.clients.map((c: any) => c.name)).toEqual(['laptop-a']);
    expect(JSON.stringify(listed)).not.toContain(token);

    await command(async (a, stop) => {
      expect((await request(a.port, 'GET', '/v1/info', token)).status).toBe(200);
      stop();
    }).execute({ machines: true, listen: '127.0.0.1:0' });

    const plain = command();
    await plain.execute('token', 'remove', 'laptop-a', { machines: true });
    expect(stdout.pop()).toMatch(/Removed client laptop-a/);
    await expect(plain.execute('token', 'add', { machines: true })).rejects.toThrow(/Name the client/);
    await expect(plain.execute('token', 'frob', { machines: true })).rejects.toThrow(/Unknown token action/);
  });

  it('pairs once on a machine\'s first boot and stores the token 0600', async () => {
    const tokenFile = path.join(dir, 'machine', 'token');
    await command(async (a, stop) => {
      expect(fs.existsSync(tokenFile)).toBe(false);
      expect((await request(a.port, 'GET', '/v1/info')).status).toBe(401);
      const paired = await request(a.port, 'POST', '/v1/pair');
      expect(paired.status).toBe(200);
      expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe(paired.body.token);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect((await request(a.port, 'GET', '/v1/info', paired.body.token)).status).toBe(200);
      expect((await request(a.port, 'POST', '/v1/pair')).status).toBe(403);
      stop();
    }, ['tokenFile']).execute({ allowPairing: true, listen: '127.0.0.1:0' });
    expect(stderr.join('\n')).toMatch(/waiting for a coordinator to pair/);
    expect(stderr.join('\n')).not.toContain('New token');

    // Restarted with a token, it pairs no more and the token keeps working
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    await command(async (a, stop) => {
      expect((await request(a.port, 'POST', '/v1/pair')).status).toBe(403);
      expect((await request(a.port, 'GET', '/v1/info', token)).status).toBe(200);
      stop();
    }, ['tokenFile']).execute({ allowPairing: true, listen: '127.0.0.1:0' });
  });
});
