import { cacheEnv, cacheVolumeName, parseCaches, syncCaches } from '../caches';
import { FakeBackend } from './fake-backend';

const REPO = { name: 'My.App', id: 'github.com/acme/my.app' };

describe('container.caches', () => {
  it('gives each cache one volume per repository, whatever the branch', () => {
    const caches = parseCaches([{ name: 'db', path: '/cache/db/' }, { name: 'npm-store', path: '/cache/npm' }], REPO);
    expect(caches).toEqual([
      { name: 'db', path: '/cache/db', volume: cacheVolumeName(REPO.name, REPO.id, 'db') },
      { name: 'npm-store', path: '/cache/npm', volume: cacheVolumeName(REPO.name, REPO.id, 'npm-store') },
    ]);
    expect(caches[0].volume).toMatch(/^kunj-My\.App-cache-db-[0-9a-f]{6}$/);
    expect(cacheVolumeName('My.App', 'github.com/other/my.app', 'db')).not.toBe(caches[0].volume);
    expect(cacheEnv(caches)).toEqual({ KUNJ_CACHE_DIR: '/cache/db', KUNJ_CACHE_DB: '/cache/db', KUNJ_CACHE_NPM_STORE: '/cache/npm' });
    expect(parseCaches(undefined, REPO)).toEqual([]);
    expect(cacheEnv([])).toEqual({});
  });

  it.each([
    ['not a list', { name: 'db', path: '/cache' }],
    ['a bad name', [{ name: 'DB cache', path: '/cache' }]],
    ['a relative path', [{ name: 'db', path: 'cache' }]],
    ['a path with ..', [{ name: 'db', path: '/cache/../etc' }]],
    ['the workspace', [{ name: 'db', path: '/workspace/cache' }]],
    ['a system directory', [{ name: 'db', path: '/etc' }]],
    ['a path that could split a mount option', [{ name: 'db', path: '/cache:ro' }]],
    ['the same name twice', [{ name: 'db', path: '/a' }, { name: 'db', path: '/b' }]],
    ['the same path twice', [{ name: 'a', path: '/c' }, { name: 'b', path: '/c' }]],
  ])('refuses %s', (_what, value) => {
    expect(() => parseCaches(value, REPO)).toThrow(/container\.caches/);
    expect(() => parseCaches(value, REPO)).toThrow(expect.objectContaining({ code: 'bad-config' }));
  });
});

describe('syncCaches', () => {
  const STORE = { image: 'rclone/rclone:1.68.2', env: { RCLONE_GCS_ENV_AUTH: 'true' }, remote: ':gcs:my-bucket/team', display: 'gs://my-bucket/team' };
  const caches = parseCaches([{ name: 'db', path: '/cache/db' }, { name: 'npm', path: '/cache/npm' }], REPO);
  const opts = { repoId: REPO.id, kunjVersion: '1.0.0' };
  const execs = (b: FakeBackend) => b.callsOf('exec').map(a => (a[1] as string[]).join(' '));

  it('pulls each cache in one sync container that sees only the cache volumes, then removes it', async () => {
    const b = new FakeBackend();
    b.execHandler = (_id, cmd) => (cmd[1] === 'lsf' ? Promise.resolve({ exitCode: 0, stdout: 'dump.sql\n' }) : undefined);
    const results = await syncCaches(b, STORE, caches, 'pull', opts);
    expect(results).toEqual([{ name: 'db', action: 'pulled' }, { name: 'npm', action: 'pulled' }]);
    const [spec] = b.callsOf('run').map(a => a[0] as any);
    expect(spec).toMatchObject({ image: STORE.image, env: STORE.env, network: 'bridge', entrypoint: ['sleep'], publish: [] });
    expect(spec.labels).toMatchObject({ 'kunj.repo': REPO.id, 'kunj.role': 'cache-sync' });
    expect(spec.volumes).toEqual(caches.map(c => ({ name: c.volume, path: `/caches/${c.name}` })));
    expect(spec.capabilities).toBeUndefined();
    expect(execs(b)).toContain(`rclone sync :gcs:my-bucket/team/${caches[0].volume} /caches/db --links --transfers 8 --retries 2`);
    // executable bits come back from the list stored beside the data
    expect(execs(b)).toContain(`sh -c cd "$1" && rclone cat "$2" 2>/dev/null | xargs -0 -r chmod +x sh /caches/db :gcs:my-bucket/team/${caches[0].volume}.exec`);
    expect(b.callsOf('remove')).toHaveLength(1);
  });

  it('leaves a volume alone when nothing was ever pushed', async () => {
    const b = new FakeBackend();
    b.execHandler = (_id, cmd) => (cmd[1] === 'lsf' ? Promise.resolve(cmd[4].endsWith(caches[0].volume) ? { exitCode: 3, stdout: '' } : { exitCode: 0, stdout: '' }) : undefined);
    expect(await syncCaches(b, STORE, caches, 'pull', opts)).toEqual([{ name: 'db', action: 'empty' }, { name: 'npm', action: 'empty' }]);
    expect(execs(b).some(c => c.startsWith('rclone sync'))).toBe(false);
  });

  it('pushes the volume to the store, and one failure does not stop the others', async () => {
    const b = new FakeBackend();
    b.execHandler = (_id, cmd, io) => {
      if (cmd[1] === 'sync' && cmd[2] === '/caches/db') {
        (io.stderr as NodeJS.WritableStream).write('2026/01/01 NOTICE: retrying\n2026/01/01 ERROR : googleapi: Error 403: forbidden\n');
        return Promise.resolve({ exitCode: 1, stdout: '' });
      }
      return undefined;
    };
    const results = await syncCaches(b, STORE, caches, 'push', opts);
    expect(results).toEqual([{ name: 'db', action: 'failed', message: '2026/01/01 ERROR : googleapi: Error 403: forbidden' }, { name: 'npm', action: 'pushed' }]);
    expect(execs(b)).toContain(`rclone sync /caches/npm :gcs:my-bucket/team/${caches[1].volume} --links --transfers 8 --retries 2`);
    expect(execs(b).some(c => c.includes('lsf'))).toBe(false);
    expect(execs(b)).toContain(`sh -c cd "$1" && find . -type f -perm -u+x -print0 | rclone rcat "$2" sh /caches/npm :gcs:my-bucket/team/${caches[1].volume}.exec`);
    expect(b.callsOf('remove')).toHaveLength(1);
  });

  it('refuses a store that is not an rclone remote, and does nothing without caches', async () => {
    const b = new FakeBackend();
    await expect(syncCaches(b, { ...STORE, remote: '/etc' }, caches, 'push', opts)).rejects.toMatchObject({ code: 'bad-config' });
    await expect(syncCaches(b, { ...STORE, remote: ':gcs:b/../x' }, caches, 'push', opts)).rejects.toMatchObject({ code: 'bad-config' });
    expect(await syncCaches(b, STORE, [], 'pull', opts)).toEqual([]);
    expect(b.callsOf('run')).toHaveLength(0);
  });
});
