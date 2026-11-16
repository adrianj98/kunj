# Google Cloud: notes for the first machine provider

The decision is in [cloud-machines.md](cloud-machines.md): a small VM per session, created, suspended,
resumed and deleted by a pluggable **machine provider**, with Google Cloud as the first provider. This
page holds what is specific to Google Cloud for that design. Written 2026-11-16 from Google Cloud
documentation as search engines index it and third-party pricing pages; Google's docs host could not be
fetched from the session that wrote it, so prices and limits are to be checked against the live pages
before the provider is built.

## Status

| Part | State |
| --- | --- |
| Notes | Written 2026-11-16, trimmed to the decided design |
| Shared-VM recipe by hand (phase 0 of cloud-machines.md) | Not started: needs a project and a VM (waiting on you) |
| `GceProvider` | See cloud-machines.md |

## What the machine must provide

From the shipped container code, not a wish list:

- **A real Docker daemon** under `runc` (or Sysbox): `--network container:<id>` sidecars, `NET_ADMIN`
  and `NET_RAW` on the helper, `commit` for snapshots, `build -`, TTY exec through the Engine API,
  `events`, the compose plugin.
- **The host kernel's netfilter.** The firewall is iptables, ip6tables and ipset in the helper; a
  sandboxed runtime with its own network stack (gVisor) has no ipset and partial iptables, so the
  helper would never reach READY. The isolation boundary is the VM, which is why there is one per
  session.
- **Persistent Docker state** across suspend and resume: labels, home volumes, snapshot images, the
  cache volume.
- **Egress** to origin, `api.anthropic.com`, `registry.npmjs.org` and `container.network.allow`. The
  firewall rejects `169.254/16`, so containers cannot reach the metadata server (`169.254.169.254`);
  keep `container.network.allowHost` off.

## The machine

- **Image:** Ubuntu 24.04 LTS (kernel 6.8). Docker CE from Docker's apt repository with the compose
  plugin, Node LTS, `npm i -g kunj`, a systemd unit for `kunj serve`. Container-Optimized OS was
  rejected: read-only root, no package manager, no Sysbox.
- **Sysbox** for Docker-in-Docker: open source and community-supported since Docker folded the
  enterprise edition into Docker Desktop's Enhanced Container Isolation; its compatibility page lists
  Ubuntu 24.04 (kernel 6.8+) and needs no shiftfs on kernels 5.19 and later. The unit starts serve with
  `--allow-runtime sysbox-runc`; `privileged` is also acceptable on a machine that holds only kunj's
  Docker (`dind.ts`'s Docker Desktop refusal does not apply).
- **Shapes** for `machine.size`: `small` e2-medium (2 shared vCPU, 4 GB, about $0.034 per hour),
  `medium` e2-standard-2 (2 vCPU, 8 GB, about $0.067), `large` e2-standard-4 (4 vCPU, 16 GB, about
  $0.134). 4 GB is tight once `tsc` or parallel Jest workers run next to the agent; 8 GB is the default.
  Spot is about 40 percent off and may be stopped with 30 seconds' notice; a suspend in progress loses
  to a preemption.
- **Disk:** pd-balanced, about $0.10 per GB-month, billed while suspended too; 30 GB by default, so an
  idle branch costs about $3 a month. Branches must be deleted when merged (`ct prune`) or the disks
  add up.
- **Network:** no external IP. Egress through a Cloud NAT gateway on the subnet (about $32 a month
  plus per GB, shared by every machine; documented, not created by kunj). Inbound only through
  Identity-Aware Proxy TCP forwarding (below).
- **Service account:** a dedicated one with no project roles; with `machine.selfSuspend`, bound by IAM
  condition to `compute.instances.suspend` and `compute.instances.get` on the machine itself, so the
  fallback idle timer can suspend it and nothing else.

## Reaching machines

The coordinator of cloud-machines.md reaches a machine's `kunj serve` one of two ways, both set by
`machine.network`:

- **`private`** (a cloud coordinator in the same VPC): `address()` is the machine's internal IP and port
  7433. The machine's serve listens on its internal address (`--listen <ip>:7433 --allow-remote-listen`,
  the unit reads the address from the metadata server at boot) behind a VPC firewall rule that admits the
  coordinator's network tag and IAP's `35.235.240.0/20` to that port only.
- **`tunnel`** (a local coordinator on the laptop): `tunnel()` is
  `gcloud compute start-iap-tunnel <name> 7433 --local-host-port=127.0.0.1:<port> --zone … --project …`,
  one per machine, IAM-authenticated (`roles/iap.tunnelResourceAccessor`), using the laptop's own `gcloud`
  login.

No sshd, no OS Login, no SSH keys on any machine. Both paths are access-controlled, which is what makes
the one-time token pairing safe.

**A cloud coordinator** is an e2-micro (about $7 a month, free tier in some US regions) in the same VPC,
with a service account holding the instance, image and disk permissions the provider uses and nothing
else. Clients reach it like any remote: an IAP tunnel to its port (an ssh `ProxyCommand` alias for
`kunj remote add --ssh`, or `--url http://127.0.0.1:<port>` with a tunnel kept open), a tailnet address
with `--allow-insecure-http`, or the user's own TLS front.

