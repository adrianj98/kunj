// `kunj resources`: everything kunj manages, in one list, for the workspace app's Resources window.
// Read-only. Each place (this computer's Docker, a remote kunj serve, a coordinator's cloud and the
// machines awake on it) is asked on its own with a time limit, so one that hangs costs only itself.
// A machine is never woken, and what is asked of one is marked as looking, not using.

import type { ContainerBackend, ContainerInfo, ImageInfo, LabelledObject } from './container/backend';
import type { MachineImageJson, MachineJson, ResourceJson, ResourcesJson } from './json-types';

export const THIS_COMPUTER = 'This Mac';
const KUNJ_IMAGES = ['kunj-sandbox', 'kunj-nethelper', 'kunj-sandbox-dind', 'kunj-blueprint-*'];

export interface ResourcePlace {
  name: string;
  kind: 'docker' | 'remote';
  backend(): Promise<ContainerBackend>;
}

export interface ResourceCloud {
  /** The coordinator's name: "machines" for this computer's own, else the remote's */
  name: string;
  open(): Promise<{
    provider: string;
    machines(): Promise<MachineJson[]>;
    images(): Promise<MachineImageJson[]>;
    cacheStore(): Promise<string | undefined>;
    backendFor(machine: string): Promise<ContainerBackend>;
  }>;
}

export interface CollectOptions {
  places: ResourcePlace[];
  clouds: ResourceCloud[];
  /** How long one place, and one machine of a cloud, gets (default 8 s) */
  timeoutMs?: number;
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  work.catch(() => undefined);
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0];

function containerRow(c: ContainerInfo, place: string, machine?: string): ResourceJson {
  const role = c.labels['kunj.role'];
  const kind: ResourceJson['kind'] = role === 'service' ? 'service' : role === 'helper' || c.name.endsWith('-net-helper') ? 'helper' : 'container';
  const detail = kind === 'service' ? `service ${c.labels['kunj.service'] ?? ''} (${c.image})`.replace('  ', ' ') : kind === 'helper' ? 'firewall helper' : role === 'cache-sync' ? 'cache copy' : c.image;
  return { kind, name: c.name, place, ...(machine ? { machine } : {}), repo: c.labels['kunj.repo'], ...(c.labels['kunj.branch'] ? { branch: c.labels['kunj.branch'] } : {}), state: c.state, detail, createdAt: c.createdAt };
}

function volumeRow(v: LabelledObject, place: string, machine?: string): ResourceJson {
  const role = v.labels['kunj.role'];
  const detail =
    role === 'cache' ? `cache ${v.labels['kunj.cache'] ?? ''}`.trim()
    : v.name.endsWith('-home') ? 'home directory'
    : v.name.endsWith('-docker') ? 'inner Docker data'
    : v.labels['kunj.service'] ? `data of service ${v.labels['kunj.service']}`
    : /-svc-/.test(v.name) ? `data of service ${v.name.replace(/^.*-svc-/, '').split('-')[0]}`
    : 'workspace';
  return { kind: 'volume', name: v.name, place, ...(machine ? { machine } : {}), repo: v.labels['kunj.repo'], ...(v.labels['kunj.branch'] ? { branch: v.labels['kunj.branch'] } : {}), detail, ...(v.createdAt ? { createdAt: v.createdAt } : {}) };
}

function imageRow(i: ImageInfo, place: string, machine?: string): ResourceJson {
  const detail = i.tag.startsWith('kunj-blueprint-') ? 'blueprint snapshot' : i.tag.startsWith('kunj-nethelper') ? 'firewall helper image' : i.tag.startsWith('kunj-sandbox-dind') ? 'sandbox image with Docker' : 'sandbox image';
  return { kind: 'image', name: i.tag, place, ...(machine ? { machine } : {}), ...(i.labels['kunj.repo'] ? { repo: i.labels['kunj.repo'] } : {}), detail, sizeBytes: i.size, createdAt: i.createdAt };
}

