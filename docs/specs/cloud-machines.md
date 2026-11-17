# Cloud machines: a VM per session behind one `kunj serve`, from a pluggable provider

A branch's container runs on a small cloud machine that is created for it on demand, suspended when its
agent goes quiet, resumed on the next command and deleted when the branch is gone. One **coordinator**,
an ordinary `kunj serve` started with `--machines`, is the fleet's single door: every client (a laptop, a
second laptop, the workspace app, later CI) connects to it with its own token, and it alone talks to the
cloud through a pluggable **machine provider** and to the per-session machines. The coordinator runs
either **on the laptop, auto-started by kunj** when a command needs it (one person, nothing extra to
run), or **on a tiny always-on cloud VM** (several clients, machines reached on the private network).
Same code, a deployment choice. Google Cloud is the first provider; AWS, Azure or a plain fleet of SSH
boxes are later ones, and nothing outside the provider module knows which cloud it is. The research that
led here is [google-cloud-containers.md](google-cloud-containers.md).

## Status

| Part | State |
| --- | --- |
| Spec | Written 2026-11-16; coordinator architecture and local auto-start adopted the same day (see Decisions) |
| Phase 0: one VM by hand with `kunj serve`, reached through an IAP tunnel | Done 2026-11-16 on project `kunj-dev`, VM `kunj-box` (e2-standard-2, Ubuntu 24.04, kernel 7.0, Docker 29.10, no external IP, Cloud NAT, IAP): `kunj remote ping` 1.4 s through the IAP ssh ProxyCommand; first `ct start` 303 s including the sandbox images and the blueprint snapshot; `ct exec` 3.3 s; metadata server blocked from the container, npm reachable; suspend 60 s, usable 18 s after resume with the container and a running process intact. `shell`/`agent` (interactive) and Sysbox not tried yet |
| Phase 1: `MachineProvider`, `FakeProvider`, `GceProvider`; `kunj serve --machines` (routes, per-client tokens, pairing); local auto-start; `kunj machine` | Shipped 2026-11-16 (924d4ae, 8423238, a2856bc); unit-tested, and the local coordinator smoke-tested against the real `gcloud` without a project login. No machine has been created on a real project yet |
| Phase 2: containers through the coordinator (`/v1/machines/<name>/…` proxy), `kunj ct` on machines, wake on act, idle loop, events | Not started |
| Phase 3: golden image build, `container.caches`, registry copy | Not started |
| Phase 4: a second provider (EC2) to prove the seam; workspace app rows and Wake | Not started |

## Goals and non-goals

Goals:

- **One command set.** `kunj ct start|shell|agent|attach|exec|stop|remove|prune|list` behave as they
  do for a local or remote container. The machine behind a container is created, woken and deleted as
  a side effect; `kunj machine` exists for looking at and managing machines directly.
- **One machine per branch (session).** Sized to one agent and its services (8 GB by default), its
  own kernel, no neighbours. Idle costs the disk only.
- **One door, many clients.** Every client reaches the fleet through the coordinator's address with a
  token of its own. Two laptops see the same machines and containers; a session started from one is
  attached from the other. No client needs a cloud credential or a cloud CLI when the coordinator is in
  the cloud; with a local coordinator the laptop's own `gcloud` login is what it uses.
- **Zero extra moving parts for one person.** `kunj ct start` on a laptop with `machine.provider` set
  auto-starts a local coordinator and goes; nothing to install or keep running.
