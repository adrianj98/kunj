import { cacheEnv, cacheVolumeName, parseCaches } from '../caches';

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