/** What one Docker holds that is kunj's: containers, volumes, networks and images. */
export async function dockerResources(backend: ContainerBackend, place: string, machine?: string): Promise<ResourceJson[]> {
  const [containers, volumes, networks, images] = await Promise.all([
    backend.list({}),
    backend.listVolumes({}),
    backend.listNetworks({}),
    backend.listImages({}, { references: KUNJ_IMAGES }),
  ]);
  const ours = <T extends { labels: Record<string, string> }>(xs: T[]) => xs.filter(x => !!x.labels['kunj.repo']);
  return [
    ...ours(containers).map(c => containerRow(c, place, machine)),
    ...ours(volumes).map(v => volumeRow(v, place, machine)),
    ...ours(networks).map(n => ({ kind: 'network' as const, name: n.name, place, ...(machine ? { machine } : {}), repo: n.labels['kunj.repo'], ...(n.labels['kunj.branch'] ? { branch: n.labels['kunj.branch'] } : {}), detail: 'branch network', ...(n.createdAt ? { createdAt: n.createdAt } : {}) })),
    ...images.filter(i => i.tag.startsWith('kunj-')).map(i => imageRow(i, place, machine)),
  ];
}

export async function collectResources(opts: CollectOptions): Promise<ResourcesJson> {
  const ms = opts.timeoutMs ?? 8000;
  const places: ResourcesJson['places'] = [];
  const resources: ResourceJson[] = [];

  const docker = opts.places.map(async p => {
    try {
      const rows = await within(p.backend().then(b => dockerResources(b, p.name)), ms, p.name);
      return { place: { name: p.name, kind: p.kind, available: true }, rows };
    } catch (err) {
      return { place: { name: p.name, kind: p.kind, available: false, message: message(err) }, rows: [] as ResourceJson[] };
    }
  });

  const clouds = opts.clouds.map(async c => {
    const rows: ResourceJson[] = [];
    try {
      const cloud = await within(c.open(), ms, c.name);
      const [machines, images, store] = await within(Promise.all([cloud.machines(), cloud.images().catch(() => []), cloud.cacheStore().catch(() => undefined)]), ms, c.name);
      for (const m of machines) {
        rows.push({ kind: 'machine', name: m.name, place: c.name, repo: m.repo, branch: m.branch, state: m.state, detail: m.size, createdAt: m.createdAt });
      }
      for (const i of images) rows.push({ kind: 'machine-image', name: i.name, place: c.name, repo: i.repo, detail: i.blueprint ? `golden image, blueprint ${i.blueprint}` : 'golden image', createdAt: i.createdAt });
      if (store) rows.push({ kind: 'cache-store', name: store, place: c.name, detail: 'bucket for caches' });
      // What lives on the machines that are awake; a sleeping one is listed, never woken
      await Promise.all(
        machines.filter(m => m.state === 'running' && m.paired).map(async m => {
          try {
            rows.push(...(await within(cloud.backendFor(m.name).then(b => dockerResources(b, c.name, m.name)), ms, m.name)));
          } catch {
            // the machine row itself says it is there; what is on it is not known
          }
        }),
      );
      return { place: { name: c.name, kind: 'cloud' as const, available: true, provider: cloud.provider }, rows };
    } catch (err) {
      return { place: { name: c.name, kind: 'cloud' as const, available: false, message: message(err) }, rows };
    }
  });

  for (const r of await Promise.all([...docker, ...clouds])) {
    places.push(r.place);
    resources.push(...r.rows);
  }
  const order: ResourceJson['kind'][] = ['machine', 'container', 'service', 'helper', 'volume', 'network', 'image', 'machine-image', 'cache-store'];
  resources.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.repo ?? '').localeCompare(b.repo ?? '') || (a.branch ?? '').localeCompare(b.branch ?? '') || a.name.localeCompare(b.name));
  return { places, resources };
}
