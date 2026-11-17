// Amazon EC2 as a machine provider, driven through `aws … --output json` with argv arrays
// (docs/specs/cloud-machines.md, "A second provider"). The only module that spawns aws.
//
// Names and labels: an EC2 instance has an id, not a name, so a machine's name is its `Name` tag
// and every kunj label is a tag of its own (`kunj.repo`, `kunj.branch`…). A tag value allows fewer
// characters than a branch does, so a value outside [A-Za-z0-9 _.:/=+@-] is stored as
// `b64.<base64url>`: listing filters on the stored form, which is exact (no hashing, no collision).
// Suspend is hibernation (`stop-instances --hibernate`): the root volume is encrypted and the
// instance is launched with hibernation configured. A hibernated instance and a stopped one are both
// `stopped` to EC2; the state reason tells them apart.

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

export interface Ec2Config {
  region: string;
  /** The private subnet machines start in */
  subnet: string;
  /** Security groups that let the coordinator (or SSM) reach the serve port */
  securityGroups: string[];
  /** An instance profile for machines: SSM for the tunnel, the cache bucket; empty: none */
  instanceProfile?: string;
  instanceTypes?: Partial<Record<'small' | 'medium' | 'large', string>>;
  /** An AMI id, or an SSM public parameter path, of the stock image */
  baseImage?: string;
  /** An aws CLI profile */
  profile?: string;
}

export const EC2_DEFAULTS = {
  instanceTypes: { small: 't3.medium', medium: 't3.large', large: 't3.xlarge' },
  baseImage: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
  rootDevice: '/dev/sda1',
};

const SIZE_INFO: Record<string, { vcpus: number; memoryGb: number }> = {
  't3.medium': { vcpus: 2, memoryGb: 4 },
  't3.large': { vcpus: 2, memoryGb: 8 },
  't3.xlarge': { vcpus: 4, memoryGb: 16 },
};

const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const SUBNET = /^subnet-[0-9a-f]{8,17}$/;
const GROUP = /^sg-[0-9a-f]{8,17}$/;
const NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SHAPE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9]+$/;
const AMI = /^ami-[0-9a-f]{8,17}$/;
const SSM_PARAM = /^\/[A-Za-z0-9/._-]+$/;
const PROFILE = /^[A-Za-z0-9_.-]{1,64}$/;
const INSTANCE_PROFILE = /^[A-Za-z0-9+=,.@_-]{1,128}$/;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const PLAIN_VALUE = /^[A-Za-z0-9 _.:/=+@-]*$/;

function check(value: string | undefined, re: RegExp, what: string): string {
  if (!value || !re.test(value)) {
    throw new MachineError(`machine.ec2.${what} ${value ? `"${value}" is not valid` : 'is not set'}. Set it in machine.ec2 (kunj config --set-json machine.ec2=… --global).`, 'bad-machine-config');
  }
  return value;
}

/** A label value as an EC2 tag value: itself when every character is allowed, else `b64.` and its base64url. */
export function ec2Value(value: string): string {
  const stored = PLAIN_VALUE.test(value) && !value.startsWith('b64.') ? value : `b64.${Buffer.from(value).toString('base64url')}`;
  if (stored.length > 256) throw new MachineError(`A label value is too long for an EC2 tag (${value.slice(0, 40)}…).`, 'bad-machine-config');
  return stored;
}

function fromEc2Value(stored: string): string {
  return stored.startsWith('b64.') ? Buffer.from(stored.slice(4), 'base64url').toString() : stored;
}

const tagList = (name: string | undefined, labels: Labels) => [
  ...(name ? [{ Key: 'Name', Value: name }] : []),
  ...Object.keys(labels).sort().map(k => ({ Key: k, Value: ec2Value(labels[k]) })),
];

function labelsOf(tags: Array<{ Key: string; Value: string }> | undefined): Labels {
  const out: Labels = {};
  for (const t of tags ?? []) if (t.Key.startsWith('kunj.')) out[t.Key] = fromEc2Value(t.Value);
  return out;
}

interface Ec2Instance {
  InstanceId: string;
  InstanceType?: string;
  State?: { Name?: string };
  StateReason?: { Code?: string };
  Tags?: Array<{ Key: string; Value: string }>;
  PrivateIpAddress?: string;
  LaunchTime?: string;
  Placement?: { AvailabilityZone?: string };
}

interface Ec2Image {
  ImageId: string;
  Name?: string;
  CreationDate?: string;
  Tags?: Array<{ Key: string; Value: string }>;
  BlockDeviceMappings?: Array<{ Ebs?: { SnapshotId?: string } }>;
}

/** Everything but a terminated instance, which EC2 still lists for an hour */
const LIVE_STATES = 'pending,running,stopping,stopped';

