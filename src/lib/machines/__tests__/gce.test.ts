import { CliResult, CliRunner } from '../cli';
import { GceProvider, gceKey, gceValue, gcloudDict } from '../providers/gce';
import { providerConformance } from './conformance';
import { machineLabels } from '../provider';

const CFG = { project: 'my-proj-123', zone: 'us-central1-a' };

/** gcloud as far as GceProvider uses it, over an in-memory project: argv in, JSON out. */
class FakeGcloud {
  instances = new Map<string, any>();
  images = new Map<string, any>();
  calls: string[][] = [];
  failNext: CliResult | undefined;

  private flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
    const eq = args.find(a => a.startsWith(name + '='));
    return eq?.slice(name.length + 1);
  }

  private static dict(text: string): Record<string, string> {
    let delim = ',';
    const m = /^\^(.)\^/.exec(text);
    if (m) {
      delim = m[1];
      text = text.slice(3);
    }
    const out: Record<string, string> = {};
    for (const part of text.split(delim)) {
      const eq = part.indexOf('=');
      out[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return out;
  }

  private static matches(labels: Record<string, string>, filter: string | undefined): boolean {
    if (!filter) return true;
    return filter.split(' AND ').every(clause => {
      const m = /^labels\.([^=]+)=(.*)$/.exec(clause);
      if (!m) throw new Error(`unexpected filter ${clause}`);
      return labels[m[1]] === m[2];
    });
  }

  private static ok(out: unknown): CliResult {
    return { code: 0, stdout: JSON.stringify(out), stderr: '' };
  }

  private static err(stderr: string): CliResult {
    return { code: 1, stdout: '', stderr };
  }

  addForeign(name: string): void {
    this.instances.set(name, { name, status: 'RUNNING', labels: { team: 'other' }, zone: 'zones/us-central1-a', machineType: 'machineTypes/n1-standard-1' });
  }

  runner: CliRunner = async (cmd, args) => {
    expect(cmd).toBe('gcloud');
    expect(args).toContain('--quiet');
    this.calls.push(args);
    if (this.failNext) {
      const r = this.failNext;
      this.failNext = undefined;
      return r;
    }
    const [group, kind, verb, name] = args;
    expect(group).toBe('compute');
    if (kind === 'instances') {
      const inst = this.instances.get(name);
      const missing = FakeGcloud.err(`ERROR: (gcloud.compute.instances.${verb}) Could not fetch resource:\n - The resource 'projects/p/zones/z/instances/${name}' was not found`);
      switch (verb) {
        case 'list':
          return FakeGcloud.ok([...this.instances.values()].filter(i => FakeGcloud.matches(i.labels ?? {}, this.flag(args, '--filter'))));
        case 'describe':
          return inst ? FakeGcloud.ok(inst) : missing;
        case 'create': {
          if (inst) return FakeGcloud.err(`ERROR: (gcloud.compute.instances.create) The resource '${name}' already exists`);
          const labels = FakeGcloud.dict(this.flag(args, '--labels')!);
          const metadata = FakeGcloud.dict(this.flag(args, '--metadata')!);
          const created = {
            name,
            status: 'RUNNING',
            labels,
            metadata: { items: Object.entries(metadata).map(([key, value]) => ({ key, value })) },
            machineType: `https://x/zones/us-central1-a/machineTypes/${this.flag(args, '--machine-type')}`,
            zone: 'https://x/zones/us-central1-a',
            creationTimestamp: '2026-11-16T00:00:00Z',
            networkInterfaces: [{ networkIP: `10.128.0.${this.instances.size + 2}` }],
          };
          this.instances.set(name, created);
          return FakeGcloud.ok([created]);
        }
        case 'suspend':
        case 'resume':
        case 'stop':
        case 'start':
          if (!inst) return missing;
          if (verb === 'start' && inst.status === 'SUSPENDED') return FakeGcloud.err('ERROR: instance is suspended; use resume');
          inst.status = { suspend: 'SUSPENDED', resume: 'RUNNING', stop: 'TERMINATED', start: 'RUNNING' }[verb];
          return FakeGcloud.ok([]);
        case 'delete':
          if (!inst) return missing;
          this.instances.delete(name);
          return FakeGcloud.ok([]);
      }
    }
    if (kind === 'images') {
      switch (verb) {
        case 'list':
          return FakeGcloud.ok([...this.images.values()].filter(i => FakeGcloud.matches(i.labels ?? {}, this.flag(args, '--filter'))));
        case 'create':
          this.images.set(name, { name, labels: FakeGcloud.dict(this.flag(args, '--labels')!), description: this.flag(args, '--description'), creationTimestamp: 'now' });
          return FakeGcloud.ok([]);
        case 'delete':
          if (!this.images.delete(name)) return FakeGcloud.err(`The resource '${name}' was not found`);
          return FakeGcloud.ok([]);
      }
    }
    throw new Error(`unexpected gcloud ${args.join(' ')}`);
  };
}

providerConformance('GceProvider (simulated gcloud)', () => {
  const gcloud = new FakeGcloud();
  return { provider: new GceProvider(CFG, { run: gcloud.runner }), addForeign: name => gcloud.addForeign(name) };
});

describe('GceProvider argv', () => {
  let gcloud: FakeGcloud;
  beforeEach(() => {
    gcloud = new FakeGcloud();
  });

  const spec = (over: Record<string, unknown> = {}) => ({
    name: 'kunj-app-x-abc123',
    labels: machineLabels('github.com/acme/app', 'feature/x'),
    size: 'medium',
    image: '',
    diskGb: 30,
    spot: false,
    selfSuspend: false,
    ...over,
  });

  it('creates a private, credential-less machine from the stock Ubuntu by default', async () => {
    const p = new GceProvider(CFG, { run: gcloud.runner });
    await p.create(spec());
    const args = gcloud.calls[0];
    expect(args.slice(0, 4)).toEqual(['compute', 'instances', 'create', 'kunj-app-x-abc123']);
    const flag = (n: string) => args[args.indexOf(n) + 1];
    expect(flag('--project')).toBe('my-proj-123');
    expect(flag('--zone')).toBe('us-central1-a');
    expect(flag('--machine-type')).toBe('e2-standard-2');
    expect(flag('--image-family')).toBe('ubuntu-2404-lts-amd64');
    expect(flag('--image-project')).toBe('ubuntu-os-cloud');
    expect(flag('--boot-disk-size')).toBe('30GB');
    expect(flag('--tags')).toBe('kunj-machine');
    expect(args).toContain('--no-address');
    expect(args).toContain('--no-service-account');
    expect(args).toContain('--no-scopes');
    expect(args).not.toContain('--provisioning-model');
    // labels: dots to dashes, values that do not fit hashed
    expect(flag('--labels')).toBe(`kunj-branch=${gceValue('feature/x')},kunj-repo=${gceValue('github.com/acme/app')},kunj-role=machine`);
  });

  it('gives a machine the service account for the cache bucket, and says how its containers reach it', async () => {
    const sa = 'kunj-machine@my-proj-123.iam.gserviceaccount.com';
    const p = new GceProvider({ ...CFG, serviceAccount: sa }, { run: gcloud.runner });
    await p.create(spec({ cacheStore: true }));
    const args = gcloud.calls[0];
    expect(args[args.indexOf('--service-account') + 1]).toBe(sa);
    expect(args).not.toContain('--no-service-account');
    expect(p.cacheSync({ store: 'bucket', bucket: 'my-cache', prefix: 'team/a' })).toEqual({
      store: 'bucket',
      image: 'rclone/rclone:1.68.2',
      env: { RCLONE_GCS_ENV_AUTH: 'true', RCLONE_GCS_BUCKET_POLICY_ONLY: 'true' },
      remote: ':gcs:my-cache/team/a',
      display: 'gs://my-cache/team/a',
    });
    expect(p.cacheSync({ store: 'bucket', bucket: 'my-cache', prefix: '' }).remote).toBe(':gcs:my-cache');
    // No service account: a machine could never reach the bucket
    expect(() => new GceProvider(CFG, { run: gcloud.runner }).cacheSync({ store: 'bucket', bucket: 'my-cache', prefix: '' })).toThrow(/machine\.gce\.serviceAccount/);
  });

  it('boots a golden image, as spot, with the self-suspend service account when asked', async () => {
    const p = new GceProvider({ ...CFG, serviceAccount: 'kunj-machine@my-proj-123.iam.gserviceaccount.com', network: 'dev', subnet: 'dev-us' }, { run: gcloud.runner });
    await p.create(spec({ image: 'kunj-app-img-abc', spot: true, selfSuspend: true, size: 'n2d-highmem-8' }));
    const args = gcloud.calls[0];
    const flag = (n: string) => args[args.indexOf(n) + 1];
    expect(flag('--image')).toBe('kunj-app-img-abc');
    expect(args).not.toContain('--image-family');
    expect(flag('--machine-type')).toBe('n2d-highmem-8');
    expect(flag('--service-account')).toBe('kunj-machine@my-proj-123.iam.gserviceaccount.com');
    expect(flag('--provisioning-model')).toBe('SPOT');
    expect(flag('--network')).toBe('dev');
    expect(flag('--subnet')).toBe('dev-us');
  });

  it('resumes a suspended machine on start, and skips verbs that are already done', async () => {
    const p = new GceProvider(CFG, { run: gcloud.runner });
    await p.create(spec());
    await p.suspend('kunj-app-x-abc123');
    await p.start('kunj-app-x-abc123');
    const verbs = gcloud.calls.map(a => a[2]);
    expect(verbs).toEqual(['create', 'describe', 'suspend', 'describe', 'resume']);
    gcloud.calls.length = 0;
    await p.resume('kunj-app-x-abc123');
    expect(gcloud.calls.map(a => a[2])).toEqual(['describe']);
  });

  it('reports when a machine went to sleep: lastSuspendedTimestamp when suspended, lastStopTimestamp when stopped', async () => {
    const p = new GceProvider(CFG, { run: gcloud.runner });
    await p.create(spec());
    const inst = gcloud.instances.get('kunj-app-x-abc123');
    Object.assign(inst, { lastSuspendedTimestamp: '2026-11-17T08:00:00.000-08:00', lastStopTimestamp: '2026-11-10T08:00:00.000-08:00' });
    expect((await p.get('kunj-app-x-abc123'))!.sleptAt).toBeUndefined();
    inst.status = 'SUSPENDED';
    expect((await p.get('kunj-app-x-abc123'))!.sleptAt).toBe('2026-11-17T08:00:00.000-08:00');
    inst.status = 'TERMINATED';
    expect((await p.list({}))[0].sleptAt).toBe('2026-11-10T08:00:00.000-08:00');
  });

  it('opens an IAP tunnel to the serve port and reports the internal address', async () => {
    const p = new GceProvider(CFG, { run: gcloud.runner });
    const m = await p.create(spec());
    expect(p.tunnel(m, 7433, 40001).argv).toEqual(['gcloud', 'compute', 'start-iap-tunnel', 'kunj-app-x-abc123', '7433', '--local-host-port=127.0.0.1:40001', '--zone', 'us-central1-a', '--project', 'my-proj-123']);
    expect(p.address(m, 7433)).toEqual({ host: m.addresses.internal, port: 7433 });
  });

  it('refuses config values that could become options or paths', () => {
    expect(() => new GceProvider({ zone: 'us-central1-a' }, { run: gcloud.runner })).toThrow(/machine.gce.project is not set/);
    expect(() => new GceProvider({ ...CFG, project: '--impersonate' }, { run: gcloud.runner })).toThrow(/not valid/);
    expect(() => new GceProvider({ ...CFG, zone: 'us-central1-a --x' }, { run: gcloud.runner })).toThrow(/not valid/);
    expect(() => new GceProvider({ ...CFG, machineTypes: { medium: '-x' } }, { run: gcloud.runner })).toThrow(/machineTypes.medium/);
  });

  it('tells a missing login from another failure', async () => {
    const p = new GceProvider(CFG, { run: gcloud.runner });
    gcloud.failNext = { code: 1, stdout: '', stderr: 'ERROR: (gcloud.compute.instances.list) You do not currently have an active account selected.\nPlease run: gcloud auth login' };
    await expect(p.list({})).rejects.toMatchObject({ code: 'provider-cli-missing' });
    // gcloud exits 0 with [] when its requests failed; that must not read as "no machines"
    gcloud.failNext = {
      code: 0,
      stdout: '[]',
      stderr: 'WARNING: Some requests did not succeed.\n - Request had invalid authentication credentials. Expected OAuth 2 access token.\n',
    };
    await expect(p.list({})).rejects.toMatchObject({ code: 'provider-cli-missing', message: expect.stringContaining('invalid authentication credentials') });
    gcloud.failNext = { code: 0, stdout: '[]', stderr: 'WARNING: Some requests did not succeed.\n - Required compute.instances.list permission for projects/my-proj-123\n' };
    await expect(p.list({})).rejects.toMatchObject({ code: 'provider-failed', message: expect.stringContaining('compute.instances.list permission') });
    gcloud.failNext = { code: 1, stdout: '', stderr: 'ERROR: (gcloud.compute.instances.list) Quota exceeded' };
    await expect(p.list({})).rejects.toMatchObject({ code: 'provider-failed', message: expect.stringContaining('Quota exceeded') });
  });
});

describe('GCE label encoding', () => {
  it('keeps values that fit and hashes the rest, never colliding with a literal h- value', () => {
    expect(gceKey('kunj.repo')).toBe('kunj-repo');
    expect(gceValue('machine')).toBe('machine');
    expect(gceValue('feature/x')).toMatch(/^h-[0-9a-f]{40}$/);
    expect(gceValue('h-literal')).not.toBe('h-literal');
    expect(gceValue('Upper')).not.toBe('Upper');
  });

  it('picks a delimiter no metadata value contains', () => {
    expect(gcloudDict({ a: '1', b: '2' })).toBe('a=1,b=2');
    expect(gcloudDict({ a: '1,2', b: '3' })).toBe('^|^a=1,2|b=3');
  });
});
