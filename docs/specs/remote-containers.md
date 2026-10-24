# Remote containers: `kunj serve` and the remote backend

Run branch containers on another machine (a Linux box in the office, a cloud VM, a Mac with Docker
Desktop in another room) and drive them from the laptop with the same `kunj ct` commands, the same
apps and the same guarantees as local ones. Phase 1 named this as the reason nothing may assume the host
and the Docker daemon share a filesystem ([branch-containers.md](branch-containers.md)); this spec is that
later phase.

## Status

| Part | State |
| --- | --- |
| Spec | Written, not reviewed |
| `container.dockerContext` over SSH validated end to end (prerequisite, no code) | Not started |
| Protocol and `RemoteKunjBackend` (client) over an in-process server with `FakeBackend` | Not started |
| `kunj serve` (server) | Not started |
| `kunj remote add\|list\|remove\|ping`, `container.remote`, `--remote` | Not started |
| TTY exec over the WebSocket (`shell`, `attach`, `agent`): raw-mode client, resize frames, Engine API on the server | Not started |
| `forward`, `forward --auto`, the MCP bridge and `kunj events` against a remote | Not started (expected to work unchanged; to verify) |
| Functional test against a real daemon | Not started |
| Editor attach through Remote-SSH | Later |
| TLS, multi-user | Later, own spec |

## Goals and non-goals

Goals:

- One `kunj ct` command set. A remote container is used exactly like a local one: `start`, `list`,
  `shell`, `agent`, `attach`, `forward`, `stop`, `remove`, `prune`, snapshots, services, secrets, hooks.
  The apps (`ct list --json`, `worktree list --containers`, `kunj events`) see remote containers as
  rows like any other.
- The laptop stays the authority. `~/.kunj` on the client holds the secrets vault, keep files, blueprints,
  presets, hooks, the forward and bridge registries and the config. The server stores nothing about the
  user's repositories: Docker labels remain the only container state, as in phase 1.
- No new git or file channel. Origin is still the only way code moves; everything that today goes
  through `docker exec … tar -x`, `docker build -` or a bundle keeps going through the backend as a
  stream, now over the network.
- Secrets travel once, encrypted in transit, and land only in the `docker run` env file on the server
  (deleted after the run), as today. Nothing is logged.

Non-goals (v1):

- Several users sharing one server. One server, one token, one user. Two laptops with the same token
  behave as one user (names and labels do not include a user).
- Serving Docker to anything but kunj. The API is kunj's `ContainerBackend`, not a Docker proxy, and
  it refuses objects kunj did not create.
- A TLS stack of our own. The server listens on loopback; the client reaches it through an SSH tunnel
  kunj opens, or through a URL the user has put behind their own TLS proxy.
- Editor attach. The Dev Containers extension attaches through the laptop's own Docker context, which
  does not see the remote daemon, so `features.editorAttach` is false and `kunj ct open` refuses with
  the Remote-SSH hint (below).

## Why not only `container.dockerContext`?

A Docker context over SSH (`docker context create box --docker host=ssh://user@box`) already moves the
daemon to another machine, and it must be validated end to end first: it is the zero-code path, and it
tells us which assumptions in lifecycle.ts are really filesystem assumptions. What it cannot do:

- Every call spawns `docker`, which opens an SSH connection; `ct list` with three containers is a
  dozen connections. ControlMaster helps, kunj cannot rely on it.
- The apps and the functional contract (`features`, `backend` in `ct list --json`) cannot describe it.
- It needs the Docker CLI on the laptop, and a shell account on the box that is in the `docker` group,
  i.e. root on the box for everyone who can SSH in.
- No place for a server-side policy (which objects may be touched, which images built).

`kunj serve` is the long-running counterpart: one authenticated connection, kunj's own vocabulary,
and the laptop needs neither Docker nor a shell account on the box.

## Why not only `ssh box kunj ct …`?

