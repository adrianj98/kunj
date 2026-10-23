# Container phase 2

*Designed and decided 2026-10-23; five of six features shipped the same day. Checked against `main`
on 2026-10-23. Builds on [branch-containers.md](branch-containers.md); plan:
`docs/superpowers/plans/2026-10-23-container-phase-2.md`.*

## Goal and status

Phase 2 makes a branch container usable for real projects: their databases run next to it, the editor
opens inside it, dev servers are reachable without thinking about ports, old containers clean
themselves up, and repos that run `docker compose` themselves can. Each feature shipped separately to
`main`, in the table's order.

| # | Feature | Why | Status |
| --- | --- | --- | --- |
| 1 | Sidecar services | alertd-core needs Postgres and Pulsar, driveday Supabase's Postgres; without them the agent cannot run tests | Shipped (ed136b3, 6273c61) |
| 2 | Editor attach (`kunj ct open`) | Work in the same container the agent uses | Shipped (93b7ed3, f635113) |
| 3 | Auto port forwarding (`forward --auto`) | Dev servers just appear on localhost | Shipped (5710902, b88466c) |
| 4 | Prune (`kunj ct prune`) | Containers, volumes and snapshots pile up (1–2 GB each) | Shipped (893dc79, 4f7aa10) |
| 5 | Docker-in-Docker | Repos whose tests run `docker compose`; weakens isolation, so opt-in and last | Shipped (d40b44c, c88430b) |
| 6 | Host MCP bridge (a browser on the Mac for the agent) | Let the agent check the dev server it started | Shipped (c4ac53d, cf544d8, 92b14ef, d235d85) |
| — | Cross-feature fixes: forwards through the helper, compose deps, orphan grace | Review of the whole phase | Shipped (a32bc90) |
| — | Containers in the VS Code extension and the macOS app | Consumers of the JSON added here | Not started |

## Design

### 1. Sidecar services

Each branch gets its own instances of the services the project needs, as extra containers on the
branch's network. The agent reaches them by name (`postgres:5432`); other branches and the Mac cannot,
unless a port is forwarded.

**Declared in** (first source wins, merged by name): the blueprint's `services`, then
`container.services`, then the services of the devcontainer's `dockerComposeFile` (except its own
`service`), read through `backend.composeConfig()`: `docker compose config --no-interpolate` on stdin
in an empty project directory, so nothing on the host is read.

```jsonc
"services": {
  "postgres": { "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "dev" }, "port": 5432,
                "healthcheck": "pg_isready -U postgres", "volumes": { "data": "/var/lib/postgresql/data" } },
  "pulsar":   { "image": "apachepulsar/pulsar:3.3.0", "command": ["bin/pulsar", "standalone"], "port": 6650 }
}
```

**Keys:** `image` (required, a valid image reference), `env`, `command` (string array), `port`
(forwarding and display), `healthcheck` (a command run with `sh -c` inside the service), `volumes`
(`{ volumeName: containerPath }`, named volumes only, created per branch), `dependsOn`. Names are
`[a-z0-9][a-z0-9-]*`; unknown keys are an error. **Compose import** maps `image`, `environment`
(`${VAR:-default}` takes the default; any other `${…}` drops the variable, never read from the host),
`command`, `healthcheck.test`, `depends_on`, named volumes and the first port of `ports`/`expose`. It
drops, with one warning listing them, host bind mounts, published ports, `build`, `privileged`,
`cap_add`, `network_mode`, `devices`, `pid`, `ipc`, `security_opt`, `volumes_from`, `userns_mode`,
`cgroup_parent`, `env_file`, `extra_hosts`, `sysctls`, `runtime`, `entrypoint`, `user`, `working_dir`,
`tmpfs`, and a `depends_on` on a dropped service. A compose file with `include` or `extends.file` is
refused (they read host files), judged on the parsed document (explicit, alias and escaped keys included; unparsable, multi-document or
unknown-tag files refused), with text checks as a backstop.

**Run spec:** `<container>-svc-<name>` on the branch network with `--network-alias <name>`, only the
env and named volumes it declares (`<container>-svc-<name>-<volume>`), Docker's default capabilities
(none added; database images need their usual ones), no published ports, no firewall helper, labels
`kunj.repo`, `kunj.branch`, `kunj.role=service`, `kunj.service=<name>` and `kunj.options` (`port`,
`healthcheck`, volume names, `dependsOn`; never env). Service containers are found by their labels, not
a name prefix another branch could extend.

