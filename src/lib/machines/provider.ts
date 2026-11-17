// The machine provider seam (docs/specs/cloud-machines.md): what kunj needs from a cloud to run one
// small VM per branch session. Everything cloud-specific lives behind MachineProvider; lifecycle,
// naming, the coordinator's routes and `kunj machine` only program against it. Only a provider module
// spawns its cloud's CLI, as only docker.ts spawns docker. No imports beyond node builtins and the
// container names, so the fast path can load it.

import { containerNames } from '../container/names';

export type Labels = Record<string, string>;

/** The labels kunj puts on a machine; together they are the only record of whose machine it is. */
export const MACHINE_LABEL = {
  repo: 'kunj.repo',
  branch: 'kunj.branch',
  version: 'kunj.version',
  role: 'kunj.role',
  /** The golden image it booted from ('' for the provider's stock image) */
  image: 'kunj.image',
  /** The coordinator client (token name) that created it; informational */
  owner: 'kunj.owner',
  /** On golden images: the blueprint hash they carry */
  blueprint: 'kunj.blueprint',
} as const;

export const MACHINE_ROLE = 'machine';
export const IMAGE_ROLE = 'machine-image';
/** The branch label of the machine a golden image is baked from; never a real branch (`..` is not allowed in one) */
export const IMAGE_BUILD_BRANCH = 'kunj..image-build';

export type MachineState = 'provisioning' | 'running' | 'suspending' | 'suspended' | 'stopping' | 'stopped' | 'unknown';

export interface Machine {
  name: string;
  state: MachineState;
  /** Exactly as set at create */
  labels: Labels;
  /** The provider's shape (e2-standard-2, t3.large…) */
  size: string;
  zone?: string;
  createdAt: string;
  addresses: { internal?: string };
}

export type SizeClass = 'small' | 'medium' | 'large';
export const SIZE_CLASSES: SizeClass[] = ['small', 'medium', 'large'];

export interface MachineSize {
  name: SizeClass;
  /** The provider's shape for this class */
  shape: string;
  vcpus: number;
  memoryGb: number;
}

export interface MachineSpec {
  name: string;
  labels: Labels;
  /** A size class, or a provider shape given verbatim */
  size: string;
  /** A golden image name, or '' for the provider's stock image */
  image: string;
  diskGb: number;
  spot: boolean;
  /** Give the machine the one-permission credential that lets it suspend itself */
  selfSuspend: boolean;
  zone?: string;
  /** Provider-visible, never a secret */
  metadata?: Record<string, string>;
  /** Run as root at every boot (cloud-init style); provider-visible, never a secret */
  startupScript?: string;
  /** Give the machine the credential that reads and writes the cache store (machine.cache) */
  cacheStore?: boolean;
}

/** machine.cache on a coordinator: where repository caches are kept outside any one machine. */
export interface CacheStoreConfig {
  store: 'bucket';
  bucket: string;
  /** A folder in the bucket, '' for its root */
  prefix: string;
}

/** The image the sync container runs: rclone, which speaks every cloud's object store. */
export const CACHE_SYNC_IMAGE = 'rclone/rclone:1.68.2';

/**
 * How a container on a machine reaches the cache store: an rclone image, the environment that
 * selects the machine's own credential, and the rclone remote of the store's root. Never a secret:
 * the credential is the machine's, read from its cloud's metadata service.
 */
export interface CacheSync {
  store: 'bucket';
  image: string;
  env: Record<string, string>;
  /** e.g. `:gcs:my-bucket/kunj` */
  remote: string;
  /** What to call it in messages, e.g. gs://my-bucket/kunj */
  display: string;
}

export interface MachineImage {
  name: string;
  labels: Labels;
  createdAt: string;
}

/** A local port forwarder to a machine: run argv, and it listens on 127.0.0.1:localPort. */
export interface TunnelSpec {
  argv: string[];
}