For phase 0 by hand, before the provider exists: an `~/.ssh/config` entry whose `ProxyCommand` is
`gcloud compute start-iap-tunnel %h 22 --listen-on-stdin …` and `kunj remote add gce --ssh <alias>`
works with today's `--ssh` remotes unchanged (serve on loopback then).

## On demand: suspend and resume

Compute Engine **suspend** writes the memory to persistent storage: no vCPU or memory charge while
suspended, the saved memory billed as standard persistent disk (a few dollars a month for 8 GB), resume
in seconds with running containers and the agents' tmux sessions intact. Limits: at most 208 GB of
memory, no GPUs, a guest that supports it (Ubuntu does), 60 days before Google turns it into a stopped
instance (then `start` instead of `resume`; harmless). The coordinator's idle loop suspends a machine
through `gcloud compute instances suspend` and resumes it with `resume` on the next acting command. With
a local coordinator (`machine.selfSuspend`), the machine also carries the fallback: a service account
allowed only `compute.instances.suspend` and `compute.instances.get` on itself by IAM condition, and
`kunj serve --idle-after` on the machine running `gcloud compute instances suspend $(hostname)`, so the
machine sleeps even when the laptop is shut. An instance schedule that stops everything at night and a
budget alert are the backstops.

## Caching across machines

No shared filesystem: Docker's data root cannot be shared (overlay2, one daemon per data root) and
Filestore starts near $200 a month. Instead:

| Need | Share it as |
| --- | --- |
| `kunj-sandbox`, helper and service images, the blueprint snapshot, a warm `/workspace` | The golden image (`kunj machine image build`), rebuilt when the blueprint hash changes; Artifact Registry in the same region as the pull-on-first-start fallback |
| npm, pip, Go, Maven, apt, Docker Hub downloads | Artifact Registry **remote repositories** (pull-through caches), one hostname such as `<region>-npm.pkg.dev` in the firewall allowlist, set as the registry in the sandbox |
| Anything a repository wants every branch to find at a path (a pulled database dump, a package store, fixtures) | The generic cache volume of cloud-machines.md (`container.caches`, `KUNJ_CACHE_DIR`), carried by the golden image's disk; a nightly image build keeps it current |
| A seeded database per branch | The repository's own script against the cache volume (restore from the cached dump when given its path; a deliberate run without it pulls afresh and rewrites the dump), or one small Cloud SQL instance with `CREATE DATABASE <branch> TEMPLATE main` |

Cloud SQL would need two kunj changes: the firewall must consult the allowlist before it rejects
private ranges, and `container.network.allow` must take an IP as well as a domain. Anything that reads a
bucket runs on the machine side with its service account, never inside a container.

## Cost sketch

Per-second billing, approximate list prices, us-central1:

| Item | Price |
| --- | --- |
| e2-standard-2 (the default `medium`) | about $0.067 per hour while running |
| e2-medium (`small`) / e2-standard-4 (`large`) | about $0.034 / $0.134 per hour |
| Suspended machine | its disk (about $3 a month for 30 GB) plus the saved memory |
| Cloud NAT | about $32 a month for the project plus per GB |
| Golden image storage | about $0.05 per GB-month |
| Cloud coordinator (optional, e2-micro) | about $7 a month, or free tier; a local coordinator costs nothing |

Three sessions active at once cost about $0.20 per hour; a month of three sessions, six hours a day,
lands near $50 including disks and NAT.

## Why Google Cloud first

The provider is pluggable, and the design runs the same on AWS (EC2 hibernate, SSM port forwarding,
Bedrock through the instance role) or a plain SSH fleet. Google Cloud goes first because the IAP tunnel
is free and IAM-gated without sshd, suspend has the fewest conditions, Artifact Registry covers every
pull-through cache in one service, and the x86 8 GB shape is the cheapest. AWS is the natural second
provider when an organisation already lives there, above all for Bedrock, which kunj's own AI features
target.

## Sources

Google Cloud documentation as indexed (the docs host was not reachable from the writing session):
[gcloud compute start-iap-tunnel](https://docs.cloud.google.com/sdk/gcloud/reference/compute/start-iap-tunnel),
[IAP TCP forwarding](https://docs.cloud.google.com/iap/docs/tcp-by-host),
[Suspend or resume an instance](https://docs.cloud.google.com/compute/docs/instances/suspend-resume-instance),
[Container-Optimized OS disks and file system](https://docs.cloud.google.com/container-optimized-os/docs/concepts/disks-and-filesystem),
[Compute Engine pricing](https://cloud.google.com/compute/all-pricing),
[Spot VM pricing](https://cloud.google.com/spot-vms/pricing).
Projects: [Sysbox](https://github.com/nestybox/sysbox) and its
[distro compatibility](https://github.com/nestybox/sysbox/blob/master/docs/distro-compat.md),
[gVisor compatibility](https://gvisor.dev/docs/user_guide/compatibility/).
Third-party pricing: [e2-standard-4](https://www.economize.cloud/resources/gcp/pricing/compute-engine/e2-standard-4/),
[persistent disk](https://gcloud-compute.com/pd-balanced.html).
Other clouds, for the later providers: [EC2 hibernation prerequisites](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernating-prerequisites.html),
[SSH through Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html).