- **Pluggable provider.** A `MachineProvider` interface with the cloud-specific parts behind it, chosen
  by `machine.provider` where the coordinator runs. Everything above (lifecycle, naming, listing, the
  proxy, `kunj ct`, the apps' JSON) is cloud-agnostic. Adding a cloud is one module and its tests.
- **Clients stay the authority for their work**, as in every remote spec: vault, keep files, blueprints,
  hooks and config stay on the client; the coordinator holds the fleet's tokens and the cloud login;
  machines hold Docker labels.
- **No state file for machines.** Cloud labels (`kunj.repo`, `kunj.branch`, `kunj.version`,
  `kunj.role=machine`) are the only record of which machine is whose, mirroring the Docker-label rule
  of phase 1. Finding a branch's machine is one provider `list` by label.

Non-goals (v1):

- Kubernetes, Cloud Run or any runtime but a VM with Docker (research doc).
- Shared filesystems between machines; caches are shared by image, registry and the cache volume below.
- Multi-tenancy: a cloud coordinator serves one team that trusts each other. Tokens name clients for
  logs and for the `kunj.owner` label; they do not partition what a client may see or do.
- Building the base OS image from scratch: the golden image is built from the cloud's stock Ubuntu by
  a recipe kunj ships.

## Shape

```
clients                              coordinator: kunj serve --machines               machines (one per branch)
──────────────────────               (on the laptop, auto-started · or a tiny VM)      ────────────────────────────
laptop A: kunj ct start feature/x      ├─ /v1/machines…  ──► MachineProvider ──►     kunj-repo-feature-x-a1b2
laptop B: kunj ct attach feature/x     │                     (GceProvider: gcloud)   golden image: Ubuntu, Docker,
workspace app: kunj events             │                     labels = the state      Sysbox, kunj serve, images,
  │                                    ├─ /v1/machines/<name>/containers… ──────►   blueprint snapshot, cache volume
  │  one address, one token each       │   proxy to that machine's serve             kunj serve: private network
  └─ RemoteKunjBackend ──────────────► │   (private address, or an IAP tunnel)       (cloud coordinator) or an IAP
     (loopback · IAP · tailnet · TLS)  └─ idle loop: agent states → suspend          tunnel (local coordinator)
                                          per-machine tokens, cloud login            dockerd: main · helper · services
```

Layers:

1. **`MachineProvider`** (src/lib/machines/provider.ts): the interface, below. Runs where the
   coordinator runs.
2. **Providers** (src/lib/machines/providers/<name>.ts): `gce.ts` first. A provider drives its cloud
   through that cloud's CLI (`gcloud … --format=json`, later `aws … --output json`), the way kunj drives
   GitHub through `gh`: `execFile` with argv arrays, never a shell, whatever login the coordinator's host
   has (the user's `gcloud auth` on a laptop, a service account on a VM). **Only a provider module
   spawns a cloud CLI.** `FakeProvider` (src/lib/machines/__tests__/fake-provider.ts) is the in-memory
   one for unit tests, like `FakeBackend`.
3. **Machine lifecycle** (src/lib/machines/coordinator.ts, class `Coordinator`): cloud-agnostic, in the coordinator.
   `locateMachine(branch)`, `ensureMachine(branch, { wake })`, `suspendMachine`, `deleteMachine`,
   `planMachinePrune`, the idle loop, naming and labels, reaching a machine's serve (private address or
   tunnel), pairing its token.
4. **`kunj serve --machines`** (src/lib/serve/machines.ts): the coordinator role of the existing server.
   Adds the `/v1/machines…` routes (below), a **proxy** that forwards `/v1/machines/<name>/<route>` to
   that machine's serve as the same route (unary bodies piped, WebSockets piped frame for frame, the
   machine's token added by the coordinator), per-client tokens, and the idle loop. Without `--machines`
   the server is exactly what it is today.
5. **Client side** (src/lib/container/remote.ts, select-backend.ts): `RemoteKunjBackend` gains a base
   path, so a backend for branch `b` on remote `cloud` is the ordinary remote backend rooted at
   `/v1/machines/<name>/`. `selectBackend()` on a remote that reports `features.machines` asks the
   coordinator for the branch's machine (`POST /v1/machines/locate`, with `wake` for acting commands) and
   roots the backend there (phase 2; `MachineClient` in src/lib/machines/client.ts already speaks the routes). Nothing in lifecycle.ts, services, snapshots, forward, prune or the MCP
   bridge changes: they already program against `ContainerBackend`.
6. **Local auto-start** (src/lib/machines/local-coordinator.ts): when `machine.provider` is set in the
   client's own config and no remote is named, `selectBackend()` uses the local coordinator: it reads
   `~/.kunj/coordinator/coordinator.json` (pid, port, version, startedAt; written by the server once it
   listens, removed when it stops; a dead pid reads as none), starts `kunj serve --machines --listen 127.0.0.1:0` detached when
   none runs, waits for the port, and talks to it with the local token file. The coordinator exits on its
   own after `machine.coordinatorIdleMinutes` (default 60) with no client request, never while a TTY
   proxy is open; `kunj machine coordinator status|stop` shows and ends it.
7. **`kunj machine`** (src/commands/machine.ts): management through the coordinator's routes, on the
   fast path with lazy imports.

A cloud coordinator is reached as an ordinary remote: `kunj remote add cloud --url https://… --token-stdin`
(or `--ssh` through an IAP alias, or a tailnet URL), and `container.remote: cloud` puts a repository's
containers on the fleet. Moving from a local coordinator to a cloud one is: start `kunj serve --machines`
there with the same `machine.*` config, add the remote, set `container.remote`. Machines, labels and
images are untouched because none of them belong to the coordinator.

## Who calls what

| Concern | Who | How | Credential |
| --- | --- | --- | --- |
| Machines: find, create, wake, suspend, delete, prune, images | The **coordinator**, through the provider, when a client asks or the idle loop decides | The cloud's CLI | The coordinator host's cloud login (the user's on a laptop, a service account on a VM) |
| Containers: start, exec, agent, snapshots, services, forward, files | The **client**, through the coordinator's proxy, to the machine's `kunj serve` | The remote-containers protocol under `/v1/machines/<name>/` | The client's coordinator token; the machine token is the coordinator's |
| Idle: suspend when no agent works | The **coordinator**'s idle loop, polling each running machine's agent states | `provider.suspend(name)` | The same cloud login |
| Wake | The coordinator, on a client's acting command (`locate` with `wake: true`) | `provider.resume(name)` or `start(name)`, then wait for the machine's serve | The same |
| Idle, when the coordinator is a laptop that is closed | The **machine itself**, as a fallback: `kunj serve --idle-after` on the machine runs the provider's self-suspend command | `gcloud compute instances suspend $(hostname)` | A machine service account allowed only that (set by `machine.selfSuspend: true`) |

With a cloud coordinator, machines hold no cloud credential at all. With a local coordinator, the
laptop may be asleep when a machine falls idle, so `machine.selfSuspend` (default true for a local
coordinator, false for a cloud one) gives machines the one-permission service account and the
machine-side idle timer as a fallback; the coordinator's loop still acts first when it is running.
Clients hold one coordinator token each.

## The provider interface

```ts
export interface MachineProvider {
  readonly name: string;                       // 'gce', 'ec2', 'ssh-fleet'…
  readonly features: {
    suspend: boolean;                          // memory-preserving suspend/resume
    spot: boolean;
    images: boolean;                           // can bake and boot a golden image
    diskSnapshots: boolean;                    // can create a data disk from a snapshot
    selfSuspend: boolean;                      // a machine can suspend itself with a scoped credential
  };
  list(filter: Labels): Promise<Machine[]>;    // exact label match, any state
  get(name: string): Promise<Machine | null>;
  create(spec: MachineSpec): Promise<Machine>; // returns once the machine exists; not yet reachable
  suspend(name: string): Promise<void>;
  resume(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  delete(name: string, opts: { disks: boolean }): Promise<void>;
  address(machine: Machine): { host: string; port: number } | null;  // private address, when the coordinator is on that network
  tunnel(machine: Machine, port: number, localPort: number): TunnelSpec; // otherwise: argv of a local port forwarder
  images: {                                    // golden images, when features.images
    list(filter: Labels): Promise<MachineImage[]>;
    createFrom(machine: Machine, name: string, labels: Labels): Promise<MachineImage>;
    delete(name: string): Promise<void>;
  };
  sizes(): MachineSize[];                      // what `machine.size` maps to on this cloud
  recipeEnv(): Record<string, string>;         // provider lines for the golden-image recipe (idle command, listen address)
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
  spot: boolean; zone?: string; selfSuspend: boolean;
  metadata?: Record<string, string>;           // provider-visible, never a secret
}

export type TunnelSpec = { argv: string[]; listensOn: 'localPort' };
```

The coordinator reaches a machine's serve by `address()` when `machine.network` is `private` (a cloud
coordinator in the same VPC) and by `tunnel()` when it is `tunnel` (a laptop; the generalised tunnel.ts
runs the argv, one per machine, closed when idle). Rules a provider must keep, checked by a shared
conformance test that every provider runs against:

- **Labels are exact and complete.** `list` returns the labels as set; names kunj did not create are
  never touched (every mutating call first checks `kunj.role=machine` on the object).
- **Idempotent by name.** `create` of an existing name is `machine-exists`; `delete` of a missing one
  succeeds; `suspend` of a suspended machine succeeds.
- **No secrets anywhere.** Not in metadata, user-data, labels, images or argv. The serve token is paired
  after boot (below).
- **argv only.** No shell strings; user values (branch names, zones, projects) are validated with the
  same word rules the blueprint uses before they become an argument.

### `GceProvider`

Config under `machine.gce`: `project`, `zone`, `network`/`subnet`, `serviceAccount` for machines (a
dedicated one with no roles, or the self-suspend role), `machineTypes` per size (defaults `e2-medium`,
`e2-standard-2`, `e2-standard-4`), `baseImage` (default `ubuntu-os-cloud/ubuntu-2404-lts-amd64`).
Calls: `gcloud compute instances list|create|suspend|resume|stop|start|delete|describe`, `gcloud compute
images create|list|delete`, `gcloud compute disks create --source-snapshot`, all with `--format=json`,
labels as `--labels kunj-repo=…` (GCE label keys allow `[a-z0-9_-]`, so `kunj.repo` is stored as
`kunj-repo` and mapped back; values are hashed where a branch name does not fit the 63-character
lowercase rule, as `names.ts` does for container names). Machines get no external IP; egress is the
project's Cloud NAT. The machine's `kunj serve` listens on its internal address (`--allow-remote-listen`)
behind a VPC firewall rule that admits the coordinator's network tag and IAP's `35.235.240.0/20` to port
7433. `address()` is the internal IP and 7433; `tunnel()` is `gcloud compute start-iap-tunnel <name> 7433
--local-host-port=127.0.0.1:<localPort> --zone … --project …`. No sshd, no OS Login, no SSH keys on any
machine. `features`: all true.

### A second provider, to keep the seam honest

`Ec2Provider` (phase 4): `aws ec2 run-instances|describe-instances|stop-instances --hibernate|
start-instances|terminate-instances`, tags instead of labels, hibernation instead of suspend (an encrypted
root volume and a supported family are the image recipe's job), private IPs for `address()` and SSM port
forwarding for `tunnel()`. A third, `SshFleetProvider`, has no API: a list of boxes in the coordinator's
config, `list` by a label file kunj keeps on each box, no create/delete, suspend a no-op, `ssh -N -L` as
the tunnel. It costs little and proves that nothing above the interface assumes a cloud.

## The coordinator

**Where it runs.**

| | Local (auto-started) | Cloud (always on) |
| --- | --- | --- |
| Starts | By kunj, on the first command that needs it; exits after an idle hour | `systemd` on a tiny VM (GCE e2-micro, about $7 a month, free tier in some US regions) |
| Cloud login | The user's `gcloud auth` | The VM's service account, the one cloud identity |
| Reaches machines | `tunnel()` per machine (IAP) | `address()` on the private network |
| Idle while the laptop is shut | Machines self-suspend (`machine.selfSuspend`) | The coordinator's loop |
| Clients | This laptop | Any number, one token each |
| Config | `machine.*` in the laptop's `~/.kunj/config.json` | `machine.*` on the VM; clients only have `container.remote` |

Start local, move to the cloud when a second client appears. Nothing on the machines changes between
the two; the golden image is the same (the self-suspend timer is a unit that runs only when
`KUNJ_SELF_SUSPEND` is set on the machine).

**Reaching a cloud coordinator.** Any of the ways a remote is reached today: an IAP tunnel to its serve
port (an ssh `ProxyCommand` alias for `--ssh`, or `--url http://127.0.0.1:<port>` with a tunnel kept
open), a tailnet address with `--allow-insecure-http`, or the user's own TLS front (`--url https://…`).

**Per-client tokens.** `kunj serve token add <client> [--rotate]` on the coordinator writes a named
token to `tokens.json` (0600) in the server's token directory (`~/.kunj/coordinator/` with `--machines`, `~/.kunj/serve/` otherwise) and prints it once; `token list` shows names and creation
dates, never values; `token remove <client>` revokes. The legacy single `token` file next to it keeps
working as the client named `default` (the local coordinator uses only that). Every request carries one;
the server logs the client's name, and machines a client creates get `kunj.owner=<client>` as a label
(informational: any client may act on any machine). This is the "per-user tokens" item the
remote-containers spec deferred.

**Routes.**

| Route | Does |
| --- | --- |
| `GET /v1/machines?label=…` | `provider.list` plus, for running machines, whether their serve answers |
| `POST /v1/machines/locate` `{ repo, branch, wake, create?, size? }` | Finds the branch's machine; with `wake`, resumes or starts it and waits for its serve; with `create`, makes one from the newest golden image when there is none. Returns `{ machine, state }` or `machine-asleep` / `machine-not-found` |
| `POST /v1/machines/<name>/suspend|resume|stop|start`, `DELETE /v1/machines/<name>?disks=1` | Explicit control |
| `POST /v1/machines/prune` `{ repo, gone: [branches], dryRun }` | The machine part of `ct prune`; the client computes `gone` from its own `ls-remote`, as today |
| `/v1/machines/<name>/<any serve route>` | Proxy to the machine's serve, WebSockets included; `503 machine-asleep` when it is not running |
| `GET /v1/machines/images`, `POST /v1/machines/images/build`, `DELETE …` | Golden images |
| `GET /v1/info` | Adds `features.machines: true`, the provider name, its features and `network` |

**Pairing a machine's token.** The golden image carries no token. On first boot a machine's serve
accepts, for `machine.pairWindowMinutes` (default 10), one `POST /v1/pair` and returns a fresh token;
every other route is `401` until then. The coordinator pairs right after `create`, over the private
network or the IAP tunnel, both access-controlled, and keeps the token in
`~/.kunj/coordinator/machine-tokens.json` (0600, keyed `<provider>/<name>`). A machine's serve refuses `pair` unless started with
`--allow-pairing`, which the recipe sets. Metadata as the carrier was rejected: every project viewer can
read it.

**Idle loop.** Every minute the coordinator polls each running machine's serve for its agent states (one
`STATUS_SCRIPT` exec per running main container, as `kunj events` does) and the proxy's own count of open
TTY execs. A machine with no TTY open and no agent in `running` state for `machine.idleMinutes` (default
30) is suspended through the provider. `waiting` for input and stopped containers count as idle; the tmux
session survives the suspend. An open workspace app does not keep a machine awake.

**If the coordinator is down** nothing is lost: machines keep running or stay suspended, labels stay on
the cloud, per-machine tokens are in its file (a cloud coordinator's boot disk is the one thing worth a
snapshot; a local one's file is in `~/.kunj`). Clients see `remote-unreachable` as for any remote. A
machine whose token is lost is `machine-token`: delete and recreate it, the branch is on origin.

## Lifecycle

**Naming.** A machine is named like the container it will hold: `kunj-<repo>-<branch>-<hash>` from
`containerNames()`, lowercased and clipped to the provider's limit with the hash kept. Labels:
`kunj.repo`, `kunj.branch`, `kunj.version`, `kunj.role=machine`, `kunj.image` (the golden image it
booted from), `kunj.owner` (the client's token name).

**Locate.** `locateMachine(branch)` is one `provider.list({ 'kunj.repo', 'kunj.branch' })`. None →
no machine; one → it; several → `machine-ambiguous` naming them.

**Create.** `locate` with `create`: the `pre-machine-create` hook runs **on the client** (hooks stay
where the user's config is), then the coordinator's `ensureMachine()`: `provider.create()` from the
newest golden image of the repository's blueprint hash (or the stock Ubuntu plus the recipe at first
boot when there is none, with a warning that the first start will be slow), wait for `running`, pair
the token, wait for `GET /v1/info` (`machine.bootTimeoutMs`, default 5 min). `post-machine-create` runs
on the client with `machine`, `provider`, `branch`. The container is then created through the ordinary
`startContainer()` on the proxied backend.

**Wake.** A `suspended` machine is resumed (`stopped` is started) **only by commands that act**: `start`,
`shell`, `agent`, `attach`, `exec`, `forward`, `file write`, `logs --follow`. Listings (`ct list`,
`worktree list --containers`, `kunj events`) never wake a machine: the coordinator reports it from the
provider's state as a row whose container is `machine suspended`. `--no-wake` makes an acting command
fail with `machine-asleep`.

**Stop and remove.** `kunj ct stop` stops the container and suspends the machine (`--keep-awake` to
only stop the container). `kunj ct remove` removes the container as today (remove guard included), then
`pre-machine-delete` on the client, `DELETE /v1/machines/<name>?disks=1`, `post-machine-delete`.

**Prune.** `kunj ct prune` gains machines: those whose branch is gone from origin (the client's
`ls-remote`, as for containers; the remove guard is checked on a running machine, a suspended one is
resumed for the check unless `--force`), and orphans: machines labelled for the repo with no container
and nothing created in the last 10 minutes. Only `--yes` or a confirmation applies. Golden images of
other blueprint hashes are pruned like snapshots, never the one in use.

## The golden image

`kunj machine image build [--size …]` asks the coordinator to create a builder machine from the
provider's stock Ubuntu, run the recipe (src/machine/recipe.sh, copied to dist by the build like the
container assets) over the machine's exec channel, bake it with `provider.images.createFrom()` and
delete the builder. The recipe is generic Ubuntu: Docker CE from Docker's apt repository, Sysbox, Node
LTS, `npm i -g kunj@<this version>`, the `kunj serve` unit (`--allow-remote-listen` on the internal
address, `--allow-pairing`, and `--idle-after` with the self-suspend command, active only when the
machine was created with `selfSuspend`), `kunj-sandbox`, `kunj-nethelper` and the repository's blueprint
snapshot pulled or built (`kunj ct blueprint snapshot` through the proxy), the cache volume created and
filled by the blueprint's `setup` where it declares one. Provider-specific lines come from
`provider.recipeEnv()`. The image is labelled `kunj.version`, `kunj.blueprint` (the hash) and
`kunj.repo`; `ensureMachine()` picks the newest image whose version and hash match, warns `image-stale`
when the blueprint hash moved (and still boots the old image), and `kunj ct blueprint status` reports
the image next to the snapshot. A nightly `kunj machine image build` from the user's scheduler keeps the
data disk snapshot and the cache current; kunj ships no scheduler.

## Blueprint, snapshot, golden image: one hash, three layers

The blueprint already produces a reusable image: the **snapshot** `kunj-blueprint-<repo>:<hash>`, a
Docker image with the tools installed and `setup` run, built once per daemon and reused by every branch
container that daemon starts ([blueprints.md](blueprints.md)). Machines add one layer above it and,
optionally, one beside it, all keyed by the same `computeBlueprintHash()`:

| Layer | What it is | Reused by | Built by |
| --- | --- | --- | --- |
| Blueprint snapshot | Docker image `kunj-blueprint-<repo>:<hash>` on a daemon | Every branch on that daemon (today) | `kunj ct start` when missing, or `kunj ct blueprint snapshot` |
| Golden machine image | A cloud VM image (labels `kunj.blueprint=<hash>`, `kunj.version`) holding Ubuntu, Docker, kunj, the base images **and the snapshot** | Every machine of the repository | `kunj machine image build` |
| Registry copy (optional) | The snapshot pushed to a registry the coordinator names (`machine.registry`, e.g. Artifact Registry in the machines' region) | A machine booted from an older golden image, which pulls the snapshot for the current hash instead of building it | `kunj ct blueprint snapshot --push`, and the image build |

A new machine starts a branch in the time it takes to copy `/workspace` from the snapshot, exactly as a
second branch on the laptop does today; nothing is rebuilt per machine. When the blueprint changes, the
hash changes: new machines boot the newest golden image and warn `image-stale` until the image is rebuilt,
and in between a machine with `machine.registry` set pulls the new snapshot rather than building it. The
snapshot inside the golden image is the ordinary one: built from a bundle, no secrets, no token.

## The cache volume

`container.caches` (generic; kunj knows nothing about what goes in): a list of `{ name, path }`. For
each, every branch container of the repository mounts the named volume `kunj-<repo>-cache-<name>`
(labels `kunj.repo`, `kunj.role=cache`) at `path`, and the container's env gets `KUNJ_CACHE_DIR` (the
first path) and `KUNJ_CACHE_<NAME>`. One volume per daemon, so on a shared box every branch shares it and
on a machine per session the golden image's disk carries it. Never in a snapshot (volumes are not
committed), kept by `ct remove`, removed by `ct prune` only with `--force`. Services do not get it. What
a repository puts there is its blueprint's business, for example a pulled database dump its own script
restores from when given the path.

## `kunj machine`

| Command | Does |
| --- | --- |
| `kunj machine list [--json]` | Every machine of the repository (any state), with size, state, created, image, owner, idle since |
| `kunj machine status [branch]` | One machine (never wakes it) |
| `kunj machine create [branch] [--size]` | Makes the branch's machine and waits until its serve answers (phase 1's way in, before `ct start` does it) |
| `kunj machine suspend|resume|stop|start [branch]` | Explicitly; `resume` waits for serve |
| `kunj machine delete [branch] [--yes] [--keep-disks]` | Deletes the machine and its disks after a confirmation (`--yes` with `--json`); the running-container refusal and `--force` come with phase 2 |
| `kunj machine prune [--yes] [--force]` | Machines of gone branches and orphans; the `ct prune` plan without the containers (phase 2) |
| `kunj machine image build|list|delete` | Golden images (phase 3) |
| `kunj machine coordinator status|stop` | The local coordinator: pid, port, version, start time, log; `stop` ends it |
| `kunj machine providers` | The coordinator's provider and its features |

