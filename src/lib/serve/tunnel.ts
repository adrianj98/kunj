// The SSH tunnel to a remote added with --ssh: `ssh -N -L <free>:127.0.0.1:<port> <destination>`,
// one per kunj process, ended when the process exits. Filled in by the SSH tunnel task; until then
// every --ssh remote says so.

import { RemoteEntry } from '../remotes';
import { ContainerError } from '../container/errors';

export interface Tunnel {
  localPort: number;
  close(): Promise<void>;
}

export async function openTunnel(entry: RemoteEntry & { port: number }): Promise<Tunnel> {
  throw new ContainerError(`The SSH tunnel to ${entry.ssh} is not implemented yet; add the remote with --url for now`, 'bad-remote');
}
