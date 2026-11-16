---
type: Container
title: Cloud Machines
description: Design (not shipped) for a small cloud VM per branch session behind a coordinator (kunj serve --machines, auto-started locally or always-on in the cloud) that drives a pluggable MachineProvider, Google Cloud first.
resource: docs/specs/cloud-machines.md
tags: [container, remote, serve, machines, provider, design]
timestamp: 2026-11-16T00:00:00Z
---

# Overview

docs/specs/cloud-machines.md (2026-11-16): one 8 GB machine per branch, its own kernel, created on `kunj ct
start`, suspended when its agent goes quiet, resumed by the next acting command, deleted with the branch.
The machine runs only what [remote containers](/containers/remotes.md) already run (Docker, `kunj serve`).
The new pieces are the **coordinator**, `kunj serve --machines`, which kunj auto-starts on the laptop when a
command needs it or which runs always-on on a tiny cloud VM so several clients connect with a token each, and
the **provider** it drives.

# Layers

| Layer | Module | Role |
|---|---|---|
| `MachineProvider` | src/lib/machines/provider.ts | `list/get/create/suspend/resume/stop/start/delete`, `address()` (private network) or `tunnel()` (a local-port forwarder argv), `images`, `sizes()`, `recipeEnv()`, `features` |
| Providers | src/lib/machines/providers/gce.ts (first), ec2.ts, ssh-fleet.ts (later) | Drive the cloud through its CLI with argv arrays; the only modules that spawn one. `FakeProvider` for tests |
| Lifecycle | src/lib/machines/lifecycle.ts | In the coordinator, cloud-agnostic: locate by labels, ensure (create, wait, pair token), wake on act, the idle loop, suspend, delete, prune |
| Coordinator | src/lib/serve/machines.ts | `kunj serve --machines`: `/v1/machines…` routes, the proxy of `/v1/machines/<name>/<route>` to that machine's serve (WebSockets piped), per-client tokens (`kunj serve token add`), machine tokens |
| Local auto-start | src/lib/machines/local-coordinator.ts | With `machine.provider` set locally, kunj starts `kunj serve --machines` on loopback (pid file like forwards), reuses it, lets it exit after an idle hour |
| `kunj ct` | select-backend.ts, remote.ts | `locate` on the coordinator, then a `RemoteKunjBackend` rooted at `/v1/machines/<name>/`; container lifecycle unchanged |
| `kunj machine` | src/commands/machine.ts | list/status/suspend/resume/stop/start/delete/prune/image/coordinator/providers |

# Blueprint to image

One hash, three layers: the blueprint snapshot `kunj-blueprint-<repo>:<hash>` (a Docker image per daemon, shipped
today), the golden machine image labelled `kunj.blueprint=<hash>` that carries it (built by `kunj machine image
build` from a builder machine), and an optional registry copy (`machine.registry`) an older machine pulls instead of
rebuilding. A new machine starts a branch by copying `/workspace` from the snapshot, as a second branch does locally.

# Rules

Cloud labels (`kunj.repo`, `kunj.branch`, `kunj.version`, `kunj.role=machine`) are the only machine state;
machines are named like their container. Listings never wake a machine, acting commands do (`--no-wake`).
Idle is decided from agent state by the coordinator's loop, never from client connections; with a local
coordinator the machine also suspends itself as a fallback (`machine.selfSuspend`, a one-permission credential).
The coordinator pairs each machine's serve token once after boot (`POST /v1/pair`) over the private network or an
IAP tunnel, never through metadata; clients hold one coordinator token each. Hooks run on the client. No secrets reach the
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
