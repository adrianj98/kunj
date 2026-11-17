import { CliResult, CliRunner } from '../cli';
import { Ec2Provider, ec2Value } from '../providers/ec2';
import { providerConformance } from './conformance';
import { machineLabels } from '../provider';

const CFG = { region: 'us-east-1', subnet: 'subnet-0abc1234', securityGroups: ['sg-0abc1234'] };

/** aws as far as Ec2Provider uses it, over an in-memory account: argv in, JSON out. */
class FakeAws {
  instances = new Map<string, any>();
  images = new Map<string, any>();
  calls: string[][] = [];
  private seq = 0;

  private static ok(out: unknown = {}): CliResult {
    return { code: 0, stdout: JSON.stringify(out), stderr: '' };
  }

  private values(args: string[], name: string): string[] {
    const i = args.indexOf(name);
    if (i < 0) return [];
    const out: string[] = [];
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
    return out;
  }

  /** `--filters` must be exactly one JSON array, as the real CLI needs it */
  private filters(args: string[]): Array<{ Name: string; Values: string[] }> {
    const given = this.values(args, '--filters');
    if (given.length === 0) return [];
    expect(given).toHaveLength(1);
    const parsed = JSON.parse(given[0]);
    expect(Array.isArray(parsed)).toBe(true);
    return parsed;
  }

  private static matches(o: { Tags?: Array<{ Key: string; Value: string }>; State?: { Name: string }; Name?: string }, filters: Array<{ Name: string; Values: string[] }>): boolean {
    return filters.every(({ Name, Values }) => {
      if (Name === 'instance-state-name') return Values.includes(o.State?.Name ?? '');
      if (Name === 'name') return Values.includes(o.Name ?? '');
      const key = Name.replace(/^tag:/, '');
      return Values.includes(o.Tags?.find(t => t.Key === key)?.Value ?? '\0');
    });
  }

