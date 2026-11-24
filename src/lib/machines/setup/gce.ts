// `kunj machine setup` for Google Cloud (docs/specs/cloud-machines.md, "Setup"): everything a project
// needs before its first machine, as steps that each say whether they are already done. gcloud argv
// only, through the same CliRunner the provider uses; nothing is created that already exists.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliRunner, firstErrorLine } from '../cli';
import { IMAGE_ROLE, MACHINE_ROLE, MachineError } from '../provider';

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

/**
 * Objects in the cache bucket not written for this many days are deleted by the bucket itself (a
 * lifecycle rule setup adds). An object is immutable, so its age is the time since it was last
 * pushed: a cache nobody pushes for a month is gone, and the next `kunj ct cache push` writes it anew.
 */
export const CACHE_MAX_AGE_DAYS = 30;

/** The exact names setup makes, which removal deletes and nothing else. */
function gceNames(opts: { project: string; zone: string; network?: string }) {
  const bad = (what: string, value: string) => new MachineError(`${what} "${value}" is not valid.`, 'bad-machine-config');
  if (!PROJECT.test(opts.project)) throw bad('The project id', opts.project);
  if (!ZONE.test(opts.zone)) throw bad('The zone', opts.zone);
  const network = opts.network || 'default';
  if (!NETWORK.test(network)) throw bad('The network', network);
  const { project, zone } = opts;
  const email = `${GCE_SETUP.account}@${project}.iam.gserviceaccount.com`;
  // A router belongs to one network and a NAT's name to one router: other networks get their own
  const suffix = network === 'default' ? '' : `-${network}`.slice(0, 40).replace(/-+$/, '');
  return {
    project,
    zone,
    network,
    region: zone.replace(/-[a-z]$/, ''),
    email,
    member: `serviceAccount:${email}`,
    role: `projects/${project}/roles/${GCE_SETUP.role}`,
    router: `${GCE_SETUP.router}${suffix}`,
    nat: `${GCE_SETUP.nat}${suffix}`,
    bucket: `${project}-kunj-cache`.slice(0, 63).replace(/-+$/, ''),
  };
}

/** gcloud for one project, and the ways setup and removal call it. */
function gcloudFor(project: string, run: CliRunner) {
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
  return { ok, must, json };
}

type LifecycleRule = { action?: { type?: string }; condition?: Record<string, unknown> };

/** The bucket's lifecycle rules, as `gcloud storage buckets describe` prints them (either spelling). */
function lifecycleRules(described: any): LifecycleRule[] {
  const config = described?.lifecycle_config ?? described?.lifecycle;
  return Array.isArray(config?.rule) ? config.rule : [];
}

const isCacheAgeRule = (r: LifecycleRule) =>
  r.action?.type === 'Delete' && Object.keys(r.condition ?? {}).join() === 'age' && r.condition?.age === CACHE_MAX_AGE_DAYS;

