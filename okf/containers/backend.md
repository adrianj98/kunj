---
type: Container
title: Container Backend
description: ContainerBackend is the only seam between kunj and a container engine; LocalDockerBackend in docker.ts is the one module that spawns docker, and FakeBackend replaces it in unit tests.
resource: src/lib/container/backend.ts
tags: [container, docker, backend, testing]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Lifecycle, port forwarding, prune, services, snapshots and the `kunj ct` command all program against the
`ContainerBackend` interface in `src/lib/container/backend.ts`. The only implementation that touches a real
engine is `LocalDockerBackend` in `src/lib/container/docker.ts`, which is the only module in kunj that spawns
`docker`. The split exists so a remote backend can be added later and so the whole container system can be
unit tested in memory.

`kunj ct` builds one backend per invocation in `ContainerCommand.context()`:
`new LocalDockerBackend({ context: options.context || config.container?.dockerContext })`.

# The interface

| Group | Methods |
| --- | --- |
| Engine | `info()` (`EngineInfo`: `serverVersion`, `runtimes`, `operatingSystem`; throws `Docker is not available: ...`), `contextName()`, `features` |
| Images | `imageExists`, `buildImage(tag, contextTar, { dockerfile, buildArgs })`, `commitContainer(id, tag, labels, changes?)`, `listImages(filter, { references? })`, `removeImage` (idempotent) |
| Networks and volumes | `createNetwork`, `createVolume`, `volumeExists`, `listVolumes(filter)`, `listNetworks(filter)` (return `LabelledObject` with exact labels and `createdAt`) |
| Containers | `run(spec)`, `list(filter)`, `inspectLabels(name)`, `containerState(id)`, `containerRun(id)` (state + `startedAt`), `start`, `stop`, `remove({ containers, volumes, networks })` |
| Exec and I/O | `exec(id, cmd, io)` returns `{ exitCode, stdout }` (non-zero is returned, not thrown), `copyIn`, `logs(id, { follow, tail, onLine })` |
| Other | `composeConfig(yamlText)`, `events(filter, onEvent, signal)` |

`features` is `{ localPorts, editorAttach, dockerInDocker: Array<'sysbox' | 'privileged'> }`. `ExecIO` carries
`stdin`, `stdout`, `stderr`, `tty`, `user`, `workdir`, `env` and `timeoutMs`; a timeout rejects with
`ExecTimeoutError`. `ContainerSpec` describes one `docker run`: name, image, labels, env, network or
`networkOf`, aliases, user, workdir, volumes, publish, cpus, memory, `capDrop`/`capabilities`,
`securityOpt`, `runtime`, `privileged`, `extraHosts`, `init`, `entrypoint`, `command`.

`IMAGE_REF` / `isImageRef()` reject image references that are empty, start with `-` or contain spaces, since
the image is a positional argument that would otherwise be read as a flag.

# LocalDockerBackend

Every call is an argv array, never a shell. Notable behaviour:

| Behaviour | Detail |
| --- | --- |
| Context | `--context <name>` is prepended to every call when set |
| `run()` | Env goes into a temp `--env-file` (mode 0600, in `mkdtemp` `kunj-env-*`, deleted afterwards), so values never appear in `ps`; a key or value with a newline is refused |
| `runArgs()` | Labels sorted; `--network container:<id>` for `networkOf`; `-p 127.0.0.1:<host>:<container>` (loopback only); `--cap-drop` before `--cap-add`; `--entrypoint` takes `entrypoint[0]`, the rest go before `command` |
| `list()` | Two subprocesses whatever the count: `ps -a` for ids, then one `inspect` for exact labels and ports (`ps` mangles labels containing commas) |
| `listVolumes/Networks` | `ls` with label filters, then one `inspect` for exact labels |
| Errors | `docker <sub> failed: <first line>`; `kunj ct` then asks `info()` once to explain a down daemon (`explainDockerError`) |
| `buildImage` | The context is streamed on stdin; output echoed to stderr so `--json` stdout stays clean |
| `composeConfig` | `docker compose config --no-interpolate` in an empty temp project with a reduced env (`COMPOSE_ENV_KEYS`) |
| `killChildren()` | Ends every docker child still running; used by `kunj events` and `abortDockerCalls()` |

`exec` passes `io.env` with `-e`, which is why secrets never go through it: `kunj ct` only passes `TERM`,
`COLORTERM` and `LANG` there (see [Env and status](/containers/env-and-status.md)).

# FakeBackend

`src/lib/container/__tests__/fake-backend.ts` is an in-memory `ContainerBackend` that records every call in
`calls` (`methods()`, `callsOf(method)`). Tests program it through public fields: `execResults` and
`execErrors` keyed by `cmd.join(' ')`, `hangOn` (timeouts), `failOn` (a method that throws), `existing`
containers, `existingImages`, `images`, `volumes`, `networks`, `composeConfigs`, `states`, `startedAt`,
`createdAt`, `infoResult`, `context`, `execHandler` for streaming tests, and `emitEvent()` for `events()`.
Constants `FAKE_STARTED_AT` and `OLD_CREATED_AT` (older than prune's grace period) are exported. Unknown
exec commands exit 0 with no output. `npm test` runs every container unit test against it; the Docker
suite and functional tests use the real daemon (see [Testing](/architecture/testing.md)).

# Related Concepts

* [Branch Containers](/containers/overview.md)
* [Container Lifecycle](/containers/lifecycle.md)
* [Naming and Labels](/containers/naming-and-labels.md)
* [Events stream](/features/events-stream.md) - uses `events()` and `killChildren()`
* [Testing](/architecture/testing.md)

# Citations

[1] [src/lib/container/backend.ts](/src/lib/container/backend.ts)
[2] [src/lib/container/docker.ts](/src/lib/container/docker.ts)
[3] [src/lib/container/__tests__/fake-backend.ts](/src/lib/container/__tests__/fake-backend.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [docs/specs/container-system.md](/docs/specs/container-system.md)
