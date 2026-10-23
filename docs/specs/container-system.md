# Kunj container system

*Umbrella for `kunj ct`. Checked against `main` on 2026-10-23. The design of each part is in its own
spec; this file says what exists, where the code is and what comes next.*

## What it is

`kunj container` (alias `kunj ct`) runs a branch in its own Docker container with its own clone of the
repo, the way `kunj worktree` gives a branch its own directory. The main use is a sandbox for an AI
agent running with permissions skipped: it cannot touch the host's files, the host's `.git`, or other
branches' containers. The same container serves a shell, an attached editor and the app's dev server.

*Drawing: CLI → `ContainerBackend` → Docker; per branch a container, its network helper, its sidecar
services and its own network; code moves only through origin (and, for snapshots, a git bundle made on
the host).*

## Status

| Feature | Status | Spec |
| --- | --- | --- |
| Sandbox containers: start, shell, exec, agent, attach, forward, list, stop, remove | Shipped | [branch-containers.md](branch-containers.md) |
| Network helper and firewall (default and allowlist modes, IPv6) | Shipped | [branch-containers.md](branch-containers.md) |
| Credentials by name, credential helper scoped to origin, hooks | Shipped | [branch-containers.md](branch-containers.md) |
| Default zsh config and `KUNJ_*` env | Shipped | [branch-containers.md](branch-containers.md) |
| Blueprints and snapshots, including private origins | Shipped | [blueprints.md](blueprints.md) |
| Sidecar services, `ct open`, `forward --auto`, `ct prune`, Docker-in-Docker | Shipped | [container-phase-2.md](container-phase-2.md) |
| `kunj ct file read\|write` (workspace files for the IDE) | Shipped | [workspace-ide.md](workspace-ide.md) |
| Host MCP bridge (a browser on the Mac for the agent) | Not started | [container-phase-2.md](container-phase-2.md) |
| Workspace IDE (phase 3) | CLI contract shipped; app proposed | [workspace-ide.md](workspace-ide.md) |
| Containers in the VS Code extension and the macOS app | Not started | — |
| Remote Docker host (`kunj serve`) | Not started | — |

## Rules every part follows

These are stated in full in [branch-containers.md](branch-containers.md); they are the invariants a
change must not break.

- Only `docker.ts` spawns `docker`; everything else programs against `ContainerBackend`.
- No host bind mounts; files are tar-streamed through `docker exec`.
- Secrets only in the `docker run` env file; never `docker exec -e`, never labels, never a snapshot.
- Docker labels (`kunj.*`) are the only state; reuse requires an exact label match.
- Nothing runs in the branch container before the network helper reports `/tmp/kunj-ready`; the branch
  container never gets `NET_ADMIN` or `NET_RAW`; port forwards exec in the helper, not the container.
- `container`/`ct` is on the fast path: light top-level imports, inquirer lazy, no AWS or LangChain.
- `kunj ct --json` errors are always `{ "error": { "code", "message" } }`; `list --json` changes are additive.

## Code map

| File | Role |
| --- | --- |
| `src/commands/container.ts` | The command |
| `src/lib/container/backend.ts`, `docker.ts` | Backend interface; the Docker CLI implementation |
| `src/lib/container/lifecycle.ts` | Start, resume, rollback, stop, remove guard, status |
| `src/lib/container/names.ts`, `env.ts`, `defaults.ts`, `errors.ts`, `seed.ts`, `forward.ts` | Names and labels, env, defaults, errors, seed, forwarding |
| `src/lib/container/image.ts`, `devcontainer.ts` | Image choice and builds |
| `src/lib/container/blueprint.ts`, `presets.ts`, `infer.ts`, `provision.ts`, `snapshot.ts` | Blueprints |
| `src/lib/container/services.ts`, `editor.ts`, `autoforward.ts`, `prune.ts`, `dind.ts` | Phase 2 |
| `src/lib/container/files.ts` | `kunj ct file` |
| `src/container/sandbox/`, `sandbox-dind/`, `nethelper/`, `presets/` | Image build contexts, firewall, preset scripts (copied to `dist/container`) |
| `src/settings/container.ts` | Settings |
| `src/lib/json-types.ts` | Published JSON shapes (`ContainerListJson`, `FileReadJson`, …) |

**Tests.** `npm test` runs the unit tests against `FakeBackend`. `npm run test:docker`
(`*.docker.test.ts`) drives a real Docker daemon, builds the images and checks the firewall; it skips
itself when Docker is unavailable.

## Roadmap

**Phase 2, left:** the host MCP bridge.

**Next:**

- Copy the safe parts of `~/.claude` (CLAUDE.md, settings, skills, agents, commands) into containers;
  never session history or credentials.
- Run `kunj` itself inside the container, with the user's kunj config minus sensitive settings.
- Extra repos cloned next to the workspace (driveday's `../ideazone`).
- Containers in the VS Code extension and the macOS app, reading `kunj ct list --json`.
- Phase 3, the workspace IDE: [workspace-ide.md](workspace-ide.md).

**Later (remote):** `container.dockerContext` over SSH validated end to end; then `kunj serve`, an
authenticated HTTP and WebSocket API exposing `ContainerBackend`, and a `RemoteKunjBackend`. Because
every Docker interaction is a stream through the backend and origin is the only git channel, it needs no
new git or file transfer design: `forward` tunnels over the service's WebSocket instead of
`docker exec`, and editor attach goes through Remote-SSH (`features.editorAttach` false until then).
Auth, TLS and multi-user get their own spec.

## Decisions

- **2026-10-21** Containers are independent of worktrees: a branch may have either, both or neither.
- **2026-10-21** The remote backend is a later addition, not a redesign: no shared filesystem assumed.
- **2026-10-23** Phase order: phase 2 (services, editor, auto forward, prune, Docker-in-Docker, MCP
  bridge) before the workspace IDE; `forward --auto` moved from the UI phase into phase 2.
