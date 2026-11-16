# Branch containers on Google Cloud: options

Research into where kunj's branch containers (`kunj ct`, [container-system.md](container-system.md))
can run on Google Cloud, so a laptop drives them with `kunj ct … --remote <name>` as
[remote-containers.md](remote-containers.md) already allows. Written 2026-11-16 from the Google Cloud
documentation as search engines index it, the Sysbox and gVisor project pages and third-party pricing
pages; Google's own docs host (`docs.cloud.google.com`) could not be fetched from the session that wrote
this, so every price and product limit below is marked as needing a check against the live page before
anything is built.

## Status

| Part | State |
| --- | --- |
| Research and recommendation | Written 2026-11-16 |
| Recipe tried on a real Compute Engine VM | Not started (waiting on you: a project and a VM) |
| `kunj serve --idle-after`, remote `wake`, `kunj remote add --gce` (below, "On demand" and "What kunj would need") | Not started; optional |
| User docs page (docs-site: Containers › On a cloud VM) | Not started |

## What the containers need from a host

These are the facts that decide the options. All of them come from the shipped code, not from a wish list.

- **A real Docker daemon**, driven by `docker` argv from `LocalDockerBackend` (the only module that
  spawns Docker). Used features: `run` with named volumes and user networks, `--network container:<id>`
  (the network helper shares the main container's network namespace), `--cap-drop ALL` plus
  `--cap-add NET_ADMIN,NET_RAW` on the helper, `build -` from a tar on stdin, `commit` (blueprint
  snapshots), `exec` with a TTY through the Engine API socket (`shell`, `attach`, `agent`), `events`,
  `cp`-style tar streaming, `docker compose config` (the compose plugin), and optionally
  `--runtime sysbox-runc` or `--privileged` for Docker-in-Docker.
- **The host kernel's netfilter.** The firewall (`firewall.sh`) is iptables, ip6tables and ipset inside
  the helper. A sandboxed runtime with its own network stack (gVisor's netstack) only partly implements
  iptables, has no ipset and no `nat` table, so the helper would fail before READY and nothing would
  start. Branch containers must run under `runc` (or sysbox) on a Linux kernel; the isolation boundary
  around the agent is then the machine the daemon runs on.
- **Persistent Docker state.** Labels on Docker objects are the only container state, the home
  directory is a volume, snapshots are images. Whatever stops and starts the host must keep
  `/var/lib/docker`.
- **`kunj serve` next to the daemon**: a Node process with the daemon socket, listening on loopback,
  reached from the laptop by an SSH tunnel kunj opens (`kunj remote add <name> --ssh <destination>`)
  or by a URL (`https://` anywhere; `http://` only to loopback, or `--allow-insecure-http` on an
  already-encrypted network). The laptop keeps the vault, keep files, blueprints and hooks; the box
  stores only Docker labels and `~/.kunj/serve/token`.
- **Egress from the containers** to origin, `api.anthropic.com`, `registry.npmjs.org` and whatever
  `container.network.allow` names. The firewall already rejects link-local `169.254/16`, so a container
  on a Google VM cannot reach the metadata server (`169.254.169.254`) unless `container.network.allowHost`
  is turned on; keep it off there.

## Options

### A. Compute Engine VM running Docker and `kunj serve` (recommended)

One Linux VM is the shape `kunj serve` was designed for ("a cloud VM" is in the first sentence of its
spec), and nothing in kunj changes.

- **Image:** Ubuntu 24.04 LTS (kernel 6.8). Docker CE from Docker's apt repository (engine, CLI,
  compose plugin), Node 20+, `npm i -g kunj`, a systemd unit for `kunj serve` as an unprivileged user in
  the `docker` group. Debian 12 works the same way. Container-Optimized OS is not a good fit: its root
  is read-only with no package manager, so kunj would itself have to run as a container with the daemon
  socket mounted, and it cannot take Sysbox.
- **Docker-in-Docker:** Sysbox is still open source, community-supported since Docker folded the
  enterprise edition into Docker Desktop's Enhanced Container Isolation; its compatibility page lists
  Ubuntu 24.04 (kernel 6.8+) and needs no shiftfs on kernels 5.19 and later, so a stock Ubuntu 24.04 VM
  takes it. Start the server with `--allow-runtime sysbox-runc` and set `container.dockerInDocker:
  sysbox` in the repository that needs it. `privileged` (`--allow-privileged`) is also reasonable on a VM
  that holds nothing but kunj's Docker, because an escape then reaches only that VM; the Docker Desktop
  refusal in `dind.ts` does not apply (the daemon's `operatingSystem` is Ubuntu).
- **Network:** no external IP. Egress through a Cloud NAT gateway on the VM's subnet (the containers
  need origin, npm and Anthropic). Inbound only through Identity-Aware Proxy TCP forwarding: a VPC
  firewall rule allowing `35.235.240.0/20` to port 22, and the `roles/iap.tunnelResourceAccessor` role
  for the user. No port is open to the internet, and the `kunj serve` token stays a second factor behind
  Google's IAM.
- **Reaching the server, three ways, all with today's kunj:**
  1. **SSH through IAP, kunj's own tunnel.** An `~/.ssh/config` entry
     ```
     Host kunj-gce
       HostName <instance>
       User <os-login-user>
       ProxyCommand gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --zone <zone> --project <project>
     ```
     and `kunj remote add gce --ssh kunj-gce`. `tunnel.ts` runs `ssh -N -L … kunj-gce`, ssh runs the
     ProxyCommand, and the tunnel lives and dies with the kunj process as it does for any `--ssh` remote.
     This is the recommended form: no extra daemon on the laptop, nothing to keep running.
  2. **IAP tunnel to the serve port, URL remote.** `gcloud compute start-iap-tunnel <instance> 7433
     --local-host-port=localhost:7433` in a terminal (or a launchd agent) and `kunj remote add gce --url
     http://127.0.0.1:7433`, which `checkRemoteUrl()` accepts because the address is loopback. Simpler
     to explain, but the tunnel is the user's to keep alive, and `kunj events` and the workspace app
     report the remote down whenever it is not.
  3. **Tailscale (or WireGuard) on the VM.** `kunj serve --listen <tailnet-ip>:7433 --allow-remote-listen`
     and `kunj remote add gce --url http://<tailnet-ip>:7433 --allow-insecure-http`. No IAP, no SSH; the
     tailnet is the encryption. Good when a tailnet already exists.
- **Stopping when idle is where the money is.** A stopped VM costs only its disk. Options, cheapest
  first: a Compute Engine instance schedule (stop at night, start in the morning; one schedule per VM,
  about a 15-minute window); a small cron on the VM that powers it off after N minutes with no
  `kunj serve` connection and no running main container; Google's idle-VM recommendations (they only
  advise). Starting it again is `gcloud compute instances start` (the ssh ProxyCommand has no
  auto-start; see "What kunj would need"). Containers survive a stop as stopped containers; `kunj ct
  start` resumes them, and the `kunj serve` unit comes back with the VM.
