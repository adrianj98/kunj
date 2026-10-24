import * as http from 'http';
import { ContainerSpec } from '../backend';
import { RemoteError, RemoteKunjBackend } from '../remote';
import { Harness, startHarness } from './remote-harness';

const spec: ContainerSpec = {
  name: 'kunj-r-b-1',
  image: 'kunj-sandbox:1-a',
  labels: { 'kunj.repo': 'r', 'kunj.branch': 'b' },
  env: { A: '1', MULTI: 'two\nlines' },
  network: 'kunj-r-b-1',
  aliases: ['app'],
  workdir: '/workspace',
  volumes: [{ name: 'v', path: '/home/dev' }],
  publish: [],
  capDrop: ['ALL'],
  capabilities: ['CHOWN'],
  entrypoint: ['sleep'],
  command: ['infinity'],
};

describe('RemoteKunjBackend: unary calls', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(() => h.close());

  it('reports the server features after ready()', () => {
    expect(h.remote.features).toEqual({ ...h.fake.features, editorAttach: false, dockerInDocker: [] });
    expect(h.remote.serverVersion).toBe('test');
    expect(h.remote.serverContext).toBe('default');
  });

  it('info and contextName', async () => {
    h.fake.context = 'box';
    expect(await h.remote.info()).toEqual(h.fake.infoResult);
    expect(await h.remote.contextName()).toBe('box');
  });

  it('round-trips every argument of run, including env and nested arrays', async () => {
    expect(await h.remote.run(spec)).toBe('id-1');
    expect(h.fake.callsOf('run')).toEqual([[spec]]);
  });

  it('images', async () => {
    h.fake.existingImages.add('kunj-sandbox:1-a');
    expect(await h.remote.imageExists('kunj-sandbox:1-a')).toBe(true);
    expect(await h.remote.imageExists('kunj-sandbox:1-b')).toBe(false);
    await h.remote.commitContainer('id-1', 'kunj-blueprint-r:h', { 'kunj.repo': 'r' }, ['ENV X=1']);
    expect(await h.remote.listImages({ 'kunj.repo': 'r' }, { references: ['kunj-blueprint-r'] })).toEqual(h.fake.images);
    expect(await h.remote.listImages({ 'kunj.repo': 'r' })).toEqual(h.fake.images);
    expect(h.fake.callsOf('listImages')).toEqual([[{ 'kunj.repo': 'r' }, { references: ['kunj-blueprint-r'] }], [{ 'kunj.repo': 'r' }]]);
    await h.remote.removeImage('kunj-blueprint-r:h');
    expect(h.fake.images).toEqual([]);
  });

  it('networks and volumes', async () => {
    await h.remote.createNetwork('n', { 'kunj.repo': 'r' });
    await h.remote.createVolume('v', { 'kunj.repo': 'r', 'kunj.branch': 'b' });
    expect(await h.remote.volumeExists('v')).toBe(true);
    expect(await h.remote.volumeExists('w')).toBe(false);
    expect(await h.remote.listVolumes({ 'kunj.repo': 'r' })).toEqual(await h.fake.listVolumes({ 'kunj.repo': 'r' }));
    expect(await h.remote.listNetworks({ 'kunj.repo': 'r' })).toEqual(await h.fake.listNetworks({ 'kunj.repo': 'r' }));
  });

  it('containers: list, labels, state, start, stop, remove', async () => {
    h.fake.existing.push({ id: 'c1', name: 'kunj-r-b-1', state: 'exited', image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [{ container: 3000, host: 3000 }] });
    h.fake.states.set('kunj-r-b-1', 'exited');
    h.fake.states.set('gone', null);
    expect(await h.remote.list({ 'kunj.repo': 'r' })).toEqual(h.fake.existing);
    expect(await h.remote.inspectLabels('kunj-r-b-1')).toEqual({ 'kunj.repo': 'r' });
    expect(await h.remote.inspectLabels('gone')).toBeNull();
    expect(await h.remote.containerState('kunj-r-b-1')).toBe('exited');
    expect(await h.remote.containerState('gone')).toBeNull();
    expect(await h.remote.containerRun('kunj-r-b-1')).toEqual({ state: 'exited', startedAt: expect.any(String) });
    expect(await h.remote.containerRun('gone')).toBeNull();
    await h.remote.start('kunj-r-b-1');
    await h.remote.stop('kunj-r-b-1');
    await h.remote.remove({ containers: ['kunj-r-b-1'], volumes: ['v'], networks: ['n'] });
    expect(h.fake.methods().filter(m => ['start', 'stop', 'remove'].includes(m))).toEqual(['start', 'stop', 'remove']);
    expect(h.fake.callsOf('remove')).toEqual([[{ containers: ['kunj-r-b-1'], volumes: ['v'], networks: ['n'] }]]);
  });

  it('composeConfig, including a failure passed on verbatim', async () => {
    h.fake.composeConfigs.set('a: 1', { services: { a: {} } });
    h.fake.composeConfigs.set('bad', new Error('docker compose config failed: yaml: line 1'));
    expect(await h.remote.composeConfig('a: 1')).toEqual({ services: { a: {} } });
    await expect(h.remote.composeConfig('bad')).rejects.toThrow('docker compose config failed: yaml: line 1');
  });

  it('passes a backend error on with the local text and no RemoteError wrapper', async () => {
    h.fake.failOn = 'info';
    const err = await h.remote.info().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RemoteError);
    expect(err.message).toBe('info failed');
  });

  it('maps a refusal to remote-refused with the server message', async () => {
    const err = await h.remote.run({ ...spec, labels: { x: 'y' } }).catch(e => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.code).toBe('remote-refused');
    expect(err.message).toMatch(/remote harness refused: .*kunj\.repo/);
  });

  it('maps a bad token to remote-unauthorized and never retries', async () => {
    const bad = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${h.port}`, token: 'wrong', name: 'box' });
    const err = await bad.ready().catch(e => e);
    expect(err).toMatchObject({ code: 'remote-unauthorized' });
    expect(err.message).toContain('kunj remote token box');
    expect(err.message).not.toContain('wrong');
    // Only the harness's own ready() reached the fake (the server asks the context once); the bad client never did
    expect(h.fake.methods()).toEqual(['contextName']);
  });

  it('maps an unreachable server to the local "Docker is not available" text', async () => {
    const closed = h;
    h = await startHarness(); // for afterEach
    await closed.close();
    const err = await closed.remote.list({ 'kunj.repo': 'r' }).catch(e => e);
    expect(err).toMatchObject({ code: 'remote-unreachable' });
    // RESET when a kept-alive socket was closed under us, REFUSED on a fresh connection
    expect(err.message).toMatch(/^Docker is not available: remote harness is unreachable \(ECONN(REFUSED|RESET)\)$/);
  });

  it('refuses another protocol version and a server that is not kunj serve', async () => {
    const other = http.createServer((req, res) => {
      if (req.url === '/v1/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kunj: '0', protocol: 99, features: h.fake.features, context: 'x' }));
      } else {
        res.writeHead(200);
        res.end('<html>');
      }
    });
    await new Promise<void>(r => other.listen(0, '127.0.0.1', r));
    const port = (other.address() as any).port;
    const remote = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${port}`, token: 't', name: 'box' });
    await expect(remote.ready()).rejects.toMatchObject({ code: 'remote-protocol' });
    await expect(remote.list({ 'kunj.repo': 'r' })).rejects.toMatchObject({ code: 'remote-protocol' });
    other.close();
  });
});
