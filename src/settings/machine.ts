// Cloud machine settings (docs/specs/cloud-machines.md). They are read where the coordinator runs:
// the laptop for a local coordinator (auto-started by kunj), or the coordinator VM. A client of a
// cloud coordinator needs only container.remote.

import { registerSettings } from '../lib/settings-registry';

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function registerMachineSettings(): void {
  registerSettings([
    {
      key: 'machine.provider',
      description: 'The cloud that runs one machine per branch session (gce); empty: no machines',
      type: 'string',
      defaultValue: '',
      category: 'machine',
      detailedDescription:
        'Set on the machine that runs the coordinator (kunj serve --machines). On a laptop, kunj then starts a local ' +
        'coordinator on its own when a kunj machine command needs one. Each provider reads machine.<provider>.*.',
      examples: ['gce', 'ec2'],
      relatedSettings: ['machine.gce', 'machine.ec2'],
    },
    {
      key: 'machine.network',
      description: 'How the coordinator reaches machines: tunnel (a provider tunnel per machine, from a laptop) or private (their internal address, from a coordinator VM in the same network)',
      type: 'enum',
      options: ['tunnel', 'private'],
      defaultValue: 'tunnel',
      category: 'machine',
    },
    {
      key: 'machine.size',
      description: 'Size of a new machine: small (4 GB), medium (8 GB), large (16 GB), or a provider shape such as n2d-highmem-8',
      type: 'string',
      defaultValue: 'medium',
      category: 'machine',
      examples: ['medium', 'large', 'e2-highmem-4'],
    },
    {
      key: 'machine.diskGb',
      description: 'Boot and Docker disk of a new machine, in GB (billed while the machine sleeps too)',
      type: 'number',
      defaultValue: 30,
      category: 'machine',
      validate: positive,
    },
    {
      key: 'machine.spot',
      description: 'Create spot machines: much cheaper, but the cloud may stop one at any time',
      type: 'boolean',
      defaultValue: false,
      category: 'machine',
    },
    {
      key: 'machine.selfSuspend',
      description: "Give machines a credential that can only suspend themselves, so they sleep when the laptop running the coordinator is shut",
      type: 'boolean',
      defaultValue: true,
      category: 'machine',
      relatedSettings: ['machine.gce'],
    },
    {
      key: 'machine.idleMinutes',
      description: 'Suspend a machine after this many minutes with no agent running and no terminal open',
      type: 'number',
      defaultValue: 30,
      category: 'machine',
      validate: positive,
    },
    {
      key: 'machine.bootTimeoutMs',
      description: 'How long to wait for a new or waking machine to answer; a new machine from the stock image spends about 3.5 minutes installing',
      type: 'number',
      defaultValue: 600000,
      category: 'machine',
      validate: positive,
    },
    {
      key: 'machine.pairWindowMinutes',
      description: "How long after boot a machine's kunj serve accepts pairing with a coordinator",
      type: 'number',
      defaultValue: 10,
      category: 'machine',
      validate: positive,
    },
    {
      key: 'machine.coordinatorIdleMinutes',
      description: 'An auto-started local coordinator exits after this many minutes without a request',
      type: 'number',
      defaultValue: 60,
      category: 'machine',
      validate: positive,
    },
    {
      key: 'machine.image',
      description: "A machine image new machines boot instead of the provider's stock Ubuntu (one that already has Docker and kunj starts in seconds)",
      type: 'string',
      defaultValue: '',
      category: 'machine',
      examples: ['kunj-machine-20261116'],
    },
    {
      key: 'machine.kunjPackage',
      description: 'What a new machine installs as kunj: an npm spec (kunj@1.4.0) or github:<owner>/<repo>#<ref>, built on the machine; empty: this version from npm (a development build: main from GitHub)',
      type: 'string',
      defaultValue: '',
      category: 'machine',
      examples: ['kunj@1.4.0', 'github:adrianj98/kunj#main'],
      validate: (v: unknown) => typeof v === 'string' && (v === '' || /^(kunj@[0-9A-Za-z.+-]{1,40}|github:[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,60}#[A-Za-z0-9_.\/-]{1,80})$/.test(v)),
    },
    {
      key: 'machine.bootstrap',
      description: 'Give new machines a startup script that installs Docker, Node and kunj and starts kunj serve; turn off only for an image that does all of that itself',
      type: 'boolean',
      defaultValue: true,
      category: 'machine',
    },
    {
      key: 'machine.cache',
      description: 'Where this coordinator keeps repository caches (container.caches) outside its machines: { "bucket": "<name>", "prefix": "<folder>" }',
      type: 'object',
      defaultValue: {},
      category: 'machine',
      detailedDescription:
        'Each coordinator has its own: set it in the config of the machine that runs kunj serve --machines (the global config here ' +
        'for the local coordinator). With a bucket, a new branch container first pulls each cache from the bucket, and ' +
        'kunj ct cache push copies a machine\'s cache back so the next machines get it. Empty, or { "store": "none" }: caches ' +
        'come only from the machine image. On Google Cloud the bucket is a Cloud Storage bucket and machine.gce.serviceAccount ' +
        'must be set, with Storage Object Admin on that bucket.',
      examples: ['{"bucket": "my-kunj-cache"}', '{"bucket": "my-kunj-cache", "prefix": "team-a"}', '{"store": "none"}'],
      relatedSettings: ['container.caches', 'machine.gce'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
    {
      key: 'machine.ec2',
      description: 'Amazon EC2 provider: { region, subnet, securityGroups, instanceProfile?, instanceTypes?, baseImage?, profile? }',
      type: 'object',
      defaultValue: {},
      category: 'machine',
      detailedDescription:
        'region, subnet (a private one with a NAT for egress) and securityGroups are required. Suspend is hibernation, so ' +
        'machines get an encrypted root volume and one of the instance types that can hibernate (default t3.medium, ' +
        't3.large, t3.xlarge; instanceTypes overrides). The coordinator reaches a machine through Session Manager port ' +
        'forwarding (the session-manager-plugin where the coordinator runs, and SSM in instanceProfile) or its private address ' +
        'with machine.network=private. instanceProfile is also what machine.cache uses to reach the S3 bucket. baseImage is an ' +
        'AMI id or an SSM public parameter (default Ubuntu 24.04). Not run on a real account yet: tested against a simulated aws.',
      examples: ['{"region": "us-east-1", "subnet": "subnet-0abc1234", "securityGroups": ["sg-0abc1234"]}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
    {
      key: 'machine.gce',
      description: 'Google Compute Engine provider: { project, zone, network?, subnet?, serviceAccount?, machineTypes?, baseImage? }',
      type: 'object',
      defaultValue: {},
      category: 'machine',
      detailedDescription:
        'project and zone are required. Machines get no external IP (give the network a Cloud NAT for egress) and the ' +
        'network tag kunj-machine; a firewall rule must let IAP (35.235.240.0/20) reach port 7433 on that tag. ' +
        'serviceAccount is what machines run as, used with machine.selfSuspend (compute.instances.suspend and ' +
        'compute.instances.get on the machines) and machine.cache (Storage Object Admin on the bucket); give it nothing else. machineTypes overrides { small, medium, large } ' +
        '(default e2-medium, e2-standard-2, e2-standard-4); baseImage is <project>/<image family> ' +
        '(default ubuntu-os-cloud/ubuntu-2404-lts-amd64). Notes: docs/specs/google-cloud-containers.md.',
      examples: ['{"project": "my-project", "zone": "us-central1-a"}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
  ]);
}
