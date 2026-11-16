import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { FakeBackend } from '../../container/__tests__/fake-backend';
import { ServeServer, createServeServer } from '../server';
import { DEFAULT_CLIENT, addClient, fileAuthenticator, listClients, removeClient } from '../token';

function request(port: number, method: string, p: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function upgrade(port: number, token: string): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, { headers: { authorization: `Bearer ${token}` } });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

describe('named client tokens', () => {
  let dir: string;
  let legacy: string;
  let clients: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-clients-'));
    legacy = path.join(dir, 'token');
    clients = path.join(dir, 'tokens.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds, lists without values, rotates and removes clients in a 0600 file', () => {
    const a = addClient(clients, 'laptop-a');
    expect(a.length).toBeGreaterThan(30);
    expect(() => addClient(clients, 'laptop-a')).toThrow(/--rotate/);
    const rotated = addClient(clients, 'laptop-a', { rotate: true });
    expect(rotated).not.toBe(a);
    addClient(clients, 'ci');
    expect(listClients(clients).map(c => c.name)).toEqual(['laptop-a', 'ci']);
    expect(JSON.stringify(listClients(clients))).not.toContain(rotated);
    expect(fs.statSync(clients).mode & 0o777).toBe(0o600);
    expect(removeClient(clients, 'ci')).toBe(true);
    expect(removeClient(clients, 'ci')).toBe(false);
    expect(() => addClient(clients, DEFAULT_CLIENT)).toThrow();
    expect(() => addClient(clients, '--x')).toThrow();
  });

  it('names the client a token belongs to, keeps the legacy token as default, and sees changes without a restart', () => {
    fs.writeFileSync(legacy, 'legacy-token-1234567890\n');
    const auth = fileAuthenticator(legacy, clients);
    expect(auth('legacy-token-1234567890')).toBe(DEFAULT_CLIENT);
    expect(auth('nope')).toBeNull();
    expect(auth(undefined)).toBeNull();
    const t = addClient(clients, 'laptop-b');
    expect(auth(t)).toBe('laptop-b');
    removeClient(clients, 'laptop-b');
    expect(auth(t)).toBeNull();
  });

  it('serves every client, on routes and WebSocket upgrades, and logs who called', async () => {
    fs.writeFileSync(legacy, 'legacy-token-1234567890\n');
    const t = addClient(clients, 'laptop-c');
    const logged: string[] = [];
    const server = createServeServer({ backend: new FakeBackend(), authenticate: fileAuthenticator(legacy, clients), version: '1', log: l => logged.push(l) });
    const { port } = await server.listen('127.0.0.1', 0);
    try {
      expect((await request(port, 'GET', '/v1/info', t)).status).toBe(200);
      expect((await request(port, 'GET', '/v1/info', 'legacy-token-1234567890')).status).toBe(200);
      expect((await request(port, 'GET', '/v1/info', 'wrong')).status).toBe(401);
      expect(await upgrade(port, t)).toBe(101);
      expect(await upgrade(port, 'wrong')).toBe(401);
      expect(logged.some(l => l.endsWith('(laptop-c)'))).toBe(true);
      expect(logged.join('\n')).not.toContain(t);
    } finally {
      await server.close();
    }
  });
});

describe('pairing a machine', () => {
  let server: ServeServer;
  afterEach(() => server.close());

  it('hands out one token within the window and refuses everything else until then', async () => {
    const stored: string[] = [];
    server = createServeServer({ backend: new FakeBackend(), version: '1', pairing: { until: Date.now() + 60_000, onPaired: t => stored.push(t) } });
    const { port } = await server.listen('127.0.0.1', 0);
    expect((await request(port, 'GET', '/v1/info')).status).toBe(401);
    const paired = await request(port, 'POST', '/v1/pair');
    expect(paired.status).toBe(200);
    expect(stored).toEqual([paired.body.token]);
    expect((await request(port, 'GET', '/v1/info', paired.body.token)).status).toBe(200);
    expect(await upgrade(port, paired.body.token)).toBe(101);
    const again = await request(port, 'POST', '/v1/pair');
    expect(again).toEqual({ status: 403, body: { error: { code: 'pairing-closed', message: 'pairing is closed on this server' } } });
  });

  it('refuses pairing after the window and on a server that never offered it', async () => {
    server = createServeServer({ backend: new FakeBackend(), version: '1', pairing: { until: Date.now() - 1, onPaired: () => {} } });
    const { port } = await server.listen('127.0.0.1', 0);
    expect((await request(port, 'POST', '/v1/pair')).status).toBe(403);
    const other = createServeServer({ backend: new FakeBackend(), token: 'abc-0123456789', version: '1' });
    const o = await other.listen('127.0.0.1', 0);
    try {
      expect((await request(o.port, 'POST', '/v1/pair')).status).toBe(403);
    } finally {
      await other.close();
    }
  });
});

describe('extending the server', () => {
  it('adds routes that see the calling client, and fields in /v1/info', async () => {
    const server = createServeServer({
      backend: new FakeBackend(),
      token: 'tok-0123456789',
      version: '1',
      extend: api => {
        api.route('GET', '/v1/whoami', async (_req, _p, _url, client) => ({ client }));
        api.info(async () => ({ machines: { provider: 'fake', network: 'tunnel', features: { suspend: true, spot: false, images: false, diskSnapshots: false, selfSuspend: false } } }));
      },
    });
    const { port } = await server.listen('127.0.0.1', 0);
    try {
      expect((await request(port, 'GET', '/v1/whoami', 'tok-0123456789')).body).toEqual({ client: DEFAULT_CLIENT });
      expect((await request(port, 'GET', '/v1/info', 'tok-0123456789')).body.machines.provider).toBe('fake');
    } finally {
      await server.close();
    }
  });
});