- **Spot VM:** 60–70% cheaper, but Google can stop it at any time with 30 seconds' notice. An agent
  mid-task loses its tmux session (the files are on the volume; a resumed container starts the agent
  afresh with `--resume`). Fine for a personal box used in bursts, wrong for a long unattended run.
- **Service account:** give the VM a dedicated service account with no roles and no scopes. The firewall
  blocks the metadata server from containers anyway, but `kunj serve` itself and a shell on the VM
  should not be able to mint tokens either.
- **Backups:** a persistent-disk snapshot schedule on the data disk covers `/var/lib/docker` (home
  volumes, snapshots). Nothing of the user's repositories lives there that is not also on origin.

Verdict: do this first. The recipe above is a user-docs page and an afternoon; the spec's own open item
("try an `--ssh` remote against a real second machine") gets answered on the way.

### B. Cloud Workstations

A managed per-developer VM running a container image, with a persistent home disk, an idle timeout that
stops it, IAM-gated access and `gcloud workstations start-tcp-tunnel <workstation> 7433` (with
`--start-workstation` to wake a stopped one), which would carry `kunj serve`'s port straight to the
laptop as a loopback URL remote.

Why it still does not fit kunj:

- **Docker inside is a workaround, not a feature.** Third-party write-ups say the predefined images get
  Docker by mounting the workstation VM's Docker socket or by running the workstation container
  privileged; neither is documented as supported, and a security write-up describes the socket as a
  container-breakout path. (Not verified against Google's docs in this session.) Either way kunj would
  be a process in one container talking to a daemon it shares with the IDE container; the main
  container, its helper and sidecars would then be siblings of the workstation itself.
- **Docker state is not where the persistence is.** Only the configured home directory persists across
  a stop; the VM's boot disk, where `/var/lib/docker` lives, does not. Every idle stop would lose
  every branch container, image and snapshot unless the daemon's data root is moved under the home
  disk, and that is the shared daemon's configuration, not kunj's to set.
- **Cost.** The management fee is $0.05 per vCPU-hour while running, plus $0.20 per hour per cluster
  whether or not anything runs (about $146 a month on its own), plus the VM and disk. For one person
  that is more than option A's whole bill.
- **Nested virtualization** (N1/N2 only) is for running VMs inside the workstation; it does not change
  the Docker picture.

Verdict: only if a team already runs Workstations and wants kunj on them; then option A's recipe applies
inside the workstation image with the data-root caveat above. Not recommended as the first target.

### C. Google Kubernetes Engine with a Kubernetes backend

GKE is the right host for a fleet (many developers, many branches, autoscaling nodes), and a pod is a
natural fit for kunj's main+helper pair: containers in a pod share a network namespace, so the helper
sidecar with `NET_ADMIN` and `NET_RAW` filters the main container's traffic exactly as it does under
Docker; a PersistentVolumeClaim is the home volume; `exec`/`attach` with a TTY exist in the API;
labels and annotations carry kunj's state. Autopilot drops `NET_ADMIN` unless the cluster is created or
updated with `--workload-policies=allow-net-admin` (GKE 1.27+) and never allows privileged pods, so
Docker-in-Docker would need GKE Standard.

What it costs in engineering:

- A new `ContainerBackend` against the Kubernetes API (the size of `docker.ts` plus `remote.ts`), and
  the laptop holds cluster credentials, so the "thin server, one token" model of `kunj serve` changes.
- **No `commit` and no `build` on a node.** GKE nodes run containerd; there is no `docker commit`, so
  blueprint snapshots need another design (BuildKit or kaniko in a job, or a Cloud Build step, pushing
  to Artifact Registry) and `buildImage` for kunj's own sandbox and helper images needs one too.
- `composeConfig()` has to run somewhere; the snapshot's "copy `/workspace` to `/opt/kunj/seed` and
  commit" step disappears with `commit`.
- Cost: Autopilot bills per pod vCPU/memory (no idle-node waste, but a sleeping branch still has to be
  scaled to zero by kunj, i.e. the deployment deleted and the PVC kept); Standard bills nodes plus the
  cluster fee after the free tier.

Verdict: the second step, not the first. Keep it in the roadmap for a team-scale fleet; the
[multi-remote spec](multi-remote-containers.md) already lets several backends coexist, so a GKE backend
would join the fleet rather than replace the VM. Running `dockerd` itself in a privileged pod with
`kunj serve` beside it is possible on Standard but is option A with more layers.

### D. Cloud Run

Ruled out. Cloud Run gives no privileged mode, no added capabilities, no Docker daemon, no persistent
disk and a request-driven lifecycle; its first-generation sandbox is gVisor and the second a microVM,
but neither can host `dockerd` or kunj's helper. Multi-container services do share a network namespace,
which would suit the helper, but the helper cannot load iptables there. Cloud Run Jobs are batch, not
interactive.

### E. One VM per branch

Rejected. kunj's model is one daemon with labels as the state and names derived from the branch; a VM per
branch would need a new backend, Docker-less seeding and its own lifecycle, and the per-VM minimum
(boot disk, start time) is worse than containers on a shared VM in every way that matters here.

### Zero-code experiment: a Docker context over SSH

`docker context create gce --docker host=ssh://kunj-gce` with the IAP ProxyCommand above, then
`container.dockerContext: gce`, runs every `kunj ct` command against the VM's daemon with no server at
all. The remote-containers spec lists this as the validation step that was never done. It is slow (an
SSH connection per `docker` call, a dozen per `ct list`) and the apps cannot describe it, so it is a
one-hour check of the VM recipe, not the way to use it.

## Is there a managed Docker daemon on Google Cloud?

No. Asked directly ("some type of Docker in Google"), the answer is that Google sells no hosted Docker
*daemon*. What exists, and why each is or is not the answer:

- **Container-Optimized OS** is the closest thing: a Compute Engine image with Docker, containerd and
  cloud-init preinstalled, auto-updating weekly, and a VM created with a container to run at boot. It is
  "Docker in Google" in the literal sense, but its root filesystem is read-only with no package manager,
  so kunj and Node cannot be installed on it; `kunj serve` would run as a container with the daemon socket
  mounted, and Sysbox cannot be added. Option A on Ubuntu is the same VM with those two restrictions lifted.
- **Cloud Build** runs `docker build` (and arbitrary build steps) in a managed daemon per build, then
  exits. Batch only: no long-lived containers, no exec, no state. Not a host for branch containers.
- **Artifact Registry** stores images. Useful later for a GKE backend's snapshots, not a runtime.
- **Cloud Run and GKE** run containers but not Docker: Cloud Run has no daemon at all and GKE nodes run
  containerd (see options C and D).
- **Docker Offload**, Docker's own hosted engine, is the one real "Docker daemon as a service" on the
  market: `docker` on the laptop talks to a cloud engine (Docker's infrastructure, not the user's Google
  project), pay-as-you-go by size (from about $0.07 per hour for 1 vCPU/2 GB to about $1.12 for 16
  vCPU/32 GB on Docker's page), and it needs a Docker Business subscription and Docker Desktop. It does
  not fit kunj: a session is ephemeral, and once idle past the timeout (5 minutes per the newest
  write-ups) the containers, images and volumes are deleted, which destroys kunj's labels-as-state,
  home volumes and snapshots; one session per user; and whether `--cap-add`, `--network container:` and
  `commit` are allowed there is undocumented. It also runs in a US East region outside the user's cloud
  account. Good for offloading one build; wrong for containers that live for the life of a branch.

So on Google Cloud, "Docker" means a VM with a daemon on it, and the choice is only which OS image
(Ubuntu for Sysbox and `kunj serve` as a plain process; COS if an auto-updating appliance matters more
than Docker-in-Docker).

## On demand: suspend when idle, wake from the laptop

The VM should cost nothing while no agent works, without the user remembering to stop it.

**Suspend, not stop.** Compute Engine can suspend an instance (memory written to persistent storage,
no vCPU or memory charge while suspended; the saved memory is billed as standard persistent disk, a few
dollars a month for 64 GB). Resume takes seconds and brings back everything as it was: running
containers, the agents' tmux sessions, a Claude run mid-task. A stop would lose the tmux sessions and
needs a boot plus `docker start` on the way back. Limits: at most 208 GB of memory, no GPUs, the
guest must support it (Ubuntu does), 60 days at most before Google turns it into a stopped instance
(harmless). A Spot VM can be suspended but a preemption during the suspend wins; stop is the fallback.

**Idle is decided on the VM, by what the agents do, not by whether a laptop is connected.** The
workspace app holds a `kunj events` WebSocket open all day and `ct list` polls, so connections are
the wrong signal. The right one is the agent state `kunj serve` already serves: idle = for N minutes
no exec with a TTY has been open and no main container's agent is `running` (`waiting` for input and
stopped containers count as idle; the tmux session survives the suspend anyway). Two ways to get it:

1. **Today, no kunj change:** a systemd timer on the VM, every minute, runs `docker ps` for
   `kunj.role=main` and the `STATUS_SCRIPT` check for agent states (or, cruder, `docker stats` CPU
   below a threshold for N minutes) and, when idle, `gcloud compute instances suspend $(hostname)`.
   The VM's service account needs only a custom role with `compute.instances.suspend` and
   `compute.instances.get`, bound with an IAM condition to that one instance; nothing else.
2. **Proposed kunj feature:** `kunj serve --idle-after <minutes> --idle-command '<cmd>'`. The server
   counts open TTY execs and polls agent states (one `STATUS_SCRIPT` exec per running main, as `kunj
   events` does), runs the command once when idle, and logs it. One place, exact, testable with the
   fake backend.

**Wake from the laptop.** The user should never run `gcloud compute instances resume` by hand.

1. **Today, no kunj change:** make the ssh ProxyCommand a script: if the instance is not `RUNNING`,
   `gcloud compute instances resume` (or `start` when it is `TERMINATED`), wait for `RUNNING`, then
   `exec gcloud compute start-iap-tunnel … --listen-on-stdin`. `tunnel.ts` waits up to 120 s for the
   forward, which covers a resume (seconds) and a boot (under a minute). Downside: every `ct list`,
   `worktree list --containers` and `kunj events` start-up wakes the VM, so a workspace app left open
   in the morning wakes it at once; acceptable for one person, wrong for a fleet.
2. **Proposed kunj feature:** a `wake` command on the remote entry (`kunj remote add gce --ssh kunj-gce
   --wake 'gcloud compute instances resume … --zone …'`). Listings and `kunj events` never wake:
   a tunnel that fails to come up is reported as `sleeping` in `ct list --json`'s `backend` (and
   the app shows the environment asleep, with a Wake action). Commands that act (`start`, `shell`,
   `agent`, `attach`, `exec`, `forward`, `file write`) run the wake command once, then retry;
   `--no-wake` opts out. `kunj remote add gce --gce <instance> --zone <zone>` would write the ssh
   config stanza, the entry and the wake command together.

