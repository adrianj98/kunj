# Branch containers — design

*2026-10-21. Kunj CLI (`kunj container`), later the VS Code extension and macOS app.*

## Goal

Start a session for a branch inside a Docker container, the way `kunj worktree` gives a branch its
own directory. The main use is a **real sandbox for an AI agent** (Claude Code with
`--dangerously-skip-permissions`): the agent cannot touch the host's files, the host's `.git`, or
other branches' containers. The same container also serves an attached editor (VS Code / Cursor)
and an interactive shell for running the app and its tests, with its own dependencies, ports and
databases that do not clash with other branches.

Later, the Docker daemon may live on a **remote machine** running a kunj service, with the local
kunj driving it. v1 does not build that service, but nothing in v1 may assume the host and the
Docker daemon share a filesystem.

## Non-goals (v1)

- `kunj serve` and the remote backend (see *Remote roadmap*).
- Full devcontainer spec support: features, `initializeCommand`, `onCreateCommand`,
  `updateContentCommand`, `customizations` are ignored with a warning.
- Mounting the host Docker socket — never offered (it is root on the host).
- VS Code extension and macOS app UI (phase 2, below); v1 only keeps the JSON they will need.

## Decisions

| Question | Decision |
|---|---|
| Isolation | Real sandbox: the container has its own clone; nothing is bind-mounted from the host. |
| How code gets in and out | Only through `origin`. The container clones it and pushes to it; the host fetches. No bundles, no shared `.git`. |
| Image | The repo's `.devcontainer/devcontainer.json` (image or Dockerfile), else kunj's default `kunj-sandbox` image; `container.image` overrides both. The image holds tools only, never the repo. |
| Credentials | Configurable: host env var names to forward and files to copy in. Git identity always. |
| Network | Open by default; `container.network.allow` turns on an egress allowlist firewall. |
| Services (Postgres…) | Sidecar containers declared in `container.services`, on a per-branch network. |
| Docker inside | Opt-in `container.dockerInDocker: off \| sysbox \| privileged`. |
| Ports | `kunj container forward` tunnels over `docker exec` (default); `--publish` for static `-p`. |
| Agents | Run in `tmux` inside the container, so they survive a disconnect; `attach` reconnects. |
| Relation to worktrees | Independent: a branch may have a worktree, a container, both or neither. |
| Backend | Drive the `docker` CLI directly behind a `ContainerBackend` interface (no `@devcontainers/cli`, no `dockerode`). |

## What the user sees

`kunj container` (alias `kunj ct`):

```text
kunj ct start [branch] [-c] [--base <ref>] [--image <img>] [--publish <ports>] [--rebuild] [--json]
kunj ct shell [branch]                 # interactive bash/zsh in /workspace as user dev
kunj ct exec  [branch] -- <cmd...>     # run a command (TTY when stdin is one)
kunj ct agent [branch] [-- <args>]     # start or reattach the agent's tmux session (container.agentCommand)
kunj ct attach [branch]                # reattach to the agent's tmux session
kunj ct open  [branch] [--new-window]  # attach the editor to the container
kunj ct forward [branch] [<port>|<host>:<port>...] [--auto]
kunj ct list [--all] [--json]          # containers of this repo (--all: every repo)
kunj ct stop [branch]                  # stop, keep workspace and services
kunj ct remove [branch] [--force] [--keep-volumes]
kunj ct prune                          # remove containers whose branch is gone from origin and the host
```

`[branch]` defaults to the current branch; with no argument and a TTY, `start` (and the others) offer
an interactive picker like `kunj switch`. `-c` creates the branch, as `kunj worktree add -c` does.

Typical agent flow:

```bash
kunj ct start feat-x -c            # build/reuse image, create container, clone, checkout new branch
kunj ct agent feat-x               # Claude Code in tmux; Ctrl-b d detaches, it keeps working
kunj ct forward feat-x --auto      # browse the dev server it started on localhost
kunj ct attach feat-x              # come back later
git fetch && git switch feat-x     # on the host, after the agent pushed
kunj ct remove feat-x
```

