// Which ContainerBackend a command runs on: the laptop's Docker (LocalDockerBackend, with
// --context / container.dockerContext) or a `kunj serve` named by --remote / container.remote
// (RemoteKunjBackend, imported only then so the local path stays light). `--remote local` forces the
// laptop whatever the config says.

import { KunjConfig } from '../../types';
import { ContainerBackend } from './backend';
import { ContainerError } from './errors';
import { LocalDockerBackend } from './docker';
import { RemoteEntry, requireRemote, DEFAULT_SERVE_PORT } from '../remotes';

export interface BackendSelection {
  backend: ContainerBackend;
  kind: 'docker' | 'remote';
  /** The remote's name (kind 'remote') */
  remote?: string;
  /** The Docker context: the laptop's (kind 'docker') or the box's, as the server reports it */
  dockerContext?: string;
  /** Ends what the selection opened (an SSH tunnel); safe to call twice */
  close(): Promise<void>;
}

export interface SelectOptions {
  /** --remote <name>, or 'local' */
  remote?: string;
  /** --context <docker context> */
  context?: string;
  config: KunjConfig;
  /** Test seams */
  remotes?: (name: string) => RemoteEntry;
  tunnel?: (entry: RemoteEntry) => Promise<{ localPort: number; close(): Promise<void> }>;
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
  const entry = (options.remotes ?? requireRemote)(name);
  let baseUrl: string;
  let close = async (): Promise<void> => {};
  if (entry.url) {
    baseUrl = entry.url;
  } else if (entry.ssh) {
    const open = options.tunnel ?? (await import('../serve/tunnel')).openTunnel;
    const tunnel = await open({ ...entry, port: entry.port ?? DEFAULT_SERVE_PORT });
    baseUrl = `http://127.0.0.1:${tunnel.localPort}`;
    let closed = false;
    close = async () => {
      if (closed) return;
      closed = true;
      await tunnel.close();
    };
  } else {
    throw new ContainerError(`Remote "${name}" has neither url nor ssh; fix it with kunj remote add ${name} …`, 'bad-remote');
  }
  const { RemoteKunjBackend } = await import('./remote');
  const backend = new RemoteKunjBackend({ baseUrl, token: entry.token, name });
  try {
    await backend.ready();
  } catch (err) {
    await close();
    throw err;
  }
  return { backend, kind: 'remote', remote: name, dockerContext: backend.serverContext, close };
}