**Backstop:** an instance schedule that stops the VM at night whatever the timer says, and a budget
alert on the project. Together: resume on the first `kunj ct start` of the day in a few seconds,
suspend after 30 idle minutes, pay for agent hours plus disk.

## One shared VM or many small ones?

Shared, until a reason not to appears. The comparison in kunj's terms:

| | One shared VM (e.g. e2-highmem-8) | One small VM per branch (e.g. e2-standard-2 each) |
| --- | --- | --- |
| Fits today's kunj | Yes: one daemon, labels as state, one `kunj serve`, one remote entry | No: kunj has no VM-per-branch backend; it needs the multi-remote fleet plus an orchestrator that creates and deletes VMs and remote entries |
| Blueprint snapshots | Built once per hash, every new branch starts from it in seconds | Built on every VM: each new branch pays the tools + `setup` run (minutes) or needs snapshots pushed to Artifact Registry (new work) |
| Image layer cache, `kunj-sandbox` build | Once | Per VM |
| Idle branches | Stopped containers, free | A stopped VM each, with its disk (a few dollars a month each) |
| Cost with several agents active at once | Fixed: about $0.36 per hour whatever the branch count, while running | Linear: about $0.07 per hour per active branch; cheaper below about five concurrent, dearer above |
| Isolation between branches | Shared kernel; an escape reaches sibling branches (not the laptop) | VM boundary per branch |
| Noisy neighbours | Several npm installs contend for CPU and memory; an OOM can hit another branch's agent | None |
| On demand | One suspend/resume | One per branch; resume latency on each first command |
| Scaling | One box; beyond it, several shared VMs through the multi-remote spec | Natural |

