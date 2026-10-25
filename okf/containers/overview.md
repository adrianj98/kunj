---
type: Container
title: Branch Containers
description: kunj container (alias ct) runs a branch in a sandboxed Docker container with its own clone of the repository, mainly so an agent can run with permissions skipped.
resource: src/commands/container.ts
tags: [container, docker, sandbox, agent, overview]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj container` (alias `kunj ct`) gives a branch its own Docker container, the way `kunj worktree` gives it
its own directory. The container holds its own clone of the repository in a named volume, so an AI agent
started inside with `claude --dangerously-skip-permissions` (the default `container.agentCommand`) cannot
touch the host's files, the host's `.git` or other branches' containers. The same container serves a
shell, an attached editor and the app's dev server.

Origin is the only channel in and out: nothing from the host is bind-mounted. Work reaches the container by
cloning from origin (or, for a blueprint snapshot, a git bundle the host made) and leaves it by `git push`.
Files kunj itself copies in (keep files, `container.files`, the credential helper, secret files) are
tar-streamed through `docker exec`.

The command lives in `src/commands/container.ts`, the library in `src/lib/container/`, and the image build
contexts in `src/container/`. `container` and `ct` are on the [fast path](/architecture/fast-path.md), so the
module keeps top-level imports light and loads inquirer, secrets and `worktree.ts` lazily.

# Actions

| Action | What it does | Concept |
| --- | --- | --- |
| `start [branch] [-c] [--base] [--image] [--publish] [--rebuild] [--no-snapshot] [--keep-on-error]` | Create or resume the branch's container | [Lifecycle](/containers/lifecycle.md) |
| `shell [branch] [--session <id>] [--kill]` | Login shell in `/workspace`, optionally in tmux session `sh-<id>` | [Persistent shells](/features/persistent-shells.md) |
| `exec [branch] -- <cmd...>` | Run a command in the container | [Env and status](/containers/env-and-status.md) |
| `agent [branch] [-- <args>] [--session <id>] [--kill]` | Agent in tmux session `agent` or `agent-<id>` | [Container agents](/containers/container-agents.md) |
| `attach [branch] [--session <id>]` | Reattach to an agent session | [Container agents](/containers/container-agents.md) |
| `open [branch] [--new-window]` | Attach VS Code / Cursor, resuming first if needed | [Editor open](/containers/editor-open.md) |
| `forward [branch] <port>...`, `forward --auto [--detach]` | Forward localhost ports | [Forwarding](/containers/forwarding.md) |
| `mcp [branch]` | Bridge host MCP servers (foreground) | [MCP bridge](/containers/mcp-bridge.md) |
| `logs [branch] [service] [--follow]` | Container or service output (NDJSON with `--json`) | [Services](/containers/services.md) |
| `list [--all] [--no-status]` | The repository's containers (default action) | [Env and status](/containers/env-and-status.md) |
| `stop [branch]` / `remove [branch] [--force] [--keep-volumes]` | Stop; remove behind the unpushed-work guard | [Lifecycle](/containers/lifecycle.md) |
| `prune [--all] [--dry-run] [--force] [--yes]` | Remove containers of gone branches, orphans, old images | [Prune](/containers/prune.md) |
| `blueprint init\|snapshot\|status\|remove` | How a new container is set up | [Blueprints](/containers/blueprints.md), [Snapshots](/containers/snapshots.md) |
| `file read\|write [branch] <path>` | Text file access in `/workspace` | [Files](/containers/files.md) |
| `token status` | Where a new container's GitHub token comes from | [Tokens](/containers/tokens.md) |

`[branch]` defaults to the current branch, else (TTY only) a picker of the repository's containers or
origin's branches. `--context <name>` (default `container.dockerContext`) selects the Docker context.

# Security model

| Rule | Where |
| --- | --- |
| Only `docker.ts` spawns `docker`; everything else uses `ContainerBackend` | [Backend](/containers/backend.md) |
| `kunj.*` labels on Docker objects are the only state; reuse needs an exact label match | [Naming and labels](/containers/naming-and-labels.md) |
| The main container runs `sleep`; nothing is exec'd in it before the helper touches `/tmp/kunj-ready` | [Lifecycle](/containers/lifecycle.md) |
| Main keeps only `MAIN_CAPABILITIES` (no `NET_ADMIN`/`NET_RAW`); the helper owns the firewall | [Network helper and firewall](/containers/network-helper-firewall.md) |
| Secrets travel only in the `docker run` env-file, never `docker exec -e`, labels or snapshots | [Env and status](/containers/env-and-status.md), [Secrets](/secrets/overview.md) |
| The credential helper answers only for origin's `host[:port]` | [Tokens](/containers/tokens.md) |
| Published ports bind `127.0.0.1` only | [Backend](/containers/backend.md) |
| A devcontainer `remoteUser` of root is refused | [Images](/containers/images.md) |

Not protected: anything forwarded in (env, files, tokens) can be read by the agent and, with network access,
sent anywhere; an allowlist limits destinations, not data. Image builds from a devcontainer Dockerfile run
with full network access. [Docker-in-Docker](/containers/docker-in-docker.md) weakens the model.

# Module map

| Module | Role |
| --- | --- |
| `backend.ts`, `docker.ts` | Engine interface and the local Docker implementation |
| `names.ts` | Object names, `LABEL` keys, label matching |
| `lifecycle.ts` | `startContainer`, resume, `stopContainer`, `removeContainer`, `containerStatus` |
| `image.ts`, `devcontainer.ts` | Image resolution, builds, asset hashes, devcontainer parsing |
| `seed.ts` | Origin inspection and the clone script |
| `env.ts`, `tokens.ts` | Forwarded env, firewall env, `STATUS_SCRIPT`, remove guard, gh token |
| `editor.ts`, `files.ts`, `errors.ts`, `defaults.ts` | Editor attach, workspace files, error types, setting defaults |
| `services.ts`, `forward.ts`, `autoforward.ts`, `prune.ts`, `dind.ts`, `mcpbridge.ts` | Phase 2 pieces |
| `blueprint.ts`, `presets.ts`, `infer.ts`, `provision.ts`, `snapshot.ts` | Blueprints and snapshots |

Errors: a failed start throws `StartError` with a `StartErrorCode`; expected outcomes throw `ContainerError`.
With `--json`, `kunj ct` always prints `{ "error": { "code", "message" } }` (code: the start code, `hook`, the
error's `jsonCode`, else `error`).

# Related Concepts

* [Container Backend](/containers/backend.md)
* [Container Lifecycle](/containers/lifecycle.md)
* [Container Hooks](/containers/container-hooks.md)
* [Container settings](/architecture/settings-registry.md) - `src/settings/container.ts`
* [Worktrees](/features/worktrees.md) - the host-side counterpart
* [JSON contract](/architecture/json-contract.md) - `ContainerListJson` and friends

# Citations

[1] [src/commands/container.ts](/src/commands/container.ts)
[2] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[3] [src/lib/container/errors.ts](/src/lib/container/errors.ts)
[4] [src/lib/container/defaults.ts](/src/lib/container/defaults.ts)
[5] [src/settings/container.ts](/src/settings/container.ts)
[6] [docs/specs/container-system.md](/docs/specs/container-system.md)
[7] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
[8] [CLAUDE.md](/CLAUDE.md)