## Architecture

```text
src/commands/container.ts        CLI: argument parsing, prompts, output (fast path)
src/lib/container/backend.ts     ContainerBackend interface + types
src/lib/container/docker.ts      LocalDockerBackend: spawns `docker` (honours container.dockerContext)
src/lib/container/image.ts       image resolution: setting > devcontainer.json > kunj-sandbox; config hash tag
src/lib/container/devcontainer.ts  reads the supported subset of devcontainer.json (JSONC)
src/lib/container/lifecycle.ts   start/stop/remove orchestration (network, volumes, services, seed, firewall)
src/lib/container/seed.ts        clone-from-origin script + unpushed-commit check on the host
src/lib/container/forward.ts     exec-tunnel port forwarder + forwards registry
src/lib/container/names.ts       container/volume/network names and labels
src/container/sandbox/           Dockerfile, init-firewall.sh, git-credential helper (copied to dist/)
```

Every Docker call goes through the backend; `lifecycle.ts` and the command never spawn `docker`
themselves. `container` joins `FAST_COMMANDS` in src/commands/fast.ts; inquirer is imported lazily
only for the picker and confirmations.

### Backend interface

```ts
interface ContainerBackend {
  readonly features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: ('sysbox' | 'privileged')[] };
  imageExists(tag: string): Promise<boolean>;
  buildImage(tag: string, context: Readable /* tar */, opts: BuildOptions): Promise<void>;
  createNetwork(name: string, labels: Labels): Promise<void>;
  createVolume(name: string, labels: Labels): Promise<void>;
  run(spec: ContainerSpec): Promise<string>;                 // detached; returns id
  list(filter: Labels): Promise<ContainerInfo[]>;            // from labels; the only state
  exec(id: string, cmd: string[], io: ExecIO): Promise<number>; // streams; tty, user, env, workdir
  copyIn(id: string, dir: string, tar: Readable): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(ids: { containers: string[]; volumes: string[]; networks: string[] }): Promise<void>;
}
```

Rules that keep v1 remote-ready:

1. No host bind mounts. Files (keep files, credential files, the sandbox scripts) are tar-streamed
   with `copyIn`; build contexts are tar-streamed (`docker build -`).
2. Secrets are values passed with `--env-file` from a 0600 temp file deleted right after
   `docker run`, never on the command line. (They remain visible to `docker inspect`; documented.)
3. No kunj state about containers on the host: names, branch, repo and options are Docker labels
   (`kunj.repo` = repo id from the origin URL, `kunj.branch`, `kunj.base`, `kunj.version`,
   `kunj.options` JSON). The one exception is the forwards registry, which describes host processes.
4. Ports and editor attach are capabilities the backend reports (`features`), not assumptions.

### Names

`<repo>` is the repo name `getKunjDir()` already derives; `<b>` is `branchToDirName(branch)`.

| Object | Name |
|---|---|
| Container | `kunj-<repo>-<b>` |
| Workspace volume (`/workspace`) | `kunj-<repo>-<b>-ws` |
| Home volume (`/home/dev`: shell history, `~/.claude`) | `kunj-<repo>-<b>-home` |
| Docker data volume (DinD only, `/var/lib/docker`) | `kunj-<repo>-<b>-docker` |
| Network | `kunj-<repo>-<b>-net` |
| Service | `kunj-<repo>-<b>-<service>` (+ volume `…-<service>-data`) |

## Image

Resolution, first match wins:

1. `--image` / `container.image`.
2. `.devcontainer/devcontainer.json` (or `.devcontainer.json`) at the branch's tip on origin, read
   with `git show origin/<branch>:<path>` on the host (or `origin/<base>` for `-c`), parsed as
   JSONC. Supported keys: `image`, `build.dockerfile`, `build.context`, `build.args`,
   `containerEnv`, `remoteUser`, `forwardPorts`, `postCreateCommand`, `postStartCommand`,
   `dockerComposeFile` (only to print the DinD hint). Others warn once.
