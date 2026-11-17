// Google Compute Engine as a machine provider, driven through `gcloud … --format=json` with argv
// arrays (docs/specs/cloud-machines.md, google-cloud-containers.md). The only module that spawns
// gcloud.
//
// Labels: GCE label keys and values allow only [a-z0-9_-] (values up to 63 characters), and a branch
// or a repo id is rarely that. So each kunj label is stored twice: once in GCE labels, with the key's
// dots turned into dashes and a value that does not fit replaced by `h-<hash>` (what `list` filters
// on), and once exactly, in the instance's `kunj-labels` metadata (base64url JSON; an image's
// description). `list` and `get` return the exact labels and re-check a filter against them, so a
// hash collision can never return the wrong machine. Branch names are not secret; metadata is
// readable by every project viewer, and nothing secret is ever put there.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliRunner, execRunner, firstErrorLine } from '../cli';
import {
  CACHE_SYNC_IMAGE,
  CacheStoreConfig,
  CacheSync,
  Labels,
  Machine,
  MachineError,
  MachineImage,
  MachineProvider,
  MachineSize,
  MachineSpec,
  MachineState,
  ProviderFeatures,
  TunnelSpec,
  isKunjMachine,
  labelsInclude,
  shapeOf,
} from '../provider';
import type { ProviderDeps } from '.';

export interface GceConfig {
  project: string;
  zone: string;
  network?: string;
  subnet?: string;
  /** For machines (self-suspend, the cache bucket); empty: none (machines get no credential at all) */
  serviceAccount?: string;
  machineTypes?: Partial<Record<'small' | 'medium' | 'large', string>>;
  /** `<project>/<image family>` of the stock image a machine starts from without a golden image */
  baseImage?: string;
  /** Network tag the firewall rule for the serve port matches */
  networkTag?: string;
}

export const GCE_DEFAULTS = {
  machineTypes: { small: 'e2-medium', medium: 'e2-standard-2', large: 'e2-standard-4' },
  baseImage: 'ubuntu-os-cloud/ubuntu-2404-lts-amd64',
  networkTag: 'kunj-machine',
};

const SIZE_INFO: Record<string, { vcpus: number; memoryGb: number }> = {
  'e2-medium': { vcpus: 2, memoryGb: 4 },
  'e2-standard-2': { vcpus: 2, memoryGb: 8 },
  'e2-standard-4': { vcpus: 4, memoryGb: 16 },
};

const LABELS_METADATA_KEY = 'kunj-labels';

// What each value may be before it becomes an argument
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ZONE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMAGE = /^[a-z][-a-z0-9]{0,62}(\/[a-z][-a-z0-9]{0,62})?$/;
const SERVICE_ACCOUNT = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.iam\.gserviceaccount\.com$|^[0-9]+-compute@developer\.gserviceaccount\.com$/;
const META_KEY = /^[a-zA-Z0-9_-]{1,128}$/;

function check(value: string | undefined, re: RegExp, what: string): string {
  if (!value || !re.test(value)) {
    throw new MachineError(`machine.gce.${what} ${value ? `"${value}" is not valid` : 'is not set'}. Set it with kunj config --set machine.gce.${what}=<value> --global.`, 'bad-machine-config');
  }
  return value;
}