### Revised 2026-11-16: an instance per session at 8 GB

Sized per session, the small VMs are small: one agent plus one service container fits an
e2-standard-2 (2 vCPU, 8 GB, about $0.067 per hour); a light repository with no services fits an
e2-medium (4 GB, about $0.034 per hour); Docker-in-Docker or a big monorepo wants an e2-standard-4
(16 GB). 4 GB is tight once `tsc` or parallel Jest workers run next to the agent (each a gigabyte or
more), so 8 GB is the default size.

That changes the cost column: three sessions active at once cost about $0.20 per hour against the
shared box's $0.36, and the break-even is about five concurrent 8 GB sessions. Over a month of three
sessions, six hours a day, both land near $50 (shared: the VM for the hours it runs plus one disk;
per-session: session-hours plus one small disk per branch, about $2 a month each for 20 GB, so
branches must be deleted when merged or the disks add up).

What per-session instances buy: a kernel per agent (an escape reaches that branch only), no
contention between builds, and VMs sized to the work. What they cost: a first command that resumes or
boots a VM instead of finding a warm container, and the orchestration below.

**What kunj would need for an instance per session** (a project, not a recipe):

- A **Compute Engine provider** above the backends: `kunj ct start` for a branch with no VM creates
  one named like its container (`kunj-<repo>-<branch>-<hash>`), with GCE labels `kunj.repo`,
  `kunj.branch`, `kunj.version` as the state (the same rule as Docker labels); `ct list` is one
  `instances list` by label plus a `kunj serve` listing per running VM (suspended ones are reported
  from the GCE state without waking them); `ct stop` suspends, `ct remove` deletes the VM and its
  disk, `ct prune` deletes VMs of branches gone from origin. Each VM is reached as a dynamic `--ssh`
  remote through IAP (instance name, zone), so no `remotes.json` entries are kept per branch.