**Lifecycle:** `start` validates every definition before creating anything, then starts services in
`dependsOn` order after the network and before the branch container, polling each health check every
2 s for up to 120 s (then a warning, and the start continues). They are in the rollback list.
`--rebuild` recreates them on their kept volumes and removes services no longer declared, with their
volumes unless `--keep-volumes`. Resume starts stopped ones and creates newly declared ones, dependencies
first, never removing one; a service that will not start fails the start, and a failed resume stops the
services it started. `start` also replaces a running helper not on the current `kunj-nethelper` image
(keeping it when the new image cannot be built; ending the forwarders and bridges registered for the
container; stopping the container when the new helper fails), with the firewall chain swapped in
atomically, and `open` resumes when the helper or a service is down. `stop` stops them;
`remove` deletes them and their volumes (`--keep-volumes` keeps them; the unpushed-work guard is about
the branch, not service data). `list` shows `services: [{ name, state, port }]`;
`kunj ct logs [branch] [service] [--follow]` shows a service's (or the container's) output;
`kunj ct forward [branch] <service>:<port>` tunnels into the service container with whichever of
`socat`, `bash` or `nc` it has.

**Snapshots.** Services start next to the snapshot's temporary container, so `setup` can use them, and
are removed with it; their data is never in the snapshot. Migrations against a service therefore belong
in `maintain` and must be idempotent: `setup`'s only reach the build's throwaway services.

**Firewall.** Service containers are reachable from the agent (the branch subnet is allowed). They get
no forwarded environment and no host access; their own outbound traffic is not filtered in this phase.

### 2. Editor attach (`kunj ct open`)

`kunj ct open [branch] [--new-window]` opens the editor inside the branch's container at `/workspace`.

- A stopped container is resumed through the same start-or-resume routine (never rebuilt; `start`'s
  `--rebuild`, `-c`, `--image` and `--publish` never apply). A branch without a container is an error.
- It writes the Dev Containers extension's per-image attached-container config,
  `globalStorage/ms-vscode-remote.remote-containers/imageConfigs/<image>.json` (`:`, `/` and `%`
  escaped as lowercase `%xx`), with `remoteUser` and `workspaceFolder: "/workspace"`, merged into an
  existing file, for VS Code and Cursor (each when installed, always for the configured one).
- It launches `worktree.editorCommand` through `buildOpenCommand()` with
  `--folder-uri vscode-remote://attached-container+<hex of {"containerName":"/<name>"}>/workspace`
  (encoding checked against Dev Containers 0.470.0).
- Editors that are not VS Code-like get the equivalent `docker exec -it … sh -lc` line printed (JSON:
  `uri: null`, `exec`). There is no check that the extension is installed.
- In allowlist mode it warns that the editor server needs the VS Code update and marketplace domains.
- With `--context` it warns that the editor uses its own Docker context.
- It always prints `EDITOR_CREDENTIALS_WARNING` (JSON: `warning`): an attached window may copy the
  host's gitconfig, install a host-backed git credential helper and forward the SSH and GPG agents into
  the container. The git ones can be turned off with `dev.containers.copyGitConfig: false` and
  `dev.containers.gitCredentialHelperConfigLocation: "none"`; SSH and GPG forwarding have no setting.
  kunj does not change the extension's behaviour.

### 3. Auto port forwarding

`kunj ct forward [branch] --auto [--detach]` forwards every port that starts listening in the container
and drops the forward when the listener goes away.

- **Detection:** one exec every 2 s reading `/proc/net/tcp` and `/proc/net/tcp6` (not `ss`, which most
  images lack). Only listeners the tunnel can reach count: wildcard or `127.x` (not Docker's DNS
  `127.0.0.11`); a port bound only to `::1` is left out. Ports below 1024, `container.forward.ignore`
  and ports already published with `--publish` are skipped.
- **Through the network helper:** the polls and the tunnels exec in the helper (same network
  namespace), never in the branch container. A forwarder is bound to one run of the container (its
  `StartedAt`) and exits when the container stops or is recreated.
- **Host port:** the same number when free, else the next free one, on `127.0.0.1` only.
- **Registry:** `~/.kunj/container-forwards.json`, records `{ pid, container, containerId, port,
  hostPort, kind: "forward", service? }` (port 0 marks a forwarder itself), keyed by container id,
  dead pids pruned on read, atomic writes. Manual `kunj ct forward` registers its ports too.
