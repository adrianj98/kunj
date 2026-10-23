<!-- On-disk copy of the Claude Doc "Container Phase 2 Spec" (https://claude.ai/artifact/77f7sDBjgq8ZTZbnfpXPUA), rebuilt on 2026-10-23 from the edits made in Claude Code. Drawings are noted in italics. -->

# Container Phase 2 Spec

2026-10-23 · Adrian Jones

## Goal, scope and order

Phase 2 makes a branch container usable for real projects: their databases run next to them, the editor opens inside them, dev servers are reachable without thinking about ports, and old containers clean themselves up. It builds on what is on `main` (see the [Kunj Container System Spec](https://claude.ai/artifact/TmtL5VdNYr55VaddMSVEwk)).

**Progress** (updated as each feature lands on `main`; plan in `docs/superpowers/plans/2026-10-23-container-phase-2.md`):

| Feature | Status |
| --- | --- |
| Sidecar services | Shipped (ed136b3, 6273c61) |
| Editor attach | Shipped (93b7ed3, f635113) |
| Auto port forwarding | Shipped (5710902, b88466c) |
| Prune | Shipped (893dc79, 4f7aa10) |
| Docker-in-Docker | Not started |
| Host MCP bridge | Not started |

| # | Feature | Why it matters | Size |
| --- | --- | --- | --- |
| 1 | Sidecar services | alertd-core needs Postgres and Pulsar; driveday needs Supabase's Postgres. Without them the agent cannot run tests. | Large |
| 2 | Editor attach (`kunj ct open`) | Lets you work in the same container the agent uses. | Small |
| 3 | Auto port forwarding | Dev servers just appear on localhost; the apps can show them. | Medium |
| 4 | Prune | Containers, volumes and snapshots pile up (1–2 GB each). | Small |
| 5 | Docker-in-Docker | For repos whose tests run `docker compose` themselves. Weakens isolation, so it is opt-in and last. | Medium |

The proposed order is the table order: services first because they unblock real use, Docker-in-Docker fifth because sidecars cover most of its cases more safely; all five are in this phase, plus a sixth: a bridge to MCP servers on your Mac, so the agent can drive a local browser.

## Sidecar services

Each branch gets its own instances of the services the project needs, running as extra containers on the branch's network. The agent reaches them by name (`postgres:5432`); other branches and your Mac cannot, unless you forward a port.

**Where services are declared** (first match wins, merged by name):

1. `services` in the blueprint (committed, shared with the team).
2. `container.services` in your kunj config.
3. The devcontainer's `docker-compose.yml`, when `devcontainer.json` names one: its `services` are imported, except the one the devcontainer runs in.

```jsonc
"services": {
  "postgres": { "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "dev" }, "port": 5432,
                "healthcheck": "pg_isready -U postgres" },
  "pulsar":   { "image": "apachepulsar/pulsar:3.3.0", "command": ["bin/pulsar", "standalone"], "port": 6650 }
}
```

**Supported keys:** `image`, `env`, `command`, `port` (for the forward and the readiness check), `healthcheck` (a command run inside the service), `volumes` (named paths only, never host paths), `dependsOn`. Compose import maps the same keys and ignores host bind mounts, `privileged`, `cap_add`, `network_mode` and `ports` with a warning.

**Lifecycle:**

- `start` creates each service before the branch container, waits for its health check (timeout 120 s, then a warning, not a failure), and records it with labels (`kunj.role=service`).
- Data lives in a per-branch volume per service, so every branch has its own database.
- `stop` stops services with the container; `remove` deletes them and their volumes (the same unpushed-work guard applies to the branch, not to service data).
- `list` shows each service's state; `kunj ct logs <branch> <service>` shows its logs.

**Blueprints.** Services are not part of the snapshot (they are separate containers), but a blueprint's `setup` can rely on them: during a snapshot build the services start first, so `setup` can run migrations. Their data is not kept in the snapshot.

**Firewall.** Service containers are on the branch network and reachable from the agent. They get no forwarded environment and no host access. Their own outbound traffic is not filtered in this phase (decision below).

## Editor attach (`kunj ct open`)

`kunj ct open [branch] [--new-window]` opens your editor inside the branch's container, at `/workspace`, as the sandbox user.

- **How:** launches `worktree.editorCommand` (default `code`; `cursor` works the same) with `--folder-uri vscode-remote://attached-container+<hex>/workspace`, where `<hex>` is the hex-encoded JSON `{"containerName":"/<container>"}`. The exact encoding is checked against current VS Code and Cursor before shipping.
- **Requires** the Dev Containers extension. Without it, `open` prints how to install it.
- **User:** VS Code attaches as the image's user; kunj writes the attached-container config (`remoteUser`, `workspaceFolder`) into the editor's per-image config so it opens as `dev` in `/workspace`.
- **Extensions:** the editor installs its server and extensions inside the container on first attach (needs internet; works in default mode; in allowlist mode the VS Code marketplace domains must be allowed — `open` warns).
- **Ports:** the editor forwards ports itself, alongside `kunj ct forward`.
- **Apps:** the VS Code extension and macOS app get an "Open in container" action using the same command.

The container must be running; `open` starts it if stopped.

## Prune

`kunj ct prune [--all] [--dry-run] [--force]` removes what is no longer needed and reports what it freed.

| Removed | When |
| --- | --- |
| A branch container (with its helper, services, volumes, network) | Its branch no longer exists on origin and the remove guard finds no unpushed work, or `--force` |
| Orphans: a helper, service, volume or network labelled for this repo with no branch container | Always |
| Old snapshot images and kunj's own superseded `kunj-sandbox` / `kunj-nethelper` tags | Always (not the current ones) |
| Stopped containers older than `container.pruneAfterDays` (default off) | When set |

- `--dry-run` lists what would go and how much space it frees; it is the default when not in a terminal.
- `--all` covers every repo kunj knows (`~/.kunj/repos.json`), not just the current one.
- A merged branch deleted on GitHub with commits that exist only in the container is **kept** and reported, because the guard sees unpushed work; `--force` overrides.
- `list` also starts showing orphans (helpers or volumes without their container), so they are visible before a prune.

## Docker-in-Docker

For repos whose own scripts run `docker` or `docker compose`, the branch container can run its own Docker daemon. Every branch then has a separate daemon, so two branches running the same compose file never clash (same project names, ports and volumes are fine).

`container.dockerInDocker: off | sysbox | privileged` (default `off`):

| Mode | How | Isolation | Where it works |
| --- | --- | --- | --- |
| `off` | No daemon; use sidecar services | Full | Everywhere |
| `sysbox` | `--runtime sysbox-runc`, `dockerd` inside | Strong | Linux hosts with sysbox installed (checked with `docker info`) |
| `privileged` | `--privileged`, `dockerd` inside | Weak: an escape reaches the Docker host's VM | Anywhere, but only allowed with `container.allowPrivileged: true` |

**Rules:**

- The inner daemon's data lives in a per-branch volume (`/var/lib/docker`), removed with the container. Expect a few GB per branch.
- The firewall still applies; Docker Hub, its CDN and `ghcr.io` are added to the allowlist automatically.
- `privileged` on Docker Desktop's default VM is refused even with `allowPrivileged`, because that VM shares your home directory. The README documents a dedicated Colima or OrbStack profile with file sharing off, selected with `container.dockerContext`.
- Capabilities are not dropped in these modes (the daemon needs them); `list` marks such containers clearly.
- When a repo has a compose file and Docker-in-Docker is off, `start` suggests sidecar services first.

## Auto port forwarding

`kunj ct forward [branch] --auto` watches the container and forwards every port that starts listening, the way VS Code does.

- **Detection:** one `docker exec ss -ltnH` every 2 seconds; new listeners get a forward, closed ones are dropped. Ports below 1024 and the agent's own internal ports (a configurable ignore list, `container.forward.ignore`) are skipped.
- **Host port:** the same number when free, otherwise the next free one. Two branches both serving on 3000 become `localhost:3000` and `localhost:3001`.
- **Registry:** active forwards are recorded in `~/.kunj/container-forwards.json` with the process id, like editor sessions. Dead processes are pruned on read.
- **List:** `kunj ct list --json` gains `ports: [{ container, host, kind: "forward" | "publish", pid }]`, so the VS Code extension and macOS app can show "feat-a → localhost:3001" and open it.
- **Background:** `--auto --detach` runs the forwarder in the background (a small kunj process that exits when the container stops). `kunj ct agent` starts it automatically by default; `container.forward.auto: true` turns that off.
- **Services:** sidecar ports are not auto-forwarded; `kunj ct forward <branch> postgres:5432` forwards a service port explicitly.

## Settings, commands and JSON added

## Host MCP servers (browser from the container)

The agent in the container can use MCP servers that run on your Mac, starting with a browser server so it can open and drive Chrome on your screen (for example to check the dev server it just started).

**How the bridge works.** The container cannot reach your Mac (the firewall blocks the host), so the connection goes the other way, over `docker exec` like port forwarding:

1. kunj on your Mac keeps a `docker exec` open into the container that listens on a socket, `/run/kunj-mcp/<name>.sock`.
2. Claude Code in the container is configured with an MCP server whose command connects to that socket.
3. When Claude Code connects, kunj starts the real MCP server on your Mac (its stdio command) and pipes the two together. Each connection gets its own server process.

No port is opened on your Mac, and it works unchanged with a remote Docker host later.

**Configuration** (`container.mcp`, host config only, never the blueprint):

```jsonc
"container.mcp": {
  "chrome": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest", "--isolated"] }
}
```

kunj writes the matching entry into the container's Claude Code MCP config at start, and `kunj ct agent` keeps the bridge running for as long as the agent session.

**Which browser server.** Chrome DevTools MCP (or Playwright MCP) runs as a normal stdio process on your Mac and opens its own Chrome window, so it bridges cleanly. The Claude in Chrome extension is tied to your local Claude Code and your real browser profile, so it is not bridged.

**Localhost URLs.** The browser runs on your Mac, so `http://localhost:3000` means your Mac's port. With auto forwarding on, the container's port 3000 is forwarded to `localhost:3000` when free; when it had to move (say to 3001), kunj tells the agent through the MCP bridge's instructions which host port maps to which container port.

**Safety.** A browser on your Mac sits outside the sandbox: it can reach your LAN and any site you are logged into. So:

- the bridge is off unless `container.mcp` has entries;
- the default browser command uses an isolated, empty profile (`--isolated`): no cookies, no logged-in sessions;
- an optional `allowOrigins` list per server restricts which URLs the bridged browser may open (default: `localhost` only);
- `list` shows which MCP servers each container is bridged to.

| Setting | Default | Meaning |
| --- | --- | --- |
| `container.services` | (none) | Sidecar services (also `services` in the blueprint) |
| `container.dockerInDocker` | `off` | `off`, `sysbox` or `privileged` |
| `container.allowPrivileged` | `false` | Required for `privileged` |
| `container.forward.auto` | `false` | Auto forwarding while `kunj ct agent` runs (default on) |
| `container.forward.ignore` | (none) | Ports never auto-forwarded |
| `container.pruneAfterDays` | (off) | Prune stopped containers older than this |

```text
kunj ct open [branch] [--new-window]
kunj ct forward [branch] --auto [--detach]
kunj ct forward [branch] <service>:<port>
kunj ct logs [branch] [service]
kunj ct prune [--all] [--dry-run] [--force]
```

`kunj ct list --json` gains, per container: `services: [{ name, state, port }]`, `dockerInDocker`, and forwards in `ports`; at the top level, `orphans: [{ kind, name }]`. All additive, so the extension and app keep working.

## Security impact of each feature

| Feature | New risk | Mitigation |
| --- | --- | --- |
| Sidecar services | Images named by the branch's blueprint or compose file run on the branch network | Same network as the agent only; no host mounts, no privileged, no added caps, no forwarded env; compose's dangerous keys are dropped |
| Editor attach | The editor server runs inside the container with your editor's settings | Runs as the sandbox user, behind the firewall; no host paths mounted |
| Auto forwarding | Any port the agent opens becomes reachable on your Mac's localhost | Bound to 127.0.0.1 only; ignore list; `container.forward.auto: false` to turn it off |
| Prune | Deleting data | Same guard as `remove`; `--dry-run` default without a terminal; services' data only deleted with their container |
| Docker-in-Docker | `privileged` gives the container the Docker host's kernel powers | Opt-in twice (`dockerInDocker` + `allowPrivileged`), refused on Docker Desktop's shared VM, `sysbox` preferred |

## Testing and delivery plan

Each feature ships separately to `main`, in the order above, with unit tests against the fake backend and Docker tests for the real behaviour.

1. **Sidecar services.** Docker tests: a Postgres service is reachable from the agent by name and not from another branch; `setup` runs a migration against it during a snapshot; compose import of a two-service file; remove deletes the service volume.
2. **Editor attach.** Unit test of the URI; a manual check with VS Code and Cursor.
3. **Auto forwarding.** Docker test: a server started after `--auto` becomes reachable on localhost within 3 s and disappears after it stops.
4. **Prune.** Docker tests: an orphaned helper and volume are removed; a container with unpushed work on a deleted branch is kept; `--dry-run` deletes nothing.
5. **Docker-in-Docker.** Unit tests of the refusal rules; a Docker test of `privileged` inside a throwaway Colima profile when available, otherwise skipped.

## Decisions to make together

Decided (2026-10-23):

- [x] **Where services are declared:** blueprint `services` first, then kunj config, then the devcontainer's compose file.
- [x] **Firewall for services:** no egress filtering for service containers in this phase.
- [x] **Supabase for driveday:** plain services (Postgres first), with migrations through the `supabase` CLI preset.
- [x] **Health-check timeout:** warn after 120 s and continue.
- [x] **Auto forwarding:** on by default whenever `kunj ct agent` runs; `container.forward.auto: false` turns it off.
- [x] **Prune of stale branches:** only branches gone from origin, and only when the guard finds no unpushed work.
- [x] **Docker-in-Docker:** built in this phase, as the fifth feature (`sysbox` and `privileged`, with the safeguards above).

Host MCP bridge:

- [x] **Which browser MCP by default:** Chrome DevTools MCP with `--isolated`.
- [x] **Allowed origins:** `localhost` only by default, widened per server with `allowOrigins`.
- [x] **Other host MCP servers:** browser only for now; other stdio servers can be added later through the same bridge.
