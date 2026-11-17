import { cacheStoreConfig, machineSettings } from '../config';

describe('machine.cache', () => {
  it('is a bucket with an optional folder, or nothing', () => {
    expect(cacheStoreConfig({ bucket: 'my-kunj-cache' })).toEqual({ store: 'bucket', bucket: 'my-kunj-cache', prefix: '' });
    expect(cacheStoreConfig({ store: 'bucket', bucket: 'my-kunj-cache', prefix: 'team/a' })).toEqual({ store: 'bucket', bucket: 'my-kunj-cache', prefix: 'team/a' });
    expect(cacheStoreConfig(undefined)).toBeNull();
    expect(cacheStoreConfig({})).toBeNull();
    expect(cacheStoreConfig({ store: 'none', bucket: 'my-kunj-cache' })).toBeNull();
  });

  it.each([
    ['a string', 'my-bucket'],
    ['an unknown store', { store: 'nfs', bucket: 'b-1' }],
    ['no bucket', { prefix: 'x' }],
    ['a bucket with a scheme', { bucket: 'gs://my-bucket' }],
    ['a prefix that climbs', { bucket: 'my-bucket', prefix: '../x' }],
    ['a prefix with an option', { bucket: 'my-bucket', prefix: '--delete' }],
  ])('refuses %s', (_what, value) => {
    expect(() => cacheStoreConfig(value)).toThrow(expect.objectContaining({ code: 'bad-machine-config' }));
  });

  it('is left as written by machineSettings, so a bad one never breaks commands that do not coordinate', () => {
    expect(machineSettings({ machine: { provider: 'gce', cache: 'nonsense' } } as any).cache).toBe('nonsense');
  });
});
