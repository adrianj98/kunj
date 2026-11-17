// The machine settings, resolved with their defaults, and where a coordinator keeps its files.
// Light on purpose: `kunj machine` and `kunj serve` load it on the fast path.

import * as path from 'path';
import { getGlobalKunjDir } from '../config';
import { KunjConfig } from '../../types';
import { MachineDefaults } from './coordinator';
import { CacheStoreConfig, MachineError } from './provider';

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
  /** machine.cache as written; a coordinator checks it with cacheStoreConfig() when it starts */
  cache: unknown;
}

const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** machine.cache, checked: `{ "bucket": "<name>", "prefix": "<folder>" }` ("store": "none" turns it off). */
export function cacheStoreConfig(value: unknown): CacheStoreConfig | null {
  if (value === undefined || value === null) return null;
  const bad = (why: string): never => {
    throw new MachineError(`machine.cache ${why}. Expected { "bucket": "<bucket name>", "prefix": "<folder, optional>" }.`, 'bad-machine-config');
  };
  if (typeof value !== 'object' || Array.isArray(value)) bad('is not an object');
  const { store, bucket, prefix } = value as { store?: unknown; bucket?: unknown; prefix?: unknown };
  if (store === 'none') return null;
  if (store !== undefined && store !== 'bucket') bad(`has the unknown store ${JSON.stringify(store)} (known: bucket, none)`);
  if (bucket === undefined && store === undefined && Object.keys(value as object).length === 0) return null;
  if (typeof bucket !== 'string' || !BUCKET.test(bucket)) bad(`needs a bucket name, not ${JSON.stringify(bucket)}`);
  const folder = prefix === undefined || prefix === null ? '' : prefix;
  if (typeof folder !== 'string' || (folder !== '' && (!PREFIX.test(folder) || folder.length > 200))) bad(`has a prefix that is not a plain folder path: ${JSON.stringify(prefix)}`);
  return { store: 'bucket', bucket: bucket as string, prefix: folder as string };
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
    cache: m.cache,
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
