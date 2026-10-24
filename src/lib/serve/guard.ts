// What the server refuses: it serves kunj, not Docker. Every object a request names must be one kunj
// made (a `kunj.*` label), images must be kunj's tags, and the dangerous run options need the
// server's flags. A missing object passes through, so the backend answers null or its own error as it
// does locally.

import { ContainerBackend, ContainerSpec, Labels } from '../container/backend';
import { IMAGE_TAG_PREFIX, ServeError } from './protocol';

export interface GuardFlags {
  allowPrivileged: boolean;
  /** --runtime values accepted on run (e.g. sysbox-runc) */
  allowRuntimes: string[];
}

const REPO_LABEL = 'kunj.repo';
const CACHE_MS = 5000;

function refused(message: string): ServeError {
  return new ServeError(403, 'remote-refused', message);
}

export function isKunjLabels(labels: Labels | null | undefined): boolean {
  return !!labels && typeof labels[REPO_LABEL] === 'string' && labels[REPO_LABEL] !== '';
}

export class Guard {
  private cache = new Map<string, { labels: Labels | null; at: number }>();

  constructor(
    private readonly backend: ContainerBackend,
    private readonly flags: GuardFlags,
    private readonly now: () => number = Date.now,
  ) {}

  /** The container's labels (null when it does not exist); throws when it exists and is not kunj's. */
  async container(id: string): Promise<Labels | null> {
    if (!id || id.startsWith('-')) throw new ServeError(400, 'bad-request', 'bad container id');
    const hit = this.cache.get(id);
    let labels: Labels | null;
    if (hit && this.now() - hit.at < CACHE_MS) labels = hit.labels;
    else {
      labels = await this.backend.inspectLabels(id);
      this.cache.set(id, { labels, at: this.now() });
    }
    if (labels !== null && !isKunjLabels(labels)) throw refused(`${id} is not a kunj container`);
    return labels;
  }

  /** Forget a cached id (after remove, so a reused name is inspected again). */
  forget(id: string): void {
    this.cache.delete(id);
  }

  image(tag: string): void {
    const repo = tag.split('/').pop() ?? tag;
    if (!tag || tag.startsWith('-') || !repo.startsWith(IMAGE_TAG_PREFIX)) throw refused(`${tag || '(empty)'} is not a kunj image`);
  }

  runSpec(spec: ContainerSpec): void {
    if (!isKunjLabels(spec.labels)) throw refused('a container must carry the kunj.repo label');
    for (const key of Object.keys(spec.labels)) {
      if (!key.startsWith('kunj.')) throw refused(`label ${key}: only kunj.* labels may be set`);
    }
    if (spec.privileged && !this.flags.allowPrivileged) throw refused('privileged containers are off on this server (kunj serve --allow-privileged)');
    if (spec.runtime && !this.flags.allowRuntimes.includes(spec.runtime)) {
      throw refused(`runtime ${spec.runtime} is not allowed on this server (kunj serve --allow-runtime ${spec.runtime})`);
    }
    if (spec.publish.length > 0) {
      throw refused('published ports bind to the server\'s loopback, which the laptop cannot reach; use kunj ct forward instead of container.publish');
    }
    // spec.image is any image the branch chose (a devcontainer, container.image): not restricted
  }

  /** A listing must be scoped by a kunj.* label (kunj.repo, or kunj.managed for prune's orphan scan). */
  filter(labels: Labels): void {
    if (!Object.keys(labels).some(k => k.startsWith('kunj.'))) throw refused('a listing must filter on a kunj.* label');
  }

  /** Every id in a remove must be kunj's; ids that do not exist are left to the backend. */
  async removeIds(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void> {
    for (const id of ids.containers ?? []) await this.container(id);
    if (ids.volumes?.length) {
      const known = new Map((await this.backend.listVolumes({})).map(v => [v.name, v.labels]));
      for (const name of ids.volumes) {
        const labels = known.get(name);
        if (labels && !isKunjLabels(labels)) throw refused(`volume ${name} is not kunj's`);
      }
    }
    if (ids.networks?.length) {
      const known = new Map((await this.backend.listNetworks({})).map(n => [n.name, n.labels]));
      for (const name of ids.networks) {
        const labels = known.get(name);
        if (labels && !isKunjLabels(labels)) throw refused(`network ${name} is not kunj's`);
      }
    }
  }

  /** Labels of a volume or network being created. */
  createLabels(kind: 'volume' | 'network', labels: Labels): void {
    if (!isKunjLabels(labels)) throw refused(`a ${kind} must carry the kunj.repo label`);
    for (const key of Object.keys(labels)) {
      if (!key.startsWith('kunj.')) throw refused(`label ${key}: only kunj.* labels may be set`);
    }
  }
}