- A **golden image**: the shared-VM recipe (Ubuntu, Docker, Sysbox, `kunj serve`, the `kunj-sandbox`
  and helper images, the repository's blueprint snapshot pre-pulled) baked into a custom Compute
  Engine image with `gcloud compute images create`, rebuilt when the blueprint hash changes. New VMs
  then boot ready in under a minute. Without it every VM would build the sandbox image and the
  blueprint snapshot itself (minutes). An alternative is pushing snapshots to Artifact Registry and
  pulling on first start; the golden image is simpler and also caches the base images.
- Per-VM on-demand as described above (suspend on idle, wake on an acting command), already per
  session by construction.

**Verdict, revised:** the shared VM is still step one, because it is the same recipe and takes a
day, and it validates `kunj serve` over IAP. An instance per session is the target design when
isolation between branches matters or more than a handful of agents run: the shared recipe becomes
the golden image, and the Compute Engine provider instantiates it per branch.

## Caching across per-session instances

One shared daemon shares its image layers and blueprint snapshot for free; separate VMs do not. A
shared filesystem is the obvious fix and the wrong one in most cases:

- **`/var/lib/docker` cannot be shared.** overlay2 needs a local filesystem and one daemon per data
  root; two daemons on one directory corrupt it. Images, layers and snapshots are shared by a
  **registry or a golden image**, never by a mount.
- **Filestore** (managed NFS) starts at 1 TiB and about $200 a month, more than all the VMs together.
  A small NFS VM is cheaper but is one more machine to run, and kunj's server only accepts named
  volumes (the `Guard`), so NFS would have to arrive as a `local`-driver volume with NFS options, a
  small backend change. pnpm's store needs hardlinks on the same filesystem as `node_modules`, so it
  gains nothing from NFS; npm's cache tolerates it; `.git` objects should never be on it.

What to share instead, cheapest first:

| Need | Share it as |
| --- | --- |
| Base images (`kunj-sandbox`, helper, Postgres, Redis) and the blueprint snapshot | The golden Compute Engine image (pre-pulled), rebuilt when the blueprint hash changes; or Artifact Registry in the same region (no egress charge) with `ensureSnapshot()` pulling `kunj-blueprint-<repo>:<hash>` before building |
| npm, pip, Go, Maven downloads | **Artifact Registry remote repositories**: pull-through caches for npmjs, PyPI, Maven Central and Docker Hub, one hostname (`<region>-npm.pkg.dev`) that the firewall allowlist admits, no shared mount, no locking. The snapshot's `setup` sets the registry in the sandbox |
| Warm `node_modules`, built artefacts | Already in the blueprint snapshot's `/workspace` (`setup` runs `npm install`); per-session VMs get it from the golden image |
| A seeded database | Per branch, not shared: a service volume seeded in the golden image's **data disk snapshot** (a new VM's disk is created from the snapshot, restore is lazy, so Postgres starts on a seeded data directory in seconds); or one small Cloud SQL instance with a `TEMPLATE` database and `CREATE DATABASE <branch> TEMPLATE seed` per branch, reached through an allowlisted address |
| Agent state (`~/.claude`, work logs) | Stays on the laptop, as now |

