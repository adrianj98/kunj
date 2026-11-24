import { CliResult, CliRunner } from '../cli';
import * as fs from 'fs';
import { gceRemove, gceSetup } from '../setup/gce';

/** gcloud over an in-memory project: what exists, and every command asked of it. */
function fakeGcloud(have: Set<string>) {
  const calls: string[] = [];
  const lifecycle: unknown[] = [];
  const ok = (stdout = ''): CliResult => ({ code: 0, stdout, stderr: '' });
  const missing: CliResult = { code: 1, stdout: '', stderr: 'ERROR: (gcloud) NOT_FOUND: not found' };
  const run: CliRunner = async (cmd, args) => {
    expect(cmd).toBe('gcloud');
    expect(args).toContain('--quiet');
    const line = args.filter(a => !['--quiet', '--project', 'my-proj-123', '--format=json'].includes(a)).join(' ');
    calls.push(line);
    if (line === 'services list --enabled') return ok(JSON.stringify(have.has('apis') ? [{ config: { name: 'compute.googleapis.com' } }, { config: { name: 'iap.googleapis.com' } }] : []));
    if (line.startsWith('compute routers list')) return ok(JSON.stringify(have.has('nat') ? [{ network: 'https://x/global/networks/default', nats: [{ name: 'their-nat' }] }] : []));
    if (line.startsWith('compute routers describe')) return have.has('router') ? ok() : missing;
    if (line.startsWith('compute firewall-rules list')) {
      // a rule someone made by hand, under another name, that also opens ssh
      const theirs = { network: 'https://x/global/networks/default', sourceRanges: ['35.235.240.0/20'], targetTags: ['kunj-machine'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }, { IPProtocol: 'tcp', ports: ['7000-8000'] }] };
      const other = { network: 'https://x/global/networks/default', sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }] };
      return ok(JSON.stringify(have.has('firewall') ? [other, theirs] : [other]));
    }
    if (line.startsWith('iam service-accounts describe')) return have.has('account') ? ok() : missing;
    if (line.startsWith('iam roles describe')) return have.has('role') ? ok(JSON.stringify({ name: 'kunjSelfSuspend', ...(have.has('role-deleted') ? { deleted: true } : {}) })) : missing;
    if (line.startsWith('projects get-iam-policy')) {
      return ok(JSON.stringify({ bindings: have.has('binding') ? [{ role: 'projects/my-proj-123/roles/kunjSelfSuspend', members: ['serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com'] }] : [] }));
    }
    if (line.startsWith('storage buckets describe')) {
      if (!have.has('bucket')) return missing;
      const rule = [{ action: { type: 'SetStorageClass' }, condition: { age: 90 } }, ...(have.has('lifecycle') ? [{ action: { type: 'Delete' }, condition: { age: 30 } }] : [])];
      return ok(JSON.stringify({ name: 'my-proj-123-kunj-cache', lifecycle_config: { rule } }));
    }
    if (line.startsWith('storage buckets update')) {
      const file = args.find(a => a.startsWith('--lifecycle-file='))!.slice('--lifecycle-file='.length);
      lifecycle.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (line.startsWith('storage buckets get-iam-policy')) {
      return ok(JSON.stringify({ bindings: have.has('bucket-binding') ? [{ role: 'roles/storage.objectAdmin', members: ['serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com'] }] : [] }));
    }
    return ok(); // a create
  };
  return { run, calls, lifecycle };
}

const OPTS = { project: 'my-proj-123', zone: 'us-central1-a', cache: true };

