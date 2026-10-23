# Container phase 2 — design

*2026-10-23. Source of truth for discussion: the Claude Doc "Container Phase 2 Spec"
(https://claude.ai/artifact/77f7sDBjgq8ZTZbnfpXPUA). This file mirrors its decisions for the plan.*

## Scope and order

Six features, each shipped separately to `main`, in this order:

1. **Sidecar services** — per-branch Postgres/Pulsar/Redis containers on the branch network.
2. **Editor attach** — `kunj ct open`.
3. **Auto port forwarding** — `forward --auto`, on by default while `kunj ct agent` runs.
4. **Prune** — `kunj ct prune`.
5. **Docker-in-Docker** — `sysbox` and `privileged` modes.
6. **Host MCP bridge** — Chrome DevTools MCP on the Mac, usable by the agent in the container.

## 1. Sidecar services

- Declared in (first match wins, merged by name): blueprint `services`, then `container.services`, then the
  devcontainer's `dockerComposeFile` services (excluding the devcontainer's own `service`).
- Keys: `image` (required), `env`, `command` (string[]), `port` (number), `healthcheck` (string, run with
  `sh -c` inside the service), `volumes` (`{ name: containerPath }` — named volumes only, created per branch),
  `dependsOn` (string[]). Compose import maps `image`, `environment`, `command`, `healthcheck.test`,
  `depends_on`, named volumes and the first container port of `ports`/`expose`; drops host bind mounts,
  `privileged`, `cap_add`, `network_mode`, `build`, published `ports` with one warning listing what was dropped.
- Names: `<container>-svc-<name>`; data volume `<container>-svc-<name>-<volname>`; network alias `<name>`;
  labels `kunj.repo`, `kunj.branch`, `kunj.role=service`, `kunj.service=<name>`.
- Run: no forwarded env, no host mounts, no added capabilities, `--cap-drop` unchanged from Docker defaults
  (database images need their usual capabilities), no published ports, no firewall helper (decision).
- Start order: services (topologically by `dependsOn`) before the branch container; health check polled every
  2 s up to 120 s, then a warning and continue (decision). Resume starts stopped services. Stop stops them.
  Remove deletes them and their volumes. Rollback includes services created by the run.
- Snapshots: services start before `setup` during a snapshot build (so migrations can run) and are removed
  with the temporary container; their data is never in the snapshot.
- `list`: `services: [{ name, state, port }]` per container (JSON additive). `kunj ct logs [branch] [service]`.
- `kunj ct forward <branch> <service>:<port>` forwards a service port (exec tunnel into the service).

## 2. Editor attach

- `kunj ct open [branch] [--new-window]`: starts the container if stopped, then launches
  `worktree.editorCommand` with `--folder-uri vscode-remote://attached-container+<hex>/workspace`,
  `<hex>` = hex of `JSON.stringify({ containerName: '/' + name })`.
- Writes the per-image attached-container config (`remoteUser`, `workspaceFolder: '/workspace'`) to the
  editor's `globalStorage/ms-vscode-remote.remote-containers/imageConfigs/<image>.json` (VS Code and Cursor
  paths) before launching.
- Non-VS-Code editors: print the `docker exec` command instead. Allowlist mode: warn that the editor server
  needs marketplace/update domains.

## 3. Auto port forwarding

- `kunj ct forward [branch] --auto [--detach]`: poll `ss -ltnH` every 2 s via one exec; forward new
  listeners (skip < 1024 and `container.forward.ignore`), drop closed ones.
- Host port = container port when free, else next free.
- Registry `~/.kunj/container-forwards.json`: `{ pid, container, port, hostPort, kind }`, dead pids pruned on read.
- `--detach` runs a background kunj process that exits when the container stops.
- `kunj ct agent` starts a detached auto-forwarder unless `container.forward.auto` is `false` (default `true`,
  decision).
- `list` JSON `ports` gains `kind: 'forward'` entries with `pid`.

## 4. Prune

