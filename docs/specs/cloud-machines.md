# Cloud machines: a VM per session from a pluggable provider

A branch's container runs on a small cloud machine that kunj creates for it on demand, suspends when
its agent goes quiet, resumes on the next command and deletes when the branch is gone. The machine runs
nothing new: Docker and `kunj serve` from [remote-containers.md](remote-containers.md), reached from the
laptop through a tunnel. What is new is a **machine provider**: a pluggable module that knows how one
cloud creates, finds, suspends, resumes, deletes and reaches machines. Google Cloud is the first
provider; AWS, Azure or a plain fleet of SSH boxes are later ones, and nothing outside the provider
module knows which cloud it is. The research that led here, with the cost and isolation arguments, is
[google-cloud-containers.md](google-cloud-containers.md).

## Status

| Part | State |
| --- | --- |
| Spec | Written 2026-11-16 |
| Phase 0: the shared-VM recipe by hand (validates `kunj serve` over an IAP tunnel) | Not started (needs a project and a VM: waiting on you) |
| Phase 1: `MachineProvider`, `FakeProvider`, `GceProvider`, `kunj machine` | Not started |
| Phase 2: `kunj ct` on machines (locate, create, wake, list, remove, prune, events) | Not started |
| Phase 3: golden image build, `container.caches`, `kunj serve --idle-after`, pairing | Not started |
| Phase 4: a second provider (EC2) to prove the seam; workspace app rows | Not started |

## Goals and non-goals

Goals:

- **One command set.** `kunj ct start|shell|agent|attach|exec|stop|remove|prune|list` behave as they
  do for a local or remote container. The machine behind the container is created, woken and deleted
  as a side effect; `kunj machine` exists for looking at and managing machines directly.
- **One machine per branch (session).** Sized to one agent and its services (8 GB by default), its
  own kernel, no neighbours. Idle costs the disk only.
