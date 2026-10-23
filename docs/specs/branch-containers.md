# Branch containers (phase 1)

*Designed 2026-10-21, revised the same day after an adversarial second pass; shipped. Checked against
`main` on 2026-10-23. Umbrella and roadmap: [container-system.md](container-system.md).*

## Goal and status

`kunj container` (alias `kunj ct`) runs a branch in a Docker container with its own clone of the repo,
the way `kunj worktree` gives a branch its own directory. The main use is a sandbox for an AI agent
running with permissions skipped (Claude Code with `--dangerously-skip-permissions`): it cannot touch
the host's files, the host's `.git` or other branches' containers. The same container serves a shell,
an attached editor and the app's dev server, with its own dependencies, ports and databases. Later the
Docker daemon may live on a remote machine, so nothing may assume the host and the daemon share a
filesystem.

| Feature | Status |
| --- | --- |
| `start`, `shell`, `exec`, `agent`, `attach`, `forward` (manual ports), `list`, `stop`, `remove` | Shipped |
| Network helper with default and allowlist firewall modes, IPv4 and IPv6 | Shipped |
| Credentials by name (`container.env`, `container.files`, keep files), credential helper scoped to origin | Shipped |
| Container hooks and the hook-quoting fix | Shipped |
| Default zsh config and `KUNJ_*` environment in every container | Shipped (4b94e3a) |
| Services, `open`, `forward --auto`, `prune`, Docker-in-Docker | Phase 2: [container-phase-2.md](container-phase-2.md) |
| Blueprints and snapshots | [blueprints.md](blueprints.md) |
| Full devcontainer support (features, `initializeCommand`, `onCreateCommand`, `customizations`, …) | Not planned: ignored with a warning |
| Mounting the host Docker socket | Dropped: never offered (it is root on the host) |

## What the sandbox does and does not protect

"Sandbox" is easy to over-read, so this is stated precisely.

| Protected in every mode | Not protected |
| --- | --- |
| Host files: nothing is bind-mounted; the workspace is a named volume. | **Whatever you forward in.** The agent can read every variable and file you pass (`container.env`, `container.files`, keep files) and, with internet access, send it anywhere. Forward the least you can; prefer a repo-scoped token. |
| Host `.git` and other branches: own clone per container, own network per branch. | **Origin, within the token's scope.** The agent can push wherever the token may write; branch protection on the default branch is the backstop. |
| Host services: the Docker host, `host.docker.internal`, the LAN, private and link-local ranges and Tailscale's `100.64/10` are blocked by default. | **Exfiltration under an allowlist.** It limits destinations, not data: GitHub, npm and DNS are enough to carry a token out. |
| Host Docker daemon: the socket is never mounted. | Devcontainer images that give the user sudo: root inside the container (still without network capabilities). |
| Firewall integrity: the rules live in a helper the agent cannot touch, and nothing runs in the container before they are applied. | Image builds from a devcontainer Dockerfile, which run with full network access (a Dockerfile changed on the branch prints a warning). |

Docker-in-Docker weakens this table; its trade-offs are in [container-phase-2.md](container-phase-2.md).

## Design

### Commands

`[branch]` defaults to the current branch; with no argument and a terminal, kunj offers a picker (the
repo's containers, else origin's branches). Every action takes `--json`, with errors as
`{ "error": { "code", "message" } }` (`code` is the start error code, `hook`, or `error`), and
`--context <name>` to pick a Docker context.

