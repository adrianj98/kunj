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
| `kunj serve --idle-stop`, `kunj remote add --gce` (below, "What kunj would need") | Not started; optional |
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
| pd-balanced disk | about $0.10 per GB-month (200 GB: about $20 a month, also while the VM is stopped) |
| Cloud NAT gateway | hourly fee plus per-GB processed; small for one VM |
| Cloud Workstations | $0.05 per vCPU-hour management fee while running, plus $0.20 per hour per cluster, plus VM and disk |

A VM used 40 hours a week and stopped otherwise costs roughly a quarter of the always-on figure plus
the disk, which is why idle stop and wake matter more than the machine type.

## What kunj would need

Nothing to use option A today. Two small additions would make it comfortable:

- **`kunj serve --idle-stop <minutes> [--idle-command <cmd>]`:** when no client has connected for the
  period and no main container is running, run the command (default `sudo systemctl poweroff` on
  Linux). The server already sees every connection; the running-container check is one `list` by
  `kunj.role=main`. A running agent inside a container counts as busy even with no laptop attached.
- **Wake on demand:** a remote entry with a `wake` command (`gcloud compute instances start <instance>
  --zone <zone>`) that `RemoteKunjBackend` runs once when the tunnel fails to come up, then retries;
  `kunj ct start` and the workspace app's row then bring a stopped VM back instead of reporting
  `remote-unreachable`. A `kunj remote add gce --gce <instance> --zone <zone>` shorthand could write the
  `--ssh` entry, the ssh config stanza and the wake command in one go.
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
[Idle VM recommendations](https://docs.cloud.google.com/compute/docs/instances/idle-vm-recommendations-overview).
Projects: [Sysbox](https://github.com/nestybox/sysbox) and its
[distro compatibility](https://github.com/nestybox/sysbox/blob/master/docs/distro-compat.md),
[Docker Enhanced Container Isolation](https://docs.docker.com/desktop/enterprise/hardened-desktop/enhanced-container-isolation/),
[gVisor compatibility](https://gvisor.dev/docs/user_guide/compatibility/) and
[networking](https://gvisor.dev/docs/user_guide/networking).
Third-party: [Cloud Workstations container breakout write-up](https://hackingthe.cloud/gcp/exploitation/gcp-cloud-workstations-container-breakout/),
[e2-standard-4 pricing](https://www.economize.cloud/resources/gcp/pricing/compute-engine/e2-standard-4/),
[n2d-standard-4 pricing](https://www.economize.cloud/resources/gcp/pricing/compute-engine/n2d-standard-4/),
[persistent disk pricing](https://gcloud-compute.com/pd-balanced.html),
[instance schedules](https://oneuptime.com/blog/post/2026-02-17-how-to-configure-compute-engine-instance-scheduling-to-automatically-stop-vms-on-weekends/view).
