---
type: Container
title: Container Prune
description: kunj ct prune plans and removes branch containers whose branch left origin, orphaned Docker objects and superseded images, failing safe at every rule.
resource: src/lib/container/prune.ts
tags: [container, prune, cleanup, docker]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Branch containers, their volumes, snapshot images and old kunj images pile up (1-2 GB each).
`kunj ct prune` finds what kunj left behind in Docker for a repository (or every repository in
`~/.kunj/repos.json` with `--all`) and removes it. `planPrune()` builds a `PrunePlan`; `applyPrune()`
removes what is not marked `kept`.

Every rule fails safe: origin unreachable means no branch is gone, a branch the clone never saw on
origin is not gone, an unknown blueprint hash keeps every snapshot, an image in use is kept, and a
remove guard that cannot run keeps the container. The guard runs at plan time and again at removal.

# What is planned

| Category | Rule | Reason / kept |
| --- | --- | --- |
| branch container | branch missing from one `git ls-remote --heads origin` (15 s timeout, no prompt) and present in the clone's origin refs (`guard.originBranches`) | `branch-gone` |
| branch container | `container.pruneAfterDays` > 0, not running, created longer ago | `age` |
| snapshot build container | branch label ends `:snapshot`; exited/dead, created and never started past the grace, or live over a day | `snapshot-leftover` (no guard, no hooks) |
| orphan container/network | labelled repo + branch with no main container, nothing of that branch created in the last `ORPHAN_GRACE_MS` (10 min) | removed |
| orphan volume | same | `KEPT_VOLUME` unless `--force` |
| snapshot image | `kunj-blueprint-<repo>:*` with another `kunj.blueprint.hash`, not in use | only when the current hash is known |
| kunj image | `kunj-sandbox`, `kunj-nethelper`, `kunj-sandbox-dind` tags other than this version's, not in use | asked once with `--all` |

An empty `ls-remote` answer is treated as unreachable and adds a warning. A branch container with
guard problems (unpushed commits, stashes, uncommitted changes) is listed with `kept` unless `--force`.
Even with `--force` the guard runs for `branch-gone`, because it decides whether the branch was ever on
origin (a `start -c` branch never pushed is not gone). The orphan grace exists because a start
waits on service health checks for minutes before its main container exists.
`findOrphans()` decides by labels only, never by name (see [naming and labels](/containers/naming-and-labels.md)).

# Applying

`applyPrune()` order: branch containers, then orphan containers, volumes, networks (containers first,
since the others are in use until they go), then images. For each branch container (not a leftover)
and without `--force`, it re-runs `inspectForRemove()`; new work since the plan keeps it. It then runs
`pre-container-delete`, `removeContainer()` (with services and volumes) and `post-container-delete`
(see [container hooks](/containers/container-hooks.md)). Finally it drops forward-registry records of
containers that no longer exist (see [forwarding](/containers/forwarding.md)).

# Consent

| Flag | Effect |
| --- | --- |
| `--dry-run` | only print the plan |
| (no `--yes`, not a TTY, or `--json`) | dry run |
| (TTY, no `--yes`) | inquirer confirm `Remove N objects?`, default no |
| `-y, --yes` | remove without asking |
| `-f, --force` | skip the guard (not consent); also remove orphan volumes |
| `-a, --all` | every existing repo in the registry, planned from its own directory, one confirmation |
| `--no-hooks` | skip delete hooks |

`--json` prints `{ success, dryRun, plan, removed, failed }`; `plan` is the merged `PrunePlan`
(`containers`, `orphans`, `images`, `bytes`, `warnings`).

# Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `container.pruneAfterDays` | `0` (off) | also remove stopped containers created more than N days ago; the guard still applies |
| `container.allowPrivileged` | `false` | passed to the guard: a privileged DinD container is not started to check it when this is no longer true |

# Related Concepts

* [Lifecycle](/containers/lifecycle.md) - `inspectForRemove()`, `removeContainer()`, the remove guard
* [Snapshots](/containers/snapshots.md) - snapshot images and the temporary build container
* [Images](/containers/images.md) - kunj image tags per version
* [Docker-in-Docker](/containers/docker-in-docker.md) - the DinD image tag
* [Repository registry](/architecture/repo-identity-and-registry.md) - `--all`

# Citations

[1] [src/lib/container/prune.ts](/src/lib/container/prune.ts)
[2] [src/commands/container.ts](/src/commands/container.ts)
[3] [src/settings/container.ts](/src/settings/container.ts)
[4] [docs/specs/container-phase-2.md](/docs/specs/container-phase-2.md)
[5] [CLAUDE.md](/CLAUDE.md)