| Command | What it does |
| --- | --- |
| `kunj ct start [branch] [-c] [--base <ref>]` | Create or resume the branch's container. `-c` creates the branch from `origin/<base>`; base is `--base`, else `preferences.defaultBaseBranch`, else the repo default. Unlike `worktree add -c` it ignores `preferences.baseFromOrigin` and has no `--no-origin`: origin is the only channel. A base not on origin is refused before anything is created. |
| `… --image <img>` / `--rebuild` / `--publish 3000,5432` | Use this image (never a snapshot); recreate the container on its kept volumes; publish ports on `127.0.0.1`. |
| `… --keep-on-error` / `--no-hooks` / `--no-snapshot` | Keep what a failed start created; skip hooks; ignore the blueprint snapshot. |
| `kunj ct shell [branch]` | Login shell (zsh, else bash, else sh) in `/workspace` as the sandbox user. |
| `kunj ct exec [branch] -- <cmd…>` | Run one command (TTY when stdin is one); its exit code is passed through. |
| `kunj ct agent [branch] [-- <args>]` | `container.agentCommand` in a tmux session named `agent` (`tmux -u new-session -A`), so it survives a disconnect; without tmux in the image it runs directly, with a warning. |
| `kunj ct attach [branch]` | Reattach to that session. |
| `kunj ct forward [branch] <port>\|<host>:<port>…` | Forward `127.0.0.1` ports into the container until Ctrl-C. |
| `kunj ct list [--all] [--no-status]` | Containers of this repo (or every repo), with agent state, ahead/dirty, ports, services and orphans. |
| `kunj ct stop [branch]` | Stop, keeping the workspace (and services). |
| `kunj ct remove [branch] [--force] [--keep-volumes]` | Remove; refuses while work is unpushed unless `--force`. |

A typical session: `kunj ct start feat-x -c`, `kunj ct agent feat-x` (Ctrl-b d detaches; it keeps
working), `kunj ct attach feat-x` later, then on the host `git fetch && git switch feat-x` after the
agent pushed, and `kunj ct remove feat-x`.

### Architecture

*Drawing: the host side (CLI and `ContainerBackend`) and the daemon side (branch container, network
helper, sidecars, per-branch network); only Docker API calls and git traffic to origin cross between them.*

Every Docker call goes through the `ContainerBackend` interface (src/lib/container/backend.ts); only
`docker.ts` (`LocalDockerBackend`) spawns `docker`, honouring `container.dockerContext` or `--context`.
Unit tests use `FakeBackend`. The backend reports capabilities in `features` (`localPorts`,
`editorAttach`, `dockerInDocker`) rather than kunj assuming them, so a remote backend can say no.

Rules that keep it remote-ready:

1. No host bind mounts. Keep files, copied files, the credential helper and git bundles are
   tar-streamed in through `docker exec … tar -x` as the sandbox user; build contexts are streamed to
   `docker build -`.
2. Secrets travel only in the `docker run` env file (a 0600 temp file, deleted after the run), never
   on a command line, never with `docker exec -e`, never in a label. They remain visible to
   `docker inspect` on the host.
3. No host-side state about containers: Docker labels are the only record (one exception: the
   forwards registry, which describes host processes).

### Names and labels

`<repo>` is the repo name, `<b>` is `branchToDirName(branch)`, both made Docker-safe and the pair
capped at 40 characters; `<h>` is the first 6 hex chars of `sha1(<repo id> + "\n" + <full branch>)`,
where the repo id is origin's URL normalised so ssh and https forms agree. The hash exists because
`branchToDirName` collapses `feature/x` and `feature-x` and repo names are not unique.

| Object | Name |
| --- | --- |
| Branch container | `kunj-<repo>-<b>-<h>` |
| Network helper | `<container>-net-helper` |
| Workspace volume (`/workspace`) | `<container>-ws` |
| Home volume (`/home/<user>`: history, `~/.claude`) | `<container>-home` |
| Network | `<container>-net` |
| Docker data volume, sidecar services | see [container-phase-2.md](container-phase-2.md) |

Labels: `kunj.repo` (repo id), `kunj.branch` (full name), `kunj.base`, `kunj.version`,
`kunj.role` (`main`, `helper`, `service`) and `kunj.options` (JSON: firewall mode, `allowHost`,
published ports, the helper's env, user, post commands, image kind, blueprint hash, DinD mode; never
secrets). Reusing an object requires its `kunj.repo` and `kunj.branch` to match exactly; a name that
exists with other labels fails the start with code `collision`.

### Image

Chosen in this order, first match wins:

1. `--image` (never swapped for a snapshot).
2. The repo's blueprint snapshot, when there is one (see [blueprints.md](blueprints.md)); it was built
   on whichever base the next steps pick, and that base is part of its hash.
