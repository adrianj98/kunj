---
type: Container
title: Docker-in-Docker
description: Opt-in dockerd inside a branch container, via the sysbox runtime or privileged mode, on the kunj-sandbox-dind image.
resource: src/lib/container/dind.ts
tags: [container, docker-in-docker, sysbox, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Some repositories run `docker compose` in their own tests. `container.dockerInDocker` gives each branch
container its own `dockerd`, with `/var/lib/docker` on a per-branch volume. It weakens isolation, so it
is off by default and the only exception to the main container's dropped capabilities (see
[lifecycle](/containers/lifecycle.md)). For databases alone, [services](/containers/services.md) are the
safer route; a start without DinD or services prints `composeHint()` when the tree has
`compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml`.

# Modes

| Mode | Run options | Requirement |
| --- | --- | --- |
| `off` | `capDrop: ['ALL']` + `MAIN_CAPABILITIES` | none |
| `sysbox` | `runtime: 'sysbox-runc'`, capabilities kept | `docker info` lists `sysbox-runc`; inner containers stay in the sandbox's user namespace |
| `privileged` | `privileged: true` | `container.allowPrivileged: true`; refused when `docker info` says Docker Desktop, whatever the context |

`privileged` gives the agent (root via the docker group) root on the Docker host or its VM; Docker
Desktop's VM shares the home directory, so it is never allowed there. Use a dedicated context, e.g.
a Colima profile with file sharing off (`container.dockerContext`).

# Checks

| Function | When | Refuses |
| --- | --- | --- |
| `precheckDind()` | `kunj ct start` before the create hook, snapshot and push, when a container will be created | `container.image` / `--image` set; then `checkDind()` |
| `checkDind()` | also inside `startContainer` | backend lacks the mode (`features.dockerInDocker`); no sysbox runtime; privileged without `allowPrivileged`; privileged on Docker Desktop |
| `dindSource()` | image resolution | any base that is not kunj's sandbox (devcontainer, custom image) |
| `checkRecordedDind()` | resume | a privileged container once `allowPrivileged` is false; a sysbox container once the runtime is gone |

All throw `StartError(..., 'dind')`. A resume whose recorded mode differs from the setting warns that
`kunj ct start --rebuild` applies it. The remove guard will not start a privileged container to inspect
it when `allowPrivileged` was revoked (use `--force`).

# Image

`DIND_IMAGE(version)` = `kunj-sandbox-dind:<version>-<hash>`, the hash covering
`src/container/sandbox-dind/` (`assetHash('sandbox-dind')`) and the sandbox tag it is built `FROM`
(`BASE_IMAGE` build arg), so a new sandbox rebuilds it. The Dockerfile installs `docker-ce`,
`docker-ce-cli`, `containerd.io`, `docker-compose-plugin` and `iptables` from Docker's apt repo, copies
`kunj-dind-start` and adds the `dev` user to the `docker` group. See [images](/containers/images.md).

# Starting dockerd

dockerd never starts in the image. The main container runs `sleep` until the network helper reports
READY; then `startDockerd()` execs `DIND_START` (`/usr/local/bin/kunj-dind-start`) as root, before
seed and setup, on create and on every resume. The script (idempotent) clears stale pid files and
sockets, moves processes into a child cgroup on cgroup v2, starts `dockerd` with `setsid nohup`,
logs to `/var/log/kunj-dockerd.log`, waits `KUNJ_DIND_WAIT` (30) seconds for `docker info`, and makes
the socket `docker`-group 0660. A daemon that does not come up is a warning, not a failed start.

The firewall gets `DIND_DOMAINS` (Docker Hub registry, auth and CDN, `index.docker.io`, `ghcr.io`,
`pkg-containers.githubusercontent.com`) so `docker pull` works (see
[firewall](/containers/network-helper-firewall.md)). The container gets `KUNJ_DIND=<mode>` in its env
and `dind` in `kunj.options`; `ct list --json` reports `dind`.

[Snapshots](/containers/snapshots.md) use the same DinD image (so the hash agrees) with
`StartOptions.withoutDind`: no dockerd and no docker volume, so `/var/lib/docker` never ends up in an image.

# Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `container.dockerInDocker` | `off` | `off`, `sysbox` or `privileged` |
| `container.allowPrivileged` | `false` | second opt-in for `privileged` |

# Related Concepts

* [Lifecycle](/containers/lifecycle.md) - capabilities, READY, resume
* [Images](/containers/images.md) - sandbox and DinD build contexts
* [Network helper and firewall](/containers/network-helper-firewall.md)
* [Prune](/containers/prune.md) - removes DinD tags of other versions
* [Overview](/containers/overview.md) - security model

# Citations

[1] [src/lib/container/dind.ts](/src/lib/container/dind.ts)
[2] [src/container/sandbox-dind/Dockerfile](/src/container/sandbox-dind/Dockerfile)
[3] [src/container/sandbox-dind/kunj-dind-start](/src/container/sandbox-dind/kunj-dind-start)
[4] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[5] [src/commands/container.ts](/src/commands/container.ts)
[6] [src/settings/container.ts](/src/settings/container.ts)
[7] [docs/specs/container-phase-2.md](/docs/specs/container-phase-2.md)