export interface ProviderFeatures {
  /** Memory-preserving suspend/resume (otherwise suspend is a stop) */
  suspend: boolean;
  spot: boolean;
  images: boolean;
  diskSnapshots: boolean;
  /** A machine can be given a credential to suspend itself */
  selfSuspend: boolean;
}

export interface MachineProvider {
  readonly name: string;
  readonly features: ProviderFeatures;
  /** Machines whose labels include every pair of `filter` exactly, in any state */
  list(filter: Labels): Promise<Machine[]>;
  get(name: string): Promise<Machine | null>;
  /** Returns once the machine exists; not yet reachable. An existing name is `machine-exists`. */
  create(spec: MachineSpec): Promise<Machine>;
  /** Idempotent: a suspended machine stays suspended */
  suspend(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  /** A missing machine is not an error */
  delete(name: string, opts: { disks: boolean }): Promise<void>;
  /** Where the machine's kunj serve answers on the private network, when it has an address there */
  address(machine: Machine, port: number): { host: string; port: number } | null;
  /** A local port forwarder to the machine's port, for a coordinator outside its network */
  tunnel(machine: Machine, port: number, localPort: number): TunnelSpec;
  images: {
    list(filter: Labels): Promise<MachineImage[]>;
    createFrom(machine: Machine, name: string, labels: Labels): Promise<MachineImage>;
    delete(name: string): Promise<void>;
  };
  /** What each size class means on this cloud */
  sizes(): MachineSize[];
  /** How this cloud's machines sync with a cache store; absent when the provider has none */
  cacheSync?(config: CacheStoreConfig): CacheSync;
}

export type MachineErrorCode =
  | 'machine-provider'
  | 'machine-not-found'
  | 'machine-ambiguous'
  | 'machine-asleep'
  | 'machine-exists'
  | 'machine-not-kunj'
  | 'machine-create-failed'
  | 'machine-token'
  | 'machine-timeout'
  | 'provider-cli-missing'
  | 'provider-failed'
  | 'bad-machine-config'
  | 'coordinator-start-failed'
  | 'coordinator-no-machines';

/** An expected failure (printed without a stack trace); `--json` prints its code. */
export class MachineError extends Error {
  constructor(message: string, readonly code: MachineErrorCode) {
    super(message);
    this.name = 'MachineError';
  }

  get jsonCode(): MachineErrorCode {
    return this.code;
  }
}

/**
 * A machine's name: the branch container's name (same repo, branch and hash), in the form every
 * cloud accepts for an instance (a lowercase DNS label, at most 63 characters, starting with a
 * letter). The hash at the end is kept whatever is clipped.
 */
export function machineName(repoName: string, repoId: string, branch: string): string {
  const container = containerNames(repoName, repoId, branch).container;
  const hash = container.slice(container.lastIndexOf('-') + 1);
  let body = container
    .slice(0, container.lastIndexOf('-'))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+$/, '');
  body = body.slice(0, 63 - hash.length - 1).replace(/-+$/, '');
  return `${body}-${hash}`;
}

export function machineLabels(repoId: string, branch: string, extra: Labels = {}): Labels {
  return { [MACHINE_LABEL.repo]: repoId, [MACHINE_LABEL.branch]: branch, [MACHINE_LABEL.role]: MACHINE_ROLE, ...extra };
}

export function isKunjMachine(m: { labels: Labels }): boolean {
  return m.labels[MACHINE_LABEL.role] === MACHINE_ROLE;
}

export function labelsInclude(labels: Labels, filter: Labels): boolean {
  return Object.entries(filter).every(([k, v]) => labels[k] === v);
}

/** The shape a spec's size means: a class through the provider's table, anything else verbatim. */
export function shapeOf(provider: Pick<MachineProvider, 'sizes'>, size: string): string {
  const cls = provider.sizes().find(s => s.name === size);
  return cls ? cls.shape : size;
}

/** Whether a machine in this state answers on its network now. */
export function isAwake(state: MachineState): boolean {
  return state === 'running';
}