export class Ec2Provider implements MachineProvider {
  readonly name = 'ec2';
  // selfSuspend: a machine would need the aws CLI and ec2:StopInstances on itself; not built
  readonly features: ProviderFeatures = { suspend: true, spot: true, images: true, diskSnapshots: true, selfSuspend: false };
  private readonly cfg: Ec2Config & { instanceTypes: Record<'small' | 'medium' | 'large', string>; baseImage: string };
  private readonly run: CliRunner;

  constructor(config: Record<string, unknown>, deps: ProviderDeps = {}) {
    const c = config as Partial<Ec2Config>;
    const instanceTypes = { ...EC2_DEFAULTS.instanceTypes, ...(c.instanceTypes ?? {}) };
    for (const [cls, shape] of Object.entries(instanceTypes)) check(shape, SHAPE, `instanceTypes.${cls}`);
    const groups = Array.isArray(c.securityGroups) ? c.securityGroups : [];
    if (groups.length === 0) check(undefined, GROUP, 'securityGroups');
    const baseImage = c.baseImage || EC2_DEFAULTS.baseImage;
    if (!AMI.test(baseImage)) check(baseImage, SSM_PARAM, 'baseImage');
    this.cfg = {
      region: check(c.region, REGION, 'region'),
      subnet: check(c.subnet, SUBNET, 'subnet'),
      securityGroups: groups.map(g => check(g, GROUP, 'securityGroups')),
      instanceProfile: c.instanceProfile ? check(c.instanceProfile, INSTANCE_PROFILE, 'instanceProfile') : undefined,
      profile: c.profile ? check(c.profile, PROFILE, 'profile') : undefined,
      instanceTypes,
      baseImage,
    };
    this.run = deps.run ?? execRunner;
  }

  private scope(): string[] {
    return ['--region', this.cfg.region, ...(this.cfg.profile ? ['--profile', this.cfg.profile] : []), '--output', 'json'];
  }

  private async aws(args: string[], what: string): Promise<any> {
    const r = await this.run('aws', [...args, ...this.scope()]);
    if (r.code === 0) return r.stdout.trim() ? JSON.parse(r.stdout) : {};
    const line = firstErrorLine(r.stderr);
    if (/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|AuthFailure|sso login|could not be found/i.test(r.stderr)) {
      throw new MachineError(`aws is not logged in or its credentials are not accepted (${line}). Log in (aws sso login, or aws configure), then try again.`, 'provider-cli-missing');
    }
    throw new MachineError(`aws could not ${what}: ${line || `exit ${r.code}`}`, 'provider-failed');
  }

  private toMachine(i: Ec2Instance): Machine {
    const hibernated = i.StateReason?.Code === 'Client.UserInitiatedHibernate';
    const states: Record<string, MachineState> = {
      pending: 'provisioning',
      running: 'running',
      stopping: hibernated ? 'suspending' : 'stopping',
      stopped: hibernated ? 'suspended' : 'stopped',
    };
    return {
      name: i.Tags?.find(t => t.Key === 'Name')?.Value ?? i.InstanceId,
      id: i.InstanceId,
      state: states[i.State?.Name ?? ''] ?? 'unknown',
      labels: labelsOf(i.Tags),
      size: i.InstanceType ?? '',
      zone: i.Placement?.AvailabilityZone,
      createdAt: i.LaunchTime ?? '',
      addresses: { internal: i.PrivateIpAddress },
    };
  }

  private async describe(filters: string[]): Promise<Machine[]> {
    const out = await this.aws(['ec2', 'describe-instances', '--filters', `Name=instance-state-name,Values=${LIVE_STATES}`, ...filters], 'list instances');
    const instances: Ec2Instance[] = (out.Reservations ?? []).flatMap((r: { Instances?: Ec2Instance[] }) => r.Instances ?? []);
    return instances.map(i => this.toMachine(i));
  }

  async list(filter: Labels): Promise<Machine[]> {
    // Each filter is one argv element, so a value with a comma or a space cannot split it: the JSON form
    const filters = Object.keys(filter).sort().map(k => JSON.stringify({ Name: `tag:${k}`, Values: [ec2Value(filter[k])] }));
    return (await this.describe(filters)).filter(m => labelsInclude(m.labels, filter));
  }

  async get(name: string): Promise<Machine | null> {
    if (!NAME.test(name)) return null;
    const found = await this.describe([JSON.stringify({ Name: 'tag:Name', Values: [name] })]);
    return found.find(m => m.name === name) ?? null;
  }

