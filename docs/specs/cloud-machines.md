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
| Bootstrap script, `machine.image`/`kunjPackage`/`bootstrap`, nonce pairing | Shipped 2026-11-16 (883805e, f3e7e3b, and the tunnel retry in the commit after). Run on `kunj-dev`: `kunj machine create` from stock Ubuntu to a paired machine in 234 s (the script itself 3 min 19 s); suspend 156 s, resume to an answering serve 23 s |
| Phase 1: `MachineProvider`, `FakeProvider`, `GceProvider`; `kunj serve --machines` (routes, per-client tokens, pairing); local auto-start; `kunj machine` | Shipped 2026-11-16 (924d4ae, 8423238, a2856bc); unit-tested, and the local coordinator smoke-tested against the real `gcloud` without a project login. No machine has been created on a real project yet |
| Phase 2: containers through the coordinator (`/v1/machines/<name>/serve/…` proxy), `kunj ct` on machines, wake on act, idle loop | Shipped 2026-11-16 (2ce7433). Run on `kunj-dev` with the local coordinator: `kunj ct start --remote machines` woke the suspended machine and created the container in 363 s (images and snapshot built on the machine); `ct exec` 3 s; `ct exec` on a suspended machine woke it and ran in 20 s; `ct stop` did not wake it. Left: machines in `ct list` and `kunj events`, machine prune, the delete on `ct remove`, hooks. Also run 2026-11-16: `ct shell --session` (tmux session `sh-t1` on the machine, woke it in 33 s) and `ct agent` (Claude Code started in the container; its first try, soon after the wake, could not reach Anthropic for 10 s, the second did) through the proxy, and the idle loop with `machine.idleMinutes` 2 suspended the machine by itself 3 minutes after the last use |
| Phase 3: golden image build, `container.caches`, registry copy | Golden image shipped 2026-11-16 (`kunj machine image build|list|delete`, new machines boot the newest). Run on `kunj-dev`: bake 470 s; a branch's first `ct start` on a new machine from the image 160 s, against 597 s without. `container.caches` and the cache store (`machine.cache`, a bucket per coordinator, `kunj ct cache`) shipped. Left: the blueprint hash on the image and `image-stale`, registry copy |
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
| `/v1/machines/<name>/serve/v1/<any serve route>` | Proxy to the machine's serve, WebSockets included; `machine-asleep` when it is not running |
| `GET /v1/machines/images`, `POST /v1/machines/images/build`, `DELETE …` | Golden images |
| `GET /v1/info` | Adds `features.machines: true`, the provider name, its features and `network` |

**Pairing a machine's token.** The golden image carries no token. On first boot a machine's serve
accepts, for `machine.pairWindowMinutes` (default 10), one `POST /v1/pair` and returns a fresh token;
every other route is `401` until then. The call carries a nonce (16 to 128 characters) and a repeat with the same nonce inside the window gets the same token, so a reply lost on the way does not strand the machine; any other caller gets `403`. The coordinator sends one nonce per pairing attempt, right after `create`, over the private
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

## Bootstrap

A new machine becomes a kunj machine by a startup script the coordinator gives the provider at create
(src/lib/machines/bootstrap.ts; GCE: the `startup-script` metadata, passed with `--metadata-from-file`
from a temp file removed afterwards). It runs as root at every boot and is idempotent: Docker from
get.docker.com, Node 22, git and tmux when missing; a `kunj` user in the `docker` group;
`machine.kunjPackage` installed when `/etc/kunj-package` names another one (`kunj@<version>` from npm, or
`github:<owner>/<repo>#<ref>` cloned, built and packed on the machine; empty means this kunj's version,
and `main` from GitHub for a development build); then the unit `kunj-serve.service`: `kunj serve --listen
<internal-ip>:7433 --allow-remote-listen --allow-pairing --pair-window <minutes>` as that user. Log:
`/var/log/kunj-bootstrap.log`. The script is in the instance's metadata, readable by project viewers, and
carries no secret; the package value is checked against a pattern with no quotes or spaces before it is
written into it. From stock Ubuntu the script takes a few minutes, inside `machine.bootTimeoutMs`; with
`machine.image` naming an image that already has everything it only rewrites the unit, which is what the
golden image of phase 3 automates. `machine.bootstrap: false` gives no script, for an image that starts
serve by itself.

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

