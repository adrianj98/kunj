// Which ContainerBackend a command runs on: the laptop's Docker (LocalDockerBackend, with
// --context / container.dockerContext) or a `kunj serve` named by --remote / container.remote
// (RemoteKunjBackend, imported only then so the local path stays light). `--remote local` forces the
// laptop whatever the config says.

import { KunjConfig } from '../../types';
import { ContainerBackend } from './backend';
import { ContainerError } from './errors';
import { LocalDockerBackend } from './docker';
import { RemoteEntry, requireRemote, DEFAULT_SERVE_PORT } from '../remotes';

/** `--remote machines` / container.remote=machines: this machine's own coordinator (machine.provider) */
export const LOCAL_MACHINES = 'machines';

export interface BackendSelection {
  backend: ContainerBackend;
  kind: 'docker' | 'remote';
  /** The remote's name (kind 'remote') */
  remote?: string;
  /** The Docker context: the laptop's (kind 'docker') or the box's, as the server reports it */
  dockerContext?: string;
  /** Ends what the selection opened (an SSH tunnel); safe to call twice */
  close(): Promise<void>;
  /** The cloud machine the backend is, when the remote coordinates machines */
  machine?: { name: string; delete(): Promise<void> };
}

export interface SelectOptions {
  /** --remote <name>, or 'local' */
  remote?: string;
  /** --context <docker context> */
  context?: string;
  config: KunjConfig;
  /**
   * The branch this command is about, for a remote that coordinates cloud machines: its machine is
   * located (woken with `wake`, made with `create`) and the backend is that machine's serve.
   */
  machine?: { repo: string; repoName: string; branch: string; wake: boolean; create: boolean; size?: string };
  /** The local coordinator (tests) */
  localCoordinator?: (config: KunjConfig) => Promise<{ baseUrl: string; token: string }>;
  /** Test seams */
  remotes?: (name: string) => RemoteEntry;
  tunnel?: (opts: { ssh: string; port: number }) => Promise<{ localPort: number; close(): Promise<void> }>;
}

/** The remote name a command should use, or undefined for the laptop. */
export function remoteNameOf(options: { remote?: string }, config: KunjConfig): string | undefined {
  const name = options.remote ?? config.container?.remote ?? '';
  return !name || name === 'local' ? undefined : name;
}

export async function selectBackend(options: SelectOptions): Promise<BackendSelection> {
  const name = remoteNameOf(options, options.config);
  if (!name) {
    const dockerContext = options.context || options.config.container?.dockerContext || undefined;
    return { backend: new LocalDockerBackend({ context: dockerContext }), kind: 'docker', dockerContext, close: async () => {} };
  }
  let baseUrl: string;
  let token: string;
  let close = async (): Promise<void> => {};
  if (name === LOCAL_MACHINES) {
    // This machine's own coordinator, started on demand (machine.provider)
    const local = options.localCoordinator ?? (async (config: KunjConfig) => (await (await import('../machines/local-coordinator')).ensureLocalCoordinator(config)).client.opts);
    ({ baseUrl, token } = await local(options.config));
  } else {
    const entry = (options.remotes ?? requireRemote)(name);
    token = entry.token;
    if (entry.url) {
      baseUrl = entry.url;
    } else if (entry.ssh) {
      const open = options.tunnel ?? (await import('../serve/tunnel')).openTunnel;
      const tunnel = await open({ ssh: entry.ssh, port: entry.port ?? DEFAULT_SERVE_PORT });
      baseUrl = `http://127.0.0.1:${tunnel.localPort}`;
      let closed = false;
      close = async () => {
        if (closed) return;
        closed = true;
        await tunnel.close();
      };
    } else {
      throw new ContainerError(`Remote "${name}" in ~/.kunj/remotes.json has neither a url nor an ssh destination. Add it again with kunj remote add ${name} --url <url> (or --ssh <user@host>).`, 'bad-remote');
    }
  }
  const { RemoteKunjBackend } = await import('./remote');
  let backend = new RemoteKunjBackend({ baseUrl, token, name });
  let machine: BackendSelection['machine'];
  try {
    await backend.ready();
    if (backend.machines) {
      // A coordinator: the backend is the serve of this branch's machine, reached through it
      const m = options.machine;
      if (!m) {
        throw new ContainerError(`${name === LOCAL_MACHINES ? 'Cloud machines hold' : `Remote ${name} coordinates cloud machines, which hold`} one branch each, so this command needs a branch. kunj machine list shows them all.`, 'bad-remote');
      }
      const { MachineClient } = await import('../machines/client');
      const client = new MachineClient({ baseUrl, token, name });
      const located = await client.locate({ repo: m.repo, repoName: m.repoName, branch: m.branch, wake: m.wake, create: m.create, size: m.size });
      if (located.machine.state !== 'running') {
        throw new ContainerError(`The machine of ${m.branch} is ${located.machine.state}. kunj ct start ${m.branch} wakes it.`, 'remote-unreachable');
      }
      backend = new RemoteKunjBackend({ baseUrl, token, name: `${name}/${located.machine.name}`, basePath: `/v1/machines/${located.machine.name}/serve` });
      await backend.ready();
      machine = { name: located.machine.name, delete: () => client.delete(located.machine.name, { disks: true }) };
    }
  } catch (err) {
    await close();
    throw err;
  }
  return { backend, kind: 'remote', remote: name, dockerContext: backend.serverContext, close, ...(machine ? { machine } : {}) };
}
