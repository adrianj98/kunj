---
type: Container
title: Container Naming and Labels
description: How branch containers, helpers, volumes and networks are named, and the kunj.* Docker labels that are the container system's only state.
resource: src/lib/container/names.ts
tags: [container, docker, labels, naming, state]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The container system keeps no state file. Everything kunj needs to find, resume, list, guard or prune a
branch container is in the names and `kunj.*` labels of the Docker objects themselves, written once at
`docker run` time. `src/lib/container/names.ts` defines both.

Names must be unique per repository and branch, but `branchToDirName` collapses `feature/x` and `feature-x`
and repository names are not unique. So every name carries a short hash of the full repo id and exact
branch name, and a reused object must also match its labels exactly.

# Repo id

`repoIdFromUrl(url)` normalises origin's URL (or the repo root when there is no origin) so ssh and https
forms of one repository give the same id: lowercase, scheme and `user@` stripped, scp-like `host:path`
turned into `host/path`, trailing `/` and `.git` removed. `kunj ct` strips credentials from the URL first
(`stripUserinfo`).

# Names

`containerNames(repoName, repoId, branch)` builds `kunj-<readable>-<hash>`:

* `<readable>` is `dockerSafe("<repo>-<branchToDirName(branch)>")`, capped at `MAX_READABLE` = 40 characters
  so `<container>-net-helper` stays under 64.
* `<hash>` is `nameHash(repoId, branch)`: the first 6 hex of `sha1("<repoId>\n<branch>")`.

`namesOfContainer(container)` derives the rest from the container name (so they survive a renamed
repository):

| Field | Name | Use |
| --- | --- | --- |
| `container` | `kunj-<readable>-<h>` | The branch (main) container |
| `helper` | `<container>-net-helper` | [Network helper](/containers/network-helper-firewall.md) |
| `workspaceVolume` | `<container>-ws` | `/workspace` |
| `homeVolume` | `<container>-home` | The user's home, when the image user is known |
| `dockerVolume` | `<container>-docker` | `/var/lib/docker` for [Docker-in-Docker](/containers/docker-in-docker.md) |
| `network` | `<container>-net` | The branch's own network |

Service containers are `<container>-svc-<name>` (see [Services](/containers/services.md)). Host tmux
sessions for worktree agents reuse the container name via `agentSessionName()` (see
[Worktree agents](/features/worktree-agents.md)).

# Labels

The `LABEL` constant:

| Key | Value |
| --- | --- |
| `kunj.repo` | Repo id |
| `kunj.branch` | Exact branch name (the snapshot's temporary container uses `namesFor`) |
| `kunj.base` | Base ref of a branch created with `-c` (main only) |
| `kunj.version` | kunj version that created the object |
| `kunj.role` | `main`, `helper` or `service` |
| `kunj.service` | A service's declared name |
| `kunj.options` | JSON of the run options (main and services) |
| `kunj.blueprint.hash/ref/base/user/createdAt` | On snapshot images (see [Snapshots](/containers/snapshots.md)) |
| `kunj.secrets` | Vault stamp at creation: a hash of ciphertext, never a value |

`labelsFor(repoId, branch, extra)` builds the base pair; networks and volumes get it plus `kunj.version`.
`labelsMatch(labels, repoId, branch)` compares exactly: `startContainer` refuses with `StartError` code
`collision` when a container of the computed name exists with other labels. `isMain(c)` reads `kunj.role`,
falling back to "name does not end in `-net-helper`" for containers from before the role label.

# kunj.options

The main container's `kunj.options` records what a resume, the remove guard and `list` need even after the
branch is gone from origin. Read with `optionsLabel()` (`{}` when absent or unreadable).

```json
{ "firewall": "default", "allowHost": false, "publish": [{ "container": 3000, "host": 3000 }],
  "helperEnv": { "KUNJ_FW_MODE": "default", "...": "..." }, "user": "dev",
  "postCreateCommand": "...", "postStartCommand": "...", "imageKind": "sandbox",
  "blueprintHash": "...", "dind": "sysbox" }
```

`helperEnv` lets a stopped container be brought up behind its firewall again; `user` `''` means the image's
own USER (no `-u` is passed). Env values, secrets and tokens are never in labels.

# Related Concepts

* [Container Lifecycle](/containers/lifecycle.md)
* [Container Backend](/containers/backend.md) - `list(filter)` by labels
* [Prune](/containers/prune.md) - finds orphans by labels
* [Repo identity](/architecture/repo-identity-and-registry.md)

# Citations

[1] [src/lib/container/names.ts](/src/lib/container/names.ts)
[2] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[3] [src/commands/container.ts](/src/commands/container.ts)
[4] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