- **Background:** `--detach` spawns a detached `kunj ct forward <branch> --auto`. `kunj ct agent` does
  this automatically unless `container.forward.auto` is `false` or a forwarder is already registered for
  the container.
- **Output:** with `--json`, one line per change; `list --json` shows forwards in `ports` with
  `kind: "forward"` and `pid`.

### 4. Prune

`kunj ct prune [--all] [--dry-run] [--force] [--yes]` removes what is no longer needed.

| Removed | When |
| --- | --- |
| A branch container with its helper, services, volumes and network | Its branch is gone from origin (`ls-remote` lacks it **and** the clone has its `refs/remotes/origin/` ref, so a never-pushed `-c` branch is not "gone"), and the remove guard is clean, or `--force` |
| Stopped containers created more than `container.pruneAfterDays` ago (0 = off, the default) | Same guard |
| Orphans: helpers, services and networks labelled for a branch with no main container | Always; volumes without a container only with `--force` (a volume can hold unpushed work) |
| Snapshot images of another blueprint hash; `kunj-sandbox`, `kunj-nethelper`, `kunj-sandbox-dind` tags of other versions | Not in use by any container; snapshots are all kept when the current hash cannot be computed |

- Every rule fails safe: origin unreachable (or an empty answer) means no branch is gone; a guard that
  cannot run keeps the container; a privileged container is not started for its guard without
  `allowPrivileged`. The guard runs again at removal time, before `pre-container-delete`.
- A branch whose objects were created less than 10 minutes ago is starting, not orphaned (a start can
  wait minutes on service health checks before its main container exists).
- Snapshot containers (`<branch>:snapshot`) are never pruned as branches. A leftover of a killed snapshot
  build (`exited`/`dead`, `created` over 10 minutes, or live over 24 hours; a `paused` build is mid-commit) is removed with its helper, services, volumes and network, with
  no guard (it holds nothing) and reason `snapshot-leftover`. Every seed path leaves
  `refs/remotes/origin/<branch>` in the clone, which the "gone" check needs.
- It prints the plan and asks once. `--yes` removes without asking; `--json` or no terminal without
  `--yes` is a dry run; `--force` only skips the guard and adds container-less volumes. The plan sizes
  images only.
- `--all` covers every repository in `~/.kunj/repos.json`; kunj's own image tags are checked once.
- `pre/post-container-delete` run for each removed branch container. `list` shows orphans
  (`orphans: [{ kind, name }]`).

### 5. Docker-in-Docker

`container.dockerInDocker: off | sysbox | privileged` (default `off`) gives the branch container its own
`dockerd`, so two branches running the same compose file never clash (separate daemons: same project
names, ports and volumes are fine). The costs are an image cache per branch and the RAM of two stacks.

| Mode | How | Isolation | Where |
| --- | --- | --- | --- |
| `off` | No daemon; use sidecar services | Full | Everywhere |
| `sysbox` | `--runtime sysbox-runc` | Strong: inner containers stay in the sandbox's user namespace | Docker hosts whose `docker info` lists `sysbox-runc` (Linux) |
| `privileged` | `--privileged` | Weak: the agent (in the `docker` group) can become root on the Docker host or its VM without any vulnerability | Only with `container.allowPrivileged: true`, never on Docker Desktop |

- **Image:** `kunj-sandbox-dind:<version>-<hash>`, built FROM the sandbox (src/container/sandbox-dind/:
  docker-ce, CLI, containerd, compose plugin, iptables; `dev` in the `docker` group). A devcontainer,
  `container.image` or `--image` is refused.
- **Refusals before anything is created** (`precheckDind()` in `start`, before the create hook, the
  snapshot and the push; lifecycle checks again): sysbox without the runtime; privileged without
  `allowPrivileged`; privileged on Docker Desktop (detected from `docker info`, whatever the context is
  called, because its VM shares the home directory). OrbStack and a default Colima profile share the
  home too; the docs recommend a dedicated Colima or Lima profile with file sharing off, selected with
  `container.dockerContext`.
- **Resume:** a container created privileged is refused once `allowPrivileged` is no longer true, and a
  sysbox one when the daemon lost the runtime; the remove and prune guard do not start such a container
  (`--force` only). A mode changed in settings applies with `--rebuild`.
- **Run:** capabilities are not dropped (the daemon needs them); `/var/lib/docker` is a per-branch
  volume `<container>-docker`, removed with the container; `dockerd` is started as root by
  `kunj-dind-start` only after the firewall is ready, on every start and resume, and never in a
  snapshot. A daemon that does not come up is a warning (log in `/var/log/kunj-dockerd.log`).
