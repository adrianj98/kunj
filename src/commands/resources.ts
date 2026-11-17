// Resources command: everything kunj manages, wherever it is (src/lib/resources.ts).
//
//   kunj resources [--json]     containers, cloud machines, images, volumes and networks on this
//                               computer, on every remote and in every coordinator's cloud
//
// Read-only, and it wakes no machine. The workspace app's Resources window reads `--json`.

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadResolvedConfig } from '../lib/config';
import { LocalDockerBackend } from '../lib/container/docker';
import { LOCAL_MACHINES, selectBackend } from '../lib/container/select-backend';
import type { ResourceJson, ResourcesJson } from '../lib/json-types';
import { readRemotes } from '../lib/remotes';
import { ResourceCloud, ResourcePlace, THIS_COMPUTER, collectResources } from '../lib/resources';

const TITLES: Record<ResourceJson['kind'], string> = {
  machine: 'Cloud machines',
  container: 'Containers',
  service: 'Services',
  helper: 'Firewall helpers',
  volume: 'Volumes',
  network: 'Networks',
  image: 'Images',
  'machine-image': 'Machine images',
  'cache-store': 'Cache stores',
};

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
/** github.com/acme/app → app */
const repoName = (id: string | undefined) => (id ? id.slice(id.lastIndexOf('/') + 1) : '');

export class ResourcesCommand extends BaseCommand {
  constructor() {
    super({
      name: 'resources',
      description: 'Everything kunj manages: containers, cloud machines, images, volumes and networks, wherever they are',
      helpText: 'Looks on this computer\'s Docker, on every remote (kunj remote list) and in the cloud of every coordinator.\nIt changes nothing and wakes no machine; a place that does not answer is listed as such.',
    });
  }

  async execute(options: { json?: boolean } = {}): Promise<void> {
    if (options.json) this.jsonMode = true;
    const config = await loadResolvedConfig(process.cwd());
    let remoteNames: string[] = [];
    try {
      remoteNames = Object.keys(readRemotes()).sort();
    } catch {
      // an unreadable remotes.json must not take this computer's listing with it
    }
    const own = typeof config.machine?.provider === 'string' && config.machine.provider && !remoteNames.includes(LOCAL_MACHINES) ? [LOCAL_MACHINES] : [];

    // A remote is a Docker host or a coordinator: known once it has answered, so each is opened first
    const selections: Array<Awaited<ReturnType<typeof selectBackend>>> = [];
    const opened = await Promise.all(
      [...own, ...remoteNames].map(async name => {
        try {
          const selection = await selectBackend({ remote: name, config, listing: true, tunnelTimeoutMs: 5500 });
          selections.push(selection);
          return { name, selection };
        } catch (error) {
          return { name, error };
        }
      }),
    );

    const local = new LocalDockerBackend({ context: config.container?.dockerContext || undefined });
    const places: ResourcePlace[] = [{ name: THIS_COMPUTER, kind: 'docker', backend: async () => local }];
    const clouds: ResourceCloud[] = [];
    for (const o of opened) {
      const coordinator = o.selection?.coordinator;
      if (coordinator) {
        clouds.push({
          name: o.name,
          open: async () => ({
            provider: coordinator.provider,
            machines: () => coordinator.list({}),
            images: () => coordinator.images(''),
            cacheStore: () => coordinator.cacheStore(),
            backendFor: machine => coordinator.backendFor(machine),
          }),
        });
      } else {
        places.push({
          name: o.name,
          kind: 'remote',
          backend: async () => {
            if (!o.selection) throw o.error;
            return o.selection.backend;
          },
        });
      }
    }

    let result: ResourcesJson;
    try {
      result = await collectResources({ places, clouds });
    } finally {
      for (const s of selections) await s.close().catch(() => undefined);
      // A Docker that never answered still has children waiting on it, which would hold this command open
      local.killChildren();
    }
    if (this.jsonMode) {
      this.outputJSON(result satisfies ResourcesJson);
      return;
    }

    for (const kind of Object.keys(TITLES) as ResourceJson['kind'][]) {
      const rows = result.resources.filter(r => r.kind === kind);
      if (rows.length === 0) continue;
      console.log(chalk.blue(`${TITLES[kind]} (${rows.length})`));
      for (const r of rows) {
        const what = [repoName(r.repo), r.branch].filter(Boolean).join(' / ');
        const where = r.machine ? `${r.place}, on ${r.machine}` : r.place;
        const facts = [r.state, r.detail, r.sizeBytes ? megabytes(r.sizeBytes) : ''].filter(Boolean).join('  ');
        console.log(`  ${r.name}  ${chalk.gray(what)}  ${facts}  ${chalk.gray(`[${where}]`)}`);
      }
    }
    if (result.resources.length === 0) console.log(chalk.gray('Nothing: kunj manages no container, machine, image, volume or network.'));
    for (const p of result.places) if (!p.available) console.log(chalk.yellow(`${p.name} did not answer, so what it holds is not listed: ${p.message}`));
  }
}