A shared database *instance* across branches is usually wrong anyway: branches carry different
migrations. A template database or a seeded disk snapshot gives each branch its own copy at the cost
of a `CREATE DATABASE`, which is what the shared daemon's per-branch service volumes give today.

Two kunj details the Cloud SQL route would need: the firewall rejects private ranges before it
consults the allowlist, so an allowlisted private address (a Cloud SQL private IP) needs the allow
rule moved ahead of the private-range reject, and `container.network.allow` would have to accept an
IP as well as a domain.

## Isolation on the VM

Branch containers on the VM run under `runc` with capabilities dropped as locally; the helper keeps the
egress rules. gVisor (`runsc`) as the runtime for the main container would be a stronger wall, but the
helper would then run in gVisor's netstack too (same network namespace), where ipset does not exist
and iptables is partial, so the firewall cannot load. Do not offer it. The isolation story on Google
Cloud is therefore: the agent is confined to a VM that holds only kunj's Docker, no credentials
(service account without roles, no gcloud login), no other workload, behind IAP; an escape from a
container reaches that VM and the other branches on it, and nothing else. For an agent that must not
see other branches at all, give it its own VM (option A twice) rather than a sandboxed runtime.

## Cost sketch

Approximate list prices from third-party pricing pages (us-central1, late 2026); check Google's pricing
pages before quoting them.