describe('kunj machine setup for Google Cloud', () => {
  it('makes everything in an empty project, in an order where each step can build on the last', async () => {
    const g = fakeGcloud(new Set());
    const plan = gceSetup(OPTS, g.run);
    expect(plan.steps).toHaveLength(7);
    for (const step of plan.steps) expect(await step.exists()).toBe(false);
    g.calls.length = 0;
    for (const step of plan.steps) await step.apply();
    const made = g.calls.filter(c => / (create|enable|add-iam-policy-binding|update) /.test(` ${c} `)).map(c => c.replace(/--lifecycle-file=\S+/, '--lifecycle-file=<file>'));
    expect(made).toEqual([
      'services enable compute.googleapis.com iap.googleapis.com',
      'compute routers create kunj-router --network default --region us-central1',
      'compute routers nats create kunj-nat --router kunj-router --region us-central1 --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges',
      'compute firewall-rules create kunj-serve-from-iap --network default --allow tcp:7433 --source-ranges 35.235.240.0/20 --target-tags kunj-machine',
      'iam service-accounts create kunj-machine --display-name kunj machines',
      'iam roles create kunjSelfSuspend --permissions compute.instances.suspend,compute.instances.get --title kunj self suspend',
      'projects add-iam-policy-binding --member serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com --role projects/my-proj-123/roles/kunjSelfSuspend --condition=None',
      'storage buckets create gs://my-proj-123-kunj-cache --location us-central1 --uniform-bucket-level-access --public-access-prevention',
      'storage buckets add-iam-policy-binding gs://my-proj-123-kunj-cache --member serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com --role roles/storage.objectAdmin',
      'storage buckets update gs://my-proj-123-kunj-cache --lifecycle-file=<file>',
    ]);
    expect(plan.steps.filter(s => s.cost).map(s => s.cost)).toEqual(['about $32 a month, whether machines run or not', 'about 2 cents per GB a month']);
  });

  it('finds what a project already has, another NAT included, and writes the settings to match', async () => {
    const g = fakeGcloud(new Set(['apis', 'nat', 'firewall', 'account', 'role', 'binding', 'bucket', 'bucket-binding', 'lifecycle']));
    const plan = gceSetup({ ...OPTS, existing: { machineTypes: { small: 'e2-small' }, zone: 'old' } }, g.run);
    for (const step of plan.steps) expect(await step.exists()).toBe(true);
    // only questions were asked: nothing is made twice
    expect(g.calls.some(c => / create /.test(c) || c.startsWith('services enable') || c.includes('add-iam-policy-binding'))).toBe(false);
    expect(plan.config).toEqual({
      'machine.provider': 'gce',
      'machine.gce': { machineTypes: { small: 'e2-small' }, project: 'my-proj-123', zone: 'us-central1-a', serviceAccount: 'kunj-machine@my-proj-123.iam.gserviceaccount.com' },
      'machine.cache': { bucket: 'my-proj-123-kunj-cache' },
    });
  });

  it('skips the bucket when asked, grants a role that exists without making it again, and checks its input', async () => {
    const g = fakeGcloud(new Set(['role']));
    const plan = gceSetup({ ...OPTS, cache: false }, g.run);
    expect(plan.steps).toHaveLength(5);
    expect(plan.config).not.toHaveProperty('machine.cache');
    await plan.steps[4].apply();
    expect(g.calls.some(c => c.startsWith('iam roles create'))).toBe(false);
    expect(g.calls.some(c => c.startsWith('projects add-iam-policy-binding'))).toBe(true);
    // another network gets a router and a NAT of its own, and a role deleted last week is restored
    const other = fakeGcloud(new Set(['role', 'role-deleted']));
    const onVpc = gceSetup({ ...OPTS, network: 'vpc1', cache: false }, other.run);
    expect(await onVpc.steps[4].exists()).toBe(false);
    await onVpc.steps[1].apply();
    await onVpc.steps[4].apply();
    expect(other.calls).toContain('compute routers create kunj-router-vpc1 --network vpc1 --region us-central1');
    expect(other.calls.some(c => c.startsWith('compute routers nats create kunj-nat-vpc1 --router kunj-router-vpc1'))).toBe(true);
    expect(other.calls).toContain('iam roles undelete kunjSelfSuspend');
    expect(onVpc.config['machine.gce']).toMatchObject({ network: 'vpc1' });
    expect(() => gceSetup({ ...OPTS, project: 'x; rm -rf /' }, g.run)).toThrow(/project id/);
    expect(() => gceSetup({ ...OPTS, zone: 'somewhere' }, g.run)).toThrow(/zone/);
  });
});

describe('the cache bucket lifecycle rule', () => {
  it('adds a Delete rule at 30 days, keeping the bucket\'s other rules, and only when it is missing', async () => {
    const g = fakeGcloud(new Set(['bucket', 'bucket-binding']));
    const step = gceSetup(OPTS, g.run).steps[6];
    expect(step.title).toMatch(/30 days/);
    expect(await step.exists()).toBe(false);
    await step.apply();
    expect(g.lifecycle).toEqual([{ rule: [{ action: { type: 'SetStorageClass' }, condition: { age: 90 } }, { action: { type: 'Delete' }, condition: { age: 30 } }] }]);
    // the temporary file is gone
    const file = g.calls.find(c => c.startsWith('storage buckets update'))!.split('--lifecycle-file=')[1];
    expect(fs.existsSync(file)).toBe(false);
    expect(await gceSetup(OPTS, fakeGcloud(new Set(['bucket', 'lifecycle'])).run).steps[6].exists()).toBe(true);
  });
});