  private async mustBeOurs(name: string): Promise<Machine & { id: string }> {
    const m = await this.get(name);
    if (!m) throw new MachineError(`No machine named ${name} in ${this.cfg.region}.`, 'machine-not-found');
    if (!isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    return m as Machine & { id: string };
  }

  private async imageId(image: string): Promise<string> {
    if (!image) return AMI.test(this.cfg.baseImage) ? this.cfg.baseImage : `resolve:ssm:${this.cfg.baseImage}`;
    if (AMI.test(image)) return image;
    check(image, NAME, 'image');
    const out = await this.aws(['ec2', 'describe-images', '--owners', 'self', '--filters', JSON.stringify({ Name: 'name', Values: [image] })], `find image ${image}`);
    const id = (out.Images as Ec2Image[] | undefined)?.[0]?.ImageId;
    if (!id) throw new MachineError(`No machine image named ${image} in ${this.cfg.region}.`, 'machine-create-failed');
    return id;
  }

  async create(spec: MachineSpec): Promise<Machine> {
    check(spec.name, NAME, 'name');
    const shape = check(shapeOf(this, spec.size), SHAPE, 'size');
    if (!Number.isInteger(spec.diskGb) || spec.diskGb < 10 || spec.diskGb > 16384) {
      throw new MachineError(`machine.diskGb ${spec.diskGb} must be a whole number of GB between 10 and 16384.`, 'bad-machine-config');
    }
    // EC2 does not make a Name unique: asked first
    if (await this.get(spec.name)) throw new MachineError(`A machine named ${spec.name} already exists.`, 'machine-exists');
    const credential = (spec.selfSuspend || spec.cacheStore) && this.cfg.instanceProfile;
    const args = [
      'ec2', 'run-instances',
      '--image-id', await this.imageId(spec.image),
      '--instance-type', shape,
      '--count', '1',
      '--subnet-id', this.cfg.subnet,
      '--security-group-ids', ...this.cfg.securityGroups,
      '--no-associate-public-ip-address',
      '--block-device-mappings', JSON.stringify([{ DeviceName: EC2_DEFAULTS.rootDevice, Ebs: { VolumeSize: spec.diskGb, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } }]),
      '--hibernation-options', 'Configured=true',
      // Session tokens only; one hop keeps containers from the instance's credential, two lets the
      // cache sync container (and only a bridge container: branch containers are firewalled) reach it
      '--metadata-options', `HttpTokens=required,HttpPutResponseHopLimit=${spec.cacheStore ? 2 : 1}`,
      '--tag-specifications', JSON.stringify([{ ResourceType: 'instance', Tags: tagList(spec.name, spec.labels) }]),
    ];
    if (credential) args.push('--iam-instance-profile', `Name=${this.cfg.instanceProfile}`);
    if (spec.spot) args.push('--instance-market-options', JSON.stringify({ MarketType: 'spot', SpotOptions: { SpotInstanceType: 'persistent', InstanceInterruptionBehavior: 'stop' } }));
    let scriptDir: string | undefined;
    if (spec.startupScript) {
      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-startup-'));
      const file = path.join(scriptDir, 'startup.sh');
      fs.writeFileSync(file, spec.startupScript, { mode: 0o600 });
      args.push('--user-data', `file://${file}`);
    }
    try {
      const out = await this.aws(args, `create ${spec.name}`).catch(err => {
        if (err instanceof MachineError && err.code === 'provider-failed') throw new MachineError(err.message, 'machine-create-failed');
        throw err;
      });
      const instance = (out.Instances as Ec2Instance[] | undefined)?.[0];
      if (!instance) throw new MachineError(`aws created no instance for ${spec.name}.`, 'machine-create-failed');
      return this.toMachine({ ...instance, Tags: instance.Tags ?? tagList(spec.name, spec.labels) });
    } finally {
      if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true });
    }
  }

  async suspend(name: string): Promise<void> {
    const m = await this.mustBeOurs(name);
    if (m.state === 'suspended' || m.state === 'suspending') return;
    // A stopped machine stays stopped: there is no memory left to keep
    if (m.state === 'stopped' || m.state === 'stopping') return;
    await this.aws(['ec2', 'stop-instances', '--hibernate', '--instance-ids', m.id], `suspend ${name}`);
  }

  async stop(name: string): Promise<void> {
    const m = await this.mustBeOurs(name);
    if (m.state === 'stopped' || m.state === 'stopping') return;
    // EC2 has no way from hibernated to plainly stopped without a start; it is as stopped as it gets
    if (m.state === 'suspended' || m.state === 'suspending') return;
    await this.aws(['ec2', 'stop-instances', '--instance-ids', m.id], `stop ${name}`);
  }

  async start(name: string): Promise<void> {
    const m = await this.mustBeOurs(name);
    if (m.state === 'running' || m.state === 'provisioning') return;
    await this.aws(['ec2', 'start-instances', '--instance-ids', m.id], `start ${name}`);
  }

  resume(name: string): Promise<void> {
    return this.start(name);
  }

  async delete(name: string, opts: { disks: boolean }): Promise<void> {
    const m = await this.get(name);
    if (!m) return;
    if (!isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    const id = check(m.id, INSTANCE_ID, 'instance id');
    if (!opts.disks) {
      await this.aws(['ec2', 'modify-instance-attribute', '--instance-id', id, '--block-device-mappings', JSON.stringify([{ DeviceName: EC2_DEFAULTS.rootDevice, Ebs: { DeleteOnTermination: false } }])], `keep the disks of ${name}`);
    }
    await this.aws(['ec2', 'terminate-instances', '--instance-ids', id], `delete ${name}`);
  }

  address(machine: Machine, port: number): { host: string; port: number } | null {
    return machine.addresses.internal ? { host: machine.addresses.internal, port } : null;
  }

  /** Session Manager port forwarding: needs the session-manager-plugin here and SSM in the instance profile. */
  tunnel(machine: Machine, port: number, localPort: number): TunnelSpec {
    const id = check(machine.id, INSTANCE_ID, 'instance id');
    return {
      argv: [
        'aws', 'ssm', 'start-session', '--target', id, '--document-name', 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify({ portNumber: [String(port)], localPortNumber: [String(localPort)] }),
        '--region', this.cfg.region, ...(this.cfg.profile ? ['--profile', this.cfg.profile] : []),
      ],
    };
  }

  images = {
    list: async (filter: Labels): Promise<MachineImage[]> => {
      const filters = Object.keys(filter).sort().map(k => JSON.stringify({ Name: `tag:${k}`, Values: [ec2Value(filter[k])] }));
      const out = await this.aws(['ec2', 'describe-images', '--owners', 'self', ...(filters.length ? ['--filters', ...filters] : [])], 'list images');
      return ((out.Images ?? []) as Ec2Image[])
        .map(i => ({ name: i.Name ?? i.ImageId, labels: labelsOf(i.Tags), createdAt: i.CreationDate ?? '' }))
        .filter(i => labelsInclude(i.labels, filter));
    },
    createFrom: async (machine: Machine, name: string, labels: Labels): Promise<MachineImage> => {
      check(name, NAME, 'image name');
      const id = check(machine.id, INSTANCE_ID, 'instance id');
      const tags = tagList(undefined, labels);
      const out = await this.aws(
        ['ec2', 'create-image', '--instance-id', id, '--name', name, '--tag-specifications', JSON.stringify([{ ResourceType: 'image', Tags: tags }, { ResourceType: 'snapshot', Tags: tags }])],
        `create image ${name}`,
      );
      // New machines can only boot it once it is available
      if (out.ImageId) await this.aws(['ec2', 'wait', 'image-available', '--image-ids', out.ImageId], `wait for image ${name}`);
      return { name, labels: { ...labels }, createdAt: new Date().toISOString() };
    },
    delete: async (name: string): Promise<void> => {
      check(name, NAME, 'image name');
      const out = await this.aws(['ec2', 'describe-images', '--owners', 'self', '--filters', JSON.stringify({ Name: 'name', Values: [name] })], `find image ${name}`);
      for (const image of (out.Images ?? []) as Ec2Image[]) {
        await this.aws(['ec2', 'deregister-image', '--image-id', image.ImageId], `delete image ${name}`);
        // An AMI's snapshots are billed until they are deleted too
        for (const b of image.BlockDeviceMappings ?? []) {
          if (b.Ebs?.SnapshotId) await this.aws(['ec2', 'delete-snapshot', '--snapshot-id', b.Ebs.SnapshotId], `delete the snapshot of ${name}`).catch(() => {});
        }
      }
    },
  };

  /** An S3 bucket, reached with the machine's instance profile (from the metadata service). */
  cacheSync(config: CacheStoreConfig): CacheSync {
    if (!this.cfg.instanceProfile) {
      throw new MachineError('machine.cache needs machine.ec2.instanceProfile: an instance profile whose role can read and write the cache bucket.', 'bad-machine-config');
    }
    const root = `${config.bucket}${config.prefix ? `/${config.prefix}` : ''}`;
    return {
      store: 'bucket',
      image: CACHE_SYNC_IMAGE,
      env: { RCLONE_S3_PROVIDER: 'AWS', RCLONE_S3_ENV_AUTH: 'true', RCLONE_S3_REGION: this.cfg.region },
      remote: `:s3:${root}`,
      display: `s3://${root}`,
    };
  }

  sizes(): MachineSize[] {
    return (['small', 'medium', 'large'] as const).map(name => ({ name, shape: this.cfg.instanceTypes[name], ...(SIZE_INFO[this.cfg.instanceTypes[name]] ?? { vcpus: 0, memoryGb: 0 }) }));
  }
}
