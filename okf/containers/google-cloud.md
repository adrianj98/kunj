---
type: Container
title: Google Cloud Hosting Options
description: Where kunj's branch containers can run on Google Cloud - a Compute Engine VM with Docker and kunj serve behind IAP (recommended), Cloud Workstations, a GKE backend, Cloud Run (ruled out) - and the constraints that decide it.
resource: docs/specs/google-cloud-containers.md
tags: [container, remote, serve, google-cloud, research]
timestamp: 2026-11-16T00:00:00Z
---

# Overview

Research (docs/specs/google-cloud-containers.md, 2026-11-16), not shipped code. The question was where
branch containers can run on Google Cloud so a laptop drives them with `kunj ct … --remote <name>` through
[Remotes](/containers/remotes.md) and `kunj serve` (docs/specs/remote-containers.md).

# What decides it

The shipped code needs a real Docker daemon ([Container Backend](/containers/backend.md)): `--network
container:<id>` sidecars, `NET_ADMIN`/`NET_RAW` on the helper, `commit` for snapshots, `build -`, TTY exec
over the Engine API, optionally `sysbox-runc` or `--privileged`. The firewall
([Network Helper and Firewall](/containers/network-helper-firewall.md)) is iptables and ipset in the host
kernel's netfilter, so a sandboxed runtime with its own network stack (gVisor) cannot run the helper.
Docker state (labels, home volumes, snapshot images) must survive the host stopping. The firewall's
`169.254/16` reject already keeps containers off the GCE metadata server.

# Options

| Option | Verdict |
| --- | --- |
| Compute Engine VM (Ubuntu 24.04, Docker CE, Sysbox, `kunj serve` as a systemd unit; no external IP, Cloud NAT egress, IAP TCP forwarding inbound) | Recommended; works with today's kunj |
| Cloud Workstations (`kunj serve` inside the workstation, `gcloud workstations start-tcp-tunnel`) | Not recommended: Docker inside is a socket/privileged workaround, `/var/lib/docker` is not on the persistent home disk, cluster fee |
| GKE with a new Kubernetes `ContainerBackend` (pod = main + helper sidecar, PVC home, exec API) | Later, for a fleet: no `commit`/`build` on nodes, Autopilot needs `--workload-policies=allow-net-admin` and never privileged |
| Cloud Run | Ruled out: no capabilities, no daemon, no persistent disk |
| One VM per branch | Rejected |
| A managed Docker daemon (Container-Optimized OS, Cloud Build, Docker Offload) | None fits: COS cannot host kunj or Sysbox, Cloud Build is batch, Docker Offload deletes state after idle and runs outside the user's project |

# Reaching the VM

All three forms use the existing `kunj remote add`:

1. `--ssh kunj-gce`, where `~/.ssh/config` gives the host a `ProxyCommand gcloud compute start-iap-tunnel %h 22
   --listen-on-stdin …` (recommended; the tunnel lives with the kunj process, src/lib/serve/tunnel.ts).
2. `gcloud compute start-iap-tunnel <vm> 7433 --local-host-port=localhost:7433` kept running, and
   `--url http://127.0.0.1:7433` (loopback http is accepted by `checkRemoteUrl()`).
3. Tailscale on the VM: `kunj serve --listen <tailnet-ip>:7433 --allow-remote-listen` and `--url … --allow-insecure-http`.

# On demand

Suspend (not stop) when idle, decided on the VM by agent state (no running agent, no open TTY exec for N
minutes), resume from the laptop: today by an ssh ProxyCommand script that resumes the instance before
opening the IAP tunnel (wakes on listings too), proposed as `kunj serve --idle-after` and a `wake` command on
the remote entry that only acting commands run while listings report `sleeping`. A shared VM is step one (a
recipe, a day); an instance per session (e2-standard-2, 8 GB, about $0.067/h, cheaper below about five
concurrent sessions, a kernel per agent) is the target when isolation matters, and needs a Compute Engine
provider (VMs named and labelled like containers, suspend/resume per branch) and a golden image baked from
the shared recipe.

# Cost and idle stop

A stopped VM costs only its disk, so an instance schedule or an idle power-off matters more than the
machine type (e2-standard-4 about $0.13/h on demand, about $0.08/h Spot; pd-balanced about $0.10 per
GB-month; third-party figures, to be checked). Proposed, not built: `kunj serve --idle-stop <minutes>`
and a per-remote wake command (`gcloud compute instances start`) run when the tunnel does not come up.

# Related Concepts

* [Remotes](/containers/remotes.md)
* [Container Backend](/containers/backend.md)
* [Network Helper and Firewall](/containers/network-helper-firewall.md)
* [Docker-in-Docker](/containers/docker-in-docker.md) - Sysbox on Ubuntu 24.04 (kernel 6.8, no shiftfs)

# Citations

[1] [docs/specs/google-cloud-containers.md](/docs/specs/google-cloud-containers.md)
[2] [docs/specs/remote-containers.md](/docs/specs/remote-containers.md)
[3] [src/lib/serve/tunnel.ts](/src/lib/serve/tunnel.ts)
[4] [src/lib/remotes.ts](/src/lib/remotes.ts)