/** gcloud over a project setup made: describe answers for what is still there, delete removes it. */
function setupProject(opts: { machines?: string[]; images?: string[]; extraNat?: boolean; listFails?: boolean } = {}) {
  const have = new Set(['binding', 'role', 'account', 'firewall', 'nat', 'router', 'bucket']);
  const calls: string[] = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const missing = { code: 1, stdout: '', stderr: 'ERROR: (gcloud) NOT_FOUND' };
  const run: CliRunner = async (cmd, args) => {
    expect(cmd).toBe('gcloud');
    const line = args.filter(a => !['--quiet', '--project', 'my-proj-123', '--format=json'].includes(a)).join(' ');
    calls.push(line);
    if (line.startsWith('compute instances list')) return opts.listFails ? missing : ok(JSON.stringify((opts.machines ?? []).map(n => ({ name: n, zone: 'https://x/zones/us-east1-b' }))));
    if (line.startsWith('compute images list')) return ok(JSON.stringify((opts.images ?? []).map(name => ({ name }))));
    if (line.startsWith('projects get-iam-policy')) {
      return ok(JSON.stringify({ bindings: have.has('binding') ? [{ role: 'projects/my-proj-123/roles/kunjSelfSuspend', members: ['serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com'] }] : [] }));
    }
    if (line.startsWith('projects remove-iam-policy-binding')) return have.delete('binding') ? ok() : missing;
    if (line.startsWith('iam roles describe')) return have.has('role') ? ok('{"name":"kunjSelfSuspend"}') : missing;
    if (line.startsWith('iam roles delete')) return have.delete('role') ? ok() : missing;
    if (line.startsWith('iam service-accounts describe')) return have.has('account') ? ok() : missing;
    if (line.startsWith('iam service-accounts delete')) return have.delete('account') ? ok() : missing;
    if (line.startsWith('compute firewall-rules describe')) return have.has('firewall') ? ok() : missing;
    if (line.startsWith('compute firewall-rules delete')) return have.delete('firewall') ? ok() : missing;
    if (line.startsWith('compute routers nats describe')) return have.has('nat') ? ok() : missing;
    if (line.startsWith('compute routers nats delete')) return have.delete('nat') ? ok() : missing;
    if (line.startsWith('compute routers describe')) {
      if (!have.has('router')) return missing;
      const nats = [...(have.has('nat') ? [{ name: 'kunj-nat' }] : []), ...(opts.extraNat ? [{ name: 'their-nat' }] : [])];
      return ok(JSON.stringify({ name: 'kunj-router', nats }));
    }
    if (line.startsWith('compute routers delete')) return have.delete('router') ? ok() : missing;
    if (line.startsWith('storage buckets describe')) return have.has('bucket') ? ok() : missing;
    if (line.startsWith('storage rm')) return have.delete('bucket') ? ok() : missing;
    throw new Error(`unexpected gcloud ${line}`);
  };
  return { run, calls, have };
}

describe('kunj machine setup --remove for Google Cloud', () => {
  it('deletes exactly what setup made, the last made first, and is a no-op the second time', async () => {
    const p = setupProject();
    const plan = gceRemove({ project: 'my-proj-123', zone: 'us-central1-a' }, p.run);
    expect(await plan.inUse()).toEqual({ machines: [], images: [] });
    for (const step of plan.steps) {
      expect(await step.exists()).toBe(true);
      await step.apply();
    }
    expect(p.calls.filter(c => /^(projects remove|iam roles delete|iam service-accounts delete|compute .* delete)/.test(c))).toEqual([
      'projects remove-iam-policy-binding --member serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com --role projects/my-proj-123/roles/kunjSelfSuspend --condition=None',
      'iam roles delete kunjSelfSuspend',
      'iam service-accounts delete kunj-machine@my-proj-123.iam.gserviceaccount.com',
      'compute firewall-rules delete kunj-serve-from-iap',
      'compute routers nats delete kunj-nat --router kunj-router --region us-central1',
      'compute routers delete kunj-router --region us-central1',
    ]);
    // the bucket is not one of the steps
    expect(p.have).toEqual(new Set(['bucket']));
    expect(plan.bucket.name).toBe('gs://my-proj-123-kunj-cache');
    for (const step of plan.steps) expect(await step.exists()).toBe(false);
    await plan.bucket.remove();
    expect(p.calls).toContain('storage rm --recursive gs://my-proj-123-kunj-cache');
    expect(await plan.bucket.exists()).toBe(false);
  });

  it('names the router and NAT of another network as setup did, and keeps a router that carries a NAT kunj did not make', async () => {
    const p = setupProject({ extraNat: true });
    const plan = gceRemove({ project: 'my-proj-123', zone: 'us-central1-a', network: 'vpc1' }, p.run);
    expect(plan.steps[4].title).toContain('kunj-nat-vpc1');
    expect(plan.steps[5].title).toContain('kunj-router-vpc1');
    const own = gceRemove({ project: 'my-proj-123', zone: 'us-central1-a' }, p.run);
    await own.steps[4].apply();
    await expect(own.steps[5].apply()).rejects.toThrow(/their-nat/);
    expect(p.have.has('router')).toBe(true);
  });

  it('reports the machines (every zone) and golden images still there, and refuses to guess when it cannot list them', async () => {
    const p = setupProject({ machines: ['kunj-app-x-abc'], images: ['kunj-app-img-1'] });
    expect(await gceRemove({ project: 'my-proj-123', zone: 'us-central1-a' }, p.run).inUse()).toEqual({ machines: ['kunj-app-x-abc (us-east1-b)'], images: ['kunj-app-img-1'] });
    expect(p.calls).toContain('compute instances list --filter=labels.kunj-role=machine');
    expect(p.calls).toContain('compute images list --no-standard-images --filter=labels.kunj-role=machine-image');
    await expect(gceRemove({ project: 'my-proj-123', zone: 'us-central1-a' }, setupProject({ listFails: true }).run).inUse()).rejects.toThrow(/nothing was removed/);
  });
});