All through the coordinator (local by default when `machine.provider` is set locally; `container.remote`
or `--remote` for a cloud one). `MachineListJson` joins json-types.ts; `ContainerListJson` gains
`machine?: { provider, name, state, size, owner }` per container and `machines: MachineJson[]`
(suspended and stopped machines, which have no container row); `backend.features` gains `machines`.
`EventJson` gains `kind: 'machine'` from the coordinator's events stream. Errors: `machine-provider`
(none configured where the coordinator runs), `machine-not-found`, `machine-ambiguous`,
`machine-asleep`, `machine-create-failed`, `machine-token`, `image-stale`, `provider-cli-missing` (the
cloud CLI is not installed or not logged in on the coordinator's host), `coordinator-start-failed`.

## Settings

| Key | Where | Default | Meaning |
| --- | --- | --- | --- |
| `machine.provider` | Coordinator's host (the laptop for a local one) | `""` | `gce`, later `ec2`, `ssh-fleet`; empty means no machines |
| `machine.network` | Coordinator's host | `tunnel` | `private` when the coordinator is in the machines' network, else `tunnel` |
| `machine.selfSuspend` | Coordinator's host | `true` locally, `false` on a cloud coordinator | Machines get the one-permission service account and the machine-side idle timer |
| `machine.coordinatorIdleMinutes` | Laptop | `60` | When an auto-started local coordinator exits |
| `machine.size` | Coordinator's host | `medium` | `small` (4 GB), `medium` (8 GB), `large` (16 GB), or a provider shape; `ct start --size` overrides |
| `machine.diskGb` | Coordinator's host | `30` | Boot and Docker disk |
| `machine.spot` | Coordinator's host | `false` | Spot/preemptible machines |
| `machine.idleMinutes` | Coordinator's host | `30` | Idle threshold (coordinator loop and machine-side timer) |
| `machine.pairWindowMinutes` | Coordinator's host | `10` | Pairing window after a machine boots |
| `machine.bootTimeoutMs` | Coordinator's host | `300000` | How long `locate --wake/--create` waits for a machine's serve |
| `machine.registry` | Coordinator's host | `""` | A registry for snapshot pushes and pulls; empty means the golden image alone |
| `machine.gce.project`, `.zone`, `.network`, `.subnet`, `.serviceAccount`, `.machineTypes`, `.baseImage` | Coordinator's host | — | Provider config; `machine.<provider>.*` for each |
| `container.remote` | Client | — | Names a cloud coordinator; absent with `machine.provider` set means the local one |
| `container.caches` | Client | `[]` | `{ name, path }` list, above |

## Security

- **One cloud identity** where the coordinator runs: the user's own login on a laptop, or a dedicated
  tiny VM running nothing else and reachable only through IAP, a tailnet or the user's TLS front.
  Machines have a service account with no roles (or only self-suspend on themselves); the firewall still
  keeps containers off the metadata server (`169.254/16`), so `allowHost` stays off.
- **Clients hold a coordinator token each**, revocable by name. A client never sees a machine token or
  a cloud credential. The agent's blast radius is one machine with nothing on it but kunj's Docker.
- **Secrets travel as today**, in the `docker run` env file through the proxy to the machine's serve,
  never through the provider (no metadata, no user-data, no image). The coordinator pipes bodies and
  frames and logs neither.
- **The proxy acts only on machines it created** (labelled `kunj.role=machine`, token in its file) and
  only forwards to their serve port.
- **The local coordinator listens on loopback** with the local token; nothing on the laptop's network
  can reach it.

## As built (phase 1, 2026-11-16)

| Piece | Where |
| --- | --- |
| Interface, labels, names, `MachineError` | src/lib/machines/provider.ts (`machineName()` = the container name as a lowercase DNS label, hash kept) |
| Registry of providers | src/lib/machines/providers/index.ts (`registerProvider`, lazy `gce`) |
| Google Cloud | src/lib/machines/providers/gce.ts: exact labels in instance metadata `kunj-labels` (base64url JSON) because GCE label values cannot hold a branch or repo id; GCE labels carry `kunj-<key>` with the value or `h-<sha256>` for filtering; a list re-checks the exact labels. gcloud's "Some requests did not succeed" warning (exit 0, `[]`) is a failure: found by the smoke test, with bad credentials every machine would have looked gone |
| CLI runner | src/lib/machines/cli.ts (`execFile`, missing binary → `provider-cli-missing`) |
| Coordinator | src/lib/machines/coordinator.ts: one `locate` per branch in flight, wake only on `wake`/`create`, pairing and `ready` polls over the private address or a provider tunnel, machine tokens in a file store |
| Routes | src/lib/serve/machines.ts (`machineRoutes()` through `createServeServer`'s `extend`); error codes mapped to HTTP statuses |
| Server | src/lib/serve/server.ts: `authenticate` (named clients, src/lib/serve/token.ts `fileAuthenticator`), `pairing`, `extend`; src/commands/serve.ts: `--machines`, `--idle-exit`, `--allow-pairing`, `--pair-window`, `token add|list|remove` |
| Tunnels | src/lib/serve/tunnel.ts `openCommandTunnel()` (any provider argv) beside `openTunnel()` (ssh) |
| Local coordinator | src/lib/machines/local-coordinator.ts (`ensureLocalCoordinator`, `resolveCoordinator`), src/lib/machines/config.ts (`machineSettings`, `coordinatorPaths`) |
| Client and command | src/lib/machines/client.ts, src/commands/machine.ts (fast path) |
| Settings, JSON | src/settings/machine.ts; `MachineJson`, `MachineListJson`, `MachineJsonResult`, `MachineProvidersJson`, `CoordinatorStatusJson` in json-types.ts |
| Tests | src/lib/machines/__tests__ (conformance for FakeProvider and GceProvider over a simulated gcloud, coordinator, local coordinator), src/lib/serve/__tests__/clients.test.ts, src/commands/__tests__/{machine,serve-machines}.test.ts |

Not yet: the proxy to a machine's serve and `kunj ct` on machines, the idle loop and machine
self-suspend timer (`machine.idleMinutes` is registered but unused), prune, golden images, the cache
volume. A coordinator machine created now boots the stock Ubuntu with nothing on it, so its serve never
answers and `create` ends in `machine-timeout` until the phase 3 recipe (or a hand-made image) puts
`kunj serve --allow-pairing` on it.

## Decisions

- **2026-11-16** A VM per session, not a shared VM: sized at 8 GB it is cheaper below about five
  concurrent sessions, and gives a kernel per agent (research doc). The shared VM remains phase 0 and
  the thing the golden image is baked from.
- **2026-11-16** Provider through the cloud's CLI, not an SDK: nothing heavy joins kunj's dependencies,
  and it is how kunj already treats `gh` and `docker`.
- **2026-11-16** Labels as the only machine state, and no registry file per machine: find by asking the
  provider, as the multi-remote spec finds containers by asking every backend.
- **2026-11-16** **A coordinator (`kunj serve --machines`), not the laptop calling the provider directly.**
  First written as laptop-to-provider; replaced the same day because several clients must connect to one
  fleet. The coordinator gives one address and one token per client, the idle loop and pairing in one
  place, and `kunj serve` with one more role rather than a new server.
- **2026-11-16** **The coordinator runs locally by default, auto-started by kunj**, and moves to a tiny
  cloud VM when more than one client needs it. Same binary, same config keys; machines notice nothing.
  A required always-on VM would have made the one-person case worse than before; a required local
  process would have made the team case impossible.
- **2026-11-16** Token by one-time pairing over an access-controlled path (private network or IAP),
  never by metadata.
- **2026-11-16** Listings never wake a machine; acting commands do, unless `--no-wake`.
- **2026-11-16** Idle is decided from agent state, never from client connections, so an open workspace
  app does not keep a machine awake. The coordinator's loop is primary; machine self-suspend with a
  one-permission credential is the fallback for a local coordinator whose laptop is shut.
- **2026-11-16** Hooks run on the client, where the user's config is; the coordinator runs none.

## Testing

- Unit: lifecycle against `FakeProvider` and `FakeBackend` (create, locate, ambiguous, wake on act,
  no wake on list, idle loop decisions, pairing success and `401` eviction, prune plans); the provider
  conformance suite run by `FakeProvider` and, with argv assertions against a stub `gcloud`, by
  `GceProvider`; the proxy (unary and WebSocket piping, `machine-asleep`, token substitution, per-client
  tokens) against an in-process machine serve on `FakeBackend`; local auto-start (spawn, pid file,
  reuse, idle exit) with a stub `kunj`.
- `npm run test:remote` runs the container suites through a coordinator in front of a machine serve,
  both in-process, so every container feature is exercised through the proxy.
- Opt-in `*.gce.test.ts` (`KUNJ_GCE_PROJECT`, `KUNJ_GCE_ZONE`): a real local coordinator and machine:
  create, pair, start a container, suspend, resume, remove, delete, image build; everything labelled with
  the test repo is deleted afterwards. Minutes and money, like the functional suite.

## Plan

0. By hand: one Ubuntu VM with the recipe, reached through IAP, `kunj remote add --ssh`; proves serve
   over IAP and closes the remote-containers spec's "real second machine" item.
1. `MachineProvider`, `FakeProvider`, `GceProvider`; `kunj serve --machines` with the `/v1/machines`
   routes (no proxy yet), per-client tokens, pairing; local auto-start; `kunj machine
   list|status|suspend|resume|delete|coordinator|providers`.
2. The proxy; `RemoteKunjBackend` with a base path; `selectBackend()` through `locate`; create on
   `start`, wake on act, the idle loop, machines in `ct list` and `kunj events`, remove and prune, hooks,
   JSON additions, docs.
3. Golden image build, `container.caches`, `machine.registry`, `image-stale`, blueprint status,
   machine-side self-suspend timer.
4. `Ec2Provider` (and `SshFleetProvider` if cheap), workspace app rows and a Wake action, the docs page
   "Containers in the cloud".