Running the whole CLI on the box over SSH is the other zero-protocol option, and it is better than the
server at one thing: interactive sessions. `ssh -t` gives `shell`, `attach` and `agent` a real pty,
resize, colours and signals for free, which is the hardest part of any protocol of our own. Where it
fails is state: the box would need its own `~/.kunj` (a second vault with a different key provider, keep
files, blueprints, hooks that cannot reach the laptop), credentials for private origins would move to
the box, forwards and the MCP bridge would need their own tunnels, and the apps, which run `kunj …
--json` locally, could not use it. It also needs a shell account in the `docker` group per user.

A hybrid (the server for everything, `ssh -t … kunj serve exec` for the three interactive commands) was
considered and dropped: it would make SSH a requirement rather than a transport, keep a shell account in
the picture, and leave `--url` remotes without a terminal. So **everything goes over the protocol**,
the terminal included, and SSH is only one way to carry it (an `ssh -L` tunnel when the box has no TLS
in front of it). One credential, one code path, no accounts on the box.

## Shape

```
laptop                                              box
───────────────────────────────                     ──────────────────────────────────
kunj ct …  ──► RemoteKunjBackend ──► HTTP+WS ──►  kunj serve ──► LocalDockerBackend ──► dockerd
  ~/.kunj (vault, keep, blueprints,   via ssh -L,    ~/.kunj/serve/ (token, log)
   forwards, bridges, config)         or a TLS URL   labels on Docker objects (the only state)
```

Every call, the terminal of `shell`, `attach` and `agent` included, is an HTTP or WebSocket request
to `kunj serve`. How the bytes reach the box (an SSH tunnel kunj opens, or a URL behind the user's TLS
proxy) is a transport detail the protocol does not see.

- **`RemoteKunjBackend`** (src/lib/container/remote.ts) implements `ContainerBackend` over the wire.
  Lifecycle, forward, autoforward, services, snapshot, prune, files and the MCP bridge are not changed:
  they already program against the interface. The one rule they must keep is the one phase 1 set: no
  host paths reach the backend.