- **Firewall:** in allowlist mode Docker Hub, its CDN, `ghcr.io` and its blob host are added. kunj's
  firewall is not a boundary for inner containers in either mode.
- `list` marks the mode (`dind`). When the working tree has a compose file, DinD is off and no services
  are declared, `start` suggests services.

### 6. Host MCP bridge

Shipped (c4ac53d, cf544d8, 92b14ef, d235d85; module `src/lib/container/mcpbridge.ts`). The agent in the
container can use a browser MCP server that runs on the Mac, so it can open and drive Chrome to check the
dev server it started. Off unless `container.mcp` has an entry. It went through three security review
rounds; the first found a sandbox escape (host file read and write through the browser tools), so the
filter is deny by default.

- **Transport:** the container cannot reach the Mac, so kunj holds a `docker exec` running
  `socat UNIX-LISTEN:/run/kunj-mcp/<name>.sock,mode=600 STDIO` as the sandbox user (one session per
  server at a time, restarted when either side ends). Root is used only to create `/run/kunj-mcp` and
  chown it to the user (mode 700). Claude Code in the container gets
  `mcpServers.<name> = { command: 'socat', args: ['-', 'UNIX-CONNECT:/run/kunj-mcp/<name>.sock'] }`
  merged into the user's `~/.claude.json` (other servers kept). The host spawns the real stdio server
  only after the first complete JSON line, with only `PATH`, `HOME` and the configured `env`.
- **Configuration:** `container.mcp: { chrome: { command?, args?, env?, allowOrigins? } }`, host config
  only (never the blueprint or the repository); only the browser entry is honoured in v1, other keys warn.
  The default server is pinned: `npx -y chrome-devtools-mcp@1.12.0` with a fresh temporary
  `--userDataDir` per session whose preferences refuse downloads (and point the download folder inside it),
  plus `--categoryPerformance=false --categoryMemory=false --fileNavigations=false
  --no-usage-statistics`; the directory is deleted on every exit path. Custom `args` drop these and warn.
- **Lifetime:** `kunj ct agent` starts a detached bridge (registry `~/.kunj/container-bridges.json`, shared
  `pidRegistry` with the forwarder) bound to one run of the container (`State.StartedAt`); it exits when
  the container stops or restarts. `kunj ct mcp [branch]` runs it in the foreground. Snapshot builds never
  bridge. `list --json` gains `bridges: [{ name, pid }]`.
- **Filter, container to host:** only tools on a pinned allowlist (`BROWSER_TOOLS`), each with an argument
  allowlist (`BROWSER_TOOL_ARGS`); unknown arguments and any path-like key (`filePath`, `sourcePath`, …,
  checked recursively, failing closed past 32 levels) are refused; `upload_file` and `new_page`'s
  `isolatedContext` are refused. Batches, malformed lines, ids that are not a short string or an integer,
  and duplicate in-flight ids are refused or dropped; refusals quote at most 100 characters of container
  text. `capabilities.roots` is stripped from `initialize`, and the bridge answers the server's
  `roots/list` itself with `[]`.
- **Filter, host to container:** every result carrying a `tools` array is rewritten to the allowlist with
  path-like schema properties removed.
- **Origins:** `navigate_page`/`new_page` URLs must match `allowOrigins`; the default allows only the host
  ports currently forwarded for that container (`localhost` or `127.0.0.1`, http or https). This limits
  explicit navigation only: a click or `evaluate_script` can still go anywhere, so it is not a network
  boundary. The port map is appended to the server's `initialize` instructions.
- **Limits:** 4 MB per container line, 16 MB per server line, 1 MB per refusal reply, backpressure both
  ways and an 8 MB cap on output buffered to the container; any error ends the session, never the
  process.

What holds: no file path from the agent reaches the server, and the default browser refuses downloads.
What does not: the agent drives a real browser on the Mac's network, so it can reach any service the Mac
can, through page scripts and links. With a custom command or args, downloads land where that browser
saves them.

### Settings and commands added

| Setting | Default | Meaning |
| --- | --- | --- |
| `container.services` | `{}` | Sidecar services (also blueprint `services`); edit the config file by hand |
| `container.forward.auto` | `true` | `kunj ct agent` starts a background `forward --auto` |
| `container.forward.ignore` | `[]` | Ports `--auto` never forwards (below 1024 never are) |
| `container.pruneAfterDays` | `0` (off) | Prune also removes stopped containers created longer ago |
| `container.dockerInDocker` | `off` | `off`, `sysbox` or `privileged` |
| `container.allowPrivileged` | `false` | Required for `privileged`; still refused on Docker Desktop |
| `container.mcp` | `{}` | Host MCP servers bridged into containers; only `chrome` in v1 |