| Item | Price |
| --- | --- |
| e2-standard-4 (4 vCPU, 16 GB), on demand | about $0.13 per hour, about $98 a month always on |
| e2-standard-4, Spot | about $0.08 per hour |
| n2d-standard-4 (faster, AMD) | about $0.17 per hour |
| 64 GB of memory: e2-highmem-8 (8 vCPU) about $0.36 per hour (about $264 a month always on, Spot about $0.22); e2-standard-16 (16 vCPU) about $0.54; n2d-highmem-8 about $0.46; n2-highmem-8 about $0.52 | computed from Google's per-vCPU and per-GB rates for us-central1, cross-checked against the e2-standard-4 figure |
| pd-balanced disk | about $0.10 per GB-month (200 GB: about $20 a month, also while the VM is stopped) |
| Cloud NAT gateway | hourly fee plus per-GB processed; small for one VM |
| Cloud Workstations | $0.05 per vCPU-hour management fee while running, plus $0.20 per hour per cluster, plus VM and disk |

A VM used 40 hours a week and stopped otherwise costs roughly a quarter of the always-on figure plus
the disk, which is why idle stop and wake matter more than the machine type.

## What kunj would need

Nothing to use option A today. Two small additions would make it comfortable:

- **`kunj serve --idle-after <minutes> --idle-command <cmd>`** and a **`wake` command on remote entries**,
  as described under "On demand" above (suspend when no agent runs and no TTY is open; listings
  report `sleeping`, acting commands wake).