export function gceSetup(opts: GceSetupOptions, run: CliRunner): SetupPlan {
  const { project, zone, network, region, email, member, role, router, nat, bucket } = gceNames(opts);
  const { ok, must, json } = gcloudFor(project, run);

  // A custom role deleted in the last week still answers `describe`, marked deleted
  const roleUsable = async () => {
    const found = (await json(['iam', 'roles', 'describe', GCE_SETUP.role])) as { deleted?: boolean } | null;
    return !!found && !found.deleted;
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
        if (!(await ok(['compute', 'routers', 'describe', router, '--region', region]))) {
          await must(['compute', 'routers', 'create', router, '--network', network, '--region', region], 'create the router');
        }
        await must(
          ['compute', 'routers', 'nats', 'create', nat, '--router', router, '--region', region, '--auto-allocate-nat-external-ips', '--nat-all-subnet-ip-ranges'],
          'create the NAT',
        );
      },
    },
    {
      title: `A firewall rule that lets only Google's tunnel reach kunj on machines (port ${GCE_SETUP.port})`,
      // Any rule that does the job counts, whatever it is called: a project set up by hand is found
      exists: async () => {
        type Rule = { network?: string; direction?: string; disabled?: boolean; sourceRanges?: string[]; targetTags?: string[]; targetServiceAccounts?: string[]; allowed?: Array<{ IPProtocol?: string; ports?: string[] }> };
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
            // for every instance, or for kunj's tag; one aimed at other service accounts does not reach machines
            !r.targetServiceAccounts?.length &&
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
        if (!(await roleUsable())) return false;
        const policy = (await json(['projects', 'get-iam-policy', project])) as { bindings?: Array<{ role?: string; members?: string[]; condition?: unknown }> } | null;
        // A conditional binding may have run out: only an unconditional one counts
        return !!policy?.bindings?.some(b => b.role === role && !b.condition && b.members?.includes(member));
      },
      apply: async () => {
        const found = (await json(['iam', 'roles', 'describe', GCE_SETUP.role])) as { deleted?: boolean } | null;
        if (found?.deleted) await must(['iam', 'roles', 'undelete', GCE_SETUP.role], 'restore the deleted role');
        else if (!found) {
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
        const policy = (await json(['storage', 'buckets', 'get-iam-policy', `gs://${bucket}`])) as { bindings?: Array<{ role?: string; members?: string[]; condition?: unknown }> } | null;
        return !!policy?.bindings?.some(b => b.role === 'roles/storage.objectAdmin' && !b.condition && b.members?.includes(member));
      },
      apply: async () => {
        if (!(await ok(['storage', 'buckets', 'describe', `gs://${bucket}`]))) {
          await must(['storage', 'buckets', 'create', `gs://${bucket}`, '--location', region, '--uniform-bucket-level-access', '--public-access-prevention'], 'create the bucket');
        }
        await must(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, '--member', member, '--role', 'roles/storage.objectAdmin'], 'let the machines use the bucket');
      },
    });
    steps.push({
      title: `Caches not pushed for ${CACHE_MAX_AGE_DAYS} days deleted from the bucket by the bucket itself`,
      exists: async () => lifecycleRules(await json(['storage', 'buckets', 'describe', `gs://${bucket}`])).some(isCacheAgeRule),
      apply: async () => {
        // The bucket's other rules are kept: update replaces the whole lifecycle configuration
        const rules = lifecycleRules(await json(['storage', 'buckets', 'describe', `gs://${bucket}`]));
        const rule = [...rules, { action: { type: 'Delete' }, condition: { age: CACHE_MAX_AGE_DAYS } }];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-lifecycle-'));
        const file = path.join(dir, 'lifecycle.json');
        try {
          fs.writeFileSync(file, JSON.stringify({ rule }));
          await must(['storage', 'buckets', 'update', `gs://${bucket}`, `--lifecycle-file=${file}`], 'add the lifecycle rule to the bucket');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
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

export interface GceRemoveOptions {
  project: string;
  zone: string;
  network?: string;
}

export interface RemovePlan {
  provider: string;
  target: string;
  /** In the order they are deleted; `exists()` true means it is still there */
  steps: SetupStep[];
  /** The cache bucket: never one of `steps`, since deleting it deletes every cache in it */
  bucket: { name: string; exists(): Promise<boolean>; remove(): Promise<void> };
  /** kunj's machines (every zone) and golden images still in the project; throws when gcloud cannot tell */
  inUse(): Promise<{ machines: string[]; images: string[] }>;
}

/**
 * `kunj machine setup --remove`: deletes what setup made, by the exact names setup uses, the last made
 * first. Every step is idempotent (one already gone is skipped). A NAT or firewall rule made by hand
 * under another name is never touched, the APIs stay on (other things in the project may use them),
 * and the cache bucket is a separate question.
 */
export function gceRemove(opts: GceRemoveOptions, run: CliRunner): RemovePlan {
  const { project, zone, region, email, member, role, router, nat, bucket } = gceNames(opts);
  const { ok, must, json } = gcloudFor(project, run);

  const steps: SetupStep[] = [
    {
      title: `The permission for machines to put themselves to sleep (${GCE_SETUP.role} granted to ${GCE_SETUP.account})`,
      exists: async () => {
        const policy = (await json(['projects', 'get-iam-policy', project])) as { bindings?: Array<{ role?: string; members?: string[]; condition?: unknown }> } | null;
        return !!policy?.bindings?.some(b => b.role === role && !b.condition && b.members?.includes(member));
      },
      apply: async () => void (await must(['projects', 'remove-iam-policy-binding', project, '--member', member, '--role', role, '--condition=None'], 'remove the role binding')),
    },
    {
      title: `The custom role ${GCE_SETUP.role}`,
      // A deleted role still answers describe for a week, marked deleted
      exists: async () => {
        const found = (await json(['iam', 'roles', 'describe', GCE_SETUP.role])) as { deleted?: boolean } | null;
        return !!found && !found.deleted;
      },
      apply: async () => void (await must(['iam', 'roles', 'delete', GCE_SETUP.role], 'delete the role')),
    },
    {
      title: `The machines' service account (${email})`,
      exists: () => ok(['iam', 'service-accounts', 'describe', email]),
      apply: async () => void (await must(['iam', 'service-accounts', 'delete', email], 'delete the service account')),
    },
    {
      title: `The firewall rule ${GCE_SETUP.firewall}`,
      exists: () => ok(['compute', 'firewall-rules', 'describe', GCE_SETUP.firewall]),
      apply: async () => void (await must(['compute', 'firewall-rules', 'delete', GCE_SETUP.firewall], 'delete the firewall rule')),
    },
    {
      title: `The NAT ${nat} in ${region}, with the addresses it allocated`,
      cost: 'saves about $32 a month',
      exists: () => ok(['compute', 'routers', 'nats', 'describe', nat, '--router', router, '--region', region]),
      apply: async () => void (await must(['compute', 'routers', 'nats', 'delete', nat, '--router', router, '--region', region], 'delete the NAT')),
    },
    {
      title: `The router ${router} in ${region}`,
      exists: () => ok(['compute', 'routers', 'describe', router, '--region', region]),
      apply: async () => {
        // A NAT someone added to kunj's router since keeps it
        const found = (await json(['compute', 'routers', 'describe', router, '--region', region])) as { nats?: Array<{ name?: string }> } | null;
        const others = (found?.nats ?? []).map(n => n.name).filter(n => n && n !== nat);
        if (others.length) throw new MachineError(`the router ${router} also carries ${others.join(', ')}, which kunj did not make: it is left as it is`, 'provider-failed');
        await must(['compute', 'routers', 'delete', router, '--region', region], 'delete the router');
      },
    },
  ];

  return {
    provider: 'gce',
    target: `project ${project}, zone ${zone}`,
    steps,
    bucket: {
      name: `gs://${bucket}`,
      exists: () => ok(['storage', 'buckets', 'describe', `gs://${bucket}`]),
      // Every object, then the bucket
      remove: async () => void (await must(['storage', 'rm', '--recursive', `gs://${bucket}`], 'delete the bucket')),
    },
    inUse: async () => {
      // Every zone: a machine made under another machine.gce.zone needs the same rule and account
      const instances = (await json(['compute', 'instances', 'list', `--filter=labels.kunj-role=${MACHINE_ROLE}`])) as Array<{ name?: string; zone?: string }> | null;
      const images = (await json(['compute', 'images', 'list', '--no-standard-images', `--filter=labels.kunj-role=${IMAGE_ROLE}`])) as Array<{ name?: string }> | null;
      if (!Array.isArray(instances) || !Array.isArray(images)) {
        throw new MachineError(`gcloud could not list the machines and images in ${project}, so nothing was removed (is gcloud logged in?)`, 'provider-failed');
      }
      return {
        machines: instances.map(i => `${i.name ?? '?'}${i.zone ? ` (${i.zone.split('/').pop()})` : ''}`),
        images: images.map(i => i.name ?? '').filter(Boolean),
      };
    },
  };
}
