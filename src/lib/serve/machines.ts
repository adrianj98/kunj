// The coordinator role of `kunj serve` (--machines): the /v1/machines routes over a Coordinator
// (docs/specs/cloud-machines.md, "The coordinator"). Clients never talk to the cloud; they ask here.
// The proxy to a machine's own serve (/v1/machines/<name>/…) is phase 2.

import type { MachineImageJson, MachineJson } from '../json-types';
import { Coordinator } from '../machines/coordinator';
import { Labels, MACHINE_LABEL, Machine, MachineError, MachineErrorCode, MachineImage } from '../machines/provider';
import { readJsonBody } from './http';
import { MachineRouteErrorCode, ServeError, parseLabelQuery } from './protocol';
import { ServeExtension } from './server';

export type { MachineJson };

export function imageJson(i: MachineImage): MachineImageJson {
  return {
    name: i.name,
    repo: i.labels[MACHINE_LABEL.repo] ?? '',
    createdAt: i.createdAt,
    ...(i.labels[MACHINE_LABEL.version] ? { version: i.labels[MACHINE_LABEL.version] } : {}),
    ...(i.labels[MACHINE_LABEL.blueprint] ? { blueprint: i.labels[MACHINE_LABEL.blueprint] } : {}),
  };
}

export function machineJson(m: Machine, paired: boolean): MachineJson {
  const l = m.labels;
  return {
    name: m.name,
    state: m.state,
    repo: l['kunj.repo'] ?? '',
    branch: l['kunj.branch'] ?? '',
    size: m.size,
    zone: m.zone,
    createdAt: m.createdAt,
    owner: l['kunj.owner'] || undefined,
    image: l['kunj.image'] || undefined,
    version: l['kunj.version'] || undefined,
    paired,
  };
}

const STATUS: Record<MachineErrorCode, number> = {
  'machine-provider': 500,
  'machine-not-found': 404,
  'machine-ambiguous': 409,
  'machine-asleep': 409,
  'machine-exists': 409,
  'machine-not-kunj': 403,
  'machine-create-failed': 502,
  'machine-token': 502,
  'machine-timeout': 504,
  'provider-cli-missing': 503,
  'provider-failed': 502,
  'bad-machine-config': 500,
  'coordinator-start-failed': 500,
  'coordinator-no-machines': 404,
};

/** A MachineError as the route's error; anything else passes through as a backend error. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof MachineError) throw new ServeError(STATUS[err.code] ?? 500, err.code as MachineRouteErrorCode, err.message);
    throw err;
  }
}

const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function nameParam(name: string): string {
  if (!NAME.test(name)) throw new ServeError(400, 'bad-request', 'expected a machine name');
  return name;
}

function str(body: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = body[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || (required && !v)) throw new ServeError(400, 'bad-request', `expected ${key}`);
  return v;
}

export function machineRoutes(coordinator: Coordinator): (api: ServeExtension) => void {
  return api => {
    api.proxy((name, passive) => mapped(() => coordinator.proxyTarget(name, !passive)));

    api.info(async () => ({
      machines: { provider: coordinator.provider.name, features: { ...coordinator.provider.features }, network: coordinator.network },
    }));

    api.route('GET', '/v1/machines', async (_req, _p, url) =>
      mapped(async () => {
        const filter: Labels = parseLabelQuery(url.searchParams);
        const machines = await coordinator.list(filter);
        return { machines: machines.map(m => machineJson(m, coordinator.isPaired(m.name))) };
      }),
    );

    api.route('GET', '/v1/machines/providers', async () => ({
      provider: coordinator.provider.name,
      features: { ...coordinator.provider.features },
      sizes: coordinator.provider.sizes(),
      network: coordinator.network,
      ...(coordinator.cache ? { cache: coordinator.cache } : {}),
    }));

    api.route('POST', '/v1/machines/locate', async (req, _p, _url, client) => {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const repo = str(body, 'repo')!;
      const branch = str(body, 'branch')!;
      const repoName = str(body, 'repoName', false) || repo.split('/').pop() || 'repo';
      const size = str(body, 'size', false);
      return mapped(async () => {
        const r = await coordinator.locate({ repo, repoName, branch, size, wake: body.wake === true, create: body.create === true, owner: client });
        return { machine: machineJson(r.machine, r.paired), created: r.created, woke: r.woke };
      });
    });

    api.route('GET', '/v1/machines/images', async (_req, _p, url) =>
      mapped(async () => ({ images: (await coordinator.images(url.searchParams.get('repo') ?? '')).map(imageJson) })),
    );

    api.route('DELETE', '/v1/machines/images/:name', async (_req, p) =>
      mapped(async () => {
        await coordinator.deleteImage(nameParam(p.name));
        return { deleted: p.name };
      }),
    );

    // Bakes a golden image from the machine (it is stopped first); the reply comes when the image exists
    api.route('POST', '/v1/machines/:name/image', async (req, p) => {
      const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
      const blueprint = str(body, 'blueprint', false);
      if (blueprint !== undefined && !/^[0-9a-f]{0,64}$/.test(blueprint)) throw new ServeError(400, 'bad-request', 'expected a blueprint hash');
      return mapped(async () => ({ image: imageJson(await coordinator.bake(nameParam(p.name), { blueprint: blueprint || undefined })) }));
    });

    for (const verb of ['suspend', 'resume', 'stop', 'start'] as const) {
      api.route('POST', `/v1/machines/:name/${verb}`, async (_req, p, url) =>
        mapped(async () => {
          const name = nameParam(p.name);
          // wait=0 (suspend, stop): answered once the machine is known; the cloud takes a minute or two
          if ((verb === 'suspend' || verb === 'stop') && url.searchParams.get('wait') === '0') {
            const machine = await coordinator.get(name);
            void coordinator[verb](name).catch(err => coordinator.note(`${verb} of ${name} failed: ${(err as Error).message}`));
            const going = machine.state === 'running' ? { ...machine, state: verb === 'suspend' ? ('suspending' as const) : ('stopping' as const) } : machine;
            return { machine: machineJson(going, coordinator.isPaired(name)) };
          }
          const result = await coordinator[verb](name);
          const machine = result ?? (await coordinator.get(name));
          return { machine: machineJson(machine, coordinator.isPaired(name)) };
        }),
      );
    }

    api.route('DELETE', '/v1/machines/:name', async (_req, p, url) =>
      mapped(async () => {
        await coordinator.delete(nameParam(p.name), { disks: url.searchParams.get('disks') !== '0' });
        return { deleted: p.name };
      }),
    );
  };
}