- `kunj ct prune [--all] [--dry-run] [--force]`.
- Removes: branch containers whose branch is gone from origin **and** whose remove guard is clean (or
  `--force`); orphans (helpers, services, volumes, networks labelled for the repo with no main container);
  snapshot images whose hash is not the current one; superseded `kunj-sandbox`/`kunj-nethelper` tags;
  stopped containers older than `container.pruneAfterDays` (off by default).
- `--dry-run` lists and sizes; it is the default when stdout is not a TTY. `--all` iterates `~/.kunj/repos.json`.
- `list` shows orphans (`orphans: [{ kind, name }]` in JSON).

## 5. Docker-in-Docker

- `container.dockerInDocker: off | sysbox | privileged` (default `off`); `container.allowPrivileged` (default
  `false`) required for `privileged`.
- `sysbox`: `--runtime sysbox-runc`; refused unless `docker info` lists the runtime.
- `privileged`: `--privileged`; refused unless `allowPrivileged`; refused on Docker Desktop's default context
  (`docker context show` = `desktop-linux`/`default` with a Docker Desktop server) even with `allowPrivileged`.
- Both: capabilities not dropped; inner `/var/lib/docker` on a per-branch volume `<container>-docker`;
  `dockerd` started by the sandbox image's entry path (a `kunj-dind` start script run as root after READY);
  sandbox image gains `docker-ce` CLI + `dockerd` + compose plugin (or a separate `kunj-sandbox-dind` image —
  plan decides); Docker Hub, its CDN and `ghcr.io` added to the allowlist; `list` marks the mode.
- With a compose file and DinD off, `start` suggests services.

## 6. Host MCP bridge

- `container.mcp: { <name>: { command, args?, env?, allowOrigins? } }` — host config only; v1 allows only a
  browser server (decision: browser only); default suggested entry `chrome` →
  `npx -y chrome-devtools-mcp@latest --isolated`.
- Bridge: kunj on the host runs `docker exec -i <ctr> socat UNIX-LISTEN:/run/kunj-mcp/<name>.sock,fork,mode=600,user=<user> STDIO`?
  — one exec per connection is the model used by `forward`; the plan picks the concrete mechanism. Per
  connection the host spawns the configured stdio MCP server and pipes both ways.
- Container side: kunj writes `~/.claude.json`/project MCP config entry
  `{ "<name>": { "command": "socat", "args": ["-", "UNIX-CONNECT:/run/kunj-mcp/<name>.sock"] } }` at start.
- `kunj ct agent` keeps the bridge alive for the session (same detached-process model as auto forwarding).
- `allowOrigins` (default `["http://localhost", "http://127.0.0.1"]`): enforced by passing the server's own
  origin restriction where it has one, otherwise by inspecting `navigate_page`/`new_page` tool calls in the
  host-side pipe and rejecting other origins with a JSON-RPC error.
- Port mapping hint: the bridge's server instructions include the container→host port map from the forward
  registry.

## Security impact

| Feature | Risk | Mitigation |
|---|---|---|
| Services | Branch-named images run on the branch network | No host mounts, no privileged, no added caps, no env; dangerous compose keys dropped |
| Editor | Editor server inside the container | Sandbox user, behind the firewall |
| Auto forward | Ports reachable on the Mac's localhost | 127.0.0.1 only; ignore list; `forward.auto: false` |
| Prune | Data loss | Remove guard; dry-run default without a TTY |
| DinD | `privileged` = host-VM kernel powers | Two opt-ins; refused on Docker Desktop's shared VM; sysbox preferred |
| MCP bridge | A browser on the Mac, outside the sandbox | Off by default; isolated profile; localhost-only origins |

## Testing

Unit tests against `FakeBackend` for every feature; Docker tests: service reachable by name and isolated
per branch, migration during a snapshot, compose import, service volume removed; auto forward picks up a
late server and drops it; prune removes orphans and keeps unpushed work; DinD refusal rules (privileged Docker
test only in a throwaway Colima profile, else skipped); MCP bridge with a fake stdio MCP server (echo) end to
end, origin rejection unit-tested.