**As built (2026-11-16)**, src/lib/container/caches.ts and `startContainer`: the volume is
`kunj-<repo>-cache-<name>-<hash of the repo id>`, labelled `kunj.repo`, `kunj.role=cache`,
`kunj.cache=<name>` and no branch, so prune's orphan search never sees it and `ct remove` never names it
(nothing in kunj deletes one yet, not even `prune --force`: `docker volume rm` does). It is mounted in
every **new** branch container (an existing one keeps its mounts until `--rebuild`) and in the blueprint
snapshot build, so `setup` can fill it; the snapshot image itself holds none of it. On cloud machines the
snapshot is built on the image builder, whose disk becomes the golden image, so a cache `setup` filled
there is on every new machine. After READY the mount points are chowned to the sandbox user. Names are
`[a-z0-9-]`, paths absolute, without `..`, `:` or `,`, and never the workspace or a system directory
(`bad-config`, checked before anything is created). A cache volume is not in a failed start's rollback:
another start may be using it. Every branch can write to it, so its contents are only as trusted as the
branches. On a cloud machine the cache volume is on that machine's disk: what a session adds to it stays
on that machine and goes when `ct remove` deletes the machine. What every machine shares is what the
golden image carried, so without a cache store a shared cache is refreshed by baking a new image.

### The cache store (as built 2026-11-17)

The image alone makes the cache a snapshot: filled at bake time, copied to each machine, never updated
between machines. A coordinator can therefore keep the caches in a store outside its machines.

- **Per coordinator.** `machine.cache` in the config of the machine that runs `kunj serve --machines`
  (the global config for the local coordinator): `{ "bucket": "<name>", "prefix": "<folder>" }`. Each
  remote has its own; unset or `{ "store": "none" }` means the image only. Checked when the coordinator
  starts (`cacheStoreConfig()`, `bad-machine-config`); `store` is the seam for other kinds (a network
  folder) later.
- **Pluggable.** `MachineProvider.cacheSync(config)` returns a `CacheSync`: the sync image
  (`rclone/rclone`, pinned), the environment that selects the machine's own cloud credential and the
  rclone remote of the store's root. GCE: a Cloud Storage bucket, `RCLONE_GCS_ENV_AUTH`, and new machines
  run as `machine.gce.serviceAccount` (required, Storage Object Admin on the bucket only). No secret
  travels: the credential is the machine's, from the metadata service, which a branch container's
  firewall blocks.
- **Client driven.** The coordinator hands the `CacheSync` out in `GET /v1/machines/providers` (`cache`);
  `selectBackend()` exposes it as `machine.cacheSync()`, asked only when the repository has caches.
  `syncCaches()` (caches.ts) runs one container on the machine through the ordinary backend
  (`kunj.role=cache-sync`, only the cache volumes mounted at `/caches/<name>`, default bridge, no
  capabilities), execs `rclone sync` per cache and removes it. Each cache lives at
  `<store>/<volume name>/`, so repositories never collide.