```text
kunj ct open [branch] [--new-window]
kunj ct forward [branch] --auto [--detach]
kunj ct forward [branch] <service>:<port>
kunj ct logs [branch] [service] [--follow]
kunj ct prune [--all] [--dry-run] [--force] [--yes]
kunj ct mcp [branch]
```

`list --json` gained, per container, `services`, `dind`, `bridges` and forward entries in `ports`, and at the top
level `orphans`; all additive.

### Security impact

| Feature | New risk | Mitigation |
| --- | --- | --- |
| Services | Images named by the branch's blueprint or compose file run on the branch network | Same network as the agent only; no host mounts, privileged, added caps, host env or published ports; dangerous compose keys dropped, `include`/`extends.file` refused |
| Editor attach | The editor server runs inside the container; the extension may forward host credentials and agents | Sandbox user, behind the firewall; the warning names the settings that turn the git ones off |
| Auto forwarding | Any port the agent opens is reachable on the Mac's localhost | `127.0.0.1` only; ignore list; `forward.auto: false`; exec only in kunj's own helper |
| Prune | Data loss | Remove guard at plan and removal; dry run without a TTY or with `--json`; volumes only with `--force` |
| Docker-in-Docker | `privileged` is root on the Docker host's VM | Two opt-ins, refused on Docker Desktop, re-checked on resume, `sysbox` preferred |
| MCP bridge | The agent drives a browser on the Mac, outside the sandbox and on the Mac network | Off by default; pinned server; tool and argument allowlists, no path arguments; throwaway profile that refuses downloads; listener as the sandbox user; origins limited to forwarded ports (explicit navigation only); size bounds |

## Decisions

All 2026-10-23.

- **Where services are declared:** blueprint first, then kunj config, then the devcontainer's compose file.
- **No egress filtering for service containers** in this phase.
- **Supabase for driveday:** plain services (Postgres first), migrations through the `supabase` preset.
- **Health-check timeout:** warn after 120 s and continue.
- **Migrations against services in `maintain`**, idempotent (a32bc90): `setup`'s reach only the
  snapshot's throwaway services.
- **Auto forwarding on by default** whenever `kunj ct agent` runs; `container.forward.auto: false` turns it off.
- **Forwards exec only in the network helper** (a32bc90), never in the branch container.
- **`/proc/net/tcp` instead of `ss`** (b88466c): most images lack `ss`.
- **Prune of stale branches:** only branches gone from origin that the clone saw there, only with a
  clean guard; `--force` skips only the guard; consent through the prompt or `--yes` (4f7aa10).
- **Docker-in-Docker built in this phase**, fifth, `sysbox` and `privileged`, kunj sandbox image only.
- **MCP bridge:** Chrome DevTools MCP, browser only for now. After review: deny by default (tool and
  argument allowlists), server pinned to 1.12.0, a throwaway profile instead of `--isolated`, default
  origins = the container's forwarded ports, malformed lines dropped, batches refused.

## Open questions and roadmap

- MCP bridge: bump the pinned chrome-devtools-mcp only after re-reading its tool schemas; consider
  `--allowedUrlPattern` (Chrome 149+) as a real origin boundary; verify the download block in a visible
  browser.
- Containers in the VS Code extension and the macOS app (start, agent in a terminal, open, forward,
  remove), reading `kunj ct list --json`.
- Service egress filtering, if a service image turns out to need watching.

## Code map

| File | Role |
| --- | --- |
| `src/lib/container/services.ts` | Parse, compose import, order, run spec, start/resume/stop/remove, health checks |
| `src/lib/container/editor.ts` | Attached-container URI, image config files, the credentials warning |
| `src/lib/container/autoforward.ts`, `forward.ts` | `/proc/net/tcp` polling, the registry, detached forwarders; the tunnel |
| `src/lib/container/prune.ts` | Plan, orphans, apply |
| `src/lib/container/dind.ts`, `src/container/sandbox-dind/` | Modes, refusals, the DinD image and `kunj-dind-start` |
| `src/commands/container.ts` | `open`, `forward`, `logs`, `prune`, `list` |
| `src/settings/container.ts` | The settings above |
