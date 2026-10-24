import * as http from 'http';
import { FakeBackend } from '../../container/__tests__/fake-backend';
import { ContainerSpec } from '../../container/backend';
import { PROTOCOL_VERSION } from '../protocol';
import { ServeServer, createServeServer } from '../server';

const TOKEN = 'test-token-0123456789';

interface Reply {
  status: number;
  body: any;
}

function request(port: number, method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (data !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function spec(over: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: 'kunj-r-b-1',
    image: 'kunj-sandbox:1-a',
    labels: { 'kunj.repo': 'r', 'kunj.branch': 'b' },
    env: { A: '1' },
    network: 'kunj-r-b-1',
    workdir: '/workspace',
    volumes: [],
    publish: [],
    command: ['sleep', 'infinity'],
    ...over,
  };
}

describe('kunj serve: unary routes', () => {
  let fake: FakeBackend;
  let server: ServeServer;
  let port: number;
  const logged: string[] = [];

  beforeEach(async () => {
    fake = new FakeBackend();
    logged.length = 0;
    server = createServeServer({ backend: fake, token: TOKEN, version: '9.9.9', log: l => logged.push(l) });
    port = (await server.listen('127.0.0.1', 0)).port;
  });

  afterEach(() => server.close());

  it('refuses a missing or wrong token before touching the backend', async () => {
    expect((await request(port, 'GET', '/v1/info', undefined, null)).status).toBe(401);
    const wrong = await request(port, 'GET', '/v1/info', undefined, 'nope');
    expect(wrong).toEqual({ status: 401, body: { error: { code: 'unauthorized', message: 'unauthorized' } } });
    expect(fake.calls).toEqual([]);
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain('nope');
  });

  it('describes itself', async () => {
    const r = await request(port, 'GET', '/v1/info');
    expect(r).toEqual({ status: 200, body: { kunj: '9.9.9', protocol: PROTOCOL_VERSION, features: { ...fake.features, dockerInDocker: [] } } });
    const e = await request(port, 'GET', '/v1/engine');
    expect(e.body).toEqual(fake.infoResult);
    expect((await request(port, 'GET', '/v1/engine/context')).body).toEqual({ context: 'default' });
  });

  it('404s an unknown route with the error shape', async () => {
    const r = await request(port, 'GET', '/v1/nothing');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not-found');
  });

  it('runs a kunj-labelled spec and returns the id', async () => {
    const s = spec();
    const r = await request(port, 'POST', '/v1/containers', s);
    expect(r).toEqual({ status: 200, body: { id: 'id-1' } });
    expect(fake.callsOf('run')).toEqual([[s]]);
  });

  it('refuses a run without kunj.repo, with a foreign label, privileged or a runtime', async () => {
    const cases: Array<[Partial<ContainerSpec>, RegExp]> = [
      [{ labels: { 'kunj.branch': 'b' } }, /kunj.repo/],
      [{ labels: { 'kunj.repo': 'r', 'com.example': 'x' } }, /only kunj\.\* labels/],
      [{ privileged: true }, /--allow-privileged/],
      [{ runtime: 'sysbox-runc' }, /--allow-runtime sysbox-runc/],
    ];
    for (const [over, message] of cases) {
      const r = await request(port, 'POST', '/v1/containers', spec(over));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('remote-refused');
      expect(r.body.error.message).toMatch(message);
    }
    expect(fake.callsOf('run')).toEqual([]);
    expect(logged.some(l => l.startsWith('refused POST /v1/containers'))).toBe(true);
  });

  it('allows privileged and a runtime when the server was started with the flags', async () => {
    await server.close();
    server = createServeServer({ backend: fake, token: TOKEN, version: '1', allowPrivileged: true, allowRuntimes: ['sysbox-runc'] });
    port = (await server.listen('127.0.0.1', 0)).port;
    expect((await request(port, 'POST', '/v1/containers', spec({ privileged: true }))).status).toBe(200);
    expect((await request(port, 'POST', '/v1/containers', spec({ runtime: 'sysbox-runc' }))).status).toBe(200);
  });

  it('rejects a body that is not a spec', async () => {
    const r = await request(port, 'POST', '/v1/containers', { name: 'x', image: '-rm', labels: {}, env: {}, command: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/image reference/);
  });

  it('limits JSON bodies to 1 MB', async () => {
    const r = await request(port, 'POST', '/v1/containers', spec({ env: { BIG: 'x'.repeat(1024 * 1024 + 1) } }));
    expect(r.status).toBe(413);
    expect(fake.calls).toEqual([]);
  });

  it('lists containers, volumes, networks and images by a label, or all of them', async () => {
    fake.existing.push({ id: 'c1', name: 'kunj-r-b-1', state: 'running', image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] });
    fake.volumes.add('v1');
    fake.volumeLabels.set('v1', { 'kunj.repo': 'r' });
    fake.networks.set('n1', { 'kunj.repo': 'r' });
    fake.images.push({ tag: 'kunj-blueprint-r:h', id: 'img', createdAt: 't', labels: { 'kunj.repo': 'r' }, size: 1 });
    const q = '?label=kunj.repo%3Dr';
    expect((await request(port, 'GET', `/v1/containers${q}`)).body).toEqual(fake.existing);
    expect((await request(port, 'GET', `/v1/volumes${q}`)).body).toEqual(await fake.listVolumes({ 'kunj.repo': 'r' }));
    expect((await request(port, 'GET', `/v1/networks${q}`)).body).toEqual(await fake.listNetworks({ 'kunj.repo': 'r' }));
    expect((await request(port, 'GET', `/v1/images${q}&reference=kunj-blueprint-r`)).body).toEqual(fake.images);
    expect(fake.callsOf('listImages').pop()).toEqual([{ 'kunj.repo': 'r' }, { references: ['kunj-blueprint-r'] }]);
    expect((await request(port, 'GET', '/v1/containers')).body).toEqual(fake.existing);
    expect((await request(port, 'GET', '/v1/containers?label=com.example%3Dx')).body).toEqual([]);
  });

  it('answers labels for any container, state for a kunj one, null for a missing one, and refuses acting on a foreign one', async () => {
    fake.existing.push(
      { id: 'c1', name: 'kunj-r-b-1', state: 'running', image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] },
      { id: 'c2', name: 'other', state: 'running', image: 'i', createdAt: 't', labels: { app: 'db' }, ports: [] },
    );
    fake.states.set('gone', null);
    expect((await request(port, 'GET', '/v1/containers/kunj-r-b-1/labels')).body).toEqual({ labels: { 'kunj.repo': 'r' } });
    expect((await request(port, 'GET', '/v1/containers/kunj-r-b-1/state')).body).toEqual({ state: 'running', startedAt: expect.any(String) });
    expect((await request(port, 'GET', '/v1/containers/gone/labels')).body).toEqual({ labels: null });
    expect((await request(port, 'GET', '/v1/containers/gone/state')).body).toEqual({ state: null });
    // Labels of a foreign container are readable (a name collision is reported from them); nothing else is
    expect((await request(port, 'GET', '/v1/containers/other/labels')).body).toEqual({ labels: { app: 'db' } });
    const foreign = await request(port, 'GET', '/v1/containers/other/state');
    expect(foreign.status).toBe(403);
    expect(fake.callsOf('containerRun')).toEqual([['kunj-r-b-1'], ['gone']]);
    // start/stop go through the same guard
    expect((await request(port, 'POST', '/v1/containers/other/start')).status).toBe(403);
    expect((await request(port, 'POST', '/v1/containers/kunj-r-b-1/stop')).status).toBe(200);
    expect(fake.callsOf('stop')).toEqual([['kunj-r-b-1']]);
  });

  it('caches the guard inspect of a kunj container for a few seconds, never a missing one', async () => {
    fake.existing.push({ id: 'c1', name: 'kunj-r-b-1', state: 'running', image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] });
    await request(port, 'GET', '/v1/containers/kunj-r-b-1/state');
    await request(port, 'GET', '/v1/containers/kunj-r-b-1/state');
    expect(fake.callsOf('inspectLabels')).toEqual([['kunj-r-b-1']]);
    fake.states.set('new', null);
    expect((await request(port, 'GET', '/v1/containers/new/state')).body).toEqual({ state: null });
    fake.existing.push({ id: 'c3', name: 'new', state: 'created', image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] });
    fake.states.set('new', 'created');
    expect((await request(port, 'GET', '/v1/containers/new/state')).body).toMatchObject({ state: 'created' });
    expect(fake.callsOf('inspectLabels')).toEqual([['kunj-r-b-1'], ['new'], ['new']]);
  });

  it('creates volumes and networks with kunj labels only', async () => {
    expect((await request(port, 'POST', '/v1/volumes', { name: 'v', labels: { 'kunj.repo': 'r' } })).status).toBe(200);
    expect((await request(port, 'POST', '/v1/networks', { name: 'n', labels: { 'kunj.repo': 'r' } })).status).toBe(200);
    expect((await request(port, 'POST', '/v1/volumes', { name: 'v2', labels: { x: 'y' } })).status).toBe(403);
    expect((await request(port, 'GET', '/v1/volumes/v')).body).toEqual({ exists: true });
    expect((await request(port, 'GET', '/v1/volumes/nope')).body).toEqual({ exists: false });
    expect(fake.callsOf('createVolume')).toEqual([['v', { 'kunj.repo': 'r' }]]);
  });

  it('removes kunj objects and refuses foreign ones; missing ones pass through', async () => {
    fake.existing.push({ id: 'c2', name: 'other', state: 'exited', image: 'i', createdAt: 't', labels: { app: 'db' }, ports: [] });
    fake.volumes.add('theirs');
    fake.volumeLabels.set('theirs', { app: 'db' });
    fake.volumes.add('ours');
    fake.volumeLabels.set('ours', { 'kunj.repo': 'r' });
    expect((await request(port, 'POST', '/v1/remove', { containers: ['other'] })).status).toBe(403);
    expect((await request(port, 'POST', '/v1/remove', { volumes: ['theirs'] })).status).toBe(403);
    const ok = await request(port, 'POST', '/v1/remove', { containers: ['gone'], volumes: ['ours', 'missing'], networks: ['n'] });
    expect(ok.status).toBe(200);
    expect(fake.callsOf('remove')).toEqual([[{ containers: ['gone'], volumes: ['ours', 'missing'], networks: ['n'] }]]);
  });

  it('handles images: exists, remove, commit, with the kunj- prefix required', async () => {
    fake.existingImages.add('kunj-sandbox:1-a');
    fake.existing.push({ id: 'c1', name: 'kunj-r-b-1', state: 'running', image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] });
    const tag = encodeURIComponent('kunj-sandbox:1-a');
    expect((await request(port, 'GET', `/v1/images/${tag}`)).body).toEqual({ exists: true });
    // Any image the branch chose may be asked about; only kunj's may be built, committed or removed
    expect((await request(port, 'GET', `/v1/images/${encodeURIComponent('node:22')}`)).body).toEqual({ exists: false });
    expect((await request(port, 'GET', `/v1/images/${encodeURIComponent('-rm')}`)).status).toBe(400);
    expect((await request(port, 'DELETE', `/v1/images/${encodeURIComponent('node:22')}`)).status).toBe(403);
    expect((await request(port, 'DELETE', `/v1/images/${tag}`)).status).toBe(200);
    expect(fake.callsOf('removeImage')).toEqual([['kunj-sandbox:1-a']]);
    const commit = await request(port, 'POST', '/v1/containers/kunj-r-b-1/commit', { tag: 'kunj-blueprint-r:h', labels: { 'kunj.blueprint.hash': 'h' }, changes: ['ENV A=1'] });
    expect(commit.status).toBe(200);
    expect(fake.callsOf('commitContainer')).toEqual([['kunj-r-b-1', 'kunj-blueprint-r:h', { 'kunj.blueprint.hash': 'h' }, ['ENV A=1']]]);
    expect((await request(port, 'POST', '/v1/containers/kunj-r-b-1/commit', { tag: 'mine:1', labels: {} })).status).toBe(403);
  });

  it('passes a backend error on verbatim as a 500', async () => {
    fake.failOn = 'info';
    const r = await request(port, 'GET', '/v1/engine');
    expect(r).toEqual({ status: 500, body: { error: { code: 'backend', message: 'info failed' } } });
  });

  it('runs compose config', async () => {
    fake.composeConfigs.set('services: {}', { services: { db: {} } });
    const r = await request(port, 'POST', '/v1/compose/config', { yaml: 'services: {}' });
    expect(r.body).toEqual({ config: { services: { db: {} } } });
  });
});
