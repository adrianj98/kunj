import { CliResult, CliRunner } from '../cli';
import { gceSetup } from '../setup/gce';

/** gcloud over an in-memory project: what exists, and every command asked of it. */
function fakeGcloud(have: Set<string>) {
  const calls: string[] = [];
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
    if (line.startsWith('storage buckets describe')) return have.has('bucket') ? ok() : missing;
    if (line.startsWith('storage buckets get-iam-policy')) {
      return ok(JSON.stringify({ bindings: have.has('bucket-binding') ? [{ role: 'roles/storage.objectAdmin', members: ['serviceAccount:kunj-machine@my-proj-123.iam.gserviceaccount.com'] }] : [] }));
    }
    return ok(); // a create
  };
  return { run, calls };
}

const OPTS = { project: 'my-proj-123', zone: 'us-central1-a', cache: true };

describe('kunj machine setup for Google Cloud', () => {
  it('makes everything in an empty project, in an order where each step can build on the last', async () => {
    const g = fakeGcloud(new Set());
    const plan = gceSetup(OPTS, g.run);
    expect(plan.steps).toHaveLength(6);
    for (const step of plan.steps) expect(await step.exists()).toBe(false);
    g.calls.length = 0;
    for (const step of plan.steps) await step.apply();
    const made = g.calls.filter(c => / (create|enable|add-iam-policy-binding) /.test(` ${c} `) || c.includes(' create ') || c.startsWith('services enable'));
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
    ]);
    expect(plan.steps.filter(s => s.cost).map(s => s.cost)).toEqual(['about $32 a month, whether machines run or not', 'about 2 cents per GB a month']);
  });

  it('finds what a project already has, another NAT included, and writes the settings to match', async () => {
    const g = fakeGcloud(new Set(['apis', 'nat', 'firewall', 'account', 'role', 'binding', 'bucket', 'bucket-binding']));
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