3. The default `kunj-sandbox:<kunj version>`, built locally on first use from
   `dist/container/sandbox/Dockerfile`: Debian slim, git, gh, node LTS, Claude Code, tmux, socat,
   iproute2, iptables/ipset, sudo, zsh; user `dev` (uid 1000) with sudo **only** for
   `/usr/local/bin/init-firewall.sh`, modelled on
   `github.com/anthropics/claude-code/.devcontainer`.

A devcontainer Dockerfile is built from a tar of `build.context` taken from `git archive
origin/<branch>` (not the host working tree, so the image matches what the container clones). The
tag is `kunj-<repo>:<hash>` where the hash covers the Dockerfile, the context tree id and the build
args; an existing tag is reused. `--rebuild` forces a build and recreates the container, keeping its
volumes.

Devcontainer images lack kunj's tools. At start kunj checks for `git`, `tmux`, `socat` and `sudo`
and warns about missing ones (the agent then runs without tmux; forwarding falls back to bash
`/dev/tcp`; the firewall is unavailable and `network.allow` fails the start).

## Starting a container

`kunj ct start <branch>`:

1. **Resolve** the repo, origin URL and base (`resolveBaseRef()` for `-c`). Run
   `pre-container-create`.
2. **Check origin has the work.** `git fetch origin <branch>`; if the branch exists only locally,
   or the host's branch has commits `origin/<branch>` lacks, offer to push them (`git push -u`).
   Declining aborts; in `--json` mode it fails with `code: "unpushed"` instead of prompting.
   There is no `--no-origin`: origin is the only channel, so `-c` always starts from
   `origin/<base>`.
3. **Image** (above).
4. **Network and volumes** created if missing; **services** started on the network (below).
5. **Run** the container detached: `sleep infinity` as PID 1 under `--init`, user `dev`,
   workdir `/workspace`, labels, env file, `--network`, optional `--cpus/--memory`,
   `--cap-add NET_ADMIN,NET_RAW` only when the firewall is on, `--runtime sysbox-runc` or
   `--privileged` for DinD, and `-p 127.0.0.1:<free>:<port>` for each `--publish` /
   `forwardPorts` entry.
6. **Firewall** (when `network.allow` is set): `copyIn` `init-firewall.sh`, run it with sudo,
   fail the start if its self-check fails.