/** A GCE label key for a kunj label key: `kunj.repo` → `kunj-repo`. */
export function gceKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** A value as stored in a GCE label: itself when it fits, else `h-` and a hash of it. */
export function gceValue(value: string): string {
  if (/^[a-z0-9_-]{0,63}$/.test(value) && !value.startsWith('h-')) return value;
  return `h-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

function gceLabels(labels: Labels): string {
  return Object.keys(labels).sort().map(k => `${gceKey(k)}=${gceValue(labels[k])}`).join(',');
}

/** gcloud's dict syntax with a delimiter no key or value contains (`^<d>^k=v<d>k=v`). */
export function gcloudDict(entries: Record<string, string>): string {
  const text = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  for (const d of [',', '|', ';', '#', '@', '%']) {
    if (text.every(t => !t.includes(d))) return d === ',' ? text.join(',') : `^${d}^${text.join(d)}`;
  }
  throw new MachineError('A metadata value contains every delimiter gcloud can take.', 'bad-machine-config');
}

function encodeLabels(labels: Labels): string {
  return Buffer.from(JSON.stringify(labels)).toString('base64url');
}

function decodeLabels(text: string | undefined): Labels | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every(v => typeof v === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

const STATES: Record<string, MachineState> = {
  PROVISIONING: 'provisioning',
  STAGING: 'provisioning',
  RUNNING: 'running',
  SUSPENDING: 'suspending',
  SUSPENDED: 'suspended',
  STOPPING: 'stopping',
  TERMINATED: 'stopped',
};

const lastSegment = (url: string | undefined): string | undefined => url?.slice(url.lastIndexOf('/') + 1);

interface GceInstance {
  name: string;
  status: string;
  labels?: Record<string, string>;
  metadata?: { items?: Array<{ key: string; value: string }> };
  machineType?: string;
  zone?: string;
  creationTimestamp?: string;
  networkInterfaces?: Array<{ networkIP?: string }>;
}

interface GceImage {
  name: string;
  labels?: Record<string, string>;
  description?: string;
  creationTimestamp?: string;
}

export class GceProvider implements MachineProvider {
  readonly name = 'gce';
  readonly features: ProviderFeatures = { suspend: true, spot: true, images: true, diskSnapshots: true, selfSuspend: true };
  private readonly cfg: Required<Pick<GceConfig, 'project' | 'zone' | 'baseImage' | 'networkTag'>> & GceConfig;
  private readonly run: CliRunner;

  constructor(config: Record<string, unknown>, deps: ProviderDeps = {}) {
    const c = config as Partial<GceConfig>;
    const machineTypes = { ...GCE_DEFAULTS.machineTypes, ...(c.machineTypes ?? {}) };
    for (const [cls, shape] of Object.entries(machineTypes)) check(shape, SHAPE, `machineTypes.${cls}`);
    this.cfg = {
      ...c,
      project: check(c.project, PROJECT, 'project'),
      zone: check(c.zone, ZONE, 'zone'),
      baseImage: check(c.baseImage || GCE_DEFAULTS.baseImage, IMAGE, 'baseImage'),
      networkTag: check(c.networkTag || GCE_DEFAULTS.networkTag, NAME, 'networkTag'),
      machineTypes,
      network: c.network ? check(c.network, NAME, 'network') : undefined,
      subnet: c.subnet ? check(c.subnet, NAME, 'subnet') : undefined,
      serviceAccount: c.serviceAccount ? check(c.serviceAccount, SERVICE_ACCOUNT, 'serviceAccount') : undefined,
    };
    this.run = deps.run ?? execRunner;
  }

  private scope(): string[] {
    return ['--project', this.cfg.project, '--zone', this.cfg.zone];
  }

  /** Runs gcloud; a failure becomes provider-failed (or provider-cli-missing for a missing login). */
  private async gcloud(args: string[], what: string): Promise<string> {
    const r = await this.run('gcloud', [...args, '--quiet']);
    // A list whose requests failed (bad credentials, no access to the project) still exits 0 with []
    // and only a warning: taken as a failure, or every machine would look gone
    const partial = /Some requests did not succeed/i.test(r.stderr);
    if (r.code === 0 && !partial) return r.stdout;
    const line = partial ? (r.stderr.split('\n').find(l => /^\s*-\s/.test(l)) ?? '').replace(/^\s*-\s*/, '').trim() : firstErrorLine(r.stderr);
    if (/do not currently have an active account|gcloud auth login|Reauthentication required|invalid authentication credentials/i.test(r.stderr)) {
      throw new MachineError(`gcloud is not logged in or its credentials are not accepted (${line}). Run gcloud auth login, then try again.`, 'provider-cli-missing');
    }
    throw new MachineError(`gcloud could not ${what}: ${line || `exit ${r.code}`}`, 'provider-failed');
  }

  private static notFound(stderr: string): boolean {
    return /was not found|not found|notFound/i.test(stderr);
  }

  private toMachine(i: GceInstance): Machine | null {
    const exact = decodeLabels(i.metadata?.items?.find(m => m.key === LABELS_METADATA_KEY)?.value);
    return {
      name: i.name,
      state: STATES[i.status] ?? 'unknown',
      // A machine kunj did not make has no exact labels: its GCE labels as they are (never kunj.role)
      labels: exact ?? { ...(i.labels ?? {}) },
      size: lastSegment(i.machineType) ?? '',
      zone: lastSegment(i.zone),
      createdAt: i.creationTimestamp ?? '',
      addresses: { internal: i.networkInterfaces?.[0]?.networkIP },
    };
  }

  async list(filter: Labels): Promise<Machine[]> {
    const clauses = Object.keys(filter).sort().map(k => `labels.${gceKey(k)}=${gceValue(filter[k])}`);
    const args = ['compute', 'instances', 'list', '--project', this.cfg.project, `--zones=${this.cfg.zone}`, '--format=json'];
    if (clauses.length) args.push(`--filter=${clauses.join(' AND ')}`);
    const out = JSON.parse((await this.gcloud(args, 'list instances')) || '[]') as GceInstance[];
    return out.map(i => this.toMachine(i)).filter((m): m is Machine => !!m && labelsInclude(m.labels, filter));
  }

  async get(name: string): Promise<Machine | null> {
    check(name, NAME, 'name');
    const r = await this.run('gcloud', ['compute', 'instances', 'describe', name, ...this.scope(), '--format=json', '--quiet']);
    if (r.code !== 0) {
      if (GceProvider.notFound(r.stderr)) return null;
      throw new MachineError(`gcloud could not describe ${name}: ${firstErrorLine(r.stderr)}`, 'provider-failed');
    }
    return this.toMachine(JSON.parse(r.stdout) as GceInstance);
  }

  /** The machine, refusing one kunj did not create; null when there is none. */
  private async ours(name: string): Promise<Machine | null> {
    const m = await this.get(name);
    if (m && !isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    return m;
  }

  private async mustBeOurs(name: string): Promise<Machine> {
    const m = await this.ours(name);
    if (!m) throw new MachineError(`No machine named ${name} in ${this.cfg.project}/${this.cfg.zone}.`, 'machine-not-found');
    return m;
  }

  private imageArgs(image: string): string[] {
    if (!image) {
      const [project, family] = this.cfg.baseImage.split('/');
      return family ? ['--image-family', family, '--image-project', project] : ['--image', project];
    }
    check(image, IMAGE, 'image');
    return image.includes('/') ? ['--image', image.split('/')[1], '--image-project', image.split('/')[0]] : ['--image', image];
  }

  async create(spec: MachineSpec): Promise<Machine> {
    check(spec.name, NAME, 'name');
    const shape = check(shapeOf(this, spec.size), SHAPE, 'size');
    if (!Number.isInteger(spec.diskGb) || spec.diskGb < 10 || spec.diskGb > 65536) {
      throw new MachineError(`machine.diskGb ${spec.diskGb} must be a whole number of GB between 10 and 65536.`, 'bad-machine-config');
    }
    const metadata: Record<string, string> = { ...(spec.metadata ?? {}), [LABELS_METADATA_KEY]: encodeLabels(spec.labels) };
    for (const k of Object.keys(metadata)) check(k, META_KEY, `metadata key`);
    const args = [
      'compute', 'instances', 'create', spec.name, ...this.scope(),
      '--machine-type', shape,
      ...this.imageArgs(spec.image),
      '--boot-disk-size', `${spec.diskGb}GB`,
      '--boot-disk-type', 'pd-balanced',
      '--no-address',
      '--tags', this.cfg.networkTag,
      '--labels', gceLabels(spec.labels),
      '--metadata', gcloudDict(metadata),
      '--format=json',
    ];
    if (this.cfg.network) args.push('--network', this.cfg.network);
    if (this.cfg.subnet) args.push('--subnet', this.cfg.subnet);
    if ((spec.selfSuspend || spec.cacheStore) && this.cfg.serviceAccount) args.push('--service-account', this.cfg.serviceAccount, '--scopes', 'cloud-platform');
    else args.push('--no-service-account', '--no-scopes');
    if (spec.spot) args.push('--provisioning-model', 'SPOT', '--instance-termination-action', 'STOP');
    // The startup script goes by file: it is far too long and too full of delimiters for --metadata
    let scriptDir: string | undefined;
    if (spec.startupScript) {
      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-startup-'));
      const file = path.join(scriptDir, 'startup.sh');
      fs.writeFileSync(file, spec.startupScript, { mode: 0o600 });
      args.push('--metadata-from-file', `startup-script=${file}`);
    }
    const r = await this.run('gcloud', [...args, '--quiet']).finally(() => {
      if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true });
    });
    if (r.code !== 0) {
      if (/already exists/i.test(r.stderr)) throw new MachineError(`A machine named ${spec.name} already exists.`, 'machine-exists');
      throw new MachineError(`gcloud could not create ${spec.name}: ${firstErrorLine(r.stderr)}`, 'machine-create-failed');
    }
    const created = JSON.parse(r.stdout || '[]') as GceInstance[] | GceInstance;
    const instance = Array.isArray(created) ? created[0] : created;
    return instance ? (this.toMachine(instance) as Machine) : ((await this.get(spec.name)) as Machine);
  }

  /** Runs an instance verb unless the machine is already in one of `done`. */
  private async transition(name: string, verb: string, done: MachineState[]): Promise<void> {
    const m = await this.mustBeOurs(name);
    if (done.includes(m.state)) return;
    await this.gcloud(['compute', 'instances', verb, name, ...this.scope()], `${verb} ${name}`);
  }

  suspend(name: string): Promise<void> {
    return this.transition(name, 'suspend', ['suspended', 'suspending']);
  }

  resume(name: string): Promise<void> {
    return this.transition(name, 'resume', ['running', 'provisioning']);
  }

  stop(name: string): Promise<void> {
    return this.transition(name, 'stop', ['stopped', 'stopping']);
  }

  async start(name: string): Promise<void> {
    // A suspended instance is resumed, not started (gcloud refuses start on SUSPENDED)
    const m = await this.mustBeOurs(name);
    if (m.state === 'running' || m.state === 'provisioning') return;
    const verb = m.state === 'suspended' ? 'resume' : 'start';
    await this.gcloud(['compute', 'instances', verb, name, ...this.scope()], `${verb} ${name}`);
  }

  async delete(name: string, opts: { disks: boolean }): Promise<void> {
    if (!(await this.ours(name))) return;
    await this.gcloud(['compute', 'instances', 'delete', name, ...this.scope(), opts.disks ? '--delete-disks=all' : '--keep-disks=all'], `delete ${name}`);
  }

  address(machine: Machine, port: number): { host: string; port: number } | null {
    return machine.addresses.internal ? { host: machine.addresses.internal, port } : null;
  }

  tunnel(machine: Machine, port: number, localPort: number): TunnelSpec {
    return {
      argv: ['gcloud', 'compute', 'start-iap-tunnel', machine.name, String(port), `--local-host-port=127.0.0.1:${localPort}`, '--zone', machine.zone || this.cfg.zone, '--project', this.cfg.project],
    };
  }

  images = {
    list: async (filter: Labels): Promise<MachineImage[]> => {
      const clauses = Object.keys(filter).sort().map(k => `labels.${gceKey(k)}=${gceValue(filter[k])}`);
      const args = ['compute', 'images', 'list', '--project', this.cfg.project, '--no-standard-images', '--format=json'];
      if (clauses.length) args.push(`--filter=${clauses.join(' AND ')}`);
      const out = JSON.parse((await this.gcloud(args, 'list images')) || '[]') as GceImage[];
      return out
        .map(i => ({ name: i.name, labels: decodeLabels(i.description) ?? { ...(i.labels ?? {}) }, createdAt: i.creationTimestamp ?? '' }))
        .filter(i => labelsInclude(i.labels, filter));
    },
    createFrom: async (machine: Machine, name: string, labels: Labels): Promise<MachineImage> => {
      check(name, NAME, 'image name');
      await this.gcloud(
        ['compute', 'images', 'create', name, '--project', this.cfg.project, '--source-disk', machine.name, '--source-disk-zone', machine.zone || this.cfg.zone,
          '--labels', gceLabels(labels), '--description', encodeLabels(labels), '--force'],
        `create image ${name}`,
      );
      return { name, labels: { ...labels }, createdAt: new Date().toISOString() };
    },
    delete: async (name: string): Promise<void> => {
      check(name, NAME, 'image name');
      const r = await this.run('gcloud', ['compute', 'images', 'delete', name, '--project', this.cfg.project, '--quiet']);
      if (r.code !== 0 && !GceProvider.notFound(r.stderr)) throw new MachineError(`gcloud could not delete image ${name}: ${firstErrorLine(r.stderr)}`, 'provider-failed');
    },
  };

  /**
   * A Cloud Storage bucket, reached with the machine's own service account (from the metadata
   * service, which a branch container's firewall blocks: only the sync container sees it).
   */
  cacheSync(config: CacheStoreConfig): CacheSync {
    if (!this.cfg.serviceAccount) {
      throw new MachineError(
        'machine.cache needs machine.gce.serviceAccount: the service account new machines run as, with Storage Object Admin on the cache bucket and nothing else it does not need.',
        'bad-machine-config',
      );
    }
    const root = `${config.bucket}${config.prefix ? `/${config.prefix}` : ''}`;
    return {
      store: 'bucket',
      image: CACHE_SYNC_IMAGE,
      env: { RCLONE_GCS_ENV_AUTH: 'true', RCLONE_GCS_BUCKET_POLICY_ONLY: 'true' },
      remote: `:gcs:${root}`,
      display: `gs://${root}`,
    };
  }

  sizes(): MachineSize[] {
    const types = this.cfg.machineTypes as Record<'small' | 'medium' | 'large', string>;
    return (['small', 'medium', 'large'] as const).map(name => ({ name, shape: types[name], ...(SIZE_INFO[types[name]] ?? { vcpus: 0, memoryGb: 0 }) }));
  }
}
