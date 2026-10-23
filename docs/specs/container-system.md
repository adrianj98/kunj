<!-- On-disk copy of the Claude Doc "Kunj Container System Spec" (https://claude.ai/artifact/TmtL5VdNYr55VaddMSVEwk), rebuilt on 2026-10-23 from the edits made in Claude Code. Drawings are noted in italics. -->

# Kunj Container System Spec

2026-10-23 · Adrian Jones

## Goal and status

`kunj container` (alias `kunj ct`) runs a branch in its own Docker container with its own clone of the repo, the way `kunj worktree` gives a branch its own directory. The main use is a sandbox for an AI agent running with permissions skipped: it cannot touch the host's files, the host's `.git`, or other branches' containers. The same container serves a shell, an attached editor, and the app's dev server.

This document describes what is on `main` (commit 4b94e3a). Blueprints have their own document: [Blueprints Spec](https://claude.ai/artifact/FE8AfuYceDbFTguCDfWD86).

| Area | State |
| --- | --- |
| Sandbox containers: start, shell, exec, agent, attach, forward, list, stop, remove | Shipped |
| Network helper with firewall (default and allowlist modes) | Shipped |
| Blueprints and snapshots, including private origins | Shipped |
| Default zsh config and `KUNJ_*` env | Shipped |
| Phase 2 (see Container Phase 2 Spec): sidecar services, editor attach, auto port forwarding | Shipped |
| Phase 2: prune, Docker-in-Docker, host MCP bridge | Not started |
| Phase 3: workspace IDE (see `workspace-ide.md`) | Spec only, after phase 2 |
| VS Code extension and macOS app UI for containers | Not started |
| Remote Docker host (`kunj serve`) | Not started |

## Architecture

<?claude block dia?>

The CLI never runs `docker` itself; everything goes through `ContainerBackend`, so a remote Docker host can be added later without redesign. Code moves only through origin (and, for snapshots, a git bundle made on your Mac).

## Commands

`[branch]` defaults to the current branch; with no branch and a terminal, kunj offers a picker. Every command accepts `--json` (errors as `{ "error": { "code", "message" } }`) and `--context <name>` to pick a Docker context.

| Command | What it does |
| --- | --- |
| `kunj ct start [branch] [-c] [--base <ref>]` | Create or resume the branch's container. `-c` creates the branch from `origin/<base>` (default branch unless `--base`). |
| `… --image <img>` / `--rebuild` / `--publish 3000,5432` | Override the image; recreate the container keeping its volumes; publish ports on 127.0.0.1. |
| `… --no-snapshot` / `--keep-on-error` / `--no-hooks` | Ignore the blueprint snapshot; keep a failed start for debugging; skip hooks. |
| `kunj ct shell [branch]` | Login shell in `/workspace` as the sandbox user. |
| `kunj ct exec [branch] -- <cmd>` | Run one command; its exit code is passed through. |
| `kunj ct agent [branch] [-- <args>]` | Start or reattach the agent (`container.agentCommand`) in a tmux session named `agent`. |
| `kunj ct attach [branch]` | Reattach to that tmux session. |
| `kunj ct forward [branch] <port> …` | Forward `localhost` ports into the container until Ctrl-C. |
| `kunj ct list [--all] [--no-status]` | Containers of this repo, with agent state, ahead/dirty and ports. |
| `kunj ct stop [branch]` | Stop, keeping the workspace. |
| `kunj ct remove [branch] [--force] [--keep-volumes]` | Remove; refuses while work is unpushed unless `--force`. |
| `kunj ct blueprint init\|snapshot\|status\|remove` | Blueprints (see the Blueprints Spec). |

## Starting a container

A new container is started in this order. Nothing runs inside the branch container until its firewall reports ready.

1. **Resolve** the repo, origin and image. A container with the same name but other labels is refused. A branch with commits not yet on origin prompts to push them.
2. **Blueprint snapshot**: build it if needed (see the Blueprints Spec).
3. **Create** the network and two volumes (workspace and home).
4. **Run** the branch container with `--entrypoint sleep`, all capabilities dropped except `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID` and `SETGID`, and secrets passed only through an env file.
5. **Run the network helper** in the same network namespace; wait until it touches `/tmp/kunj-ready`.
6. **Seed** the workspace: copy from the snapshot, or clone from origin, then switch to the branch.
7. **Copy in** keep files and `container.files`.
8. **Provision**: presets and `setup` when there is no snapshot; `maintain` otherwise.
9. **Run** `postCreateCommand` once and `postStartCommand` every time.
10. **Hooks**: `post-container-create`.

**Resume.** An existing container is started, its helper is recreated (so the firewall is always re-applied) and `maintain` runs. Nothing is rebuilt.

**Rollback.** If any step fails, everything this run created is removed: containers, the helper, the network, and only the volumes this run created. A failed firewall stops the container even with `--keep-on-error`.

**Remove guard.** Before removing, kunj starts the container behind its firewall and checks every local branch, a detached HEAD, stashes and uncommitted changes against origin. Anything not pushed, or an origin it cannot reach, refuses without `--force`.

## Images and blueprints

The image is chosen in this order: `--image` or `container.image`, then a blueprint snapshot of the repo, then the repo's `.devcontainer/devcontainer.json`, then kunj's own `kunj-sandbox` image.

| Image | Contents |
| --- | --- |
| `kunj-sandbox` | Debian bookworm-slim, git, git-lfs, gh, Node 22, Claude Code, tmux, socat, zsh, user `dev` (uid 1000), no sudo, UTF-8 locale. About 1.15 GB. |
| devcontainer | Built from the branch's `devcontainer.json` (`image` or `build`). `remoteUser: root` is refused; build paths outside the repo are refused; a Dockerfile changed on the branch prints a warning because builds have network access. |
| `kunj-blueprint-<repo>:<hash>` | The base image plus the blueprint's tools and an installed copy of the repo at `/opt/kunj/seed`. |
| `kunj-nethelper` | Alpine with iptables, ipset and the firewall script. |

Kunj's own image tags include a hash of their build files, so a changed Dockerfile or firewall script is rebuilt automatically.

The repo is never baked into `kunj-sandbox` or a devcontainer image. It reaches the container through the workspace volume, cloned from origin or copied from a snapshot.

## Network and firewall

Each branch has its own Docker network, so containers of different branches cannot reach each other. The firewall lives in a separate helper container that shares the branch container's network namespace and holds `NET_ADMIN`; the branch container has no network capabilities and no sudo, so the agent cannot change the rules.

| Mode | Allowed | Blocked |
| --- | --- | --- |
| Default | The internet; origin on its own port, even on a private network | The Docker host, the gateway, `host.docker.internal`, private and link-local ranges, Tailscale `100.64/10` |
| Allowlist (`container.network.allow`) | Only the listed domains, origin, GitHub, `api.anthropic.com`, `registry.npmjs.org`, `nodejs.org`, and Bedrock when used | Everything else, plus everything blocked by default |
| `container.network.allowHost: true` | The host and private ranges as well | — |

In both modes DNS goes only to Docker's resolver, and IPv6 is filtered the same way (the helper refuses to start if IPv6 exists but cannot be filtered). In allowlist mode the addresses are re-resolved every 5 minutes, and the helper checks at start that `example.com` is blocked and origin is reachable.

The allowlist limits where traffic can go, not what it carries: anything forwarded into the container could still leave through an allowed destination.

## Credentials and settings

Only the host environment variables named in `container.env` are forwarded, and only when set. AWS keys go in only when `CLAUDE_CODE_USE_BEDROCK` is set. Your git name and email are always set. A GitHub or GitLab token is used through a credential helper that answers only for origin's host, so a push to another remote gets nothing. Credentials in the origin URL are stripped.

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…   # or ANTHROPIC_API_KEY, or Bedrock
export GH_TOKEN="$(gh auth token)"            # so the agent can push; a repo-scoped token is safer
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `container.image` | (none) | Image override |
| `container.agentCommand` | `claude --dangerously-skip-permissions` | What `kunj ct agent` runs |
| `container.env` | Claude auth, `AWS_REGION`, `GH_TOKEN` | Host variables forwarded when set |
| `container.files` | (none) | `hostPath:containerPath` files copied in at start |
| `container.keepFiles` | `true` | Copy the repo's keep files in |
| `container.network.allow` | (none) | Egress allowlist; empty means open internet |
| `container.network.allowHost` | `false` | Let the container reach the Docker host and private ranges |
| `container.dockerContext` | (none) | Docker context for every call |
| `container.cpus`, `container.memory` | (none) | Resource limits |
| `container.publish` | (none) | Ports always published at start |

## Ports, shell and agent

**Ports.** `kunj ct forward <port>` listens on `localhost` and tunnels each connection through `docker exec` to `socat` inside the container, so it reaches servers that bind only to the container's localhost and needs nothing set at start. The host port is the same number when free, otherwise the next free one. `--publish` maps ports statically at start instead; it is faster but the server must listen on `0.0.0.0`.

**Shell.** `kunj ct shell` opens a login zsh in `/workspace`. The container uses a UTF-8 locale and your terminal type, so full-screen tools render correctly. A default zsh config (prompt `kunj ▸ <branch> <dir> ❯`, shared history, completion, git aliases) and the variables `KUNJ_CONTAINER`, `KUNJ_BRANCH` and `KUNJ_REPO` are set in every container.

**Agent.** `kunj ct agent` runs `container.agentCommand` in a tmux session named `agent`, so it keeps running when you detach (Ctrl-b d) or your laptop sleeps. `kunj ct attach` reconnects.

**Editor.** Not built yet. VS Code can already attach to the container by name with the Dev Containers extension ("Attach to Running Container"); `kunj ct open` would automate that.

## Security model

| Protected | Not protected |
| --- | --- |
| Host files: nothing is bind-mounted; the workspace is a named volume. | Whatever you forward in: the agent can read every variable and file you pass and send it out. |
| Host `.git` and other branches: own clone per container, own network per branch. | Origin, within the token's scope: the agent can push wherever the token allows. Branch protection on `main` is the backstop. |
| Host services: gateway, `host.docker.internal`, LAN and private ranges blocked by default. | Data leaving through allowed destinations (GitHub, npm, DNS). |
| Host Docker daemon: the socket is never mounted. | Devcontainer images that give the user sudo: root inside the container (still no network capabilities). |
| Firewall integrity: rules live in a helper the agent cannot touch; nothing runs before they are applied. | Image builds from a devcontainer Dockerfile, which run with network access. |
| Snapshots: no forwarded variable or token ends up in a snapshot image. | A repo's own `.kunj/presets/*.sh`, which runs as root at snapshot time. |

Also fixed along the way: values substituted into `hooks.*` commands are now shell-quoted for their context, so a branch name cannot inject a command into a hook.

## Code map, state and tests

| File | Role |
| --- | --- |
| `src/commands/container.ts` | The `kunj ct` command; on the fast path (no AWS or LangChain imports) |
| `src/lib/container/backend.ts` | `ContainerBackend` interface: the only seam between kunj and Docker |
| `src/lib/container/docker.ts` | The only module that runs `docker` |
| `src/lib/container/lifecycle.ts`, `provision.ts` | Start, resume, remove guard, status, provisioning |
| `names.ts`, `env.ts`, `seed.ts`, `forward.ts` | Names and labels, forwarded env and firewall env, the seed script, port forwarding |
| `image.ts`, `devcontainer.ts` | Image choice and builds, the devcontainer subset |
| `blueprint.ts`, `presets.ts`, `infer.ts`, `snapshot.ts` | Blueprints |
| `src/container/sandbox/`, `nethelper/`, `presets/` | Image build files, firewall script, preset scripts |

**State.** There is no state file. Docker labels (`kunj.repo`, `kunj.branch`, `kunj.role`, `kunj.options`, …) are the only record. Names are `kunj-<repo>-<branch>-<hash>`; the hash keeps `feature/x` and `feature-x` apart.

**Tests.** `npm test` runs about 384 unit tests against a fake backend. `npm run test:docker` runs 17 end-to-end tests against real Docker (about 50 s): clone and seed, push, credential scoping, ports, firewall modes, rollback, remove guard, snapshots and bundles.

## Open items and roadmap

Comment on any of these to reorder or change them.

**Next (phase 2):**

- [ ] Sidecar services per branch (Postgres, Pulsar, Redis), from settings or the devcontainer's compose file.
- [ ] `kunj ct open`: attach VS Code or Cursor to the container.
- [ ] Copy the safe parts of `~/.claude` (CLAUDE.md, settings, skills, agents, commands) into containers; never session history or credentials.
- [ ] Run `kunj` itself inside the container, with your kunj config minus sensitive settings.
- [ ] Extra repos cloned next to the workspace (driveday's `../ideazone`).
- [ ] `kunj ct prune` for containers whose branch is gone.
- [ ] Docker-in-Docker (`sysbox`, or `privileged` in an isolated VM).

**Then (phase 3):** `forward --auto`, and containers in the VS Code extension and the macOS app.

**Later (phase 4):** a remote Docker host, first through a Docker context over SSH, then a `kunj serve` API.

**Known rough edges:**

- [ ] `agent`/`attach` always ask for a terminal, so `attach` without one reports "no session".
- [ ] Helpers or volumes left without their container do not show in `list` and cannot be removed with `kunj ct remove`.
- [ ] The remove guard has no timeout, and its checks trust the container's own record of what origin has.
- [ ] Exotic hook templates (arithmetic or unparenthesised `case` inside `$(…)`) can still be injected by a hostile branch name.
