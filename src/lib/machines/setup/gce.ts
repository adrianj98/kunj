// `kunj machine setup` for Google Cloud (docs/specs/cloud-machines.md, "Setup"): everything a project
// needs before its first machine, as steps that each say whether they are already done. gcloud argv
// only, through the same CliRunner the provider uses; nothing is created that already exists.

import { CliRunner, firstErrorLine } from '../cli';
import { MachineError } from '../provider';

export interface SetupStep {
  title: string;
  /** What it costs while it exists, when it costs anything */
  cost?: string;
  exists(): Promise<boolean>;
  apply(): Promise<void>;
}

export interface SetupPlan {
  provider: string;
  /** Where: shown to the user before anything is made */
  target: string;
  steps: SetupStep[];
  /** Settings to write once the steps are done: key → value (global config) */
  config: Record<string, unknown>;
}

export interface GceSetupOptions {
  project: string;
  zone: string;
  network?: string;
  /** A bucket for container.caches, and the service account that reaches it */
  cache: boolean;
  /** machine.gce as it is now: keys this setup does not manage are kept */
  existing?: Record<string, unknown>;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ZONE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const NETWORK = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const GCE_SETUP = {
  router: 'kunj-router',
  nat: 'kunj-nat',
  firewall: 'kunj-serve-from-iap',
  account: 'kunj-machine',
  role: 'kunjSelfSuspend',
  iapRange: '35.235.240.0/20',
  port: 7433,
  tag: 'kunj-machine',
};

export function gceSetup(opts: GceSetupOptions, run: CliRunner): SetupPlan {
  const bad = (what: string, value: string) => new MachineError(`${what} "${value}" is not valid.`, 'bad-machine-config');
  if (!PROJECT.test(opts.project)) throw bad('The project id', opts.project);
  if (!ZONE.test(opts.zone)) throw bad('The zone', opts.zone);
  const network = opts.network || 'default';
  if (!NETWORK.test(network)) throw bad('The network', network);
  const { project, zone } = opts;
  const region = zone.replace(/-[a-z]$/, '');
  const email = `${GCE_SETUP.account}@${project}.iam.gserviceaccount.com`;
  const member = `serviceAccount:${email}`;
  const role = `projects/${project}/roles/${GCE_SETUP.role}`;
  const bucket = `${project}-kunj-cache`.slice(0, 63).replace(/-+$/, '');

  const gcloud = (args: string[]) => run('gcloud', [...args, '--project', project, '--quiet']);
  const ok = async (args: string[]) => (await gcloud(args)).code === 0;
  const must = async (args: string[], what: string) => {
    const r = await gcloud(args);
    if (r.code === 0) return r.stdout;
    if (/do not currently have an active account|gcloud auth login|Reauthentication required/i.test(r.stderr)) {
      throw new MachineError('gcloud is not logged in. Run gcloud auth login, then kunj machine setup again.', 'provider-cli-missing');
    }
    throw new MachineError(`gcloud could not ${what}: ${firstErrorLine(r.stderr) || `exit ${r.code}`}`, 'provider-failed');
  };
  const json = async (args: string[]): Promise<any> => {
    const r = await gcloud([...args, '--format=json']);
    try {
      return r.code === 0 ? JSON.parse(r.stdout || 'null') : null;
    } catch {
      return null;
    }
  };

  const steps: SetupStep[] = [
    {
      title: 'Compute Engine and Identity-Aware Proxy turned on in the project',
      exists: async () => {
        const on = ((await json(['services', 'list', '--enabled'])) ?? []) as Array<{ config?: { name?: string } }>;
        const names = new Set(on.map(s => s.config?.name));
        return names.has('compute.googleapis.com') && names.has('iap.googleapis.com');
      },
      apply: async () => void (await must(['services', 'enable', 'compute.googleapis.com', 'iap.googleapis.com'], 'turn the services on')),
    },
    {
      title: `A NAT in ${region}, so machines without a public address can download what they install`,
      cost: 'about $32 a month, whether machines run or not',
      // Any NAT on the network will do: a project that has one is left as it is
      exists: async () => {
        const routers = ((await json(['compute', 'routers', 'list', `--filter=region:${region}`])) ?? []) as Array<{ network?: string; nats?: unknown[] }>;
        return routers.some(r => (r.network ?? '').endsWith(`/networks/${network}`) && (r.nats?.length ?? 0) > 0);
      },
      apply: async () => {
        if (!(await ok(['compute', 'routers', 'describe', GCE_SETUP.router, '--region', region]))) {
          await must(['compute', 'routers', 'create', GCE_SETUP.router, '--network', network, '--region', region], 'create the router');
        }
        await must(
          ['compute', 'routers', 'nats', 'create', GCE_SETUP.nat, '--router', GCE_SETUP.router, '--region', region, '--auto-allocate-nat-external-ips', '--nat-all-subnet-ip-ranges'],
          'create the NAT',
        );
      },
    },
    {
      title: `A firewall rule that lets only Google's tunnel reach kunj on machines (port ${GCE_SETUP.port})`,
      // Any rule that does the job counts, whatever it is called: a project set up by hand is found
      exists: async () => {
        type Rule = { network?: string; direction?: string; disabled?: boolean; sourceRanges?: string[]; targetTags?: string[]; allowed?: Array<{ IPProtocol?: string; ports?: string[] }> };
        const rules = ((await json(['compute', 'firewall-rules', 'list'])) ?? []) as Rule[];
        const covers = (ports: string[] | undefined) =>
          !ports || ports.some(p => {
            const [from, to] = p.split('-').map(Number);
            return GCE_SETUP.port >= from && GCE_SETUP.port <= (to ?? from);
          });
        return rules.some(
          r =>
            !r.disabled &&
            (r.direction ?? 'INGRESS') === 'INGRESS' &&
            (r.network ?? '').endsWith(`/networks/${network}`) &&
            !!r.sourceRanges?.includes(GCE_SETUP.iapRange) &&
            (!r.targetTags || r.targetTags.includes(GCE_SETUP.tag)) &&
            !!r.allowed?.some(a => (a.IPProtocol === 'tcp' || a.IPProtocol === 'all') && covers(a.ports)),
        );
      },
      apply: async () =>
        void (await must(
          ['compute', 'firewall-rules', 'create', GCE_SETUP.firewall, '--network', network, '--allow', `tcp:${GCE_SETUP.port}`, '--source-ranges', GCE_SETUP.iapRange, '--target-tags', GCE_SETUP.tag],
          'create the firewall rule',
        )),
    },
    {
      title: `A service account for machines (${GCE_SETUP.account}), with no rights of its own`,
      exists: () => ok(['iam', 'service-accounts', 'describe', email]),
      apply: async () => void (await must(['iam', 'service-accounts', 'create', GCE_SETUP.account, '--display-name', 'kunj machines'], 'create the service account')),
    },
    {
      title: 'Permission for a machine to put itself to sleep (and nothing else)',
      exists: async () => {
        if (!(await ok(['iam', 'roles', 'describe', GCE_SETUP.role]))) return false;
        const policy = (await json(['projects', 'get-iam-policy', project])) as { bindings?: Array<{ role?: string; members?: string[] }> } | null;
        return !!policy?.bindings?.some(b => b.role === role && b.members?.includes(member));
      },
      apply: async () => {
        if (!(await ok(['iam', 'roles', 'describe', GCE_SETUP.role]))) {
          await must(['iam', 'roles', 'create', GCE_SETUP.role, '--permissions', 'compute.instances.suspend,compute.instances.get', '--title', 'kunj self suspend'], 'create the role');
        }
        await must(['projects', 'add-iam-policy-binding', project, '--member', member, '--role', role, '--condition=None'], 'grant the role');
      },
    },
  ];

  if (opts.cache) {
    steps.push({
      title: `A bucket for caches (gs://${bucket}) that only the machines' account can use`,
      cost: 'about 2 cents per GB a month',
      exists: async () => {
        if (!(await ok(['storage', 'buckets', 'describe', `gs://${bucket}`]))) return false;
        const policy = (await json(['storage', 'buckets', 'get-iam-policy', `gs://${bucket}`])) as { bindings?: Array<{ role?: string; members?: string[] }> } | null;
        return !!policy?.bindings?.some(b => b.role === 'roles/storage.objectAdmin' && b.members?.includes(member));
      },
      apply: async () => {
        if (!(await ok(['storage', 'buckets', 'describe', `gs://${bucket}`]))) {
          await must(['storage', 'buckets', 'create', `gs://${bucket}`, '--location', region, '--uniform-bucket-level-access', '--public-access-prevention'], 'create the bucket');
        }
        await must(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, '--member', member, '--role', 'roles/storage.objectAdmin'], 'let the machines use the bucket');
      },
    });
  }

  const config: Record<string, unknown> = {
    'machine.provider': 'gce',
    'machine.gce': { ...(opts.existing ?? {}), project, zone, serviceAccount: email, ...(opts.network ? { network } : {}) },
    ...(opts.cache ? { 'machine.cache': { bucket } } : {}),
  };
  return { provider: 'gce', target: `project ${project}, zone ${zone}`, steps, config };
}
