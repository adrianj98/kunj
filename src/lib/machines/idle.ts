// The coordinator's question to a machine for its idle loop: is an agent working there? Asked of the
// machine's own kunj serve, with the same status script `kunj ct list` and `kunj events` use.

import { STATUS_SCRIPT, parseStatus } from '../container/env';
import { isMain, optionsLabel } from '../container/names';
import type { ContainerBackend } from '../container/backend';
import { RemoteKunjBackend } from '../container/remote';

/** True when any running branch container on the machine has an agent in the `running` state. */
export async function agentBusy(baseUrl: string, token: string): Promise<boolean> {
  // passive: the question itself must not look like use to the machine's own idle timer
  const backend = new RemoteKunjBackend({ baseUrl, token, name: 'machine', passive: true });
  await backend.ready();
  return localAgentBusy(backend);
}

/** The same question of a backend at hand (a machine's own serve asks its own Docker). */
export async function localAgentBusy(backend: ContainerBackend): Promise<boolean> {
  const mains = (await backend.list({})).filter(c => c.state === 'running' && isMain(c));
  for (const c of mains) {
    const user = (optionsLabel(c.labels).user as string | undefined) || undefined;
    const r = await backend.exec(c.id, ['sh', '-c', STATUS_SCRIPT], { user, timeoutMs: 5000 });
    if (parseStatus(r.stdout).agentState === 'running') return true;
  }
  return false;
}
