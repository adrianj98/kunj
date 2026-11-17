// The machine settings, resolved with their defaults, and where a coordinator keeps its files.
// Light on purpose: `kunj machine` and `kunj serve` load it on the fast path.

import * as path from 'path';
import { getGlobalKunjDir } from '../config';
import { KunjConfig } from '../../types';
import { MachineDefaults } from './coordinator';

export interface MachineSettings {
  provider: string;
  /** machine.<provider> */
  providerConfig: Record<string, unknown>;
  network: 'tunnel' | 'private';
  defaults: MachineDefaults;
  idleMinutes: number;
  pairWindowMinutes: number;
  coordinatorIdleMinutes: number;
  /** What a new machine installs as kunj ('' = this version from npm, or main from GitHub for a dev build) */
  kunjPackage: string;
  /** Give new machines the startup script (false: the image already runs kunj serve) */
  bootstrap: boolean;
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

export function machineSettings(config: KunjConfig): MachineSettings {
  const m = (config.machine ?? {}) as NonNullable<KunjConfig['machine']>;
  const provider = typeof m.provider === 'string' ? m.provider : '';
  const block = provider ? m[provider] : undefined;
  return {
    provider,
    providerConfig: block && typeof block === 'object' && !Array.isArray(block) ? (block as Record<string, unknown>) : {},
    network: m.network === 'private' ? 'private' : 'tunnel',
    defaults: {
      size: typeof m.size === 'string' && m.size ? m.size : 'medium',
      diskGb: num(m.diskGb, 30),
      spot: m.spot === true,
      selfSuspend: m.selfSuspend !== false,
      bootTimeoutMs: num(m.bootTimeoutMs, 600000),
      image: typeof m.image === 'string' ? m.image : '',
    },
    kunjPackage: typeof m.kunjPackage === 'string' ? m.kunjPackage : '',
    bootstrap: m.bootstrap !== false,
    idleMinutes: num(m.idleMinutes, 30),
    pairWindowMinutes: num(m.pairWindowMinutes, 10),
    coordinatorIdleMinutes: num(m.coordinatorIdleMinutes, 60),
  };
}

/** `~/.kunj/coordinator/`: a coordinator's tokens, its machines' tokens, its record and log. */
export function coordinatorDir(home: string = getGlobalKunjDir()): string {
  return path.join(home, 'coordinator');
}

export function coordinatorPaths(dir: string = coordinatorDir()) {
  return {
    dir,
    /** The client `default` token (a local coordinator's clients use this one) */
    token: path.join(dir, 'token'),
    /** Named client tokens */
    clients: path.join(dir, 'tokens.json'),
    /** Machine name → that machine's serve token */
    machineTokens: path.join(dir, 'machine-tokens.json'),
    /** { pid, port, version, startedAt } of the running coordinator */
    record: path.join(dir, 'coordinator.json'),
    log: path.join(dir, 'serve.log'),
  };
}
