---
type: Container
title: Cloud Machines
description: Design (not shipped) for a small cloud VM per branch session, created, suspended, resumed and deleted through a pluggable MachineProvider, running Docker and kunj serve, with Google Cloud as the first provider.
resource: docs/specs/cloud-machines.md
tags: [container, remote, serve, machines, provider, design]
timestamp: 2026-11-16T00:00:00Z
---

# Overview

docs/specs/cloud-machines.md (2026-11-16): one 8 GB machine per branch, its own kernel, created on `kunj ct
start`, suspended when its agent goes quiet, resumed by the next acting command, deleted with the branch.
The machine runs only what [remote containers](/containers/remotes.md) already run (Docker, `kunj serve`);
the new piece is the provider.

# Layers

| Layer | Module | Role |
|---|---|---|
| `MachineProvider` | src/lib/machines/provider.ts | `list/get/create/suspend/resume/stop/start/delete`, `tunnel()` → a local-port forwarder argv, `images`, `sizes()`, `features` |
| Providers | src/lib/machines/providers/gce.ts (first), ec2.ts, ssh-fleet.ts (later) | Drive the cloud through its CLI with argv arrays; the only modules that spawn one. `FakeProvider` for tests |
| Lifecycle | src/lib/machines/lifecycle.ts | Cloud-agnostic: locate by labels, ensure (create, wait, pair token), wake on act, suspend, delete, prune, hooks |
| Tunnel | src/lib/serve/tunnel.ts | Generalised from `ssh -L` to "run this argv, wait for the local port" |
| `kunj ct` | select-backend.ts | With `machine.provider` set, the branch's machine is resolved and a `RemoteKunjBackend` opened over its tunnel; container lifecycle unchanged |
| `kunj machine` | src/commands/machine.ts | list/status/suspend/resume/stop/start/delete/prune/image/providers |

# Blueprint to image

One hash, three layers: the blueprint snapshot `kunj-blueprint-<repo>:<hash>` (a Docker image per daemon, shipped
today), the golden machine image labelled `kunj.blueprint=<hash>` that carries it (built by `kunj machine image
build` from a builder machine), and an optional registry copy (`machine.registry`) an older machine pulls instead of
rebuilding. A new machine starts a branch by copying `/workspace` from the snapshot, as a second branch does locally.

# Rules

Cloud labels (`kunj.repo`, `kunj.branch`, `kunj.version`, `kunj.role=machine`) are the only machine state;
machines are named like their container. Listings never wake a machine, acting commands do (`--no-wake`).
Idle is decided on the machine from agent state and the machine suspends itself (`kunj serve --idle-after` runs
the provider's idle command under a credential that can do only that); the laptop resumes it. The serve token is paired once
after boot over an authenticated tunnel (`POST /v1/pair`), never written to metadata. No secrets reach the
provider. A golden image (`kunj machine image build`) carries Docker, Sysbox, kunj, the images, the blueprint
snapshot and the generic cache volume (`container.caches`, `KUNJ_CACHE_DIR`).

# Related Concepts

* [Google Cloud Provider Notes](/containers/google-cloud.md)
* [Remotes](/containers/remotes.md)
* [Container Backend](/containers/backend.md)
* [Blueprints](/containers/blueprints.md) - the snapshot the golden image carries

# Citations

[1] [docs/specs/cloud-machines.md](/docs/specs/cloud-machines.md)
[2] [docs/specs/remote-containers.md](/docs/specs/remote-containers.md)
[3] [src/lib/serve/tunnel.ts](/src/lib/serve/tunnel.ts)