- **Docs:** a docs-site page with the recipe (VM, Docker, Sysbox, systemd unit, Cloud NAT, IAP rule,
  ssh config, `kunj remote add`, idle stop), and the remote-containers spec's "SSH to a real second
  machine" item closed by it.

## Open questions

- Which GCE machine family is best for several concurrent Claude agents (CPU-light, memory- and
  IO-heavy npm installs)? Start with e2-standard-4 and a pd-balanced data disk; measure.
- Does `kunj serve` need anything for a client whose SSH tunnel goes through IAP (slower connect, about
  a second)? `LOOKUP_TIMEOUT_MS` in the multi-remote spec is 5 s; probably fine.
- Cloud Workstations: whether Google documents Docker-in-workstation as supported, and whether the
  daemon's data root can be placed on the persistent home disk. Needs the live docs.

## Sources

Google Cloud documentation as indexed (the docs host was not reachable from the writing session):
[gcloud compute start-iap-tunnel](https://docs.cloud.google.com/sdk/gcloud/reference/compute/start-iap-tunnel),
[IAP TCP forwarding](https://docs.cloud.google.com/iap/docs/tcp-by-host),
[gcloud workstations start-tcp-tunnel](https://docs.cloud.google.com/sdk/gcloud/reference/workstations/start-tcp-tunnel),
[Cloud Workstations SSH support](https://docs.cloud.google.com/workstations/docs/ssh-support),
[Cloud Workstations pricing](https://cloud.google.com/workstations/pricing),
[Create a workstation configuration](https://docs.cloud.google.com/workstations/docs/create-configuration),
[GKE Autopilot security measures](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security),
[Cloud Run execution environments](https://docs.cloud.google.com/run/docs/about-execution-environments),
[Container-Optimized OS disks and file system](https://docs.cloud.google.com/container-optimized-os/docs/concepts/disks-and-filesystem),
[Idle VM recommendations](https://docs.cloud.google.com/compute/docs/instances/idle-vm-recommendations-overview),
[Suspend or resume an instance](https://docs.cloud.google.com/compute/docs/instances/suspend-resume-instance).
Projects: [Sysbox](https://github.com/nestybox/sysbox) and its
[distro compatibility](https://github.com/nestybox/sysbox/blob/master/docs/distro-compat.md),
[Docker Enhanced Container Isolation](https://docs.docker.com/desktop/enterprise/hardened-desktop/enhanced-container-isolation/),
[gVisor compatibility](https://gvisor.dev/docs/user_guide/compatibility/) and
[networking](https://gvisor.dev/docs/user_guide/networking).
Third-party: [Cloud Workstations container breakout write-up](https://hackingthe.cloud/gcp/exploitation/gcp-cloud-workstations-container-breakout/),
[e2-standard-4 pricing](https://www.economize.cloud/resources/gcp/pricing/compute-engine/e2-standard-4/),
[n2d-standard-4 pricing](https://www.economize.cloud/resources/gcp/pricing/compute-engine/n2d-standard-4/),
[persistent disk pricing](https://gcloud-compute.com/pd-balanced.html),
[instance schedules](https://oneuptime.com/blog/post/2026-02-17-how-to-configure-compute-engine-instance-scheduling-to-automatically-stop-vms-on-weekends/view),
[Docker Offload](https://www.docker.com/products/docker-offload/) and [About Docker Offload](https://docs.docker.com/offload/about.md),
[Container-Optimized OS overview](https://docs.cloud.google.com/container-optimized-os/docs/concepts/features-and-benefits).
