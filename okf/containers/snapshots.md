---
type: Container
title: Blueprint Snapshots
description: The committed kunj-blueprint-<repo>:<hash> image a new branch container starts from, built from a host-made git bundle with no secrets, and how start finds, builds and provisions around it.
resource: src/lib/container/snapshot.ts
tags: [container, blueprint, snapshot, image]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A snapshot is a Docker image holding a [blueprint](/containers/blueprints.md)'s installed tools and a
checkout with `setup` already run, so a new branch container starts in seconds. It is built by an
ordinary `startContainer` of the default branch under the name `<branch>:snapshot`, whose `/workspace`
is copied to `/opt/kunj/seed` (`SEED_DIR`) and committed as `kunj-blueprint-<repo>:<hash>`.

`snapshot.ts` builds, ensures, reports and removes snapshots; `provision.ts` finds one for a start and
runs [presets](/containers/presets.md), `setup` and `maintain` around it. One snapshot is kept per
repository.

# Building

`planSnapshot()` makes the temporary start's options and the hash. The config strips everything private:
`env: []`, `keepFiles: false`, `files: []`, `publish: []`, `agentCommand: ''`, `mcp: {}`; plus
`hostEnv: {}`, `skipHooks`, `rebuild`, `noSnapshot`, `ignoreForwardPorts`, `withoutDind` (same DinD
image so the hash agrees, but no dockerd and no docker volume) and `namesFor: '<branch>:snapshot'`
(`:` is invalid in a ref, so no real branch collides). The base image and lockfile ref match a start.

`snapshotBlueprint()`:

```
reuse? ── tag exists and not --rebuild ──> return { reused: true }
makeBranchBundle(branch) on the host
removeContainer(<branch>:snapshot)            leftover of a killed run
startContainer(bundle)                        clone bundle, presets, setup
SEED_COPY_SCRIPT (root)                       cp -a /workspace /opt/kunj/seed, drop seed markers, chown
SNAPSHOT_READ_SCRIPT (root)                   HEAD sha + /etc/kunj/env
commitContainer(tag, blueprintLabels, ENV)    envChanges(): KEY=VALUE -> ENV, $ escaped
finally: bundle cleanup, remove temp container and its services
remove older kunj-blueprint-<repo> tags
```

Labels: `kunj.repo`, `kunj.blueprint.hash`, `kunj.blueprint.ref` (the commit), `.base`, `.user`,
`.createdAt`. `SnapshotResult` is `{ tag, hash, ref, base, sizeBytes, tools, reused, viaBundle }`.

# The bundle

The temporary container never gets a token. `makeBranchBundle()` fetches
`+refs/heads/<branch>:refs/remotes/origin/<branch>` on the host with its credentials (60 s timeout),
sets `refs/heads/<branch>` in a scratch bare repo that borrows the host's objects via `alternates`,
and runs `git bundle create` for that one ref. `StartOptions.bundle` streams it in as the sandbox user
to `BUNDLE_CONTAINER_PATH` (`/tmp/kunj-origin.bundle`); [seed](/containers/seed.md) clones it, resets
`origin` to the real URL and skips the fetch, and the file is removed before the commit. With a bundle,
start skips the SSH no-token refusal and the unpushed gate. `--no-bundle` clones origin in the
container instead (public origins only).

# Using a snapshot on start

| Step | Where | Behaviour |
| --- | --- | --- |
| build | `ensureStartSnapshot()` in container.ts, `ensureSnapshot(stale: 'rebuild')` | only for a new container (or `--rebuild`), not `--no-snapshot` or `--image`; builds when no image has the current hash; never throws |
| build failed | same | warns; falls back to the stale snapshot, else tools and `setup` in the container; `snapshotHandled` silences lifecycle's hints |
| lookup | `findSnapshot()` | exact hash, else newest repo snapshot marked `stale`, else null |
| hints | `resolveSource()` | `STALE_SNAPSHOT_HINT` or `noSnapshotHint()` unless handled |
| new, no snapshot | `provisionNew()` | presets as root, then `setup` as the user (`sh -lc`); first failure fails the start |
| new, from snapshot | seed copies `/opt/kunj/seed` | no clone; `maintain` runs |
| resume | `maintain()` | every start; skipped only when `setup` just ran; failure is a warning |

Resuming never builds a snapshot. Progress lines: `FIRST_SNAPSHOT_PROGRESS`
("…first use; this runs setup once…") and `STALE_SNAPSHOT_PROGRESS`.

# Commands

| Command | Behaviour |
| --- | --- |
| `kunj ct blueprint snapshot [--base <ref>] [--rebuild] [--no-bundle] [--blueprint <path>]` | builds ahead of time or forces a rebuild; prints tag, size, ref, installed tools |
| `kunj ct blueprint status` | `snapshotStatus()`: current image for the hash and the others |
| `kunj ct blueprint remove` | `removeSnapshots()`: every snapshot of the repo |
| `kunj ct prune` | removes snapshots of another hash and leftover `<branch>:snapshot` containers ([prune](/containers/prune.md)) |

# Guarantees

* No secret reaches the image: no env, keep files, files, token, agent or MCP config.
* Presets run as root, `setup`/`maintain` as the sandbox user, never the other way round.
* `/var/lib/docker` and `/tmp/kunj-presets` are never committed.
* `setup` has internet access behind the firewall, so a hostile `setup` on the default branch can
  still put anything into the snapshot (documented trust point).

# Related Concepts

* [Blueprints](/containers/blueprints.md) - file, hash, resolution
* [Presets](/containers/presets.md) - tool installs and `/etc/kunj/env`
* [Seed](/containers/seed.md) - `.kunj-seeded`, `.kunj-copying`, `.kunj-fresh`, bundle clone
* [Lifecycle](/containers/lifecycle.md) - `startContainer`, `removeContainer`
* [Tokens](/containers/tokens.md) - why the bundle exists
* [Docker-in-Docker](/containers/docker-in-docker.md) - `withoutDind`

# Citations

[1] [src/lib/container/snapshot.ts](/src/lib/container/snapshot.ts)
[2] [src/lib/container/provision.ts](/src/lib/container/provision.ts)
[3] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [src/lib/container/blueprint.ts](/src/lib/container/blueprint.ts)
[6] [docs/specs/blueprints.md](/docs/specs/blueprints.md)
[7] [CLAUDE.md](/CLAUDE.md)