- **Pull** makes the volume equal to the store; it runs in `startContainer` for a new container (and the
  snapshot build) after the volumes exist and before the branch container, so `setup` and `maintain` see
  it, and then the cache is chowned recursively. A store nothing was pushed to (`rclone lsf` empty or
  exit 3, with the store's own root listing) leaves the volume as the image made it; a store that cannot
  be listed is a failure. What a pull wrote is handed to the owner of the cache's top directory. A failed pull is a warning, never a failed start.
- **Push** makes the store equal to the volume: `kunj ct cache push [branch]`, never automatic, so the
  newest push wins and it is always a person's choice. An empty cache is not pushed without `--force`
  (a machine whose pull failed would otherwise empty the store for everyone). `kunj ct cache pull` repeats the pull by hand;
  `kunj ct cache status` lists the caches and the store (`ContainerCacheJson`, `ContainerCacheSyncJson`).
- **What survives the store:** file contents, times and symlinks (`--links`). An object store keeps no
  modes, so the names of executable files travel beside the data (`<volume>.exec`) and get their bit
  back; other mode bits and ownership do not survive (everything is the sandbox user's after a pull).

Run on `kunj-dev` (bucket `kunj-dev-kunj-cache`, us-central1): push of a small cache 4 s; a machine
deleted and made again from the golden image had the pushed files, the symlink and the executable bit
before `setup` ran; a manual pull removed a local-only file and restored a changed one.

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
| `machine.image` | Coordinator's host | `""` | A machine image new machines boot instead of the stock Ubuntu |
| `machine.kunjPackage` | Coordinator's host | `""` | What the bootstrap installs: `kunj@<version>` or `github:<owner>/<repo>#<ref>` |
| `machine.bootstrap` | Coordinator's host | `true` | Give new machines the startup script |
| `machine.registry` | Coordinator's host | `""` | A registry for snapshot pushes and pulls; empty means the golden image alone |
| `machine.gce.project`, `.zone`, `.network`, `.subnet`, `.serviceAccount`, `.machineTypes`, `.baseImage` | Coordinator's host | — | Provider config; `machine.<provider>.*` for each |
| `container.remote` | Client | — | Names a cloud coordinator; absent with `machine.provider` set means the local one |
| `container.caches` | Client | `[]` | `{ name, path }` list, above |
| `machine.cache` | Coordinator | `{}` | The cache store: `{ bucket, prefix? }`, above |

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

Added 2026-11-16 after phase 0 and the reviews: the bootstrap script, `machine.image`,
`machine.kunjPackage`, `machine.bootstrap`, pairing repeatable by nonce, a live machine's token kept when a
create is refused, and `Coordinator.poll()`: the endpoint is opened inside the retry loop, because the
first real create failed on a tunnel opened before the machine's port was listening (gcloud tests the
port and exits). `machine.bootTimeoutMs` defaults to 10 minutes.

### Phase 2 as built (2026-11-16)

| Piece | Where |
| --- | --- |
| Proxy | src/lib/serve/proxy.ts: `/v1/machines/<name>/serve/v1/<route>` goes to that machine's serve as `/v1/<route>`; http piped with the hop-by-hop and authorization headers dropped and the machine's token set; an upgrade is passed as raw bytes over a TCP connection (frames are never parsed). The path has `serve/` in it so it cannot collide with `/v1/machines/<name>/suspend` and friends. Registered through `ServeExtension.proxy()`; streams.ts asks it before its own WebSocket routes |
| Shared endpoint | `Coordinator.proxyTarget()`: one endpoint (an IAP tunnel, from a laptop) per machine, opened by the first request, shared, closed a minute after the last. A failed connection retires it for new requests, by identity, and it is released when its last user is done, so one bad request never closes a tunnel another stream is on; `machine-asleep` when the provider says the machine is not running; dropped on suspend, stop and delete |
| Client | `RemoteKunjBackend` `basePath`; `selectBackend()` with `machine: { repo, repoName, branch, wake, create, size }`: a remote whose `/v1/info` has `machines` is a coordinator, the branch's machine is located and the backend rooted at its path. `--remote machines` / `container.remote=machines` is this machine's own coordinator (`LOCAL_MACHINES`); `local` and `machines` cannot name a remote |
| Intent | `ContainerCommand.intentOf()` (src/commands/container.ts): `start` creates and wakes; `shell`, `exec`, `agent`, `attach`, `open`, `mcp`, `logs`, `forward`, `file`, `remove` wake; `stop` does not; `list`, `prune`, `blueprint`, `token` have no branch and are refused on a coordinator for now. `ct start --size` |
| Idle loop | `Coordinator.idleTick()` every minute in `kunj serve --machines`, asking each awake machine through src/lib/machines/idle.ts (`STATUS_SCRIPT` over the machine's serve): suspended after `machine.idleMinutes` with no proxied request, no open stream and no agent in the `running` state; a machine whose serve cannot be asked is not thereby busy, so one nobody reached for the whole spell is suspended rather than left billing. The loop's own question does not count as use. `--idle-exit` does not end a coordinator while a proxy is open or a machine is awake |
| Tests | src/lib/machines/__tests__/proxy.test.ts: a coordinator serve in front of a machine serve, both in process (unary, WebSocket exec, streamed upload, one shared tunnel, tokens never crossing, wake rules, idle rules) |

`kunj ct remove` on a machine deletes the machine too once the container is gone (the selection carries
`machine.delete()`); with `--keep-volumes` the machine stays, since the volumes are on its disk; a failed
delete is a warning naming `kunj machine delete`.

Not yet: machines in `ct list`/`kunj events`/the apps, machine prune, the
machine hooks, the self-suspend timer on the machine (so with a local coordinator a machine sleeps only
while that coordinator runs, which `--idle-exit` now waits for), the cache volume.

## Golden image as built (2026-11-16)

Simpler than the design above, and enough to take the install out of every new machine:

| Piece | How it is built |
| --- | --- |
| `kunj machine image build [--no-snapshot] [--size s]` | src/commands/machine.ts. (1) `locate` with `create` for the reserved branch `kunj..image-build` (`IMAGE_BUILD_BRANCH`; `..` cannot be in a real branch name), which gives a builder machine from the provider's **stock** image, never from an older golden image. (2) Unless `--no-snapshot`, it runs this kunj's own `ct blueprint snapshot --remote <coordinator> --machine kunj..image-build` as a child (output on stderr), which builds `kunj-sandbox`, `kunj-nethelper` and the blueprint snapshot in the builder's Docker. (3) `POST /v1/machines/<builder>/image`. (4) The builder is deleted, also when a step failed or the command got SIGINT/SIGTERM; while a builder exists (another build, or an interrupted one) a build is refused with `machine-exists` and the delete command, so a disk in an unknown state is never baked and a live build is never cut off. A failed snapshot makes no image |
| `Coordinator.bake()` | Refuses any machine but a builder (`kunj.branch` = `kunj..image-build`): a branch's machine has that branch's containers and their env on its disk. Stops the machine, waits for `stopped`, `provider.images.createFrom()` as `<machine name without hash>-img-<UTC yyyymmddhhmmss>` with labels `kunj.repo`, `kunj.role=machine-image`, `kunj.version` (and `kunj.blueprint` when the client sends a hash; the command does not yet), then deletes the repository's older images |
| Booting from it | `Coordinator.create()` picks `machine.image` when set, else the repository's newest golden image, else the stock image; the name is in the machine's `kunj.image` label. A failed image listing means the stock image, not a failed create |
| Pairing from an image | The image holds the builder's serve token. The bootstrap script writes the machine's hostname to `/etc/kunj-machine`; on a machine with another name it stops the unit and deletes `~kunj/.kunj/serve/token` before starting serve, so the new machine pairs like a first boot. The rest of the script finds everything installed and only rewrites the unit |
| `kunj machine image [list]`, `image delete <name>` | `GET /v1/machines/images?repo=`, `DELETE /v1/machines/images/<name>` (only images with kunj's role label) |
| `ct blueprint snapshot --machine <branch>` | On a coordinator a snapshot is built on one machine: the current branch's, or `--machine`'s (created when missing) |

Not yet: the `kunj.blueprint` hash on the image and the `image-stale` warning, Sysbox in the image,
`machine.registry`, images in `kunj ct blueprint status`, a size other than the default for the builder's disk.

Run on `kunj-dev` (2026-11-16, e2-standard-2): `kunj machine image build` took 470 s (builder up and
paired 152 s, snapshot about 230 s, stop and bake about 75 s; the image is 30 GB, 3.4 GB stored). Then
`kunj ct start` for a branch with no machine took 160 s: the machine was created from the image and
paired in 92 s, and the container started from the snapshot already on its disk in about 68 s, with no
install and no image build. Without the image the same took 234 s + 363 s. `container.caches` was set for
the run: `/cache/db` was mounted, owned by the sandbox user and writable, with `KUNJ_CACHE_DIR` set.
Before that, `kunj ct remove` deleted the old container and its machine in 61 s.

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