  addForeign(name: string): void {
    const id = `i-0000000${++this.seq}aaa`;
    this.instances.set(id, { InstanceId: id, State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: name }, { Key: 'team', Value: 'other' }], InstanceType: 'm5.large' });
  }

  runner: CliRunner = async (cmd, args) => {
    expect(cmd).toBe('aws');
    expect(args.slice(-4)).toEqual(['--region', 'us-east-1', '--output', 'json']);
    this.calls.push(args);
    const [service, verb] = args;
    expect(service).toBe('ec2');
    const ids = this.values(args, '--instance-ids');
    const each = (fn: (i: any) => void) => {
      for (const id of ids) {
        const inst = this.instances.get(id);
        if (!inst) return { code: 254, stdout: '', stderr: `An error occurred (InvalidInstanceID.NotFound) when calling the operation: The instance ID '${id}' does not exist` };
        fn(inst);
      }
      return FakeAws.ok();
    };
    switch (verb) {
      case 'describe-instances':
        return FakeAws.ok({ Reservations: [{ Instances: [...this.instances.values()].filter(i => FakeAws.matches(i, this.filters(args))) }] });
      case 'run-instances': {
        const id = `i-0000000${++this.seq}abc`;
        const spec = JSON.parse(this.values(args, '--tag-specifications')[0])[0];
        const created = {
          InstanceId: id,
          State: { Name: 'running' },
          Tags: spec.Tags,
          InstanceType: this.values(args, '--instance-type')[0],
          PrivateIpAddress: `10.0.0.${this.seq + 3}`,
          LaunchTime: '2026-11-16T00:00:00Z',
          Placement: { AvailabilityZone: 'us-east-1a' },
        };
        this.instances.set(id, created);
        return FakeAws.ok({ Instances: [{ ...created, Tags: undefined }] });
      }
      case 'stop-instances':
        return each(i => {
          i.State = { Name: 'stopped' };
          i.StateReason = { Code: args.includes('--hibernate') ? 'Client.UserInitiatedHibernate' : 'Client.UserInitiatedShutdown' };
        });
      case 'start-instances':
        return each(i => {
          i.State = { Name: 'running' };
          delete i.StateReason;
        });
      case 'terminate-instances':
        return each(i => (i.State = { Name: 'terminated' }));
      case 'modify-instance-attribute':
        return FakeAws.ok();
      case 'describe-images':
        return FakeAws.ok({ Images: [...this.images.values()].filter(i => FakeAws.matches(i, this.filters(args))) });
      case 'create-image': {
        const ImageId = `ami-0000000${++this.seq}abc`;
        const spec = JSON.parse(this.values(args, '--tag-specifications')[0]);
        this.images.set(ImageId, { ImageId, Name: this.values(args, '--name')[0], Tags: spec[0].Tags, CreationDate: 'now', BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-0abc' } }] });
        return FakeAws.ok({ ImageId });
      }
      case 'wait':
      case 'delete-snapshot':
        return FakeAws.ok();
      case 'deregister-image':
        this.images.delete(this.values(args, '--image-id')[0]);
        return FakeAws.ok();
    }
    throw new Error(`unexpected aws ${args.join(' ')}`);
  };
}

providerConformance('Ec2Provider (simulated aws)', () => {
  const aws = new FakeAws();
  return { provider: new Ec2Provider(CFG, { run: aws.runner }), addForeign: name => aws.addForeign(name) };
});

describe('Ec2Provider', () => {
  let aws: FakeAws;
  beforeEach(() => {
    aws = new FakeAws();
  });
  const spec = (over: Record<string, unknown> = {}) => ({
    name: 'kunj-app-x-abc123',
    labels: machineLabels('github.com/acme/app', 'feature/x~1'),
    size: 'medium',
    image: '',
    diskGb: 30,
    spot: false,
    selfSuspend: false,
    ...over,
  });
  const runArgs = () => aws.calls.find(c => c[1] === 'run-instances')!;
  const flag = (n: string) => runArgs()[runArgs().indexOf(n) + 1];

  it('creates a private, hibernation-ready machine from the stock Ubuntu with no credential', async () => {
    const p = new Ec2Provider(CFG, { run: aws.runner });
    const m = await p.create(spec());
    expect(m).toMatchObject({ name: 'kunj-app-x-abc123', state: 'running', size: 't3.large', labels: spec().labels });
    expect(m.id).toMatch(/^i-/);
    expect(flag('--image-id')).toBe('resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id');
    expect(flag('--instance-type')).toBe('t3.large');
    expect(flag('--subnet-id')).toBe('subnet-0abc1234');
    expect(runArgs()).toContain('--no-associate-public-ip-address');
    expect(flag('--hibernation-options')).toBe('Configured=true');
    expect(JSON.parse(flag('--block-device-mappings'))[0].Ebs).toMatchObject({ VolumeSize: 30, Encrypted: true, DeleteOnTermination: true });
    expect(flag('--metadata-options')).toBe('HttpTokens=required,HttpPutResponseHopLimit=1');
    expect(runArgs()).not.toContain('--iam-instance-profile');
    // a branch with a character a tag does not allow is stored encoded, and read back exactly
    const tags = JSON.parse(flag('--tag-specifications'))[0].Tags as Array<{ Key: string; Value: string }>;
    expect(tags.find(t => t.Key === 'kunj.branch')!.Value).toBe(ec2Value('feature/x~1'));
    expect(ec2Value('feature/x~1')).toMatch(/^b64\./);
    expect(ec2Value('feature/x')).toBe('feature/x');
    expect((await p.list({ 'kunj.branch': 'feature/x~1' })).map(x => x.name)).toEqual(['kunj-app-x-abc123']);
  });

  it('gives a machine the instance profile and a second metadata hop only for the cache store, and spot when asked', async () => {
    const p = new Ec2Provider({ ...CFG, instanceProfile: 'kunj-machine' }, { run: aws.runner });
    await p.create(spec({ cacheStore: true, spot: true, size: 'm7i.2xlarge' }));
    expect(flag('--iam-instance-profile')).toBe('Name=kunj-machine');
    expect(flag('--metadata-options')).toContain('HopLimit=2');
    expect(flag('--instance-type')).toBe('m7i.2xlarge');
    expect(JSON.parse(flag('--instance-market-options')).MarketType).toBe('spot');
    expect(p.cacheSync({ store: 'bucket', bucket: 'my-cache', prefix: 'team' })).toEqual({
      store: 'bucket',
      image: 'rclone/rclone:1.68.2',
      env: { RCLONE_S3_PROVIDER: 'AWS', RCLONE_S3_ENV_AUTH: 'true', RCLONE_S3_REGION: 'us-east-1' },
      remote: ':s3:my-cache/team',
      display: 's3://my-cache/team',
    });
    expect(() => new Ec2Provider(CFG, { run: aws.runner }).cacheSync({ store: 'bucket', bucket: 'b-1', prefix: '' })).toThrow(/instanceProfile/);
  });

  it('suspends by hibernating, tunnels through Session Manager, and deletes an image with its snapshot', async () => {
    const p = new Ec2Provider(CFG, { run: aws.runner });
    const m = await p.create(spec());
    await p.suspend(m.name);
    expect(aws.calls.find(c => c[1] === 'stop-instances')).toContain('--hibernate');
    const t = p.tunnel(m, 7433, 40001).argv;
    expect(t.slice(0, 5)).toEqual(['aws', 'ssm', 'start-session', '--target', m.id]);
    expect(JSON.parse(t[t.indexOf('--parameters') + 1])).toEqual({ portNumber: ['7433'], localPortNumber: ['40001'] });
    await p.images.createFrom(m, 'kunj-app-img-1', { 'kunj.repo': 'r', 'kunj.role': 'machine-image' });
    expect(aws.calls.some(c => c[1] === 'wait' && c[2] === 'image-available')).toBe(true);
    await p.images.delete('kunj-app-img-1');
    expect(aws.calls.some(c => c[1] === 'delete-snapshot' && c.includes('snap-0abc'))).toBe(true);
    // a golden image is booted by its id, found by name
    await p.images.createFrom(m, 'kunj-app-img-2', { 'kunj.repo': 'r', 'kunj.role': 'machine-image' });
    await p.create(spec({ name: 'kunj-app-y-def456', image: 'kunj-app-img-2' }));
    expect(aws.calls.filter(c => c[1] === 'run-instances')[1][aws.calls.filter(c => c[1] === 'run-instances')[1].indexOf('--image-id') + 1]).toMatch(/^ami-/);
  });

  it('checks its settings and explains a missing login', async () => {
    expect(() => new Ec2Provider({ region: 'us-east-1', securityGroups: ['sg-0abc1234'] })).toThrow(/machine\.ec2\.subnet/);
    expect(() => new Ec2Provider({ ...CFG, securityGroups: [] })).toThrow(/securityGroups/);
    expect(() => new Ec2Provider({ ...CFG, region: 'virginia; rm -rf' })).toThrow(/region/);
    const p = new Ec2Provider(CFG, { run: async () => ({ code: 253, stdout: '', stderr: 'Unable to locate credentials. You can configure credentials by running "aws configure".' }) });
    await expect(p.list({})).rejects.toMatchObject({ code: 'provider-cli-missing' });
  });
});
