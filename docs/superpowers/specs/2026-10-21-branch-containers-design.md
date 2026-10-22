# Branch containers — design

*2026-10-21, revised the same day after a second pass. Kunj CLI (`kunj container`), later the VS Code
extension and macOS app.*

## Goal

Start a session for a branch inside a Docker container, the way `kunj worktree` gives a branch its
own directory. The main use is a **sandbox for an AI agent** (Claude Code with
`--dangerously-skip-permissions`): the agent cannot touch the host's files, the host's `.git`, or
other branches' containers. The same container also serves an attached editor (VS Code / Cursor)
and an interactive shell for running the app and its tests, with its own dependencies, ports and
databases that do not clash with other branches.

Later, the Docker daemon may live on a **remote machine** running a kunj service, with the local
kunj driving it. v1 does not build that service, but nothing in v1 may assume the host and the
Docker daemon share a filesystem.

## What the sandbox does and does not protect

Be precise, because "sandbox" is easy to over-read:

| Protected in every mode | Not protected |
|---|---|
| Host filesystem: nothing is bind-mounted; the workspace is a named volume. | **Whatever you forward in.** The agent can read every env var and file you pass (`container.env`, `container.files`, keep files) and, with internet access, send them anywhere. Forward the least you can; prefer a repo-scoped token. |
| Host `.git` and other branches: each container has its own clone; containers of different branches are on separate networks. | **Origin, within the token's scope.** The agent can push to any branch the token may write to. Branch protection on the default branch is the backstop. |
| Host services: the Docker gateway (`host.docker.internal`), the LAN and RFC1918 ranges are blocked by default, in every mode. | **Data exfiltration under an allowlist.** The allowlist limits destinations, not data: GitHub, npm and DNS are enough to carry a token out. |
| Host Docker daemon: the socket is never mounted. | **`privileged` Docker-in-Docker**: an escape reaches the Docker host (on a Mac, the Docker Desktop/Colima VM and whatever it shares). Only for a dedicated VM. |

## Non-goals (v1)

- `kunj serve` and the remote backend (see *Remote roadmap*).
- Full devcontainer spec support: features, `initializeCommand`, `onCreateCommand`,
  `updateContentCommand`, `customizations` are ignored with a warning.
- Mounting the host Docker socket — never offered (it is root on the host).
- SSH agent forwarding: an SSH origin needs a token (rewritten to https) in v1.
- VS Code extension and macOS app UI (phase 3); v1 only keeps the JSON they will need.

## Decisions

