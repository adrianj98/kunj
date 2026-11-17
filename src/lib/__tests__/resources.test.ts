import type { ContainerBackend } from '../container/backend';
import type { MachineJson } from '../json-types';
import { collectResources } from '../resources';

/** A Docker that holds what one branch container makes, plus things that are not kunj's. */
function docker(branch: string): ContainerBackend {
  const labels = { 'kunj.repo': 'github.com/acme/app', 'kunj.branch': branch };
  return {
    list: async () => [
      { id: '1', name: `kunj-app-${branch}-abc`, state: 'running', image: 'kunj-blueprint-app:h1', createdAt: 't', labels: { ...labels, 'kunj.role': 'main' }, ports: [] },
      { id: '2', name: `kunj-app-${branch}-abc-net-helper`, state: 'running', image: 'kunj-nethelper:1', createdAt: 't', labels: { ...labels, 'kunj.role': 'helper' }, ports: [] },
      { id: '3', name: `kunj-app-${branch}-abc-svc-db`, state: 'exited', image: 'postgres:16', createdAt: 't', labels: { ...labels, 'kunj.role': 'service', 'kunj.service': 'db' }, ports: [] },
      { id: '4', name: 'someone-elses', state: 'running', image: 'nginx', createdAt: 't', labels: {}, ports: [] },
    ],
    listVolumes: async () => [
      { name: `kunj-app-${branch}-abc-ws`, labels },
      { name: 'kunj-app-cache-db-123456', labels: { 'kunj.repo': 'github.com/acme/app', 'kunj.role': 'cache', 'kunj.cache': 'db' } },
      { name: 'not-ours', labels: {} },
    ],
    listNetworks: async () => [{ name: `kunj-app-${branch}-abc-net`, labels }],
    listImages: async () => [
      { tag: 'kunj-blueprint-app:h1', id: 'i1', createdAt: 't', labels: { 'kunj.repo': 'github.com/acme/app' }, size: 2_000_000_000 },
      { tag: 'kunj-sandbox:1.0.0-aa', id: 'i2', createdAt: 't', labels: {}, size: 1_000_000_000 },
    ],
  } as unknown as ContainerBackend;
}

const machine = (branch: string, state: MachineJson['state']): MachineJson => ({ name: `kunj-app-${branch}-abc`, state, repo: 'github.com/acme/app', branch, size: 'e2-standard-2', createdAt: 't', paired: true });

describe('collectResources', () => {
  it('lists what each place holds, and what lives on the machines that are awake, waking none', async () => {
    const asked: string[] = [];
    const result = await collectResources({
      places: [{ name: 'This Mac', kind: 'docker', backend: async () => docker('local') }],
      clouds: [
        {
          name: 'machines',
          open: async () => ({
            provider: 'gce',
            machines: async () => [machine('awake', 'running'), machine('asleep', 'suspended')],
            images: async () => [{ name: 'kunj-app-img-1', repo: 'github.com/acme/app', createdAt: 't', blueprint: 'h1' }],
            cacheStore: async () => 'gs://my-cache',
            backendFor: async name => {
              asked.push(name);
              return docker('awake');
            },
          }),
        },
      ],
    });
    expect(result.places).toEqual([
      { name: 'This Mac', kind: 'docker', available: true },
      { name: 'machines', kind: 'cloud', available: true, provider: 'gce' },
    ]);
    expect(asked).toEqual(['kunj-app-awake-abc']); // the sleeping machine is listed, not asked
    const of = (kind: string) => result.resources.filter(r => r.kind === kind);
    expect(of('machine').map(r => [r.branch, r.state])).toEqual([['asleep', 'suspended'], ['awake', 'running']]);
    expect(of('container').map(r => [r.name, r.place, r.machine])).toEqual([
      ['kunj-app-awake-abc', 'machines', 'kunj-app-awake-abc'],
      ['kunj-app-local-abc', 'This Mac', undefined],
    ]);
    expect(of('service')[0]).toMatchObject({ state: 'exited', detail: 'service db (postgres:16)' });
    expect(of('helper')).toHaveLength(2);
    expect(of('volume').map(r => r.detail).sort()).toEqual(['cache db', 'cache db', 'workspace', 'workspace']);
    expect(of('image').find(r => r.name.startsWith('kunj-blueprint'))).toMatchObject({ detail: 'blueprint snapshot', sizeBytes: 2_000_000_000 });
    expect(of('machine-image')[0]).toMatchObject({ name: 'kunj-app-img-1', detail: 'golden image, blueprint h1' });
    expect(of('cache-store')[0]).toMatchObject({ name: 'gs://my-cache', place: 'machines' });
    // nothing that is not kunj's
    expect(result.resources.some(r => r.name === 'someone-elses' || r.name === 'not-ours')).toBe(false);
    // machines first, then what runs
    expect(result.resources[0].kind).toBe('machine');
  });

  it('says which place did not answer, and still lists the others', async () => {
    const result = await collectResources({
      timeoutMs: 50,
      places: [
        { name: 'This Mac', kind: 'docker', backend: async () => new Promise<ContainerBackend>(() => {}) }, // a stuck Docker
        { name: 'box', kind: 'remote', backend: async () => docker('on-box') },
      ],
      clouds: [{ name: 'machines', open: async () => Promise.reject(new Error('gcloud is not logged in')) }],
    });
    expect(result.places).toEqual([
      { name: 'This Mac', kind: 'docker', available: false, message: 'This Mac did not answer within 50 ms' },
      { name: 'box', kind: 'remote', available: true },
      { name: 'machines', kind: 'cloud', available: false, message: 'gcloud is not logged in' },
    ]);
    expect(result.resources.filter(r => r.kind === 'container').map(r => r.place)).toEqual(['box']);
  });
});
