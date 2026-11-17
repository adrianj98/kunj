---
type: Container
title: Cloud Machines
description: A small cloud VM per branch session behind a coordinator (kunj serve --machines, auto-started locally or always-on in the cloud) that drives a pluggable MachineProvider, Google Cloud first. Phases 0 to 2 shipped and run on a real project.
resource: src/lib/machines/coordinator.ts
tags: [container, remote, serve, machines, provider, google-cloud]
timestamp: 2026-11-16T00:00:00Z
---

# Overview

docs/specs/cloud-machines.md (2026-11-16): one 8 GB machine per branch, its own kernel, created on `kunj ct
start`, suspended when its agent goes quiet, resumed by the next acting command, deleted with the branch.
The machine runs only what [remote containers](/containers/remotes.md) already run (Docker, `kunj serve`).
The new pieces are the **coordinator**, `kunj serve --machines`, which kunj auto-starts on the laptop when a
command needs it or which runs always-on on a tiny cloud VM so several clients connect with a token each, and
the **provider** it drives.

# Layers (phase 1 as built)

| Layer | Module | Role |
|---|---|---|
| `MachineProvider` | src/lib/machines/provider.ts | `list/get/create/suspend/resume/stop/start/delete`, `address()` (private network) or `tunnel()` (a local-port forwarder argv), `images`, `sizes()`, `features`; `machineName()` (the container name as a DNS label), `MachineError` |
| Providers | src/lib/machines/providers/index.ts, gce.ts | Registered by name, loaded lazily (`registerProvider`). `GceProvider` drives gcloud with argv only; exact labels in instance metadata `kunj-labels`, GCE labels hashed for filtering; gcloud's "Some requests did not succeed" (exit 0, `[]`) is a failure. Only provider modules spawn a cloud CLI (src/lib/machines/cli.ts). `FakeProvider` and a shared conformance suite in `__tests__` |
| Coordinator | src/lib/machines/coordinator.ts | Cloud-agnostic `Coordinator`: locate by labels (one in flight per branch), create, wake only when asked, pair with the machine's serve and wait until it answers; machine tokens in `~/.kunj/coordinator/machine-tokens.json` |
| Bootstrap | src/lib/machines/bootstrap.ts | The startup script a new machine runs as root at every boot (GCE `--metadata-from-file startup-script=`): Docker, Node, the `kunj` user, `machine.kunjPackage` (npm version or `github:owner/repo#ref` built on the machine), the `kunj-serve` unit with `--allow-pairing` on the internal address; idempotent, no secret; `machine.image` and `machine.bootstrap` |
| Routes | src/lib/serve/machines.ts | `kunj serve --machines` adds `/v1/machines` (list, providers, locate, suspend, resume, stop, start, delete) through `createServeServer`'s `extend` hook, and `machines` in `/v1/info` |
| Local auto-start | src/lib/machines/local-coordinator.ts, config.ts | With `machine.provider` set here, kunj spawns `kunj serve --machines --listen 127.0.0.1:0 --idle-exit <min>` detached from the home directory; the server writes `~/.kunj/coordinator/coordinator.json` (pid, port) and removes it on exit; `resolveCoordinator()` prefers `--remote`/`container.remote` when that remote coordinates machines |
| Client, command | src/lib/machines/client.ts, src/commands/machine.ts | `MachineClient` over the routes; `kunj machine list|status|create|suspend|resume|stop|start|delete|providers|coordinator` (fast path) |
| Proxy | src/lib/serve/proxy.ts | `/v1/machines/<name>/serve/v1/<route>` to that machine's serve: http piped with the machine's token in place of the client's, upgrades as raw bytes; `Coordinator.proxyTarget()` shares one endpoint per machine, closes it a minute after the last use, answers `machine-asleep` |
| `kunj ct` on machines | src/lib/container/select-backend.ts, src/commands/container.ts | A remote reporting `machines` (or `--remote machines`, the local coordinator) is a coordinator: `intentOf()` gives the command's branch and whether it creates (`start`), wakes (acting commands) or never wakes (`stop`); the backend is a `RemoteKunjBackend` with `basePath` |
| Idle loop | `Coordinator.idleTick()`, src/lib/machines/idle.ts | Every minute: suspend after `machine.idleMinutes` with no proxied request, open stream or agent in the `running` state |
| Not yet | — | Machines in `ct list` and `kunj events`, machine prune, hooks, the machine-side self-suspend timer, `container.caches`, `image-stale` |
| Golden image | src/commands/machine.ts, `Coordinator.bake()/images()/imageFor()` | `kunj machine image build`: a builder machine (reserved branch `kunj..image-build`, stock image) builds the blueprint snapshot (`ct blueprint snapshot --machine`), its stopped disk becomes `…-img-<time>` (labels `kunj.repo`, `kunj.role=machine-image`, `kunj.version`), older images of the repo are deleted, the builder is deleted. New machines boot the repo's newest image (`kunj.image` label); the bootstrap deletes the baked-in serve token when `/etc/kunj-machine` names another host, so the machine pairs anew |

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
The coordinator pairs each machine's serve token once after boot (`POST /v1/pair` with a nonce; a repeat with the same nonce gets the same token, so a lost reply is retried safely) over the private network or an
IAP tunnel, never through metadata; clients hold one coordinator token each. Hooks run on the client. No secrets reach the
provider. A golden image (`kunj machine image build`) carries Docker, Sysbox, kunj, the images, the blueprint
snapshot and the generic cache volume (`container.caches`, `KUNJ_CACHE_DIR`).

# Related Concepts

* [Google Cloud Provider Notes](/containers/google-cloud.md)
* [Remotes](/containers/remotes.md)
* [Container Backend](/containers/backend.md)
* [Blueprints](/containers/blueprints.md) - the snapshot the golden image carries

# Citations

[0] [src/lib/machines/provider.ts](/src/lib/machines/provider.ts)

[1] [docs/specs/cloud-machines.md](/docs/specs/cloud-machines.md)
[2] [docs/specs/remote-containers.md](/docs/specs/remote-containers.md)
[3] [src/lib/serve/tunnel.ts](/src/lib/serve/tunnel.ts)