| Question | Decision |
|---|---|
| Isolation | Own clone in a named volume; nothing bind-mounted from the host. |
| How code gets in and out | Only through `origin`. The container clones it and pushes to it; the host fetches. No bundles, no shared `.git`. |
| Image | The repo's `.devcontainer/devcontainer.json` (image or Dockerfile), else kunj's default `kunj-sandbox` image; `container.image` overrides both. The image holds tools only, never the repo. `remoteUser: root` is refused. |
| Credentials | Configurable: host env var names to forward and files to copy in. Git identity always. AWS keys are forwarded only when Bedrock is on. |
| Network | A **network helper** sidecar owns the firewall (so the agent's container never has `NET_ADMIN`). Default: internet open, host and LAN blocked. `container.network.allow` adds an egress allowlist, re-resolved every 5 min. |
| Services (Postgres…) | Sidecar containers declared in `container.services`, on the per-branch network (phase 2). |
| Docker inside | Opt-in `container.dockerInDocker: off \| sysbox \| privileged` (phase 2); `privileged` needs `container.allowPrivileged: true`. |
| Ports | `kunj ct forward` tunnels over `docker exec` (manual ports in v1, `--auto` in phase 3); `--publish` for static `-p`. |
| Agents | Run in `tmux` inside the container, so they survive a disconnect; `attach` reconnects. |
| Relation to worktrees | Independent: a branch may have a worktree, a container, both or neither. |
| Backend | Drive the `docker` CLI directly behind a `ContainerBackend` interface (no `@devcontainers/cli`, no `dockerode`). |

## What the user sees

`kunj container` (alias `kunj ct`):

```text
kunj ct start [branch] [-c] [--base <ref>] [--image <img>] [--publish <ports>] [--rebuild] [--json]
kunj ct shell [branch]                 # interactive bash/zsh in /workspace as the sandbox user
kunj ct exec  [branch] -- <cmd...>     # run a command (TTY when stdin is one)
kunj ct agent [branch] [-- <args>]     # start or reattach the agent's tmux session (container.agentCommand)
kunj ct attach [branch]                # reattach to the agent's tmux session
kunj ct open  [branch] [--new-window]  # attach the editor to the container (phase 2)
kunj ct forward [branch] <port>|<host>:<port>...   # --auto in phase 3
kunj ct list [--all] [--json] [--no-status]
kunj ct stop [branch]                  # stop, keep workspace and services
kunj ct remove [branch] [--force] [--keep-volumes]
kunj ct prune [--force]                # phase 2: remove containers whose branch is gone from origin, with the remove guard
```

`[branch]` defaults to the current branch; with no argument and a TTY, `start` (and the others) offer
an interactive picker like `kunj switch`. `-c` creates the branch inside the container from
`origin/<base>`; unlike `kunj worktree add -c` it ignores `preferences.baseFromOrigin` and has no
`--no-origin`, because origin is the only channel. A `--base` that does not exist on origin is
refused before anything is created.

Typical agent flow:

```bash
kunj ct start feat-x -c            # build/reuse image, create container, clone, checkout new branch
kunj ct agent feat-x               # Claude Code in tmux; Ctrl-b d detaches, it keeps working
kunj ct forward feat-x 3000        # browse the dev server it started on localhost:3000
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
src/lib/container/lifecycle.ts   start/stop/remove orchestration (network, volumes, helper, services, seed)
src/lib/container/seed.ts        clone-from-origin script + unpushed-commit check on the host
src/lib/container/forward.ts     exec-tunnel port forwarder
src/lib/container/names.ts       container/volume/network names and labels
src/container/sandbox/           Dockerfile, git-credential helper (copied to dist/ by `npm run build`)
src/container/nethelper/         Dockerfile + firewall.sh for the network helper
```

Every Docker call goes through the backend; `lifecycle.ts` and the command never spawn `docker`
themselves. `container` joins `FAST_COMMANDS` in src/commands/fast.ts; inquirer is imported lazily
only for the picker and confirmations. `package.json`'s `build` script gains a copy step for
`src/container/**` into `dist/container/` (and `files` must include it for the npm package).

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
  exec(id: string, cmd: string[], io: ExecIO): Promise<number>; // streams; tty, user, env, workdir, timeoutMs
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
   `docker run`, never on the command line. (They remain visible to `docker inspect` on the host;
   documented.)
3. No kunj state about containers on the host: names, branch, repo and options are Docker labels
   (`kunj.repo` = repo id derived from the origin URL, `kunj.branch` = the full branch name,
   `kunj.base`, `kunj.version`, `kunj.seeded`, `kunj.options` JSON — never secrets).
4. Ports and editor attach are capabilities the backend reports (`features`), not assumptions.

### Names

`<repo>` is the repo name `getKunjDir()` already derives, `<b>` is `branchToDirName(branch)`, and
`<h>` is the first 6 hex chars of `sha1(<repo id from origin URL> + "\n" + <full branch>)`. The hash
is there because `branchToDirName` collapses `feature/x` and `feature-x`, and two repos can share a
name. Reusing any object additionally requires its `kunj.repo` and `kunj.branch` labels to match
exactly; a name that exists with different labels (or without kunj labels) is refused.

| Object | Name |
|---|---|
| Container | `kunj-<repo>-<b>-<h>` |
| Network helper | `kunj-<repo>-<b>-<h>-net-helper` |
| Workspace volume (`/workspace`) | `kunj-<repo>-<b>-<h>-ws` |
| Home volume (sandbox user's home: shell history, `~/.claude`) | `kunj-<repo>-<b>-<h>-home` |
| Docker data volume (DinD only, `/var/lib/docker`) | `kunj-<repo>-<b>-<h>-docker` |
| Network | `kunj-<repo>-<b>-<h>-net` |
| Service | `kunj-<repo>-<b>-<h>-<service>` (+ volume `…-<service>-data`) |

## Image

Resolution, first match wins:

1. `--image` / `container.image`.
2. `.devcontainer/devcontainer.json` (or `.devcontainer.json`) at the branch's tip on origin, read
   with `git show origin/<branch>:<path>` on the host (or `origin/<base>` for `-c`), parsed as
   JSONC. Supported keys: `image`, `build.dockerfile`, `build.context`, `build.args`,
   `containerEnv`, `remoteUser`, `forwardPorts`, `postCreateCommand`, `postStartCommand`,
   `dockerComposeFile` (only to print the DinD hint). Others warn once. `remoteUser` must name a
   non-root user that exists in the image; `root`, uid 0 or an absent key falls back to the image's
   `USER` if non-root, else the start is refused. (The file comes from the branch, which the agent
   can edit, so it must not be able to grant itself root.)
3. The default `kunj-sandbox:<kunj version>-<hash of its build context>`, built locally on first use from
   `dist/container/sandbox/Dockerfile`: Debian slim, git, git-lfs, gh, node LTS, Claude Code, tmux,
   socat, iproute2, zsh; user `dev` (uid 1000), **no sudo**; npm prefix in the home directory.
   Modelled on `github.com/anthropics/claude-code/.devcontainer`, minus the firewall (the network
   helper owns it).

A devcontainer Dockerfile is built from a tar of `build.context` taken from `git archive
origin/<branch>` (not the host working tree, so the image matches what the container clones;
submodule contents and LFS blobs are not in the archive, documented). The tag is
`kunj-<repo>:<hash>` where the hash covers the Dockerfile, the context tree id and the build args;
an existing tag is reused. `--rebuild` forces a build and recreates the container, keeping its
volumes.

Devcontainer images lack kunj's tools. At start kunj checks for `git`, `tmux` and `socat` and warns
about missing ones (the agent then runs without tmux; forwarding falls back to bash `/dev/tcp`).

## Starting a container

`kunj ct start <branch>`:

1. **Resolve** the repo, origin URL and base (`resolveBaseRef()` for `-c`). Refuse a `--base` not
   on origin. Run `pre-container-create`.
2. **Check origin has the work.** `git fetch origin <branch>`; if the branch exists only locally,
   or the host's branch has commits `origin/<branch>` lacks, offer to push them (`git push -u`).
   Declining aborts; in `--json` mode it fails with `code: "unpushed"` instead of prompting.
3. **Image** (above).
4. **Network and volumes** created if missing; **network helper** started on the network (below);
   **services** started (phase 2).
5. **Run** the container detached: `sleep infinity` as PID 1 under `--init`, the sandbox user,
   workdir `/workspace`, labels, env file, `--network`, optional `--cpus/--memory`, all
   capabilities dropped except CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, `--runtime sysbox-runc` or `--privileged` for DinD (phase 2), and
   `-p 127.0.0.1:<free>:<port>` for each `--publish` / `forwardPorts` entry.
6. **Seed** (`seed.ts`, run with `exec` as the sandbox user) — unless the `kunj.seeded` label is
   set, so a half-finished seed (e.g. kept by `--keep-on-error`) is redone:
   - git identity from the host (`user.name`, `user.email`), `push.autoSetupRemote=true` so the
     agent's first `git push` works without `-u`;
   - when a token is forwarded (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`), a credential helper
     that answers **only** for origin's host (git passes `host=`; any other host gets nothing, so a
     `git push` to an attacker's remote cannot carry the token), and
     `url.https://<host>/.insteadOf git@<host>:` so SSH origins work. No token and an SSH or private
     origin: fail before creating anything, pointing at `container.env`;
   - `git clone --recurse-submodules <origin> /workspace`, then `git switch <branch>` or, for `-c`,
     `git switch -c <branch> --no-track origin/<base>`;
   - set the label `kunj.seeded=1` (labels are immutable on Docker, so it is a marker file
     `/workspace/.kunj-seeded` outside git's view via `.git/info/exclude`).
7. **Keep files** from `~/.kunj/<repo>/keep/` and `container.files` are tar-streamed in; the
   summary lists every file copied, because they usually hold secrets.
8. `postCreateCommand` once (marker file in the home volume), `postStartCommand` every start.
9. Run `post-container-create`; print a summary (or JSON).

Starting a container that exists but is stopped just starts it (and its helper) and re-runs
`postStartCommand`; it does not sync the clone with origin — the agent pulls. Starting a running one
is a no-op that prints its state.

### Getting work out

There is no kunj command for it. The agent (or the user, via `kunj ct exec feat-x -- git push`)
pushes to origin; the host fetches. Opening a PR from inside works when the token allows it (`gh`
is in the default image).

### Removing

`kunj ct remove` deletes the container, helper, services, network and volumes (`--keep-volumes`
keeps the workspace and home volumes). It first starts the container if stopped and checks, inside
it: every local ref with commits not on origin (`git for-each-ref` + `git rev-list ^--remotes`),
the stash list, and tracked changes (`git status --porcelain=v2`). Any hit, or origin unreachable,
refuses unless `--force`. Untracked and ignored files are not protected, as with `git worktree
remove`; `--keep-volumes` is the way to keep them.

## Credentials and settings

New `container` category in the settings registry (src/settings/index.ts):

| Setting | Default | Meaning |
|---|---|---|
| `container.image` | `""` | Image override |
| `container.agentCommand` | `claude --dangerously-skip-permissions` | What `kunj ct agent` runs |
| `container.env` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `GH_TOKEN` | Host env var names forwarded when set; `NAME=value` entries (with `${...}` variables) are passed literally. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_PROFILE` are forwarded only when `CLAUDE_CODE_USE_BEDROCK` is set |
| `container.files` | `[]` | `hostPath:containerPath` files copied in at start (e.g. `${home}/.aws/config:~/.aws/config`) |
| `container.keepFiles` | `true` | Copy the repo's keep files into new containers |
| `container.network.allow` | `[]` | Empty: open internet (host and LAN still blocked). Otherwise an egress allowlist (below) |
| `container.network.allowHost` | `false` | Allow the Docker gateway / `host.docker.internal` |
| `container.services` | `{}` | Sidecars (phase 2) |
| `container.dockerInDocker` | `off` | `off`, `sysbox`, `privileged` (phase 2) |
| `container.allowPrivileged` | `false` | Required for `privileged`, whatever the context |
| `container.dockerContext` | `""` | Docker context for every call (`docker --context`) |
| `container.cpus` / `container.memory` | `""` | Resource limits |
| `container.publish` | `[]` | Ports always published at start |

macOS keychain logins cannot be shared into Linux, so Claude auth is `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or Bedrock via the `AWS_*` variables. `kunj
ct start` warns when none of them is set and the agent command is `claude`. `~/.claude` lives in
the home volume, so a login done inside the container persists for that branch.

## Network

Every branch has its own bridge network, so containers of different branches cannot reach each
other. A small **network helper** container (`src/container/nethelper/`: Alpine + iptables + ipset
+ a shell script, built once as `kunj-nethelper:<version>-<hash>`) runs with `--network container:<the
branch container>` and `NET_ADMIN`/`NET_RAW`, and owns the rules in the shared network namespace.
The agent's container has all capabilities dropped except CHOWN, DAC_OVERRIDE, FOWNER, SETUID,
SETGID (no NET_ADMIN, no NET_RAW), so it cannot change or bypass them even if the
devcontainer image happens to include iptables; devcontainer images need nothing for this to work.

The helper always:

- blocks the Docker gateway (`host.docker.internal`), `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`
  and link-local, except the branch network's own subnet (sidecars) and origin's resolved
  addresses on origin's port (a self-hosted origin) — unless `container.network.allowHost`;
- restricts DNS to Docker's embedded resolver (`127.0.0.11`), so DNS cannot be used to reach
  arbitrary resolvers;
- applies the same rules with `ip6tables`.

With `container.network.allow`, it additionally sets OUTPUT to DROP and allows established
traffic, GitHub's ranges from `api.github.com/meta` when origin is on GitHub, and the resolved IPs
of: the listed domains, origin's host, `api.anthropic.com`,
`bedrock-runtime.<AWS_REGION>.amazonaws.com` when Bedrock is on, `registry.npmjs.org`, and Docker
Hub / `ghcr.io` when DinD is on. It re-resolves every 5 minutes (CDN IPs rotate), verifies that
`example.com` is unreachable and origin reachable at start (or the start fails), and logs changes.
`kunj ct list` shows `firewall: "allowlist" | "default"`.

The allowlist limits where the agent can connect, not what it sends: GitHub, npm and the AI API are
enough to exfiltrate a token. That is why `container.env` defaults to the AI credentials and a
GitHub token only.

## Services and Docker inside (phase 2)

**Sidecars** (`container.services`), started before the container and removed with it:

```json
"container.services": {
  "postgres": { "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "dev" }, "port": 5432 }
}
```

Each runs as `kunj-<repo>-<b>-<h>-<name>` on the branch network with the network alias `<name>`, a
data volume, and no published ports. The agent reaches `postgres:5432`; no other branch can.

**Docker inside** (`container.dockerInDocker`): the container runs its own `dockerd`
(`/var/lib/docker` on the branch's docker volume), so `docker compose up` works as on a laptop, and
two branches running the same compose file never clash (separate daemons: same project names,
container names, ports and volumes are fine). Costs: an image cache per branch and the RAM of two
stacks.

- `sysbox` uses `--runtime sysbox-runc`; available only on Linux hosts with sysbox installed
  (checked with `docker info`).
- `privileged` uses `--privileged`, which an escape turns into access to the Docker host: on a Mac
  that is the Docker Desktop, Colima or OrbStack VM, which share `/Users` or `$HOME` by default. It
  requires `container.allowPrivileged: true` for every context (kunj cannot reliably tell a
  dedicated VM from a shared one by its name); the README documents a Colima/Lima profile with file
  sharing off, selected with `container.dockerContext`.

When the repo has a compose file and DinD is off, `start` prints a one-line hint.

## Ports

**`kunj ct forward <port>`** (v1): kunj listens on `127.0.0.1:<host port>`; each accepted
connection runs `docker exec -i <ctr> socat -t 10 - TCP:127.0.0.1:<port>` (fallback: bash
`/dev/tcp`, which cannot half-close; documented) and pipes both ways. It reaches servers bound to
localhost inside the container and inner DinD services, and needs nothing at `docker run` time. The
host port is the container port when free, else the next free one. It runs in the foreground until
interrupted. Each connection costs an exec (100–300 ms on Docker Desktop); fine for browsing and
HMR, not for load tests. `--auto` (poll `ss -ltnH`, forward new listeners) and a forwards registry
for the UI are phase 3.

**`--publish`** / `container.publish` / `forwardPorts`: static `-p 127.0.0.1:<free>:<port>` at
`docker run`. Faster; the server must listen on `0.0.0.0`. Changing them needs `--rebuild`.

## Editor (phase 2)

`kunj ct open` launches `worktree.editorCommand` with
`--folder-uri vscode-remote://attached-container+<hex>/workspace`, where `<hex>` is the hex of
`{"containerName":"/kunj-<repo>-<b>-<h>"}` (to be confirmed against VS Code and Cursor during
implementation). Window flags follow `buildOpenCommand()`. Requires the Dev Containers extension;
the editor forwards ports itself. For non-VS Code editors, `open` prints the shell command instead.

## Hooks

Add `pre/post-container-create` and `pre/post-container-delete` to `HOOKS` in
src/lib/hook-defs.ts, with arguments `branch`, `container` and `image`, run on the host through
`runActionHook()`; `--no-hooks` on `start` and `remove`.

**Prerequisite fix in hooks.ts:** `hooks.<name>` config commands are run with `shell: true` after
`${...}` expansion (src/lib/hooks.ts:326), so a branch named `x$(cmd)` would run `cmd` on the host.
Branch names were user-typed until now; with containers they also come from what agents push and
what the picker lists. Expanded values must be single-quoted for the shell (`'…'` with `'\''`
escaping) before substitution, for every hook, not only the container ones. Script hooks already
get arguments positionally and in the environment, which is safe.

## JSON

`kunj ct list --json` (kept backwards compatible once the extension and app consume it):

```json
{
  "repo": "kunj",
  "backend": { "kind": "docker", "context": "default" },
  "containers": [{
    "branch": "feat-x", "name": "kunj-kunj-feat-x-3fa2b1", "id": "3f2a…", "state": "running",
    "image": "kunj-sandbox:1.3.0", "createdAt": "2026-10-21T10:00:00Z",
    "dockerInDocker": "off", "firewall": "default",
    "services": [{ "name": "postgres", "state": "running" }],
    "ports": [{ "container": 3000, "host": 13000, "kind": "publish" }],
    "agent": { "running": true },
    "workspace": { "head": "a1b2c3d", "ahead": 2, "dirty": true }
  }]
}
```

`agent.running` and `workspace` come from one `exec` per *running* container with a 2 s timeout
(`tmux has-session; echo "tmux=$?"; git status --porcelain=v2 --branch`, so "no session" is
distinguishable from a failed exec). A timeout yields `"status": "timeout"` for that container
instead of blocking the list. `--no-status` skips it. This matches the one-status-call-per-worktree
budget of `kunj worktree list`.

## Errors

- Docker missing or daemon down: one clear message (`docker info` failed: …), exit 1.
- Every failure after the first object is created rolls back what this run created (container,
  helper, network, volumes, services) unless `--keep-on-error`, so a failed start leaves nothing
  behind.
- Clone failure (auth): point at the token settings, show git's stderr.
- Name collision with a non-kunj container or mismatched labels: refuse.
- `--json` mode: errors as `{ "error": { "code", "message" } }`, hook output to stderr (as worktrees do).

## Testing

- Unit (Jest, no Docker): name/label derivation (including the `feature/x` vs `feature-x` case),
  devcontainer JSONC parsing, `remoteUser` policy and image resolution, image hash, `docker run`
  argument building (env file, Bedrock-gated AWS vars, runtime, publish), the seed script text, the
  credential helper's host check, the firewall rule set per mode, the remove guard's parsing, list
  JSON shaping and the timeout path. The backend is an interface, so `lifecycle.ts` is tested
  against a fake backend that records calls, including rollback on each failing step and re-seeding
  after a half-finished seed.
- Integration (`npm run test:docker`, skipped when `docker info` fails; not in the default `npm
  test`): start a container against a local bare repo served as origin, check the clone and branch,
  push from inside without `-u` and fetch on the host, forward a port to a `python -m http.server`,
  the helper blocks the gateway and (with an allowlist) `example.com`, `git push` to a non-origin
  https remote gets no credentials, remove refuses with a second unpushed branch, and remove leaves
  no `kunj.repo`-labelled objects.

## Phases

1. **v1 CLI**: start/shell/exec/agent/attach/list/stop/remove, forward (manual ports), network
   helper with the default and allowlist modes, keep files, hooks (with the hooks.ts quoting fix),
   README section.
2. Sidecar services, `open`, `prune`, DinD (`sysbox`, `privileged`), isolated-VM documentation.
3. **UI**: `--auto` forwarding + forwards registry; containers in the VS Code extension's tree and
   the macOS app (start, agent in a terminal, open, forward, remove), reading `kunj ct list --json`.
4. **Remote**: `container.dockerContext` over SSH validated end to end; then `kunj serve` (an
   authenticated HTTP/WebSocket API exposing `ContainerBackend`) and a `RemoteKunjBackend`. Auth,
   TLS and multi-user get their own spec.

## Remote roadmap notes

Because every Docker interaction is a stream through the backend and origin is the only git
channel, a remote backend needs no new git or file transfer design. What changes: `forward` tunnels
over the service's WebSocket instead of `docker exec`, and editor attach goes through Remote-SSH to
the server (`features.editorAttach` false until then).

## Second pass — what changed and why

Findings from an adversarial review of the first draft, and the response:

| Finding | Response |
|---|---|
| `branchToDirName` collapses `feature/x` and `feature-x`; two repos can share a name; a stopped container of the other branch would be reused and seed skipped. | Hash suffix on every name; reuse requires exact label match. |
| `remove` only checked the one branch; missed other local branches and stashes; could not check a stopped container; origin unreachable was undefined. | Guard checks every ref, the stash and tracked changes; starts a stopped container; fails closed. |
| A credential helper answering for every host hands the token to any remote the agent adds. | Helper answers only for origin's host. |
| `remoteUser: root` in the branch's devcontainer.json makes the agent root; `NET_ADMIN` lasts the container's life, so root could flush the firewall. | Root refused; firewall moved to a network-helper sidecar sharing the network namespace; the agent container has all capabilities dropped except CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID (no NET_ADMIN/NET_RAW), and the kunj sandbox image has no sudo. |
| In open mode the agent could reach `host.docker.internal` and the LAN. | Host and RFC1918 blocked by default in every mode; `allowHost` to opt out. |
| The allowlist does not stop exfiltration of forwarded secrets; DNS to any resolver. | Stated plainly in the spec; AWS keys forwarded only with Bedrock; DNS pinned to Docker's resolver. |
| Resolved allowlist IPs go stale; no IPv6. | Helper re-resolves every 5 min; ip6tables. |
| `privileged` refusal keyed on Docker Desktop's context name misses Colima/OrbStack, which share `$HOME`. | `container.allowPrivileged` required for every context. |
| `${branch}` is substituted as text into `shell: true` hook commands. | Quoting fix in hooks.ts, for all hooks, as a prerequisite. |
| First `git push` fails without `-u` (`--no-track`). | `push.autoSetupRemote=true` in the container. |
| Seed keyed on `/workspace/.git` is not idempotent. | Seed marker written at the end; re-run until it exists. |
| `prune` could delete work when GitHub auto-deletes a merged branch. | Prune uses the remove guard and `--force`; moved to phase 2. |
| Per-connection exec cost, socat exit before flush, `--auto` polling load. | `socat -t`; `--auto` and the registry moved to phase 3. |
| `list --json` exec had no timeout; `tmux has-session` exit code ambiguous. | 2 s timeout with a `timeout` status; exit code echoed separately. |
| `-c` said "as `kunj worktree add -c`" but ignores `baseFromOrigin`; submodules/LFS not cloned; dist copy step unnamed. | Each stated explicitly; `--recurse-submodules`; git-lfs in the default image; build step named. |

Rejected: keeping volumes by default on `remove` (a remove that keeps data is a `stop`; the
stronger guard plus `--keep-volumes` covers it) and dropping the `features` object (it is a few
lines and the remote backend needs it).

## Open questions

- Exact `attached-container` URI encoding accepted by current VS Code and Cursor (check during
  phase 2).
- Whether `kunj-sandbox` and `kunj-nethelper` should be published to a registry so remote hosts
  need not build them (decide in phase 4).