- **`kunj serve`** (src/commands/serve.ts, src/lib/serve/*) wraps a `LocalDockerBackend` in an HTTP and
  WebSocket server. It is a thin proxy: one route per backend method, no lifecycle logic. The
  alternative, a thick server running kunj's lifecycle on the box with its own `~/.kunj`, would move
  the vault, keep files and hooks to the box and need a sync design; rejected (see Decisions).
- **Only docker.ts touches Docker**, still. The server imports docker.ts; the client never does.

## Transport and auth

- **Listen:** `kunj serve` binds `127.0.0.1:7433` by default (`--listen <host:port>`). A non-loopback
  address is refused unless `--allow-remote-listen` is given, because the connection is then plain HTTP
  on a LAN; the message says to use SSH or a TLS proxy instead.
- **Token:** created on the first `kunj serve` (32 random bytes, base64url), stored in
  `~/.kunj/serve/token` (0600) on the box, printed once. `kunj serve token` prints it again,
  `kunj serve token --rotate` replaces it. Every request carries `Authorization: Bearer <token>`,
  compared in constant time; a wrong token is `401` with no detail, and the server logs the client
  address once per minute at most (no token fragments).
- **Reaching the box:** `kunj remote add <name> --ssh user@box [--port 7433]` records a remote reached
  through an SSH tunnel; the client runs `ssh -N -L <local>:127.0.0.1:7433 user@box` on demand (one per
  kunj process, reused for its lifetime, killed on exit) and talks HTTP to `127.0.0.1:<local>`. `kunj
  remote add <name> --url https://box.example/kunj` records a URL the user has put behind TLS
  themselves; `http://` is accepted only for loopback addresses. Both forms need the token, taken from
  `--token`, `--token-stdin` or a prompt, never from argv history by default (`--token` warns).
- **Where the token lives on the laptop:** `~/.kunj/remotes.json` (0600), like gh's `hosts.yml`. Not in
  the secrets vault: listings (`ct list`, `worktree list --containers`, `events`) never unlock the vault,
  and they are the commands that talk to the remote most.
- **Versioning:** `GET /v1/info` returns `{ kunj, protocol, engine }`. The protocol version is an
  integer; the client refuses a server with another major (`remote-protocol`) and warns on a newer minor.

What the server trusts: anyone with the token can create and exec into containers, which is root on the
box's Docker. The token is therefore worth what SSH access to the box is worth, and the defaults
(loopback only, SSH tunnel) keep it from being more exposed than that.

## Protocol

JSON over HTTP for unary calls, WebSocket for anything that streams. Every path is under `/v1/`.
Errors are `{ error: { code, message } }` with the HTTP status; the client rethrows them as the same
`Error` text the local backend would have produced, so lifecycle's error handling does not change.

| `ContainerBackend` | Route |
| --- | --- |
| `info()` | `GET /v1/engine` |
| `contextName()` | `GET /v1/engine` (`context`) |
| `features` | `GET /v1/info` (`features`), fetched once per process, lazily |
| `imageExists`, `listImages`, `removeImage` | `GET /v1/images/:tag`, `GET /v1/images?label=…&reference=…`, `DELETE /v1/images/:tag` |
| `buildImage(tag, context, opts)` | `POST /v1/images/:tag/build` (chunked tar body; `X-Kunj-Build: <json opts>`; response streams build output lines) |
| `commitContainer` | `POST /v1/containers/:id/commit` |
| `createNetwork`, `listNetworks` | `POST /v1/networks`, `GET /v1/networks?label=…` |
| `createVolume`, `volumeExists`, `listVolumes` | `POST /v1/volumes`, `GET /v1/volumes/:name`, `GET /v1/volumes?label=…` |
| `run(spec)` | `POST /v1/containers` (body: the spec, env included) → `{ id }` |
| `list`, `inspectLabels`, `containerState`, `containerRun` | `GET /v1/containers?label=…`, `GET /v1/containers/:id/labels`, `GET /v1/containers/:id/state` |
| `start`, `stop` | `POST /v1/containers/:id/start`, `POST /v1/containers/:id/stop` |
| `remove(ids)` | `POST /v1/remove` (body: the id lists) |
| `copyIn(id, dir, tar)` | `POST /v1/containers/:id/copy?dir=…` (chunked tar body) |
| `composeConfig(yaml)` | `POST /v1/compose/config` |
| `exec(id, cmd, io)` | `WS /v1/containers/:id/exec` |
| `logs(id, opts)` | `WS /v1/containers/:id/logs` |
| `events(filter, onEvent, signal)` | `WS /v1/events?label=…` |

**Exec channel.** The client opens the WebSocket and sends one text frame, the request:
`{ cmd, user, workdir, env, tty, stdin: boolean, timeoutMs }`. Then binary frames, the first byte a
channel: `0` stdin (client→server), `1` stdout, `2` stderr (server→client); text frames are control:
`{ "resize": { cols, rows } }` (client→server), `{ "exit": code }` or `{ "error": message }`
(server→client, then close). Stdin EOF is an empty `0` frame. Backpressure: each side stops reading
its source while the socket's buffered amount is above 1 MB, like the MCP bridge. A WebSocket closed
without `exit` is `Error('exec ended: connection closed')`, which lifecycle already treats as a failure.

- `stdin`/`stdout`/`stderr` **streams** (forward, autoforward, the MCP bridge, copy helpers) pipe to and
  from the channel frames. Nothing in those modules changes.
- **`'inherit'` with `tty`** (`shell`, `attach`, `agent`) is the one case the local backend solves by
  handing `docker exec -it` its real fds. Remotely the **client is the terminal**: `RemoteKunjBackend`
  puts `process.stdin` in raw mode, sends its bytes on channel `0`, writes channel `1` to
  `process.stdout` (a TTY exec has one merged output stream, as `docker exec -t` does), sends a `resize`
  control frame right after the request and on every `SIGWINCH`, and restores the terminal on `exit`,
  close, error and an uncaught exception, as commit.ts does around its own raw-mode moments. Ctrl-C is
  byte `0x03` on channel `0`, delivered to the container's pty, so tmux and the agent see it and kunj does
  not die. The exit code is the `exit` frame's.
  On the **server**, `docker exec -t` refuses to run without a TTY on its own stdin and kunj has no pty
  dependency, so a TTY exec goes through the **Docker Engine API** on the daemon socket (the socket from
  `docker context inspect`): `POST /containers/:id/exec` with `Tty`, `AttachStdin/Stdout/Stderr`, `User`,
  `WorkingDir`, `Env`; `POST /exec/:id/start` on a hijacked connection, whose raw bytes are the pty;
  `POST /exec/:id/resize?h=&w=` for each `resize` frame; `GET /exec/:id/json` for the exit code. Closing
  the WebSocket closes the hijacked socket, which hangs up the pty (SIGHUP to the process group, as a
  dropped SSH session would). This is `execTty()` in docker.ts, a second way of talking to Docker that
  stays inside the one module allowed to. Non-TTY execs keep spawning `docker exec`. The env a TTY exec
  carries is what `interactive()` sets today (`TERM`, `COLORTERM`, `LANG`), not secrets; the server
  refuses other names on a TTY exec.
- `'inherit'` **without** `tty` (progress output of a seed or a preset) is streamed to the client's
  `process.stdout`/`stderr` unchanged.
- `'ignore'` stdin sends EOF at once. `timeoutMs` is enforced on the server (the exec is killed) and
  reported as `{ "error": "timeout" }`, which the client rethrows as `ExecTimeoutError`.

**Logs and events** are text frames, one JSON object per line. `events` resolves when the client closes
the socket (the abort signal) and rejects when the server closes it first, which is what `kunj events`
expects: it prints `backend unavailable` and retries `info()` every 10 s.

**copyIn and buildImage** stream the tar as the request body. The server pipes it straight into
`docker exec … tar -x` / `docker build -`; nothing is written to the box's disk. The env of `run()` is
written by the server's `LocalDockerBackend` to a 0600 temp file for `--env-file` and deleted after the
run, exactly as locally; the request body is the only other place it exists, and the body is never
logged.

## What the server refuses

The server is not a Docker proxy. Every id it is given must be an object kunj made:

- `exec`, `start`, `stop`, `remove`, `copyIn`, `commit`, `logs`, `inspectLabels`, `containerState`:
  the container must carry the label `kunj.repo` (one `inspect`, cached 5 s per id). Volumes and
  networks in `remove` must carry `kunj.repo` too.
- `run`: the spec's labels must include `kunj.repo`; `privileged` and `runtime` are refused unless the
  server was started with `--allow-privileged` / `--allow-runtime sysbox-runc`, and `features.dockerInDocker`
  reports only what is allowed, so the client's `checkDind()` refuses before it tries.
- `buildImage`, `commitContainer`, `removeImage`: the tag must start with `kunj-`.
- `list`, `listImages`, `listVolumes`, `listNetworks`, `events`: the filter must include a `kunj.*`
  label (`kunj.repo`, or `kunj.managed` for prune's orphan scan).
- Bodies above 1 MB (except the streaming tar bodies), label keys outside `kunj.*` on create, and
  `spec.publish` entries whose host port is not loopback-bound are refused. Published ports bind to the
  box's loopback and are useless from the laptop; `forward` is the way to reach them, so the server
  says so.

## Client side

- **Settings:** `container.remote` (string, the remote's name; `""` or unset means local). Repo-local
  config is the expected place, so one repository's containers live on the box and another's stay on
  the laptop. `--remote <name>` on every `ct` subcommand overrides, `--remote local` forces the laptop
  (like `--context`, which stays and means the laptop's Docker context).
- **`kunj remote`** (src/commands/remote.ts, on the fast path): `add`, `list` (name, how it is reached,
  last `ping` result; never the token), `remove`, `ping <name>` (`GET /v1/info`, prints versions and
  features), `token <name>` (replace the stored token). `~/.kunj/remotes.json`:
  `{ "<name>": { "ssh"?: "user@box", "port"?: 7433, "url"?: "https://…", "token": "…" } }`.
- **`ct list --json`:** `backend` becomes `{ kind: 'docker', context }` for local and
  `{ kind: 'remote', remote: '<name>', context }` for a remote. `kind` is a union now; the apps treat an
  unknown kind as "not local" and show the remote's name in the row. `features` is added to the object
  so an app knows `editorAttach` is off without guessing.
- **`kunj ct open`** on a remote: `ContainerError('remote-no-editor')`, with the hint to open the box
  through Remote-SSH and run `kunj ct open` there, or to use `kunj ct shell`. **`features.localPorts`**
  stays true: the forwarder listens on the laptop and tunnels through the exec channel, so `forward`,
  `--auto` and the ports in the apps work as before, only slower (one WebSocket per connection on top of
  one exec).
- **`kunj events`:** the container watcher uses the configured remote per repo, and a remote that is
  down is `backend unavailable` for that repo only.
- **Hooks** (`pre/post-container-create|delete`) run on the laptop, as they do today; `container` and
  `image` in their arguments are the names on the box.
- **Snapshots:** `makeBranchBundle()` runs on the laptop (its credentials) and the bundle goes in
  through `copyIn`, so a snapshot of a private origin needs no token on the box. `kunj ct blueprint
  snapshot` and `status` take `--remote` like `start`.
- **Prune:** `git ls-remote --heads origin` runs on the laptop, the Docker side on the box. Unchanged.
- **The apps' terminals** (the workspace app's shell and agent tabs, a VS Code terminal) run
  `kunj ct shell|agent <branch> --session <id>` in a pty as they do today; kunj runs the host-side parts,
  then its one TTY exec is the WebSocket channel above, kunj itself relaying between SwiftTerm's pty and
  the socket. tmux stays inside the container, so a reopened tab reattaches as locally. Nothing in the
  apps changes. For an `--ssh` remote the tunnel's `ssh` must never prompt from a GUI: keys through the
  agent (macOS gives GUI apps `SSH_AUTH_SOCK`), and `kunj remote add --ssh` connects once,
  interactively, so the host key is in `known_hosts` before any app session; a prompt that does appear
  lands in the terminal tab, where it can be answered. A `--url` remote has no such step.
- **The SSH tunnel** lives for one kunj process. Detached helpers (`forward --auto`, `ct mcp`) are
  their own processes and open their own tunnel; `spawnDetached` passes `--remote` as it passes
  `--context` today.

## Timing

Locally a `docker exec` is 100–300 ms on Docker Desktop; remotely add one round trip per call and one
WebSocket handshake per exec. `ct list` is one `GET` plus one exec per running container; `start` is
some dozens of calls (image check, network, volumes, run, ready wait, seed, copies, maintain), so a
start that takes 20 s locally takes a few seconds more over a LAN and noticeably more over the
internet. The ready wait polls `/tmp/kunj-ready` with an exec every 500 ms today; over the wire the
remote backend keeps the interval but each poll is a round trip, which is fine. Nothing is batched in
v1; if a listing turns out slow, the first batch is a `GET /v1/containers?label=…&status=1` that runs
`STATUS_SCRIPT` on the server for each running container and returns it with the list.

## Security impact

- The server is root-equivalent on the box's Docker for anyone with the token (see Transport and
  auth). Loopback by default, SSH tunnel by default, refusal of non-`kunj.*` objects, no privileged or
  runtime without flags, and a constant-time token compare are the controls; TLS and per-user tokens
  are the next spec.
- Secrets: in transit inside the SSH tunnel or the user's TLS; at rest only in the env temp file during
  `docker run` and in the container's process environment, as today. The server never logs a request
  body or an exec's bytes. `--verbose` logs routes, ids and durations.
- A container on the box can reach what the box's firewall helper allows, which is the box's network,
  not the laptop's. `container.network.allow` is evaluated in the helper on the box as today; `forward`
  and the MCP bridge reach the laptop only through connections the laptop opens.
- The `kunj.*` label check means a token holder cannot use the server to exec into the box's other
  containers; they can still create a kunj-labelled container and exec into that, which is the point of
  the tool. Docker-in-Docker and `--privileged` stay off unless the server operator opts in.

## Testing

- **Unit:** `src/lib/serve/__tests__/` starts the server in-process on an ephemeral loopback port with
  `FakeBackend` behind it and runs `RemoteKunjBackend` against it; the existing lifecycle, forward,
  services, snapshot and prune tests are parametrised to run against both `FakeBackend` and
  `RemoteKunjBackend`-over-`FakeBackend`, so every stream and every error text crosses the wire once.
  The TTY channel is tested with a fake terminal (a duplex pair standing in for `process.stdin/stdout`,
  `setRawMode` recorded) against `FakeBackend`'s `execTty`: raw mode on and off on every exit path,
  the first `resize`, `SIGWINCH` → `resize`, `0x03` passed through, exit code, refused env names. Auth:
  missing, wrong and rotated tokens; the `kunj.*` refusals; body limits; a mid-stream disconnect.
- **Docker:** `remote.docker.test.ts` runs the server against the real daemon and checks copyIn and
  build through the body stream, events, and a TTY exec through the Engine API: `stty size` in the
  container after a `resize` frame, and a hang-up when the client closes the socket.
- **Functional:** `remote.functional.test.ts` starts `kunj serve` as a child, adds it as a remote with
  `--url http://127.0.0.1:<port>` and runs the start/list/shell/forward/stop/remove path of the existing
  functional suite with `--remote`.

## Implementation order

1. Validate `container.dockerContext` over SSH end to end (no code; a note of what broke, if anything).
2. Protocol module (`src/lib/serve/protocol.ts`: routes, frame encoding, error mapping) and
   `RemoteKunjBackend`, over an in-process server with `FakeBackend`; parametrised tests. No TTY yet.
3. `kunj serve` command, token file, `--listen`, refusals, `--verbose` log; `kunj remote` and
   `~/.kunj/remotes.json`; `container.remote` and `--remote` in `ct`; `backend` in `ct list --json`.
4. TTY exec: `execTty()` in docker.ts over the Engine API; the client's raw-mode terminal and resize;
   `shell`, `attach` and `agent` against a remote.
5. The SSH tunnel; `kunj events` per-repo remotes; `spawnDetached` with `--remote`.
6. Docker and functional tests; docs-site page; `kunj setup` asks about a remote when `ct` is used.
7. Later: Remote-SSH editor attach, TLS, per-user tokens.

## Decisions

- **2026-10-24** Thin server. `kunj serve` exposes `ContainerBackend` and nothing above it; the laptop
  keeps `~/.kunj` and runs lifecycle, hooks, secrets and bundles. A thick server would need the vault,
  keep files and hooks on the box and a way to keep them in step with the laptop.
- **2026-10-24** Loopback plus SSH tunnel is the v1 transport; kunj opens the tunnel itself. No TLS code
  in kunj; a user who wants a URL puts it behind their own proxy. Plain `http://` only to loopback.
- **2026-10-24** One bearer token per server, in a 0600 file on each side, not in the secrets vault:
  the commands that use it most are the listings, which never unlock the vault.
- **2026-10-24** Everything over the protocol, the terminal included; SSH is only a tunnel when the
  box has no TLS in front of it. Considered and rejected: the whole CLI over SSH (state moves to the
  box) and a hybrid with `ssh -t … kunj serve exec` for the interactive commands (SSH becomes a
  requirement, a shell account stays in the picture, `--url` remotes get no terminal).
- **2026-10-24** TTY exec on the server goes through the Docker Engine API, not a pty: kunj gets no
  native dependency (`node-pty` was the alternative; `script`/`unbuffer` wrappers rejected as fragile),
  and docker.ts stays the only module that touches Docker.
- **2026-10-24** The server refuses anything not labelled `kunj.*`, so a token is "kunj on this box",
  not "Docker on this box". Privileged and runtime are opt-in flags of the server.
- **2026-10-24** `features.editorAttach` is false on a remote; `ct open` refuses with the Remote-SSH
  hint. `features.localPorts` stays true, because the forwarder runs on the laptop.

## Open questions

- Should `kunj serve` run as a systemd unit by default (`kunj serve install`)? Or leave it to docs with
  an example unit file, like `kunj completion --install` does for shells. Leaning docs plus example.
- `remotes.json` vs a per-remote directory: one file is enough for a handful of boxes.
- Whether to batch `STATUS_SCRIPT` into the list route in v1 or wait for a measurement.
- The SSH tunnel's `ssh` arguments: honour `~/.ssh/config` (yes), allow `--ssh-option` (probably not in v1).
