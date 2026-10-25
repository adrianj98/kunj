---
type: Container
title: Container Lifecycle
description: How kunj starts, resumes, stops and removes a branch container, with READY gating, dropped capabilities, rollback on failure and the unpushed-work remove guard.
resource: src/lib/container/lifecycle.ts
tags: [container, lifecycle, firewall, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`src/lib/container/lifecycle.ts` holds `startContainer`, its private `resume`, `stopContainer`,
`inspectForRemove`, `removeContainer`, `needsResume` and `containerStatus`. It programs only against
[ContainerBackend](/containers/backend.md), so it is tested with `FakeBackend`; host-side git (origin
checks, devcontainer reads with `git show`) runs here too.

`kunj ct start` calls it through `ContainerCommand.startOrResume()`, which first decides whether the start
will create (`--rebuild` or no container by that name), prechecks Docker-in-Docker, loads container secrets,
runs `pre-container-create`, builds a missing or stale blueprint snapshot, then calls `startContainer` and
finally `post-container-create` (see [Container hooks](/containers/container-hooks.md)).

# New container

```
info -> label check (collision) -> inspectOrigin -> secrets/env -> [resume if it exists]
  -> dind checks -> SSH no-token / base-missing / unpushed (push prompt)
  -> resolve image + blueprint + services -> build/ensure images (+ helper image)
  -> network, volumes -> services -> docker run main (sleep infinity)
  -> docker run helper -> wait for /tmp/kunj-ready  (READY)
  -> dockerd (dind) -> seed -> keep files, container.files, secret files, MCP config
  -> presets + setup, or maintain -> postCreate/postStartCommand
```

| Step | Detail |
| --- | --- |
| Origin | `inspectOrigin()`; no host is `origin`. SSH origin without a token (and no bundle) is `no-token` |
| `-c` | `base-missing` unless `--base`/default exists on origin (`refExistsOnOrigin`) |
| Unpushed | Branch absent from origin or ahead: `confirmPush()` (TTY only) pushes, else `unpushed` |
| Images | See [Images](/containers/images.md); `--rebuild` rebuilds and removes the old main and helper, keeping volumes |
| Ports | `--publish`, `container.publish`, devcontainer `forwardPorts`; `mapPorts()` picks a free host port from the same number up |
| Main spec | `--entrypoint sleep infinity`, `--init`, `capDrop: ['ALL']` + `MAIN_CAPABILITIES`, `extraHosts: host.docker.internal:host-gateway`, `/workspace` and home volumes, cpus/memory |
| Main env | devcontainer `containerEnv`, then forwarded env and tokens, then `KUNJ_CREDENTIAL_HOST`, `KUNJ_CONTAINER=1`, `KUNJ_BRANCH`, `KUNJ_REPO`, `KUNJ_DIND` last so the branch cannot spoof them |
| Checks after READY | `checkImage()`: a devcontainer's `remoteUser` must exist and not be uid 0; warns when git, tmux or socat are missing |
| Seed | `seedIfNeeded()` unless `/workspace/.kunj-seeded` exists (see [Seed](/containers/seed.md)) |
| Files | Keep files into `/workspace` (unless `container.keepFiles` is false), `container.files` (`hostPath:containerPath`, relative targets under the home), secret files (0600, added to `.git/info/exclude`) |
| postCreateCommand | Once, marked by `$HOME/.kunj-created`; failure warns and retries next start |

# MAIN_CAPABILITIES and READY

`MAIN_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID']`. Everything else is dropped,
NET_RAW above all (an AF_PACKET socket would skip the helper's OUTPUT rules). Docker-in-Docker replaces this
with `--runtime sysbox-runc` or `--privileged`.

The image's ENTRYPOINT (branch-controlled for a devcontainer) is replaced by `sleep`, so nothing of the
image runs before the firewall. `waitForHelper()` polls `test -f /tmp/kunj-ready` in the helper every 300 ms
for up to 20 s (`firewall` error otherwise). Nothing is exec'd in main before that, because the firewall
accepts established connections and anything opened earlier would outlive the rules.

# Rollback

`startContainer` lists what it created (`created.containers/volumes/networks`, the main container listed
before `run`). On failure it removes exactly those, never volumes that existed before (`--keep-volumes`,
`--rebuild`). With `--keep-on-error` it keeps them but still stops a main container that ran without its
firewall. Each step wraps errors in `StartError` with a code via `step()`.

# Resume

An existing container is resumed whatever origin now has. `resume()` reads `kunj.options`, warns when the
`kunj.secrets` stamp differs (`secretsRebuildHint`: env secrets need `--rebuild`), refuses a recorded
Docker-in-Docker mode that can no longer run (`checkRecordedDind`), starts stopped services and creates newly
declared ones, then `bringUp()`: start main if stopped, always remove and recreate the helper (a stale ready
file survives a restart, the rules do not), wait for READY. A running main with a running helper on the
current `kunj-nethelper` tag is left alone (secret files re-rendered); `kunj ct open` passes
`keepStaleHelper` so an out-of-date running helper is also kept. Before replacing a running main's helper,
`stopHelperUsers()` SIGTERMs registered forwarders and MCP bridges (checked with `ps` to be
`ct|container forward|mcp`). After READY a stopped container is re-seeded if never seeded, `maintain` runs
and `postStartCommand` runs. On failure a container left without its firewall is stopped
(`Stopped <name>: its firewall could not be re-applied`), and only services this call started are stopped.

`needsResume(found, names)` is true when main, its helper or a service is not running.

# Stop and remove

`stopContainer()` stops the helper first (the rules live in the namespace), then main, then its services.

`removeContainer()` runs `inspectForRemove()` unless `--force`: a stopped container is brought up behind
its recorded `helperEnv` (refused with no recorded env, or for a `privileged` one once
`container.allowPrivileged` is no longer true), `GUARD_SCRIPT` runs with `SAFE_GIT`, then
`git ls-remote --exit-code origin HEAD` (15 s) checks reachability, and the container is stopped again.
`describeGuard()` reports unpushed refs (detached HEAD counts), stashes, uncommitted tracked changes,
unreadable git sections (fail closed) and an unreachable origin. Untracked files are not protected. Removal
deletes main, helper, services, the `-ws`, `-home`, `-docker` and service volumes (unless
`--keep-volumes`) and the network. `kunj ct remove` runs the guard itself so each problem prints on its own
line, then `pre-container-delete`, removal with `force: true`, `post-container-delete`.

# Related Concepts

* [Network helper and firewall](/containers/network-helper-firewall.md)
* [Naming and labels](/containers/naming-and-labels.md)
* [Seed](/containers/seed.md), [Images](/containers/images.md), [Tokens](/containers/tokens.md)
* [Services](/containers/services.md), [Snapshots](/containers/snapshots.md), [Docker-in-Docker](/containers/docker-in-docker.md)
* [Secrets delivery](/secrets/resolution-and-delivery.md)
* [Prune](/containers/prune.md) - reuses the remove guard

# Citations

[1] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[2] [src/lib/container/env.ts](/src/lib/container/env.ts)
[3] [src/lib/container/errors.ts](/src/lib/container/errors.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