7. **Seed** (`seed.ts`, run with `exec` as `dev`) — only when `/workspace/.git` is absent:
   - git identity from the host (`user.name`, `user.email`);
   - when a token is forwarded (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`), a credential
     helper that reads it, and `url.https://<host>/.insteadOf git@<host>:` so SSH origins work;
   - `git clone <origin> /workspace`, then `git switch <branch>` or, for `-c`,
     `git switch -c <branch> --no-track origin/<base>`.
8. **Keep files** from `~/.kunj/<repo>/keep/` and `container.files` are tar-streamed in.
9. `postCreateCommand` once (marker file `/home/dev/.kunj-created`), `postStartCommand` every start.
10. Run `post-container-create`; print a summary (or JSON).

Starting a container that exists but is stopped just starts it, re-runs the firewall and
`postStartCommand`. Starting a running one is a no-op that prints its state.

### Getting work out

There is no kunj command for it. The agent (or the user, via `kunj ct exec feat-x -- git push`)
pushes to origin; the host fetches. Opening a PR from inside works when the token allows it (`gh`
is in the default image). The token should be a fine-grained one limited to the repository;
branch protection on the default branch is the backstop. `kunj ct remove` refuses when the
container's branch has commits not on origin, or uncommitted changes, unless `--force`.

## Credentials and settings

New `container` category in the settings registry (src/settings/index.ts):

| Setting | Default | Meaning |
|---|---|---|
| `container.image` | `""` | Image override |
| `container.agentCommand` | `claude --dangerously-skip-permissions` | What `kunj ct agent` runs |
| `container.env` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GH_TOKEN` | Host env var names forwarded when set; `NAME=value` entries (with `${...}` variables) are passed literally |
| `container.files` | `[]` | `hostPath:containerPath` files copied in at start (e.g. `${home}/.aws/config:/home/dev/.aws/config`) |
| `container.network.allow` | `[]` | Empty: open internet. Otherwise an egress allowlist (below) |
| `container.services` | `{}` | Sidecars, below |
| `container.dockerInDocker` | `off` | `off`, `sysbox`, `privileged` |
| `container.dockerContext` | `""` | Docker context for every call (`docker --context`) |
| `container.cpus` / `container.memory` | `""` | Resource limits |
| `container.publish` | `[]` | Ports always published at start |

macOS keychain logins cannot be shared into Linux, so Claude auth is `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or Bedrock via the `AWS_*` variables. `kunj
ct start` warns when none of them is set and the agent command is `claude`. `~/.claude` lives in
the home volume, so a login done inside the container persists for that branch.

## Network

Without `container.network.allow` the container has normal internet access.

With it, `init-firewall.sh` (adapted from Anthropic's reference script) sets INPUT/OUTPUT/FORWARD
to DROP, allows DNS, loopback and established traffic, the branch network's subnet (so sidecars
work), GitHub's ranges from `api.github.com/meta` when origin is on GitHub, and the resolved IPs
of: the listed domains, origin's host, `api.anthropic.com`, `bedrock-runtime.<AWS_REGION>.amazonaws.com`
when Bedrock is on, `registry.npmjs.org`, and Docker Hub / `ghcr.io` when DinD is on. Unlike the
reference script it does **not** allow the Docker host's gateway beyond the branch subnet's
sidecars. It verifies that `example.com` is unreachable and origin is reachable, or the start fails.

Each branch has its own bridge network, so containers of different branches cannot reach each other.

## Services and Docker inside

**Sidecars** (`container.services`), started before the container and removed with it:

```json
"container.services": {
  "postgres": { "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "dev" }, "port": 5432 }
}
```

Each runs as `kunj-<repo>-<b>-<name>` on the branch network with the network alias `<name>`, a
data volume, and no published ports. The agent reaches `postgres:5432`; no other branch can.

**Docker inside** (`container.dockerInDocker`): the container runs its own `dockerd`
(`/var/lib/docker` on the branch's docker volume), so `docker compose up` works as on a laptop, and
two branches running the same compose file never clash (separate daemons: same project names,
container names, ports and volumes are fine). Costs: an image cache per branch and the RAM of two
stacks.

- `sysbox` uses `--runtime sysbox-runc`; available only on Linux hosts with sysbox installed
  (checked with `docker info`).
- `privileged` uses `--privileged`, which an escape turns into access to the Docker host. It is
  refused against Docker Desktop's default context (whose VM shares `/Users`) unless
  `--allow-privileged` is passed; the recommended use is a dedicated Colima/OrbStack/Lima VM with
  file sharing off, selected with `container.dockerContext`. The README documents setting one up.

When the repo has a compose file and DinD is off, `start` prints a one-line hint.

## Ports

**`kunj ct forward`** (default): kunj listens on `127.0.0.1:<host port>`; each accepted connection
runs `docker exec -i <ctr> socat - TCP:127.0.0.1:<port>` (fallback: bash `/dev/tcp`) and pipes
both ways. It reaches servers bound to localhost inside the container and inner DinD services, and
needs nothing at `docker run` time. The host port is the container port when free, else the next
free one. `--auto` polls `ss -ltnH` in the container every 2s and forwards new listeners (and drops
closed ones). It runs in the foreground until interrupted, and records `{pid, container, port,
hostPort}` in `~/.kunj/container-forwards.json` (dead PIDs pruned on read, like editor sessions).

**`--publish`** / `container.publish` / `forwardPorts`: static `-p 127.0.0.1:<free>:<port>` at
`docker run`. Faster for load testing; the server must listen on `0.0.0.0`. Changing them needs
`--rebuild`.

## Editor

`kunj ct open` launches `worktree.editorCommand` with
`--folder-uri vscode-remote://attached-container+<hex>/workspace`, where `<hex>` is the hex of
`{"containerName":"/kunj-<repo>-<b>"}` (to be confirmed against VS Code and Cursor during
implementation). Window flags follow `buildOpenCommand()`. Requires the Dev Containers extension;
the editor forwards ports itself. For non-VS Code editors, `open` prints the shell command instead.

## Hooks

Add `pre/post-container-create` and `pre/post-container-delete` to `HOOKS` in
src/lib/hook-defs.ts, with arguments `branch`, `container` and `image`, run on the host through
`runActionHook()`; `--no-hooks` on `start` and `remove`.

## JSON

`kunj ct list --json` (kept backwards compatible once the extension and app consume it):

```json
{
  "repo": "kunj",
  "backend": { "kind": "docker", "context": "default" },
  "containers": [{
    "branch": "feat-x", "name": "kunj-kunj-feat-x", "id": "3f2a…", "state": "running",
    "image": "kunj-sandbox:1.3.0", "createdAt": "2026-10-21T10:00:00Z",
    "dockerInDocker": "off", "firewall": false,
    "services": [{ "name": "postgres", "state": "running" }],
    "ports": [{ "container": 3000, "host": 3001, "kind": "forward", "pid": 4242 }],
    "agent": { "running": true },
    "workspace": { "head": "a1b2c3d", "ahead": 2, "dirty": true }
  }]
}
```

`agent.running` and `workspace` come from one `exec` per *running* container
(`tmux has-session; git status --porcelain=v2 --branch`), matching the one-status-call-per-worktree
budget of `kunj worktree list`. `--no-status` skips it.

## Errors

- Docker missing or daemon down: one clear message (`docker info` failed: …), exit 1.
- Every failure after the container is created rolls back what this run created (container,
  network, volumes, services) unless `--keep-on-error`, so a failed start leaves nothing behind.
- Clone failure (auth): point at the token settings, show git's stderr.
- Name collision with a non-kunj container: refuse.
- `--json` mode: errors as `{ "error": { "code", "message" } }`, hook output to stderr (as worktrees do).

## Testing

- Unit (Jest, no Docker): name/label derivation, devcontainer JSONC parsing and image resolution,
  image hash, `docker run` argument building (env file, caps, runtime, publish), the seed script
  text, firewall domain list, `ss` output parsing, forwards registry, list JSON shaping. The backend
  is an interface, so `lifecycle.ts` is tested against a fake backend that records calls,
  including rollback on each failing step.
- Integration (`npm run test:docker`, skipped when `docker info` fails; not in the default `npm
  test`): start a container against a local bare repo served as origin, check the clone and branch,
  push from inside and fetch on the host, forward a port to a `python -m http.server`, sidecar
  reachability and cross-branch isolation, firewall blocks `example.com`, remove leaves no
  `kunj.repo`-labelled objects.

## Phases

1. **v1 CLI**: everything above except DinD, plus the README section.
2. **DinD** (`sysbox`, `privileged`) and the isolated-VM documentation.
3. **UI**: containers in the VS Code extension's tree and the macOS app (start, agent in a
   terminal, open, forward, remove), reading `kunj ct list --json`.
4. **Remote**: `container.dockerContext` over SSH validated end to end; then `kunj serve` (an
   authenticated HTTP/WebSocket API exposing `ContainerBackend`) and a `RemoteKunjBackend`. Auth,
   TLS and multi-user get their own spec.

## Remote roadmap notes

Because every Docker interaction is a stream through the backend and origin is the only git
channel, a remote backend needs no new git or file transfer design. What changes: `forward` tunnels
over the service's WebSocket instead of `docker exec`, and editor attach goes through Remote-SSH to
the server (`features.editorAttach` false until then).

## Open questions

- Exact `attached-container` URI encoding accepted by current VS Code and Cursor (check during
  phase 1).
- Whether `kunj-sandbox` should also be published to a registry so remote hosts need not build it
  (decide in phase 4).
