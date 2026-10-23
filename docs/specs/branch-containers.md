<!-- On-disk copy of the Claude Doc "Branch Containers Design" (https://claude.ai/artifact/8AhUG3mjYg5kDJNRNJW3xP), rebuilt on 2026-10-23 from the edits made in Claude Code. Drawings are noted in italics. -->

# Branch Containers Design

2026-10-21 · Adrian Jones

## Goal

`kunj container` starts a session for a branch inside a Docker container, the way `kunj worktree` gives a branch its own directory. The main use is a real sandbox for an AI agent (Claude Code with `--dangerously-skip-permissions`): the agent cannot touch the host's files, the host's `.git`, or other branches' containers. The same container serves an attached editor (VS Code, Cursor) and an interactive shell for running the app and its tests, with its own dependencies, ports and databases that never clash with other branches.

Later the Docker daemon may live on a remote machine running a kunj service, with the local kunj driving it. v1 does not build that service, but nothing in v1 may assume the host and the Docker daemon share a filesystem.

**Not in v1:** `kunj serve` and the remote backend; full devcontainer support (features and the rarer lifecycle hooks are ignored with a warning); mounting the host Docker socket (never offered, it is root on the host); the VS Code extension and macOS app UI (phase 3).

## What the sandbox does and does not protect

Added in the second pass, because "sandbox" is easy to over-read.

| Protected in every mode | Not protected |
| --- | --- |
| Host filesystem: nothing is bind-mounted; the workspace is a named volume. | **Whatever you forward in.** The agent can read every env var and file you pass and, with internet access, send them anywhere. Forward the least you can; prefer a repo-scoped token. |
| Host `.git` and other branches: each container has its own clone, on its own network. | **Origin, within the token's scope.** The agent can push to any branch the token may write to; branch protection on the default branch is the backstop. |
| Host services: the Docker gateway (`host.docker.internal`), the LAN and RFC1918 ranges are blocked by default in every mode. | **Exfiltration under an allowlist.** The allowlist limits destinations, not data: GitHub, npm and DNS are enough to carry a token out. |
| Host Docker daemon: the socket is never mounted. | **`privileged` Docker-in-Docker:** an escape reaches the Docker host (on a Mac, the VM and whatever it shares). Only for a dedicated VM. |

## Decisions

These are the choices made during the brainstorm; each row is a place to comment if you disagree.

| Question | Decision |
| --- | --- |
| Isolation | Own clone in a named volume; nothing bind-mounted from the host. |
| Code in and out | Only through `origin`. The container clones it and pushes to it; the host fetches. No bundles, no shared `.git`. |
| Image | The repo's `.devcontainer/devcontainer.json` (image or Dockerfile), else kunj's default `kunj-sandbox` image; `container.image` overrides both. The image holds tools only, never the repo. `remoteUser: root` is refused. |
| Credentials | Configurable: host env var names to forward and files to copy in. Git identity always. AWS keys only when Bedrock is on. |
| Network | A network-helper sidecar owns the firewall, so the agent's container never has `NET_ADMIN`. Default: internet open, host and LAN blocked. `container.network.allow` adds an egress allowlist, re-resolved every 5 min. |
| Services (Postgres, Redis) | Sidecar containers in `container.services` on the per-branch network (phase 2). |
| Docker inside the container | Opt-in `container.dockerInDocker: off / sysbox / privileged` (phase 2); `privileged` needs `container.allowPrivileged: true`. |
| Ports | `kunj ct forward` tunnels over `docker exec` (manual ports in v1, `--auto` in phase 3); `--publish` for static `-p`. |
| Agents | Run in `tmux` inside the container so they survive a disconnect; `attach` reconnects. |
| Relation to worktrees | Independent: a branch may have a worktree, a container, both or neither. |
| Backend | Drive the `docker` CLI directly behind a `ContainerBackend` interface; no `@devcontainers/cli`, no `dockerode`. |

## What the user sees

`kunj container` (alias `kunj ct`). `[branch]` defaults to the current branch; with no argument and a TTY, the commands offer an interactive picker like `kunj switch`. `-c` creates the branch, as `kunj worktree add -c` does.

```text
kunj ct start [branch] [-c] [--base <ref>] [--image <img>] [--publish <ports>] [--rebuild] [--json]
kunj ct shell [branch]                 # interactive shell in /workspace as the sandbox user
kunj ct exec  [branch] -- <cmd...>     # run a command (TTY when stdin is one)
kunj ct agent [branch] [-- <args>]     # start or reattach the agent's tmux session
kunj ct attach [branch]                # reattach to the agent's tmux session
kunj ct open  [branch] [--new-window]  # attach the editor to the container (phase 2)
kunj ct forward [branch] <port>|<host>:<port>...   # --auto in phase 3
kunj ct list [--all] [--json] [--no-status]
kunj ct stop [branch]                  # stop, keep workspace and services
kunj ct remove [branch] [--force] [--keep-volumes]
kunj ct prune [--force]                # phase 2: branch gone from origin, with the remove guard
```

`-c` creates the branch inside the container from `origin/<base>`; unlike `kunj worktree add -c` it ignores `preferences.baseFromOrigin` and has no `--no-origin`, because origin is the only channel. A `--base` that does not exist on origin is refused before anything is created.

A typical agent session:

```bash
kunj ct start feat-x -c            # build or reuse the image, create the container, clone, new branch
kunj ct agent feat-x               # Claude Code in tmux; Ctrl-b d detaches, it keeps working
kunj ct forward feat-x --auto      # browse the dev server it started, on localhost
kunj ct attach feat-x              # come back later
git fetch && git switch feat-x     # on the host, after the agent pushed
kunj ct remove feat-x
```

## Architecture

The CLI never spawns `docker` itself; every call goes through a `ContainerBackend`, and git traffic goes only through origin. That is what makes a remote daemon a later addition rather than a redesign.

<?claude block dia?>

The host side is the CLI and the backend; the daemon side is the branch container, its sidecars and its network. Only two things cross between them: Docker API calls and git pushes to origin.

**Modules**

| File | Role |
| --- | --- |
| `src/commands/container.ts` | CLI: arguments, prompts, output; on the fast path (`FAST_COMMANDS`), inquirer imported lazily |
| `src/lib/container/backend.ts` | `ContainerBackend` interface and types |
| `src/lib/container/docker.ts` | `LocalDockerBackend`: spawns `docker`, honours `container.dockerContext` |
| `src/lib/container/image.ts` | Image resolution and config-hash tag |
| `src/lib/container/devcontainer.ts` | Reads the supported subset of `devcontainer.json` (JSONC) |
| `src/lib/container/lifecycle.ts` | start, stop, remove: network, volumes, services, seed, firewall, rollback |
| `src/lib/container/seed.ts` | Clone-from-origin script and the unpushed-commit check |
| `src/lib/container/forward.ts` | Exec-tunnel port forwarder and the forwards registry |
| `src/lib/container/names.ts` | Container, volume and network names; labels |
| `src/container/sandbox/` | Dockerfile, `init-firewall.sh`, git credential helper (copied to `dist/`) |

**Backend interface**

```ts
interface ContainerBackend {
  readonly features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: ('sysbox' | 'privileged')[] };
  imageExists(tag: string): Promise<boolean>;
  buildImage(tag: string, context: Readable /* tar */, opts: BuildOptions): Promise<void>;
  createNetwork(name: string, labels: Labels): Promise<void>;
  createVolume(name: string, labels: Labels): Promise<void>;
  run(spec: ContainerSpec): Promise<string>;                    // detached; returns id
  list(filter: Labels): Promise<ContainerInfo[]>;               // from labels; the only state
  exec(id: string, cmd: string[], io: ExecIO): Promise<number>; // streams; tty, user, env, workdir
  copyIn(id: string, dir: string, tar: Readable): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(ids: { containers: string[]; volumes: string[]; networks: string[] }): Promise<void>;
}
```

**Rules that keep v1 remote-ready**

1. No host bind mounts. Keep files, credential files and the sandbox scripts are tar-streamed with `copyIn`; build contexts are tar-streamed (`docker build -`).
2. Secrets are values passed with `--env-file` from a 0600 temp file deleted right after `docker run`, never on the command line. They remain visible to `docker inspect`; the docs say so.
3. No kunj state about containers on the host. Name, branch, repo and options are Docker labels (`kunj.repo` from the origin URL, `kunj.branch`, `kunj.base`, `kunj.version`, `kunj.options`). The one exception is the forwards registry, which describes host processes.
4. Ports and editor attach are capabilities the backend reports (`features`), not assumptions.

**Names** (`<repo>` as `getKunjDir()` derives it, `<b>` = `branchToDirName(branch)`)

| Object | Name |
| --- | --- |
| Container | `kunj-<repo>-<b>` |
| Workspace volume (`/workspace`) | `kunj-<repo>-<b>-ws` |
| Home volume (`/home/dev`: shell history, `~/.claude`) | `kunj-<repo>-<b>-home` |
| Docker data volume (DinD only) | `kunj-<repo>-<b>-docker` |
| Network | `kunj-<repo>-<b>-net` |
| Service | `kunj-<repo>-<b>-<service>` + volume `…-<service>-data` |

`<h>` is the first 6 hex chars of `sha1(<repo id from origin URL> + "\n" + <full branch>)`, added because `branchToDirName` collapses `feature/x` and `feature-x` and two repos can share a name. Reusing any object also requires its `kunj.repo` and `kunj.branch` labels to match exactly; a name that exists with different labels is refused.

| Object | Name |
| --- | --- |
| Container | `kunj-<repo>-<b>-<h>` |
| Network helper | `kunj-<repo>-<b>-<h>-net-helper` |
| Workspace volume (`/workspace`) | `kunj-<repo>-<b>-<h>-ws` |
| Home volume (shell history, `~/.claude`) | `kunj-<repo>-<b>-<h>-home` |
| Docker data volume (DinD only) | `kunj-<repo>-<b>-<h>-docker` |
| Network | `kunj-<repo>-<b>-<h>-net` |
| Service | `kunj-<repo>-<b>-<h>-<service>` + volume `…-<service>-data` |

## Image

The image holds tools, never the repo, so one image serves every branch and no code or `.env` is baked into layers. Resolution, first match wins:

1. `--image` or `container.image`.
2. `.devcontainer/devcontainer.json` (or `.devcontainer.json`) at the branch's tip on origin, read with `git show origin/<branch>:<path>` (or `origin/<base>` for `-c`), parsed as JSONC. Supported keys: `image`, `build.dockerfile`, `build.context`, `build.args`, `containerEnv`, `remoteUser`, `forwardPorts`, `postCreateCommand`, `postStartCommand`, and `dockerComposeFile` only to print the Docker-in-Docker hint. Other keys warn once.
3. The default `kunj-sandbox:<kunj version>`, built locally on first use from `dist/container/sandbox/Dockerfile`: Debian slim, git, gh, node LTS, Claude Code, tmux, socat, iproute2, iptables and ipset, sudo, zsh; user `dev` (uid 1000) with sudo only for `/usr/local/bin/init-firewall.sh`. Modelled on [Anthropic's reference devcontainer](https://github.com/anthropics/claude-code/tree/main/.devcontainer).

A devcontainer Dockerfile is built from a tar of `build.context` taken from `git archive origin/<branch>`, not from the host working tree, so the image matches what the container clones. The tag is `kunj-<repo>:<hash>`, where the hash covers the Dockerfile, the context tree id and the build args; an existing tag is reused. `--rebuild` forces a build and recreates the container, keeping its volumes.

Devcontainer images lack kunj's tools. At start kunj checks for `git`, `tmux`, `socat` and `sudo` and warns about missing ones: the agent then runs without tmux, forwarding falls back to bash `/dev/tcp`, and `network.allow` fails the start because the firewall needs sudo.

## Starting a container

`kunj ct start <branch>` runs these steps in order; a failure after step 4 rolls back everything this run created unless `--keep-on-error`.

1. **Resolve** the repo, origin URL and base (`resolveBaseRef()` for `-c`). Run `pre-container-create`.
2. **Check origin has the work.** `git fetch origin <branch>`; if the branch exists only locally, or has commits `origin/<branch>` lacks, offer to push them (`git push -u`). Declining aborts; in `--json` mode it fails with `code: "unpushed"` instead of prompting. There is no `--no-origin`: origin is the only channel, so `-c` always starts from `origin/<base>`.
3. **Image** as above.
4. **Network and volumes** created if missing; **services** started on the network.
5. **Run** the container detached: `sleep infinity` as PID 1 under `--init`, user `dev`, workdir `/workspace`, labels, env file, `--network`, optional `--cpus` and `--memory`, `--cap-add NET_ADMIN,NET_RAW` only when the firewall is on, `--runtime sysbox-runc` or `--privileged` for Docker-in-Docker, and `-p 127.0.0.1:<free>:<port>` for each `--publish` or `forwardPorts` entry.
6. **Firewall** when `network.allow` is set: copy in `init-firewall.sh`, run it with sudo, fail the start if its self-check fails.
7. **Seed**, only when `/workspace/.git` is absent: git identity from the host; when a token is forwarded (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`), a credential helper that reads it plus `url.https://<host>/.insteadOf git@<host>:` so SSH origins work; `git clone <origin> /workspace`; then `git switch <branch>` or, for `-c`, `git switch -c <branch> --no-track origin/<base>`.
8. **Keep files** from `~/.kunj/<repo>/keep/` and `container.files` are tar-streamed in.
9. `postCreateCommand` once (marker file `/home/dev/.kunj-created`), `postStartCommand` on every start.
10. Run `post-container-create`; print a summary or JSON.

Starting a stopped container just starts it and re-runs the firewall and `postStartCommand`. Starting a running one prints its state.

**Getting work out.** There is no kunj command for it. The agent, or you via `kunj ct exec feat-x -- git push`, pushes to origin; the host fetches. Opening a PR from inside works when the token allows it (`gh` is in the default image). Use a fine-grained token limited to the repository; branch protection on the default branch is the backstop. `kunj ct remove` refuses when the container's branch has commits not on origin or uncommitted changes, unless `--force`.

Second-pass changes to the steps above: a `--base` not on origin is refused in step 1; the container runs with no added capabilities (the network helper holds them); seed is keyed on a completion marker rather than on `/workspace/.git`, so a half-finished seed is redone; it sets `push.autoSetupRemote=true` so the first `git push` works without `-u`; the credential helper answers only for origin's host, so a `git push` to a remote the agent added cannot carry the token; the clone uses `--recurse-submodules`; and the summary lists every keep file copied in, because they usually hold secrets.

**Getting work out.** There is no kunj command for it. The agent, or you via `kunj ct exec feat-x -- git push`, pushes to origin; the host fetches. Opening a PR from inside works when the token allows it (`gh` is in the default image). Use a fine-grained token limited to the repository.

**Removing.** `kunj ct remove` deletes the container, helper, services, network and volumes (`--keep-volumes` keeps the workspace and home volumes). It first starts the container if stopped and checks inside it: every local ref with commits not on origin, the stash list, and tracked changes. Any hit, or origin unreachable, refuses unless `--force`. Untracked and ignored files are not protected, as with `git worktree remove`.

## Credentials and settings

A new `container` category in the settings registry. Everything secret is forwarded by name from the host environment or copied in from a file; nothing is mounted.

| Setting | Default | Meaning |
| --- | --- | --- |
| `container.image` | `""` | Image override |
| `container.agentCommand` | `claude --dangerously-skip-permissions` | What `kunj ct agent` runs in tmux |
| `container.env` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `GH_TOKEN` | Host env var names forwarded when set; `NAME=value` entries are passed literally. The `AWS_*` key variables are forwarded only when `CLAUDE_CODE_USE_BEDROCK` is set |
| `container.files` | `[]` | `hostPath:containerPath` files copied in at start |
| `container.keepFiles` | `true` | Copy the repo's keep files into new containers |
| `container.network.allow` | `[]` | Empty: open internet, host and LAN still blocked. Otherwise an egress allowlist |
| `container.network.allowHost` | `false` | Allow the Docker gateway / `host.docker.internal` |
| `container.services` | `{}` | Sidecar containers (phase 2) |
| `container.dockerInDocker` | `off` | `off`, `sysbox` or `privileged` (phase 2) |
| `container.allowPrivileged` | `false` | Required for `privileged`, whatever the Docker context |
| `container.dockerContext` | `""` | Docker context for every call |
| `container.cpus`, `container.memory` | `""` | Resource limits |
| `container.publish` | `[]` | Ports always published at start |

macOS keychain logins cannot be shared into Linux, so Claude auth is `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or Bedrock via the `AWS_*` variables. `kunj ct start` warns when none is set and the agent command is `claude`. `~/.claude` lives in the home volume, so a login done inside the container persists for that branch.

## Network, services and Docker inside

**Network.** Each branch has its own bridge network, so containers of different branches cannot reach each other. A small network-helper container (Alpine + iptables + ipset, built once as `kunj-nethelper:<version>`) runs with `--network container:<branch container>` and `NET_ADMIN`, and owns the rules in the shared network namespace. The agent's container has no capabilities and no sudo, so it cannot change them, and devcontainer images need nothing for this to work. The helper always blocks the Docker gateway, RFC1918 and link-local ranges except the branch subnet (unless `container.network.allowHost`), pins DNS to Docker's embedded resolver, and applies the same rules with `ip6tables`. With `container.network.allow` it also sets OUTPUT to DROP and allows established traffic, GitHub's ranges from `api.github.com/meta` when origin is on GitHub, and the resolved IPs of the listed domains, origin's host, `api.anthropic.com`, `bedrock-runtime.<AWS_REGION>.amazonaws.com` when Bedrock is on, `registry.npmjs.org`, and Docker Hub plus `ghcr.io` when Docker-in-Docker is on. It re-resolves every 5 minutes because CDN IPs rotate, and verifies at start that `example.com` is unreachable and origin reachable, or the start fails.

**Sidecars** (`container.services`) start before the container and are removed with it. Each runs as `kunj-<repo>-<b>-<name>` on the branch network with the network alias `<name>`, a data volume and no published ports. The agent reaches `postgres:5432`; no other branch can.

```json
"container.services": {
  "postgres": { "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "dev" }, "port": 5432 }
}
```

**Docker inside** (`container.dockerInDocker`): the container runs its own `dockerd` with `/var/lib/docker` on the branch's docker volume, so `docker compose up` works as on a laptop. Two branches running the same compose file never clash: separate daemons mean the same project names, container names, ports and volumes are fine. The costs are an image cache per branch and the RAM of two stacks.

- `sysbox` uses `--runtime sysbox-runc`; Linux hosts with sysbox installed only (checked with `docker info`).
- `privileged` uses `--privileged`, which an escape turns into access to the Docker host. It is refused against Docker Desktop's default context (whose VM shares `/Users`) unless `--allow-privileged` is passed. The recommended setup is a dedicated Colima, OrbStack or Lima VM with file sharing off, selected with `container.dockerContext`; the README documents it.

When the repo has a compose file and Docker-in-Docker is off, `start` prints a one-line hint.

## Ports and editor

**`kunj ct forward`** is the default way to reach a server inside the container. Kunj listens on `127.0.0.1:<host port>`; each accepted connection runs `docker exec -i <ctr> socat - TCP:127.0.0.1:<port>` (fallback: bash `/dev/tcp`) and pipes bytes both ways. It reaches servers bound to localhost inside the container and inner Docker-in-Docker services, needs nothing at `docker run` time, and works unchanged over a remote Docker context. The host port is the container port when free, else the next free one. `--auto` polls `ss -ltnH` in the container every 2 s and forwards new listeners, dropping closed ones. It runs in the foreground until interrupted and records `{pid, container, port, hostPort}` in `~/.kunj/container-forwards.json`, pruning dead PIDs on read like editor sessions. Each connection costs about 50 to 100 ms to open an exec, fine for browsing and APIs; use `--publish` for load tests.

**`--publish`**, `container.publish` and `forwardPorts`: static `-p 127.0.0.1:<free>:<port>` at `docker run`. Faster, but the server must listen on `0.0.0.0` (kunj warns when a published port is bound only to localhost) and changing them needs `--rebuild`.

**Editor.** `kunj ct open` launches `worktree.editorCommand` with `--folder-uri vscode-remote://attached-container+<hex>/workspace`, where `<hex>` encodes `{"containerName":"/kunj-<repo>-<b>"}` (to be confirmed against current VS Code and Cursor during implementation). Window flags follow `buildOpenCommand()`. It requires the Dev Containers extension; the editor forwards ports itself. For other editors `open` prints the shell command instead.

## Hooks, JSON and errors

**Hooks.** `pre/post-container-create` and `pre/post-container-delete` join `HOOKS` in `src/lib/hook-defs.ts`, with arguments `branch`, `container` and `image`, run on the host through `runActionHook()`; `start` and `remove` take `--no-hooks`.

**JSON.** `kunj ct list --json` is the contract the VS Code extension and macOS app will consume, so it stays backwards compatible once they do:

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

`agent.running` and `workspace` come from one `exec` per running container (`tmux has-session; git status --porcelain=v2 --branch`), matching the one-status-call-per-worktree budget of `kunj worktree list`; `--no-status` skips it.

**Errors.**

- Docker missing or daemon down: one clear message from `docker info`, exit 1.
- Any failure after the container is created rolls back what this run created (container, network, volumes, services) unless `--keep-on-error`, so a failed start leaves nothing behind.
- Clone failure: point at the token settings and show git's stderr.
- Name collision with a non-kunj container: refuse.
- `--json` mode: errors as `{ "error": { "code", "message" } }`; hook output goes to stderr, as it does for worktrees.

## Testing and phases

**Unit tests** (Jest, no Docker): name and label derivation, devcontainer JSONC parsing and image resolution, the image hash, `docker run` argument building (env file, caps, runtime, publish), the seed script text, the firewall domain list, `ss` output parsing, the forwards registry and the list JSON. `lifecycle.ts` is tested against a fake backend that records calls, including rollback at each failing step.

**Integration tests** (`npm run test:docker`, skipped when `docker info` fails, not part of `npm test`): start a container against a local bare repo served as origin, check the clone and branch, push from inside and fetch on the host, forward a port to `python -m http.server`, sidecar reachability and cross-branch isolation, the firewall blocking `example.com`, and `remove` leaving no `kunj.repo`-labelled objects.

**Phases**

1. v1 CLI: start, shell, exec, agent, attach, list, stop, remove; forward with manual ports; the network helper with default and allowlist modes; keep files; hooks, including a quoting fix in `hooks.ts` (`${branch}` is substituted as text into `shell: true` commands today, so a branch named `x$(cmd)` would run `cmd` on the host); README section.
2. Sidecar services, `open`, `prune`, Docker-in-Docker (`sysbox`, `privileged`) and the isolated-VM documentation.
3. UI: `--auto` forwarding and the forwards registry; containers in the VS Code extension's tree and the macOS app, reading `kunj ct list --json`.
4. Remote: `container.dockerContext` over SSH validated end to end; then `kunj serve`, an authenticated HTTP and WebSocket API exposing `ContainerBackend`, and a `RemoteKunjBackend`. Auth, TLS and multi-user get their own spec.

Because every Docker interaction is a stream through the backend and origin is the only git channel, the remote backend needs no new git or file transfer design. What changes: `forward` tunnels over the service's WebSocket instead of `docker exec`, and editor attach goes through Remote-SSH (`features.editorAttach` false until then).

**Open questions**

- [ ] Exact `attached-container` URI encoding accepted by current VS Code and Cursor (check in phase 1).
- [ ] Whether `kunj-sandbox` should be published to a registry so remote hosts need not build it (decide in phase 4).

The same text is committed as `docs/superpowers/specs/2026-10-21-branch-containers-design.md` in the kunj repo; the repo copy is what the implementation plan will be written from.

## Second pass: what changed and why

An adversarial review of the first draft found 15 issues; the two about existing kunj code (`branchToDirName`, hook quoting) were verified against the source. Each row is a place to object.

| Finding | Response |
| --- | --- |
| `branchToDirName` collapses `feature/x` and `feature-x`, and two repos can share a name, so a stopped container of the other branch would be reused with seed skipped. | Hash suffix on every name; reuse requires an exact label match. |
| `remove` checked only the one branch; it missed other local branches and stashes, could not check a stopped container, and origin unreachable was undefined. | The guard checks every ref, the stash and tracked changes; starts a stopped container; fails closed. |
| A credential helper answering for every host hands the token to any remote the agent adds. | The helper answers only for origin's host. |
| `remoteUser: root` in the branch's devcontainer.json would make the agent root, and `NET_ADMIN` lasted the container's life, so root could flush the firewall. | Root refused; the firewall moved to a network-helper sidecar; the agent container has no capabilities and no sudo. |
| In open mode the agent could reach `host.docker.internal` and the LAN. | Host and RFC1918 blocked by default in every mode; `allowHost` to opt out. |
| The allowlist does not stop exfiltration of forwarded secrets; DNS could reach any resolver. | Stated plainly; AWS keys forwarded only with Bedrock; DNS pinned to Docker's resolver. |
| Resolved allowlist IPs go stale; no IPv6. | The helper re-resolves every 5 min; `ip6tables`. |
| The `privileged` refusal keyed on Docker Desktop's context name missed Colima and OrbStack, which share `$HOME`. | `container.allowPrivileged` required for every context. |
| `${branch}` is substituted as text into `shell: true` hook commands. | Quoting fix in `hooks.ts` for all hooks, as a prerequisite. |
| The first `git push` fails without `-u` because of `--no-track`. | `push.autoSetupRemote=true` in the container. |
| Seed keyed on `/workspace/.git` was not idempotent. | A marker written at the end; seed re-runs until it exists. |
| `prune` could delete work when GitHub auto-deletes a merged branch. | Prune uses the remove guard and `--force`; moved to phase 2. |
| Per-connection exec cost, socat exiting before flush, `--auto` polling load. | `socat -t`; `--auto` and the registry moved to phase 3. |
| `list --json` exec had no timeout; `tmux has-session` exit code was ambiguous. | 2 s timeout with a `timeout` status; the exit code echoed separately. |
| `-c` claimed to work "as `kunj worktree add -c`" but ignores `baseFromOrigin`; submodules and LFS not cloned; the dist copy step unnamed. | Each stated explicitly; `--recurse-submodules`; git-lfs in the default image; build step named. |

Rejected: keeping volumes by default on `remove` (a remove that keeps data is a `stop`; the stronger guard plus `--keep-volumes` covers it), and dropping the backend `features` object (a few lines the remote backend needs).
