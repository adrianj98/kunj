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

/** How the guard reads labels; the backend's own calls by default (tests give a direct lookup). */
export interface GuardLookup {
  container(id: string): Promise<Labels | null>;
  volumes(): Promise<Array<{ name: string; labels: Labels }>>;
  networks(): Promise<Array<{ name: string; labels: Labels }>>;
}

export function backendLookup(backend: ContainerBackend): GuardLookup {
  return {
    container: id => backend.inspectLabels(id),
    volumes: () => backend.listVolumes({}),
    networks: () => backend.listNetworks({}),
  };
}

const REPO_LABEL = 'kunj.repo';
// Short: a kunj container removed out of band and replaced under the same name is let through for
// at most this long (the token holder could exec into kunj's containers anyway)
const CACHE_MS = 2000;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
// Capabilities kunj's main container (MAIN_CAPABILITIES) and network helper use; anything else needs --allow-privileged
const ALLOWED_CAPABILITIES = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'NET_ADMIN', 'NET_RAW']);

function refused(message: string): ServeError {
  return new ServeError(403, 'remote-refused', message);
}

export function isKunjLabels(labels: Labels | null | undefined): boolean {
  return !!labels && typeof labels[REPO_LABEL] === 'string' && labels[REPO_LABEL] !== '';
}

export class Guard {
  private cache = new Map<string, { labels: Labels | null; at: number }>();

  constructor(
    private readonly lookup: GuardLookup,
    private readonly flags: GuardFlags,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Lets a container through when it is kunj's or does not exist (the backend then answers as it
   * does locally); throws when it exists and is someone else's. Only a kunj container is cached:
   * a missing one may be created a moment later.
   */
  async container(id: string): Promise<void> {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < CACHE_MS) return;
    await this.inspect(id);
  }

  /** The container's labels as the backend reports them now; throws when it is not kunj's. */
  async inspect(id: string): Promise<Labels | null> {
    if (!id || id.startsWith('-')) throw new ServeError(400, 'bad-request', 'bad container id');
    const labels = await this.lookup.container(id);
    if (labels !== null && !isKunjLabels(labels)) throw refused(`${id} is not a kunj container`);
    if (labels) this.cache.set(id, { labels, at: this.now() });
    return labels;
  }

  /** Forget a cached id (after remove, so a reused name is inspected again). */
  forget(id: string): void {
    this.cache.delete(id);
  }

  /** kunj's images have no registry or namespace: kunj-<name>[:tag], with no '/' anywhere */
  image(tag: string): void {
    if (!tag || !tag.startsWith(IMAGE_TAG_PREFIX) || tag.includes('/')) throw refused(`${tag || '(empty)'} is not a kunj image`);
  }

  async runSpec(spec: ContainerSpec): Promise<void> {
    if (!isKunjLabels(spec.labels)) throw refused('a container must carry the kunj.repo label');
    for (const key of Object.keys(spec.labels)) {
      if (!key.startsWith('kunj.')) throw refused(`label ${key}: only kunj.* labels may be set`);
    }
    if (spec.privileged && !this.flags.allowPrivileged) throw refused('privileged containers are off on this server (kunj serve --allow-privileged)');
    if (spec.runtime && !this.flags.allowRuntimes.includes(spec.runtime)) {
      throw refused(`runtime ${spec.runtime} is not allowed on this server (kunj serve --allow-runtime ${spec.runtime})`);
    }
    if (!this.flags.allowPrivileged) {
      for (const cap of spec.capabilities ?? []) {
        if (!ALLOWED_CAPABILITIES.has(cap)) {
          throw refused(`capability ${cap} is not allowed on this server (kunj serve --allow-privileged)`);
        }
      }
      if (spec.securityOpt?.length) {
        throw refused('securityOpt is not allowed on this server (kunj serve --allow-privileged)');
      }
    }
    for (const v of spec.volumes) {
      if (!v || typeof v.name !== 'string' || typeof v.path !== 'string') {
        throw new ServeError(400, 'bad-request', 'expected volume { name, path }');
      }
      if (/^[/.~]/.test(v.name) || v.name.includes('/') || !VOLUME_NAME.test(v.name)) {
        throw refused(`volume ${v.name || '(empty)'}: host paths are not allowed, only named volumes`);
      }
      if (!v.path.startsWith('/')) {
        throw refused(`volume ${v.name}: target path ${v.path} must be absolute`);
      }
    }
    if (spec.networkOf) await this.container(spec.networkOf);
    if (spec.volumes.length) {
      const known = new Map((await this.lookup.volumes()).map(v => [v.name, v.labels]));
      for (const v of spec.volumes) {
        const labels = known.get(v.name);
        if (labels && !isKunjLabels(labels)) throw refused(`volume ${v.name} is not kunj's`);
      }
    }
    // spec.image is any image the branch chose (a devcontainer, container.image): not restricted.
    // Published ports bind to the server's loopback (docker.ts), useless from the laptop but harmless.
  }

  /** An event stream must be scoped by a kunj.* label; listings are not (prune reads every container for the images in use). */
  filter(labels: Labels): void {
    if (!Object.keys(labels).some(k => k.startsWith('kunj.'))) throw refused('an event stream must filter on a kunj.* label');
  }

  /** Every id in a remove must be kunj's; ids that do not exist are left to the backend. */
  async removeIds(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void> {
    for (const id of ids.containers ?? []) await this.container(id);
    if (ids.volumes?.length) {
      const known = new Map((await this.lookup.volumes()).map(v => [v.name, v.labels]));
      for (const name of ids.volumes) {
        const labels = known.get(name);
        if (labels && !isKunjLabels(labels)) throw refused(`volume ${name} is not kunj's`);
      }
    }
    if (ids.networks?.length) {
      const known = new Map((await this.lookup.networks()).map(n => [n.name, n.labels]));
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
