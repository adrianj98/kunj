---
type: Container
title: Sidecar Services
description: Postgres, Redis and other service containers started next to a branch container on its own network, reachable by service name.
resource: src/lib/container/services.ts
tags: [container, services, compose, docker]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A branch container often needs a database or broker to run its tests. Sidecar services are one Docker
container per service, on the branch's own network (`names.network`), with a `--network-alias` equal to
the service name, so the branch container reaches them as `postgres:5432`. They are declared in the
[blueprint](/containers/blueprints.md) (`services`), in the `container.services` setting, or in the
devcontainer's compose file.

A service image is chosen by the branch, so it is treated as untrusted: it gets only the env it
declares, only named volumes (created per branch), no added capabilities, no `--privileged`, no host
bind mount, no published ports and no firewall helper. The module is `src/lib/container/services.ts`;
[lifecycle](/containers/lifecycle.md) calls it on start, resume, stop and remove.

# Declaration

```json
{ "postgres": { "image": "postgres:16-alpine", "env": { "POSTGRES_PASSWORD": "dev" },
  "healthcheck": "pg_isready -U postgres", "volumes": { "data": "/var/lib/postgresql/data" },
  "port": 5432, "dependsOn": [] } }
```

| Key | Rule (`parseServices()`) |
| --- | --- |
| name | `SERVICE_NAME` = `^[a-z0-9][a-z0-9-]*$` |
| `image` | required, must pass `isImageRef()` |
| `env` | object of `NAME: value` (string, number or boolean, stringified) |
| `command` | non-empty string array; the image's own entrypoint and init are kept (`init: false`) |
| `port` | 1-65535; informational (shown in `ct list`, used by `forward <service>:<port>`) |
| `healthcheck` | shell command run with `sh -c` in the service |
| `volumes` | `volumeName: /abs/path`; a name starting with `/`, `.`, `~` or containing `/` is refused (no host paths) |
| `dependsOn` | other service names; unknown names and cycles throw (`serviceOrder()`) |

Any other key is an error. Sources merge by name with `mergeServices()`: blueprint first, then
`container.services`, then compose; the first layer that names a service wins (`resolveServices()`).

# Compose import

The devcontainer's compose files are read through `backend.composeConfig()` (`docker compose config
--no-interpolate` on stdin in an empty project directory, see [backend](/containers/backend.md)).
Before that, `composeRefusal()` refuses a file with `include`, `extends` with a `file`, `env_file`,
`label_file`, YAML tags other than `!reset`/`!override`, `!!binary`, alias or explicit (`?`) keys,
escaped double-quoted keys, more than one document, control characters or Unicode line breaks. Those
would make compose read other host files into a branch-controlled service.

`servicesFromCompose()` skips the devcontainer's own `service`, drops services without an `image`
(`build` is unsupported), and drops and reports keys in `DROPPED_KEYS` (`privileged`, `cap_add`,
`network_mode`, `devices`, `pid`, `ipc`, `security_opt`, `volumes_from`, `userns_mode`, `env_file`,
`extra_hosts`, `sysctls`, `runtime`, `entrypoint`, `user`, `working_dir`, `tmpfs`, ...), bind mounts and
published ports. `${NAME:-default}` becomes the default; any other `${...}` drops the value (never read
from the host env). The first `ports`/`expose` target becomes `port`; a compose `healthcheck.test`
becomes the shell `healthcheck`. A later compose file overrides an earlier one.

# Runtime

| Object | Name | Labels |
| --- | --- | --- |
| container | `<container>-svc-<name>` (`serviceNames()`) | `kunj.role=service`, `kunj.service=<name>`, `kunj.version`, `kunj.options` |
| volume | `<container>-svc-<name>-<volume>` | `kunj.role=service` plus repo/branch |

`kunj.options` holds `{ port, healthcheck, volumes, dependsOn }`, never env (values may be secrets).
`servicesOf()` matches by label and name prefix together, so a branch whose name extends another's is
never confused with it (see [naming and labels](/containers/naming-and-labels.md)).

| Step | Function | Behaviour |
| --- | --- | --- |
| new start | `startServices()` | after the network, before the branch container; dependency order; existing volumes and running containers reused; each waits on `waitHealthy()` |
| health | `waitHealthy()` | polls every `HEALTH_INTERVAL_MS` (2 s) up to `HEALTH_TIMEOUT_MS` (120 s); timeout is a warning, not a failure |
| `--rebuild` | `startServices({ recreate })` | recreates declared services (volumes kept); removes undeclared ones with their volumes unless `--keep-volumes` |
| resume | `resumeServices()` + `startServices()` | starts stopped ones in recorded `dependsOn` order, creates newly declared ones, never removes one; a failed resume stops what it started |
| stop | `stopServices()` | stops running service containers |
| remove | `serviceRemoval()` | deletes the containers and the volumes in their label (unless `--keep-volumes`) |

Created services are in the start's rollback list. With no Docker-in-Docker and no services, a start
prints `composeHint()` when the tree has a compose file (see [Docker-in-Docker](/containers/docker-in-docker.md)).

# Commands

| Command | Effect |
| --- | --- |
| `kunj ct forward [branch] <service>:<port>` | tunnels into the service container with whichever of socat, bash or nc it has (`TUNNEL_PROBE`); see [forwarding](/containers/forwarding.md) |
| `kunj ct logs [branch] [service] [--follow]` | the service's output; `--json` gives NDJSON `{ service, stream, line }` |
| `kunj ct list --json` | `services: [{ name, state, port }]` per container (`describeServices()`) |

`kunj ct blueprint init` notes that migrations belong in `maintain`, because `setup` only runs against
the [snapshot](/containers/snapshots.md)'s throwaway services.

# Related Concepts

* [Lifecycle](/containers/lifecycle.md) - start order, rollback, remove guard
* [Blueprints](/containers/blueprints.md) - `services` key
* [Forwarding](/containers/forwarding.md) - reaching a service port from the host
* [Prune](/containers/prune.md) - orphaned service containers and volumes
* [Images](/containers/images.md) - devcontainer support

# Citations

[1] [src/lib/container/services.ts](/src/lib/container/services.ts)
[2] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[3] [src/commands/container.ts](/src/commands/container.ts)
[4] [src/settings/container.ts](/src/settings/container.ts)
[5] [docs/specs/container-phase-2.md](/docs/specs/container-phase-2.md)
[6] [CLAUDE.md](/CLAUDE.md)