3. `container.image`.
4. `.devcontainer/devcontainer.json` (or `.devcontainer.json`) at `origin/<branch>` (`origin/<base>`
   for `-c`), read with `git show` on the host and parsed as JSONC. Supported keys: `image`, `build`
   (`dockerfile`, `context`, `args`), `containerEnv`, `remoteUser`, `forwardPorts`,
   `postCreateCommand`, `postStartCommand`, `dockerComposeFile` and `service` (for sidecar services);
   other keys warn once. `remoteUser: root` or uid 0 is refused (the branch can edit the file), and a
   user that does not exist in the image fails the start.
5. `kunj-sandbox:<version>-<hash>`, built locally on first use from src/container/sandbox/: Debian
   bookworm-slim, git, git-lfs, gh, Node 22, Claude Code, tmux, socat, iproute2, procps, zsh,
   openssh-client, gnupg, user `dev` (uid 1000), **no sudo and no iptables**, npm's global prefix in
   the home, `LANG=C.UTF-8`, `TERM=xterm-256color`.

A devcontainer Dockerfile is built from `git archive origin/<branch>:<context>` (not the working
tree, so the image matches the clone; submodules and LFS blobs are not in it), tagged
`kunj-<repo>:<hash of Dockerfile, context tree id and args>` and reused when the tag exists. The
Dockerfile must lie inside the build context. kunj's own image tags carry a hash of their build
context (`assetHash()`), so an edited Dockerfile or firewall script rebuilds. The image holds tools
only, never the repo. Devcontainer images are checked for `git`, `tmux` and `socat` after the start;
missing ones are a warning.

### Starting a container

`kunj ct start` runs, for a new container:

1. **Resolve** the repo, origin (credentials stripped from the URL) and base. Refuse a name collision,
   an origin without a host (`origin`), and an SSH origin with no token forwarded (`no-token`, unless a
   snapshot bundle is used). Docker-in-Docker that cannot run is refused here. Run
   `pre-container-create` (its `image` argument is empty: the image is not chosen yet).
2. **Check origin has the work.** Fetch `origin/<branch>`; if the branch is only local or origin
   lacks commits, offer to push (`git push -u`). Declining, `--json` or no terminal fails with
   `unpushed`.
3. **Image** as above, building what is missing; the blueprint snapshot is built first when needed.
4. **Network and volumes**, created if missing; **services** started (phase 2).
5. **Run** the branch container detached: `--entrypoint sleep` with `infinity`, `--init`, the
   sandbox user, workdir `/workspace`, labels, the env file, `--cap-drop ALL` plus only `CHOWN`,
   `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` (never `NET_ADMIN` or `NET_RAW`),
   `--add-host host.docker.internal:host-gateway`, optional `--cpus`/`--memory`, and
   `-p 127.0.0.1:<free>:<port>` for each `--publish`, `container.publish` and `forwardPorts` entry.
   The image's own entrypoint never runs.
6. **Network helper** started in the container's network namespace; kunj waits up to 20 s for
   `/tmp/kunj-ready`. Nothing is exec'd in the branch container before that file exists.
