---
type: Container
title: Google Cloud Provider Notes
description: What is specific to Google Cloud for the cloud-machines design - the Ubuntu machine with Docker, Sysbox and kunj serve, IAP TCP forwarding as the tunnel, suspend/resume, caching through the golden image and Artifact Registry, cost.
resource: docs/specs/google-cloud-containers.md
tags: [container, remote, serve, google-cloud, machines]
timestamp: 2026-11-16T00:00:00Z
---

# Overview

Notes for the first [machine provider](/containers/cloud-machines.md) (docs/specs/google-cloud-containers.md,
2026-11-16; research, no shipped code). The machine is an Ubuntu 24.04 VM with Docker CE, Sysbox and
`kunj serve` as a systemd unit, sized e2-medium / e2-standard-2 / e2-standard-4 for `machine.size`
small/medium/large (8 GB default), no external IP, Cloud NAT egress, a service account allowed only to
suspend itself.

# Tunnel

`gcloud compute start-iap-tunnel <name> 7433 --local-host-port=127.0.0.1:<port>` is the provider's tunnel
argv. IAP reaches the machine's internal address, so serve listens there (`--allow-remote-listen`) behind a
VPC rule admitting only `35.235.240.0/20` to the port; no sshd or OS Login. The tunnel is IAM-authenticated,
which makes one-time token pairing safe. By hand (phase 0), an ssh `ProxyCommand` of
`start-iap-tunnel %h 22 --listen-on-stdin` works with today's `kunj remote add --ssh`.

# On demand

Suspend keeps memory (no compute charge, saved memory billed as standard disk, up to 208 GB, 60 days); the
machine suspends itself from `kunj serve --idle-after`, the laptop resumes it through the provider.

# Caching

No shared filesystem (Docker's data root cannot be shared; Filestore starts near $200 a month). Images,
snapshot and the cache volume ride in the golden image; package downloads go through Artifact Registry
remote repositories (one allowlisted hostname); a seeded database per branch comes from the repository's own
script against the cache volume or a Cloud SQL template database (which would need allowlisted private
addresses ahead of the firewall's private-range reject).

# Related Concepts

* [Cloud Machines](/containers/cloud-machines.md)
* [Remotes](/containers/remotes.md)
* [Network Helper and Firewall](/containers/network-helper-firewall.md)
* [Docker-in-Docker](/containers/docker-in-docker.md)

# Citations

[1] [docs/specs/google-cloud-containers.md](/docs/specs/google-cloud-containers.md)
[2] [docs/specs/cloud-machines.md](/docs/specs/cloud-machines.md)