- **Pluggable provider.** A `MachineProvider` interface with the cloud-specific parts behind it, chosen
  by `machine.provider`. Everything above the interface (lifecycle, naming, listing, `kunj ct`, the
  apps' JSON) is cloud-agnostic. Adding a cloud is one module and its tests.
- **The laptop stays the authority**, as in every remote spec: vault, keep files, blueprints, hooks and
  config stay home; a machine holds Docker labels and its own `kunj serve` token.
- **No state file for machines.** Cloud labels (`kunj.repo`, `kunj.branch`, `kunj.version`,
  `kunj.role=machine`) are the only record of which machine is whose, mirroring the Docker-label rule
  of phase 1. Finding a branch's machine is one provider `list` by label.

Non-goals (v1):

- Kubernetes, Cloud Run or any runtime but a VM with Docker (see the research doc for why).
- Shared filesystems between machines; caches are shared by image, registry and the cache volume below.
- Several users on one project, quotas, budgets, or kunj as a general cloud deployment tool.
- Building the base OS image from scratch: the golden image is built from the cloud's stock Ubuntu by
  a recipe kunj ships, nothing lower.

## Shape

```
laptop                                   provider (cloud API, via its CLI)         machine
─────────────────────────────            ──────────────────────────────────        ──────────────────────
kunj ct start feature/x                  list by label kunj.branch=feature/x       golden image:
  ├─ locateMachine() ─────────────────►  none → create(spec) ─────────────────►    Ubuntu, Docker, Sysbox,
  │                                      suspended → resume                        kunj serve (systemd),
  ├─ tunnel() ────────────────────────►  argv of a local port forwarder ─────►     kunj-sandbox, helper,
  │                                                                                blueprint snapshot,
  └─ RemoteKunjBackend ─── HTTP+WS over the tunnel ───────────────────────────►    cache volume
       lifecycle.ts unchanged                                                       labels: kunj.*
```

Layers, bottom up:

1. **`MachineProvider`** (src/lib/machines/provider.ts): the interface, below.
2. **Providers** (src/lib/machines/providers/<name>.ts): `gce.ts` first. A provider drives its cloud
   through that cloud's CLI (`gcloud … --format=json`, later `aws … --output json`), the way kunj drives
   GitHub through `gh`: the user's existing login, no SDK dependency on the fast path, `execFile` with
   argv arrays, never a shell. **Only a provider module spawns a cloud CLI.** `FakeProvider`
   (src/lib/machines/__tests__/fake-provider.ts) is the in-memory one for unit tests, like `FakeBackend`.
3. **Machine lifecycle** (src/lib/machines/lifecycle.ts): cloud-agnostic. `locateMachine(branch)`,
   `ensureMachine(branch, { wake })`, `suspendMachine`, `deleteMachine`, `planMachinePrune`; naming and
   labels; waiting for a machine to answer; the token pairing.
4. **Tunnel** (src/lib/serve/tunnel.ts, generalised): today it runs `ssh -N -L`; it becomes "run this
   argv, which will listen on `127.0.0.1:<port>`, and wait until the port accepts", with the argv coming
   from the provider. `--ssh` remotes keep working unchanged (their argv is the ssh one).
5. **`kunj ct`** (src/commands/container.ts, select-backend.ts): when `machine.provider` is set for the
   repository, `selectBackend()` resolves the branch's machine through lifecycle and returns a
   `RemoteKunjBackend` over its tunnel. Nothing in lifecycle.ts, services, snapshots, forward, prune or
   the MCP bridge changes: they already program against `ContainerBackend`.
6. **`kunj machine`** (src/commands/machine.ts): direct management, on the fast path with lazy imports.

## The provider interface

```ts
export interface MachineProvider {
  readonly name: string;                       // 'gce', 'ec2', 'ssh-fleet'…
  readonly features: {
    suspend: boolean;                          // memory-preserving suspend/resume
    spot: boolean;
    images: boolean;                           // can bake and boot a golden image
    diskSnapshots: boolean;                    // can create a data disk from a snapshot
    authenticatedTunnel: boolean;              // the tunnel itself is access-controlled (IAP, SSM)
  };
  list(filter: Labels): Promise<Machine[]>;    // exact label match, any state
  get(name: string): Promise<Machine | null>;
  create(spec: MachineSpec): Promise<Machine>; // returns once the machine exists; not yet reachable
  suspend(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  delete(name: string, opts: { disks: boolean }): Promise<void>;
  tunnel(machine: Machine, port: number, localPort: number): TunnelSpec;
  images: {                                    // golden images, when features.images
    list(filter: Labels): Promise<MachineImage[]>;
    createFrom(machine: Machine, name: string, labels: Labels): Promise<MachineImage>;
    delete(name: string): Promise<void>;
  };
  sizes(): MachineSize[];                      // what `machine.size` maps to on this cloud
}

export interface Machine {
  name: string; state: 'provisioning' | 'running' | 'suspending' | 'suspended' | 'stopping' | 'stopped' | 'unknown';
  labels: Labels; size: string; zone?: string; createdAt: string; addresses: { internal?: string };
}

export interface MachineSpec {
  name: string; labels: Labels;
  size: 'small' | 'medium' | 'large' | string; // 4 / 8 / 16 GB classes, or a provider shape verbatim
  image: string;                               // golden image name, or the provider's stock Ubuntu
  diskGb: number; dataDiskFromSnapshot?: string;
  spot: boolean; zone?: string;
  metadata?: Record<string, string>;           // provider-visible, never a secret
}

export type TunnelSpec = { argv: string[]; listensOn: 'localPort' };
```

Rules a provider must keep, checked by a shared conformance test that every provider runs against:

- **Labels are exact and complete.** `list` returns the labels as set; names kunj did not create are
  never touched (every mutating call first checks `kunj.role=machine` on the object).
- **Idempotent by name.** `create` of an existing name is an error (`machine-exists`); `delete` of a
  missing one succeeds; `suspend` of a suspended machine succeeds.
- **No secrets anywhere.** Not in metadata, user-data, labels, images or argv. The serve token is
  paired after boot (below).
- **argv only.** No shell strings; user values (branch names, zones, projects) are validated with the
  same word rules the blueprint uses before they become an argument.

### `GceProvider`

Config under `machine.gce`: `project`, `zone`, `network`/`subnet` (default: the project's default
network), `serviceAccount` (a dedicated one with no project roles, below), `machineTypes` override per
size (defaults `e2-medium`, `e2-standard-2`, `e2-standard-4`), `baseImage` (default
`ubuntu-os-cloud/ubuntu-2404-lts-amd64`). Calls: `gcloud compute instances
list|create|suspend|resume|stop|start|delete|describe`, `gcloud compute images create|list|delete`,
`gcloud compute disks create --source-snapshot`, all with `--format=json` and labels as
`--labels kunj-repo=…` (GCE label keys allow `[a-z0-9_-]`, so `kunj.repo` is stored as `kunj-repo` and
mapped back by the provider; values are hashed where a branch name does not fit the 63-character
lowercase rule, exactly as `names.ts` already does for container names). Machines get no external IP;
egress is the project's Cloud NAT (documented, not created by kunj). The tunnel argv is
`gcloud compute start-iap-tunnel <name> <port> --local-host-port=127.0.0.1:<localPort> --zone … --project …`,
so **the machine needs no sshd and no OS Login**: IAP TCP forwarding connects to the machine's internal
address, the VPC firewall admits `35.235.240.0/20` to the serve port only, and the user needs
`roles/iap.tunnelResourceAccessor`. `kunj serve` on a GCE machine therefore listens on the internal
address (`--listen <internal-ip>:7433 --allow-remote-listen`, set by the image's unit from the metadata
server), which is private by the firewall rule, not by loopback. `features`: suspend, spot, images,
diskSnapshots and authenticatedTunnel all true.

### A second provider, to keep the seam honest

`Ec2Provider` (phase 4): `aws ec2 run-instances|describe-instances|stop-instances --hibernate|
start-instances|terminate-instances`, tags instead of labels, hibernation instead of suspend (an
encrypted root volume and a supported family are the image recipe's job), the tunnel through
`aws ssm start-session --document-name AWS-StartPortForwardingSession` to loopback. A third,
`SshFleetProvider`, has no API at all: a list of boxes in config, `list` by a label file kunj keeps on
each box, no create/delete, suspend as no-op, `ssh -N -L` as the tunnel. It costs little and proves that
nothing above the interface assumes a cloud.

## Lifecycle

**Naming.** A machine is named like the container it will hold: `kunj-<repo>-<branch>-<hash>` from
`containerNames()`, lowercased and clipped to the provider's limit with the hash kept, so the two can
always be matched by eye. Labels: `kunj.repo` (the repo id), `kunj.branch`, `kunj.version`,
`kunj.role=machine`, `kunj.image` (the golden image it booted from).

**Locate.** `locateMachine(branch)` is one `provider.list({ 'kunj.repo', 'kunj.branch' })`. None →
no machine; one → it; several → `machine-ambiguous` naming them (a provider bug or a manual clone,
never created by kunj).

**Create.** `ensureMachine()` with no machine: the `pre-machine-create` hook, then
`provider.create()` from the newest golden image of the repository's blueprint hash (or the stock
Ubuntu plus the recipe at first boot when there is none, with a warning that the first start will be
slow), then wait for `running`, open the tunnel, pair the token, and wait for `GET /v1/info` to answer
(a boot is under a minute; the wait is `machine.bootTimeoutMs`, default 5 min). The
`post-machine-create` hook runs with `machine`, `provider`, `branch`. The container is then created
through the ordinary `startContainer()` on the `RemoteKunjBackend`.

**Wake.** A `suspended` machine is resumed (`stopped` is started) **only by commands that act**: `start`,
`shell`, `agent`, `attach`, `exec`, `forward`, `file write`, `logs --follow`. Listings (`ct list`,
`worktree list --containers`, `kunj events`) never wake a machine: they report it from the provider's
state, with the branch from its labels, as a row whose container is `machine suspended`. `--no-wake`
makes an acting command fail with `machine-asleep` instead.

**Idle.** On the machine, `kunj serve --idle-after <minutes> --idle-command '<cmd>'` (a serve feature,
phase 3): idle means no exec with a TTY open and no main container whose agent state is `running` for
the period; the server polls agent states the way `kunj events` does and runs the command once. The
command comes from the provider's recipe at image build (GCE: `gcloud compute instances suspend
$(hostname) --zone …` under a service account whose only permissions are `compute.instances.suspend`
and `compute.instances.get` on itself, by IAM condition). A laptop is not needed for a machine to go
to sleep. `machine.idleMinutes` (default 30) is written into the unit at image build.

**Stop and remove.** `kunj ct stop` stops the container and suspends the machine (`--keep-awake` to
only stop the container). `kunj ct remove` removes the container as today (remove guard included), then
`deleteMachine()`: the `pre-machine-delete` hook, `provider.delete(name, { disks: true })`,
`post-machine-delete`. `kunj machine delete <branch>` deletes a machine whose container is already gone.

**Prune.** `kunj ct prune` gains machines: those whose branch is gone from origin (the same
`ls-remote` rule as containers; the container's remove guard is checked on a running or resumed machine,
a suspended one is resumed for the check unless `--force`), and orphans: machines labelled for the repo
with no container and nothing created in the last 10 minutes. Only `--yes` or a confirmation applies.
Golden images of other blueprint hashes are pruned like snapshots, never the one in use.

**Pairing the token.** The golden image carries no token (it is shared by every machine). On first
boot `kunj serve` starts with an empty token file and accepts, for `machine.pairWindowMinutes` (default
10) after boot, one `POST /v1/pair` that returns a freshly generated token and closes pairing; every
other route is `401` until then. The laptop calls it as soon as the tunnel is up and stores the token
in `~/.kunj/machine-tokens.json` (0600, keyed by provider and machine name; a `401` later evicts it and
the command fails with `machine-token`, since pairing cannot be repeated). This is safe only because
the tunnel is itself access-controlled (`features.authenticatedTunnel`); a provider without that (the
SSH fleet) reads the token over ssh instead, and `pair` is refused by serve unless `--allow-pairing`
was given, which the GCE recipe sets. The alternative, the laptop writing a token into instance
metadata, was rejected: metadata is readable by every project viewer.

## The golden image

`kunj machine image build [--size …]` creates a builder machine from the provider's stock Ubuntu,
runs the recipe (src/machine/recipe.sh, copied to dist by the build like the container assets) over the
tunnel's exec channel, bakes it and deletes the builder. The recipe is generic Ubuntu: Docker CE from
Docker's apt repository, Sysbox, Node LTS, `npm i -g kunj@<this version>`, the `kunj serve` unit with
`--idle-after` and `--allow-pairing`, `kunj-sandbox`, `kunj-nethelper` and the repository's blueprint
snapshot pulled or built (`kunj ct blueprint snapshot` against the builder, over the wire), the cache
volume created and filled by the blueprint's `setup` where it declares one. Provider-specific lines
(the idle command, the serve listen address) come from `provider.recipeEnv()`. The image is labelled
`kunj.version`, `kunj.blueprint` (the hash) and `kunj.repo`; `ensureMachine()` picks the newest image
whose version and hash match, warns `image-stale` when the blueprint hash moved (and still boots the
old image), and `kunj ct blueprint status` reports the image next to the snapshot. A nightly
`kunj machine image build` from the user's scheduler keeps the data disk snapshot and the cache current;
kunj ships no scheduler.

## Blueprint, snapshot, golden image: one hash, three layers

The blueprint already produces a reusable image: the **snapshot** `kunj-blueprint-<repo>:<hash>`, a
Docker image with the tools installed and `setup` run, built once per daemon and reused by every branch
container that daemon starts ([blueprints.md](blueprints.md)). Machines add one layer above it and,
optionally, one beside it, all keyed by the same `computeBlueprintHash()`:

| Layer | What it is | Reused by | Built by |
| --- | --- | --- | --- |
| Blueprint snapshot | Docker image `kunj-blueprint-<repo>:<hash>` on a daemon | Every branch on that daemon (today) | `kunj ct start` when missing, or `kunj ct blueprint snapshot` |
| Golden machine image | A cloud VM image (labels `kunj.blueprint=<hash>`, `kunj.version`) holding Ubuntu, Docker, kunj, the base images **and the snapshot** | Every machine of the repository | `kunj machine image build`: a builder machine, `kunj ct blueprint snapshot` run against it over the wire, then `provider.images.createFrom()` |
| Registry copy (optional) | The snapshot pushed to a registry the provider names (`machine.registry`, e.g. Artifact Registry in the machine's region) | A machine booted from an older golden image, which pulls the snapshot for the current hash instead of building it | `kunj ct blueprint snapshot --push`, and by the image build |

So a new machine starts a branch in the time it takes to copy `/workspace` from the snapshot, exactly as
a second branch on the laptop does today; nothing is rebuilt per machine. When the blueprint changes,
the hash changes: `ensureMachine()` boots the newest golden image and warns `image-stale` until
`kunj machine image build` runs again (a nightly build keeps it current), and in between a machine with
`machine.registry` set pulls the new snapshot rather than building it. The snapshot inside the golden
image is the ordinary one: built from a bundle, no secrets, no token, no `/var/lib/docker` of a running
branch. `kunj ct blueprint status` reports all three layers for the hash.

## The cache volume

`container.caches` (generic; kunj knows nothing about what goes in): a list of
`{ name, path }`. For each, every branch container of the repository mounts the named volume
`kunj-<repo>-cache-<name>` (labels `kunj.repo`, `kunj.role=cache`) at `path`, and the container's env
gets `KUNJ_CACHE_DIR` (the first path) and `KUNJ_CACHE_<NAME>`. One volume per daemon, so on a shared
box every branch shares it and on a machine per session the golden image's disk carries it. Never in a
snapshot (volumes are not committed), kept by `ct remove`, removed by `ct prune` only with `--force`.
Services do not get it. What a repository puts there is its blueprint's business, for example a pulled
database dump its own script restores from when given the path.

## `kunj machine`

| Command | Does |
| --- | --- |
| `kunj machine list [--json]` | Every machine of the repository (any state), with size, state, created, image, idle since (from serve when running) |
| `kunj machine status [branch]` | One machine, and whether `kunj serve` answers |
| `kunj machine suspend|resume|stop|start [branch]` | Explicitly; `resume` waits for serve |
| `kunj machine delete [branch] [--yes]` | Deletes the machine and its disks; refuses while a container runs unless `--force` |
| `kunj machine prune [--yes] [--force]` | Machines of gone branches and orphans; the `ct prune` plan without the containers |
| `kunj machine image build|list|delete` | Golden images |
| `kunj machine providers` | Registered providers and their features |

`MachineListJson` joins json-types.ts; `ContainerListJson` gains `machine?: { provider, name, state,
size }` per container and `machines: MachineJson[]` (suspended and stopped machines, which have no
container row); `backend.kind` gains `'machine'`. `EventJson` gains `kind: 'machine'` from a 30 s
provider poll. Errors: `machine-provider` (none configured or unknown), `machine-not-found`,
`machine-ambiguous`, `machine-asleep`, `machine-create-failed`, `machine-token`, `image-stale`,
`provider-cli-missing` (the cloud CLI is not installed or not logged in, with the install hint).

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `machine.provider` | `""` | `gce`, later `ec2`, `ssh-fleet`; empty means no machines |
| `machine.size` | `medium` | `small` (4 GB), `medium` (8 GB), `large` (16 GB), or a provider shape |
| `machine.diskGb` | `30` | Boot and Docker disk |
| `machine.spot` | `false` | Spot/preemptible machines |
| `machine.idleMinutes` | `30` | Baked into the image's serve unit |
| `machine.pairWindowMinutes` | `10` | Pairing window after boot |
| `machine.bootTimeoutMs` | `300000` | How long `ensureMachine` waits for serve |
| `machine.gce.project`, `.zone`, `.network`, `.subnet`, `.serviceAccount`, `.machineTypes`, `.baseImage` | — | Provider config; `machine.<provider>.*` for each |
| `machine.registry` | `""` | A registry for snapshot pushes and pulls (e.g. `<region>-docker.pkg.dev/<project>/kunj`); empty means the golden image alone |
| `container.caches` | `[]` | `{ name, path }` list, above |

## Security

- The agent's blast radius is one machine with nothing on it but kunj's Docker: a service account with
  no project roles (only the self-suspend permission by IAM condition), no gcloud login, no SSH keys
  (GCE), the serve token paired per machine. The firewall still blocks the metadata server from
  containers (`169.254/16`), so `allowHost` stays off.
- Secrets travel as today, in the `docker run` env file over the tunnel, never through the provider
  (no metadata, no user-data, no image). The golden image is built from a snapshot bundle, so it holds
  no token either.
- Access to a machine is the cloud's IAM (IAP, SSM) plus the serve token. Deleting the project's
  machines is `kunj machine prune --yes` or the console; kunj deletes only objects labelled
  `kunj.role=machine`.

## Decisions

- **2026-11-16** A VM per session, not a shared VM: sized at 8 GB it is cheaper below about five
  concurrent sessions, and gives a kernel per agent (research doc). The shared VM remains phase 0 and
  the thing the golden image is baked from.
- **2026-11-16** Provider through the cloud's CLI, not an SDK: the user's login and config are reused,
  nothing heavy joins the fast path, and it is how kunj already treats `gh` and `docker`.
- **2026-11-16** Labels as the only machine state, and no remotes.json entries per machine: find by
  asking the provider, as the multi-remote spec finds containers by asking every backend.
- **2026-11-16** Tunnel as a provider-supplied port forwarder argv, not ssh: GCE machines then need no
  sshd or OS Login; ssh remains one argv among others, so `--ssh` remotes are unchanged.
- **2026-11-16** Token by one-time pairing over an authenticated tunnel, never by metadata.
- **2026-11-16** Listings never wake a machine; acting commands do, unless `--no-wake`.
- **2026-11-16** Idle is decided on the machine from agent state, not from laptop connections, so an
  open workspace app does not keep a machine awake.
- **2026-11-16** The machine suspends itself. `kunj serve --idle-after` runs the provider's idle command on
  the machine, with a credential that can do only that (GCE: a service account allowed
  `compute.instances.suspend` on itself). Rejected: the laptop or a scheduler suspending it from outside,
  because the laptop may be closed and a scheduler cannot see agent state. External control still exists
  for the user's hand (`kunj ct stop`, `kunj machine suspend`) and as a backstop (an instance schedule at
  night); a provider that cannot self-suspend (the SSH fleet) makes the idle command a no-op.

## Testing

- Unit: lifecycle against `FakeProvider` and `FakeBackend` (create, locate, ambiguous, wake on act,
  no wake on list, pairing success and `401` eviction, prune plans, hooks); the provider conformance
  suite run by `FakeProvider` and, with argv assertions against a stub `gcloud`, by `GceProvider`.
- `npm run test:remote` already runs the container suites over `kunj serve`; the serve pairing and
  `--idle-after` tests join `serve`'s unit tests with the fake daemon.
- Opt-in `*.gce.test.ts` (`KUNJ_GCE_PROJECT`, `KUNJ_GCE_ZONE`): create, pair, start a container,
  suspend, resume, remove, delete, image build, against a real project; everything labelled with the
  test repo is deleted afterwards. Minutes and money, like the functional suite.

## Plan

0. By hand: one Ubuntu VM with the recipe, reached through IAP, `kunj remote add --ssh`; proves serve
   over IAP and closes the remote-containers spec's "real second machine" item.
1. `MachineProvider`, `FakeProvider`, `GceProvider`, generalised tunnel, `kunj machine
   list|status|suspend|resume|delete|providers`, labels and naming, pairing in serve.
2. `kunj ct` on machines: `selectBackend()` through lifecycle, create on `start`, wake on act, list
   and events with machines, remove and prune, hooks, JSON additions, docs.
3. Golden image build, `container.caches`, `kunj serve --idle-after`, `image-stale`, blueprint status.
4. `Ec2Provider` (and `SshFleetProvider` if cheap), workspace app rows and a Wake action, the docs page
   "Containers in the cloud".