7. **Seed** (src/lib/container/seed.ts, as the sandbox user), unless `/workspace/.kunj-seeded`
   exists: git identity from the host, `push.autoSetupRemote=true` (branches are created
   `--no-track`); with a token, the credential helper plus `url.https://<host>/.insteadOf` for
   `git@<host>:` and `ssh://git@<host>/`; `git clone --recurse-submodules <origin> /workspace` (or a
   copy of the snapshot's seed); `git switch <branch>` or `git switch -c <branch> --no-track
   origin/<base>`; then the marker, kept out of git through `.git/info/exclude`. A half-finished seed
   is redone on the next start.
8. **Copy in** keep files from `~/.kunj/<repo>/keep/` and `container.files`; the summary lists each,
   because they usually hold secrets.
9. **Blueprint** presets and `setup` (no snapshot) or `maintain`.
10. **Devcontainer commands**: `postCreateCommand` once (marker `$HOME/.kunj-created`),
    `postStartCommand` every start. Then `post-container-create`.

**Resume.** An existing container is resumed whatever origin now has (its clone is the source of
truth): services first, then the container, a fresh network helper (a stale ready file survives a
restart, the rules do not), a seed if it never finished, `maintain`, `postStartCommand`. Nothing is
rebuilt and the create hooks do not run. A running container with a running helper is left as is.

**Rollback.** A failure removes everything this run created (containers, helper, services, network,
and only the volumes it created). With `--keep-on-error` the objects stay, but a container whose
firewall never came up is stopped.

**Getting work out.** There is no kunj command for it: the agent (or `kunj ct exec feat-x -- git
push`) pushes to origin and the host fetches. `gh` is in the default image, so the agent can open a
PR when the token allows it.

**Removing.** `kunj ct remove` first runs the guard: it starts a stopped container behind its
firewall (from the helper env recorded in `kunj.options`) and checks, with `core.fsmonitor` and hooks
off, every local branch and a detached HEAD for commits not on `refs/remotes/origin`, the stash list,
tracked changes, and that `git ls-remote origin` answers (15 s). Any problem, a git command that
fails, or an unreachable origin refuses without `--force` (fail closed). Untracked and ignored files
are not protected, as with `git worktree remove`. Then `pre-container-delete`, removal of the helper,
container, services, network and volumes (`--keep-volumes` keeps all volumes), and
`post-container-delete`.

### Network and firewall

Each branch has its own bridge network. The firewall (src/container/nethelper/firewall.sh) runs in
`kunj-nethelper:<version>-<hash>` (Alpine with iptables, ip6tables, ipset, bind-tools, curl, socat),
started with `--network container:<branch container>` and `NET_ADMIN`/`NET_RAW`; the branch container
has neither and the default image has no sudo, so the agent cannot change the rules, and devcontainer
images need nothing for it. The rules sit in their own `KUNJ-OUT` chain jumped to first from OUTPUT,
so a restarted helper replaces them.

| Mode | Allowed | Blocked |
| --- | --- | --- |
| Default (`container.network.allow` empty) | The internet; origin's addresses on origin's port, even when private or the Docker host | The Docker gateway and `host.docker.internal`/`gateway.docker.internal`, `0/8`, `10/8`, `100.64/10`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `fe80::/10`, except the branch subnet (sidecars) |
| Allowlist | Only the listed domains, origin, `api.anthropic.com`, `registry.npmjs.org`, `nodejs.org`, GitHub's ranges from `api.github.com/meta` when origin is on github.com, `bedrock-runtime.<region>.amazonaws.com` when Bedrock is on, Docker Hub and ghcr with Docker-in-Docker | Everything else (REJECT, policy DROP), plus everything blocked by default |
| `container.network.allowHost: true` | The host and private ranges as well | — |

In both modes DNS goes only to Docker's resolver (`127.0.0.11`). IPv6 gets the same rules with
ip6tables; without ip6tables the helper carries on with IPv4 only when the namespace has no IPv6, and
refuses to start when it does. In allowlist mode the sets are rebuilt every 5 minutes (CDN addresses
rotate) by swapping in fresh ones, and at start the helper verifies that `https://example.com` is
blocked and origin reachable, or the start fails (`firewall`).

### Credentials and settings

Only the host variables named in `container.env` reach the container, and only when set; a
`NAME=value` entry is passed literally (with `${...}` variables). `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_PROFILE` ride along only when
`CLAUDE_CODE_USE_BEDROCK` is set. A forwarded `GH_TOKEN`, `GITHUB_TOKEN` or `GITLAB_TOKEN` is used
by `git-credential-kunj`, streamed into `$HOME/.kunj/bin/` of any image, which answers only for
origin's `host[:port]` (`KUNJ_CREDENTIAL_HOST`), so a push to a remote the agent adds gets nothing.
The devcontainer's `containerEnv` cannot override forwarded values or `KUNJ_CREDENTIAL_HOST`,
`KUNJ_CONTAINER`, `KUNJ_BRANCH` and `KUNJ_REPO`. macOS keychain logins cannot be shared into Linux, so
Claude auth is `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or Bedrock;
`start` warns when none is forwarded and the agent command starts with `claude`. `~/.claude` lives in
the home volume, so a login inside the container persists for that branch.

| Setting | Default | Meaning |
| --- | --- | --- |
| `container.image` | `""` | Image override |
| `container.agentCommand` | `claude --dangerously-skip-permissions` | What `kunj ct agent` runs (shell text; extra args are quoted) |
| `container.env` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `GH_TOKEN` | Host variables forwarded when set |
| `container.files` | `[]` | `hostPath:containerPath` files or directories copied in at start (`~` is the container home) |
| `container.keepFiles` | `true` | Copy the repo's keep files in |
| `container.network.allow` | `[]` | Egress allowlist; empty means open internet |
| `container.network.allowHost` | `false` | Let the container reach the Docker host and private ranges |
| `container.dockerContext` | `""` | Docker context for every call |
| `container.cpus`, `container.memory` | `""` | Resource limits |
| `container.publish` | `[]` | Ports always published at start |

Phase 2 settings are in [container-phase-2.md](container-phase-2.md).

### Ports, shell and agent

`kunj ct forward <port>` listens on `127.0.0.1:<host port>` (the same number when free, else the next
free one) and tunnels each connection with `docker exec -i <helper> socat -t 10 -
TCP:127.0.0.1:<port>` through the **network helper**, which shares the branch container's namespace:
it reaches servers bound to localhost and needs nothing at `docker run`, and nothing is exec'd in the
branch container. Each connection costs an exec (100–300 ms on Docker Desktop): fine for browsing and
HMR, not for load tests. `--publish` maps ports statically instead; faster, but the server must listen
on `0.0.0.0`, and changing them needs `--rebuild`. Running forwards are recorded in
`~/.kunj/container-forwards.json` (see phase 2).

Every container gets a default zsh config (`/etc/zsh/zshrc` in the sandbox image: prompt
`kunj ▸ <branch> <dir> ❯`, shared history, completion, git aliases) and the variables
`KUNJ_CONTAINER=1`, `KUNJ_BRANCH` and `KUNJ_REPO`. Interactive execs pass the host's `TERM`,
`COLORTERM` and `LANG=C.UTF-8`, so TUIs render as on the host.

### Hooks

`pre/post-container-create` and `pre/post-container-delete` (src/lib/hook-defs.ts) take `branch`,
`container` and `image`, run on the host through `runActionHook()`, and are skipped with
`--no-hooks`. A failing `pre-*` hook aborts. The create hooks do not run when `start` resumes.
Branch names now come from what agents push, so `${...}` values in `hooks.*` commands are quoted for
the shell context they sit in (`expandVariablesQuoted()` in src/lib/config-vars.ts), for every hook.

### `list --json`

The contract the VS Code extension, macOS app and workspace app consume; additive changes only. The
type is `ContainerListJson` in src/lib/json-types.ts:

```json
{
  "repo": "kunj",
  "backend": { "kind": "docker", "context": "default" },
  "containers": [{
    "branch": "feat-x", "name": "kunj-kunj-feat-x-3fa2b1", "id": "3f2a…", "state": "running",
    "image": "kunj-sandbox:1.3.0-ab12…", "imageInfo": { "tag": "kunj-sandbox:1.3.0-ab12…", "kind": "sandbox" },
    "createdAt": "2026-10-21T10:00:00Z", "firewall": "default", "dind": "off",
    "ports": [{ "container": 3000, "host": 3001, "kind": "forward", "pid": 4242 }],
    "agent": { "running": true },
    "workspace": { "head": "a1b2c3d", "ahead": 2, "dirty": true },
    "status": "ok",
    "services": [{ "name": "postgres", "state": "running", "port": 5432 }]
  }],
  "orphans": []
}
```

`agent.running` and `workspace` come from one exec per running container with a 2 s timeout
(`tmux has-session; echo "tmux=$?"; git status --porcelain=v2 --branch`), so "no session" differs
from a failed exec; `status` is `ok`, `timeout`, `error`, `stopped` or `skipped` (`--no-status`).
Containers started from a snapshot add `blueprint: { hash, stale }`.

## Decisions

- **Isolation** (2026-10-21): own clone in a named volume; nothing from the host bind-mounted.
- **Code in and out**: only through origin; the host fetches. (Snapshots later added a host-made git
  bundle as the one way in, so private origins need no token there; see [blueprints.md](blueprints.md).)
- **Image**: the repo's devcontainer, else `kunj-sandbox`; settings override; tools only, never the repo.
- **Backend**: drive the `docker` CLI behind `ContainerBackend`; no `@devcontainers/cli`, no `dockerode`.
- **Firewall in a helper sidecar** (second pass): root in a devcontainer could flush rules held by the
  agent's own container, so the agent's container has no network capabilities.
- **Host and LAN blocked in every mode** (second pass), `allowHost` to opt out; DNS pinned to Docker's resolver.
- **Hash suffix on every name and exact label match** (second pass): `feature/x` vs `feature-x`.
- **Credential helper scoped to origin's host** (second pass).
- **Remove guard covers every ref, the stash and tracked changes, starts a stopped container, fails
  closed** (second pass). Keeping volumes by default on `remove` was rejected: a remove that keeps data
  is a `stop`; `--keep-volumes` covers it.
- **Seed keyed on a marker file**, not on `/workspace/.git`, so a half-finished seed is redone
  (labels cannot change after `docker run`).
- **`push.autoSetupRemote=true`**, `--recurse-submodules`, git-lfs in the default image (second pass).
- **AWS keys only with Bedrock** (second pass).
- **Hook quoting fix for every hook** (second pass): `${branch}` was substituted as text into shell commands.
- **Agents in tmux** inside the container; **worktrees and containers independent** of each other.
- **Forwarding through the network helper** (a32bc90): the branch container is never exec'd for a
  forward, so nothing reaches it before its firewall and a hostile image cannot answer the probe.
- **`list --json` status exec bounded by 2 s**, with a `timeout` status (second pass).

## Open questions

- Whether `kunj-sandbox` and `kunj-nethelper` should be published to a registry so remote hosts need
  not build them (decide with the remote backend).
- Known rough edges: `agent` and `attach` always ask for a TTY, so `attach` without one reports "no
  session"; the remove guard's main exec has no timeout, and it trusts the container's own record of
  what origin has; exotic hook templates (arithmetic or an unparenthesised `case` inside `$(…)`) can
  still be injected by a hostile branch name.

## Code map

| File | Role |
| --- | --- |
| `src/commands/container.ts` | The `kunj ct` command; on the fast path (no AWS or LangChain imports, inquirer lazy) |
| `src/lib/container/backend.ts`, `docker.ts` | `ContainerBackend` and the only module that runs `docker` |
| `src/lib/container/lifecycle.ts` | Start, resume, rollback, stop, remove guard, status |
| `src/lib/container/names.ts` | Names, labels, `isMain` |
| `src/lib/container/image.ts`, `devcontainer.ts` | Image choice, builds, tags, the devcontainer subset |
| `src/lib/container/seed.ts` | Origin checks, push, the seed script |
| `src/lib/container/env.ts`, `defaults.ts`, `errors.ts` | Forwarded env, firewall env, status and guard parsing; defaults; `StartError`/`ContainerError` |
| `src/lib/container/forward.ts` | The exec-tunnel forwarder |
| `src/container/sandbox/`, `nethelper/` | Sandbox Dockerfile, zshrc, `git-credential-kunj`; helper Dockerfile and `firewall.sh` (copied to `dist/container` by `scripts/copy-container-assets.js`) |
| `src/lib/container/__tests__/` | Unit tests against `FakeBackend`; `integration.docker.test.ts` (`npm run test:docker`) against real Docker: clone and seed, push without `-u`, credential scoping, ports, firewall modes, rollback, remove guard, snapshots and bundles |
