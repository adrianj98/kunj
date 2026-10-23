# Kunj - Git Branch Management CLI

A simple and intuitive command-line tool for managing Git branches.

**User docs:** <https://adrianj98.github.io/kunj/docs/> (source in [`docs-site/`](docs-site/README.md)).

## Installation

### 1. The CLI

```bash
npm install -g kunj
```

Requires Node.js 20+ and git 2.31+. Pull request features also need the GitHub CLI (`gh`) or GitLab
CLI (`glab`), logged in. Then run `kunj setup` for shell aliases, optional Jira and the apps below.

### 2. The apps (optional)

```bash
kunj install          # asks which to install
kunj install vscode   # VS Code extension (Kunj Worktrees); --editor cursor for Cursor & co.
kunj install macos    # macOS menu bar app, into /Applications (or ~/Applications)
kunj install all -y   # everything available, no questions
```

Both are downloaded from the [GitHub release](https://github.com/adrianj98/kunj/releases) matching
your CLI version (or the newest one that has them). Running `kunj install` again updates them.

To install by hand instead, download from the release:

- **VS Code**: `kunj-worktrees-<version>.vsix`, then `code --install-extension kunj-worktrees-<version>.vsix`
  (or *Extensions: Install from VSIX…* in the command palette).
- **macOS** (14+): `Kunj-macos-<version>.zip`, unzip it, move `Kunj.app` to /Applications and, because
  the app is not signed or notarized yet, clear the quarantine before opening it:
  `xattr -dr com.apple.quarantine /Applications/Kunj.app`

### From source (development)

```bash
npm install && npm run build && npm link              # the CLI
cd vscode-extension && npm install && npm run install-local   # the VS Code extension
cd macos-app && scripts/bundle.sh --install           # the menu bar app
```

## Usage

### Create a new branch and switch to it

```bash
kunj create <branch-name>
```

This creates a new branch and automatically switches to it. Any uncommitted changes will be automatically stashed.

To disable auto-stashing:

```bash
kunj create <branch-name> --no-stash
```

### Switch to an existing branch

```bash
kunj switch <branch-name>
```

Switches to the specified branch. Automatically stashes any uncommitted changes from the current branch and restores any previously stashed changes for the target branch.

To disable auto-stashing:

```bash
kunj switch <branch-name> --no-stash
```

### Interactive branch switching

```bash
kunj switch
```

Shows a list of all branches and lets you select one interactively. Auto-stashing is enabled by default.

### List all branches

```bash
kunj list
```

Displays all branches with the current branch highlighted.

### Delete a branch

```bash
kunj delete <branch-name>
```

Deletes the specified branch (must not be the current branch).

For force deletion:

```bash
kunj delete <branch-name> --force
```

### Work with git worktrees

```bash
kunj worktree                    # list worktrees and which editor windows have them open
kunj worktree add feature/login  # create ../<repo>-worktrees/feature-login
kunj worktree add hotfix -b --base main   # new branch in a new worktree
kunj worktree add feature/y -c           # check out feature/y, creating it if it does not exist
kunj worktree open feature/login # open in your editor (worktree.editorCommand, default "code")
kunj worktree pr feature/login   # show the related pull request (add --web to open it)
kunj worktree remove feature/login
kunj worktree prune
```

Worktrees are created under `${repoconfig}/kunj/worktrees/<branch>` by default. Change the base
directory with `kunj config set worktree.baseDir='~/worktrees/${repoName}'` and the editor with
`worktree.editorCommand`.

### Keep files across worktrees

Keep files are local, untracked files (like `.env`) that should exist in every worktree.
They are stored in `~/.kunj/<repo>/keep/` and copied into each new worktree automatically.

```bash
kunj worktree keep .env               # save a copy of .env
kunj worktree keep apply              # copy all keep files into this worktree
kunj worktree keep apply --all        # ...into every worktree
kunj worktree keep delete .env        # stop keeping .env
kunj worktree keep list               # show keep files
kunj worktree keep                    # interactive menu
```

Add `--json` to any action for machine-readable output.

### Run a branch in a sandboxed container

`kunj container` (alias `ct`) runs a branch in a Docker container with its own clone of the
repository, so you can let an AI agent work with its permissions skipped without giving it your
working tree. Nothing is bind-mounted from the host: the workspace is a Docker volume, and the only
way code goes in or out is through `origin`.

You need Docker, a Claude login for the agent (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or
`CLAUDE_CODE_USE_BEDROCK` with your AWS variables) and a `GH_TOKEN` for cloning and pushing. Use a
fine-grained GitHub token scoped to this one repository; the agent can use whatever you give it.
A token written into origin's URL (`https://user:token@host/...`) is stripped and never reaches the
container; forward it with `container.env` instead.
The first start builds the `kunj-sandbox` image, which takes a few minutes and about 1.2 GB.

```bash
export GH_TOKEN=github_pat_...         # fine-grained, this repo only
kunj ct start -c feature/x             # new branch from origin/<base>, cloned into a container
kunj ct agent feature/x                # Claude in tmux (plus a background forward --auto); detach with Ctrl-b d
kunj ct attach feature/x               # come back to it later
kunj ct shell feature/x                # login shell in /workspace
kunj ct open feature/x                 # VS Code attached to the container (--new-window)
kunj ct exec feature/x -- npm test     # run one command
kunj ct forward feature/x 3000         # localhost:3000 -> container port 3000
kunj ct forward feature/x --auto       # forward every port the container starts listening on
kunj ct logs feature/x postgres        # a sidecar service's output (--follow to keep streaming)
git fetch origin && git switch feature/x   # the agent's pushes arrive via origin
kunj ct list                           # containers of this repository (-a for all)
kunj ct stop feature/x                 # keeps the workspace
kunj ct remove feature/x               # refuses while work is unpushed (-f to override)
kunj ct prune                          # containers of branches gone from origin, orphans, old images
```

The branch defaults to the current one. `start` takes `--base <ref>`, `--image <img>`,
`--publish <ports>`, `--rebuild`, `--no-snapshot` (see [Blueprints](#blueprints)) and `--keep-on-error`; `remove` takes `--force` and
`--keep-volumes`; `prune` removes the containers of branches deleted on origin (only those without
unpushed work, unless `--force`), helpers, services, volumes and networks left without their
container, snapshot and `kunj-sandbox` images that are no longer current, and stopped containers
older than `container.pruneAfterDays`; it asks first, takes `--dry-run` (the default when stdout is
not a terminal; `--yes` applies there) and `--all` (every recorded repository); `open` starts a stopped container and opens `worktree.editorCommand` attached to it
(VS Code and Cursor, through the Dev Containers extension; other editors get the `docker exec`
command to run; while attached, the extension forwards your host's git credentials, SSH agent and
gpg-agent into the container unless `dev.containers.copyGitConfig` is `false` and
`dev.containers.gitCredentialHelperConfigLocation` is `"none"`; SSH/GPG forwarding has no setting); `--context <name>` picks a Docker context; `--json` works on every action. The
image comes from the repository's `.devcontainer/devcontainer.json` (an image or a Dockerfile) if
there is one, else `kunj-sandbox`.

Settings (`kunj config`):

| Setting | Default | Meaning |
|---|---|---|
| `container.image` | none | Image override (default: the devcontainer, else `kunj-sandbox`) |
| `container.agentCommand` | Claude with permissions skipped | Command `kunj ct agent` runs in tmux |
| `container.env` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `GH_TOKEN` | Host variables forwarded when set; `NAME=value` passes a literal |
| `container.files` | none | Host files copied into new containers, as `hostPath:containerPath` |
| `container.keepFiles` | `true` | Copy the repository's keep files into new containers |
| `container.network.allow` | none | Egress allowlist of domains; empty means open internet |
| `container.network.allowHost` | `false` | Let containers reach the Docker host |
| `container.dockerContext` | none | Docker context for every call |
| `container.cpus`, `container.memory` | none | Limits passed to `docker run` (e.g. `2`, `4g`) |
| `container.publish` | none | Ports always published at start |
| `container.forward.auto` | `true` | `kunj ct agent` starts a background `forward --auto` |
| `container.forward.ignore` | none | Container ports `forward --auto` never forwards |
| `container.services` | none | Sidecar services by name (see [Services](#services)) |
| `container.pruneAfterDays` | `0` (off) | `kunj ct prune` also removes stopped containers created longer ago |

Network: by default the internet is open but the Docker host, the LAN and private ranges are
blocked, except origin itself on its own port (so a self-hosted origin on the LAN still works). Set `container.network.allow` to restrict egress to a list of domains (plus GitHub, npm
and the Anthropic API); `container.network.allowHost` opens the host again. The rules are applied
by a small helper container that shares the agent's network. The agent's container runs with all
capabilities dropped except CHOWN, DAC_OVERRIDE, FOWNER, SETUID and SETGID, so it cannot undo them
(no NET_ADMIN) or go around them (no NET_RAW), and nothing runs in the container until they are in
place.

Ports: `kunj ct forward <branch> 3000` or `8080:3000` forwards a local port into the container
over `docker exec`, so nothing is published. `--publish` and `container.publish` use Docker's own
port publishing instead. `kunj ct forward <branch> --auto` watches the container's listeners
(`/proc/net/tcp` every 2 s, so the image needs no extra tools) and forwards each new one on port 1024
or above that listens on all addresses or on 127.0.0.1 to the same port on
127.0.0.1, or the next free one, dropping it when the listener goes away; ports in
`container.forward.ignore` are skipped. It prints one line per change (`--json`: one
`{ "event": "add"|"remove", "port", "hostPort" }` object per line). `--detach` runs it in the
background until the container stops (`--json`: `{ success, branch, pid }`). `kunj ct agent` starts
one of those unless one is already running for the container or `container.forward.auto` is
`false`. Running forwarders are recorded in `~/.kunj/container-forwards.json`, and `kunj ct list
--json` shows their ports as `kind: "forward"` entries with the forwarder's `pid`.

Hooks: `pre-container-create`, `post-container-create`, `pre-container-delete` and
`post-container-delete` receive `branch`, `container` and `image` (see [Hooks](#hooks)). The create
hooks run only when a container is created (or recreated by `--rebuild`), not when one is resumed.

What the sandbox does and does not protect:

| Protected | Not protected |
|---|---|
| Host files: nothing is bind-mounted | Whatever you forward in: the agent can read every variable and file you pass and, with internet access, send it anywhere |
| Your clone and other branches: each container has its own clone, on its own network | Origin, within the token's scope: the agent can push to any branch the token may write to; use branch protection |
| Host services and LAN: blocked by default | Exfiltration under an allowlist: GitHub, npm and DNS are enough to carry a token out |
| Host Docker daemon: the socket is never mounted | |

Security notes:

- Image builds are not behind the firewall: a devcontainer Dockerfile runs with full network
  access while it builds. `kunj ct start` warns when the branch changed the build context compared
  with the default branch, before building it.
- A devcontainer image with `sudo` makes the agent root inside the container. Root cannot change
  or bypass the firewall (the container has no NET_ADMIN or NET_RAW), but it owns everything else
  in the container, including what you forwarded into it.
- Forwarded variables are in the container's environment, so `docker inspect` on the host shows
  their values to anyone who can use your Docker daemon.
- `container.network.allowHost` opens the Docker gateway, `host.docker.internal` and every
  private and link-local range (your LAN, Tailscale), not just the host.
- The allowlist always admits GitHub's published ranges (when origin is on GitHub), origin, npm
  and the Anthropic API. Git LFS storage hosts and `codeload.github.com` (archive downloads) are
  not on it by name; add them to `container.network.allow` if the repository needs them.
- `kunj ct forward` uses `socat` in the container when it has it; the bash `/dev/tcp` fallback
  cannot half-close a connection, so protocols that wait for the client to finish sending may hang.
- A devcontainer's build context is taken with `git archive`, which leaves out submodule contents
  and Git LFS files (only their pointers are included).

#### Services

A branch that needs a database or a broker gets its own, next to its container: one container per
service on the branch's network, reachable from the branch container by the service's name.

```jsonc
// .kunj/blueprint.json, or the container.services setting (same shape)
{
  "services": {
    "postgres": {
      "image": "postgres:16-alpine",
      "env": { "POSTGRES_PASSWORD": "dev" },
      "port": 5432,
      "healthcheck": "pg_isready -h 127.0.0.1 -U postgres",   // run with sh -c inside the service
      "volumes": { "data": "/var/lib/postgresql/data" }       // named volumes only, one per branch
    },
    "api-mock": { "image": "wiremock/wiremock:3", "command": ["--port", "8080"], "dependsOn": ["postgres"] }
  }
}
```

From the branch container the database is `postgres:5432`. Services are read from the blueprint's
`services`, then `container.services`, then the services of the devcontainer's `dockerComposeFile`
(all but the devcontainer's own `service`); the first to name a service wins. The compose import
takes `image`, `environment`, `command`, `healthcheck`, `depends_on`, named volumes and the first
port of `ports`/`expose`, and leaves out bind mounts, `build`, `privileged`, `cap_add`,
`network_mode`, `env_file`, `entrypoint`, `user`, `working_dir`, `tmpfs`, published ports and
variables taken from your shell, with one warning listing what it dropped. A compose file with
`include` or an `extends` that names another file is not imported at all (those read files from
your machine). `${VAR:-default}` becomes the default; nothing is read from your
environment.

`start` runs the services before the branch container, in `dependsOn` order, and waits for each
health check (every 2 s, up to 2 minutes, then a warning and the start goes on), so they are up
before `setup` runs. That holds for snapshot builds too: `setup` can run migrations against them.
Their data is never part of the snapshot, and the temporary services go with the temporary
container. `stop` stops them, a resumed start starts them again, and `remove` deletes them and their
volumes (`--keep-volumes` keeps those).

```bash
kunj ct list                          # each container's services and their state (JSON: services[])
kunj ct logs feature/x postgres       # --follow to keep streaming
kunj ct forward feature/x postgres:5432   # localhost:5432 -> the service, through docker exec
```

`forward` tunnels through the service container with `socat`, `bash` or `nc`, whichever its image
has, and refuses when it has none.

A service image is chosen by the branch, so it gets nothing from the host: no `container.env` and
no forwarded variables (only the `env` it declares), no bind mounts, no added capabilities, no
`--privileged` and no published ports. Services are not behind the firewall (they need no helper:
nothing of yours is in them), so they can reach the internet; only containers on the same branch's
network can reach them.

### Blueprints

A blueprint tells `kunj ct` how to set up a new container for this repository: which tools to
install, which commands make the checkout usable, and which keep it up to date. kunj sets the
blueprint up once in a temporary container and saves the result as a snapshot image, so later
branches start with dependencies installed and the project built.

`.kunj/blueprint.json` (JSON with comments):

```jsonc
{
  "tools":     { "node": "24", "apt": ["jq", "postgresql-client"] }, // installed as root, at snapshot time
  "setup":     ["npm ci", "npm run build"],  // once, in /workspace, as the sandbox user
  "maintain":  ["npm install"],              // on each start not right after setup, to catch up with the branch
  "lockfiles": ["package-lock.json"],        // when these change on origin, the snapshot is stale
                                             // (default: every known lockfile at the root)
  "notes":     "free text for people (and agents) reading the file"
}
```

`tools` maps a preset name to a version, a list of words or `true`. Presets are shell scripts,
looked up in this order: the repository's `.kunj/presets/<name>.sh`, then `~/.kunj/presets/<name>.sh`,
then the built-in ones (`apt`, `node`, `python`, `go`, `rust`, `java`, `yarn`, `pnpm`, `bun`,
`playwright`, `supabase`). A preset installs outside the user's home (under `/usr/local` or `/opt`),
because the home directory is a volume and is not part of the snapshot.

```bash
kunj ct blueprint init          # [--global] [--yes]: infer one from this checkout -> .kunj/blueprint.json (review it)
git add .kunj/blueprint.json && git commit -m "kunj blueprint"
kunj ct start -c feature/x      # first start builds the snapshot (as long as setup takes)
kunj ct start -c feature/y      # every later branch starts from it in seconds
```

`kunj ct start` reads the blueprint from the working tree's `.kunj/blueprint.json`, then from
`origin/<default branch>`, then from `~/.kunj/<repo>/blueprint.json` (the host copy that
`init --global` writes, for repositories you cannot commit to). When there is no snapshot for the
blueprint yet, or it is stale, the start builds one first; if that build fails it warns and runs
the tools and `setup` inside the new container instead. A container started from a snapshot gets
its own branch checked out from origin and runs `maintain`; `setup` is not run again. `maintain`
is skipped on the start that has just run `setup` itself, and runs on every later start.
When rebuilding a stale snapshot fails, the start uses the stale one and says so.

The other commands are optional:

```bash
kunj ct blueprint snapshot      # build it ahead of time; --rebuild forces one, --base <ref> snapshots another branch
kunj ct blueprint status        # which blueprint, its hash, and whether the snapshot is current
kunj ct blueprint remove        # delete this repository's snapshot images
kunj ct start --no-snapshot x   # ignore the snapshot: clone, then tools + setup in the container
```

`snapshot` and `status` take `--blueprint <path>` to use another file than the resolved one.

The snapshot (`kunj-blueprint-<repo>:<hash>`) holds the installed tools and a copy of the set-up
checkout of the default branch. It does not hold secrets (the temporary container gets no
`container.env`, keep files or copied files), the `/workspace` volume or the home volume. Its hash
covers the blueprint text, the listed lockfiles on origin's default branch, the base image and the
presets, so changing any of them makes it stale; the next `kunj ct start` of a new container
rebuilds it (`--no-snapshot` starts without either). One snapshot is kept per repository.

Security notes:

- Presets run as root, and only while a snapshot is built (or in a `--no-snapshot` container);
  `setup` and `maintain` run as the sandbox user. Everything runs behind the same firewall as any
  container: internet yes, host and LAN no.
- Presets come from files on disk. A repository's `.kunj/presets/` overrides the built-in presets
  and runs as root in the build container, so review it like a Dockerfile, especially on a branch
  you did not write.
- Tool values are validated: words only, no options (`-o...`) and no paths, so a value cannot make
  a built-in preset run something else.
- Private and SSH origins snapshot like public ones: the host fetches the branch with its own
  credentials and streams a `git bundle` of it into the temporary container, which clones that and
  then points `origin` back at the real URL. The container never gets a token while a snapshot is
  built, so none can end up in the image. `kunj ct blueprint snapshot --no-bundle` clones from
  origin inside the container instead, which needs a public HTTPS origin.

Worked examples. For kunj itself, `init` writes:

```json
{
  "setup": ["npm ci", "npm run build"],
  "maintain": ["npm install"],
  "lockfiles": ["package-lock.json"]
}
```

Node 22 is already in `kunj-sandbox`, so there is no `tools` entry. The snapshot is about 360 MB
on top of the base image and took about a minute to build.

For driveday_planner (a pnpm workspace with Playwright tests and a Supabase backend), `init` reads
`packageManager`, the Playwright dependency and `supabase/config.toml`:

```json
{
  "tools": { "pnpm": "corepack", "playwright": true, "supabase": "latest" },
  "setup": ["pnpm install --frozen-lockfile", "pnpm build"],
  "maintain": ["pnpm install --frozen-lockfile"],
  "lockfiles": ["pnpm-lock.yaml"]
}
```

`engines.node` (`>=18`) is satisfied by the image's Node 22, so `node` is left out. The Supabase
CLI works against a remote project; `supabase start` needs Docker, which the sandbox does not have.

### Hooks

Like git hooks, kunj can run your own scripts around its own actions. They fire when kunj does
something, not on every git operation (git's own hooks still run as usual):

| Hook | Fires around | Arguments (`$1`, `$2`, ...) |
| --- | --- | --- |
| `pre-/post-worktree-create` | `kunj worktree add` | worktree path, branch |
| `pre-/post-worktree-delete` | `kunj worktree remove` | worktree path, branch |
| `pre-/post-branch-create` | `kunj create`, `kunj switch -c` | branch, previous branch |
| `pre-/post-branch-switch` | `kunj switch` | branch, previous branch |
| `pre-/post-branch-delete` | `kunj delete` | branch |
| `pre-commit` | `kunj commit`, after staging, before the message | branch |
| `commit-msg` | `kunj commit`, before committing; may edit the message file | message file, branch |
| `post-commit` | `kunj commit`, after committing, before pushing | branch |
| `pre-/post-pr-create` | `kunj pr` (`post` also gets the PR URL) | branch, base branch, title[, PR url] |
| `pre-/post-stash` | `kunj stash` and the auto-stash on create/switch | branch, stash message |

A `pre-*` or `commit-msg` hook that exits non-zero aborts the action; a failing `post-*` hook is
reported only. Every kunj command that fires hooks takes `--no-hooks`.

```bash
kunj hooks                                # list hooks and what is installed for each
kunj hooks add post-worktree-create       # create ~/.kunj/<repo>/hooks/post-worktree-create from a template
kunj hooks add pre-worktree-delete -g     # ...or a global one in ~/.kunj/hooks (runs for every repo)
kunj hooks run post-worktree-create       # run a hook by hand against the current worktree
kunj hooks run post-branch-switch main    # ...or, for the other hooks, a branch
kunj worktree add feature/x --no-hooks    # skip hooks for one command
```

A hook is an executable file named after the hook, or a directory `<hook>.d/` of executables that run
in sorted order. Scripts get the arguments above, and the same values in the environment as
`KUNJ_<ARGUMENT>` (`KUNJ_BRANCH`, `KUNJ_PREVIOUS_BRANCH`, `KUNJ_MESSAGE_FILE`, `KUNJ_PR_URL`, ...),
plus `KUNJ_HOOK`, `KUNJ_REPO_ROOT`, `KUNJ_REPO_CONFIG` and `KUNJ_REPO_NAME`.
`post-worktree-create` and `pre-worktree-delete` run inside the worktree (after keep files were
copied in), the other worktree hooks from the main worktree, and all other hooks in the directory
kunj was run from.

Short commands can live in config instead of a script. They run through the shell and may use
the arguments as camelCase variables (`${branch}`, `${previousBranch}`, `${prUrl}`, `${worktree}`, ...)
and `${repoRoot}` and the other config variables. Values are quoted for you and always reach the
command literally: bare (`${branch}`), inside double quotes (`"${branch}"`), inside single quotes
(`'${branch}'`) and inside a command substitution (`"$(basename ${branch})"`, backticks), which is
quoted like a bare value:

```bash
kunj config --set hooks.post-worktree-create="npm install"
kunj config --set hooks.pre-worktree-delete="docker compose down"
kunj config --set hooks.post-branch-switch="npm install"
kunj config --set hooks.pre-pr-create="npm test"
```

Edit `config.json` by hand to give a hook a JSON array of several commands.

### VS Code extension

The `vscode-extension/` folder contains **Kunj Worktrees**, a VS Code extension that lists worktrees, shows which ones are open in other windows along with their pull requests, and opens them on click. It uses the kunj CLI for everything. Install it with `kunj install vscode`; see [vscode-extension/README.md](./vscode-extension/README.md).

### macOS menu bar app

The `macos-app/` folder contains **Kunj**, a menu bar app with the same features as the VS Code
extension, across every repository kunj knows about (`kunj repos`). Install it with
`kunj install macos`; see [macos-app/README.md](./macos-app/README.md).

```bash
kunj repos                 # repositories kunj has been used in, most recent first
kunj repos add ~/src/app   # add one by hand
kunj repos remove ~/src/x  # hide one from the list
```

## Development

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Run in development mode

```bash
npm run dev <command> [options]
```

### Docker integration tests

```bash
npm run test:docker   # needs Docker; skipped when it is not available
```

### Test locally

After building:

```bash
node dist/index.js <command> [options]
```

Or after linking:

```bash
npm link
kunj <command> [options]
```

## Features

- ✅ Create and switch to new branches in one command
- ✅ Quick branch switching with name
- ✅ Interactive branch selection with visual indicators
- ✅ **Automatic stashing** - Stashes uncommitted changes when switching branches and restores them when you return (enabled by default)
- ✅ List all branches with current branch highlighted
- ✅ Delete branches with safety checks
- ✅ Git repository validation
- ✅ Colored output for better visibility
- ✅ Error handling with helpful messages


## Requirements

- Node.js >= 14.0.0
- Git installed and configured
- Must be run inside a Git repository

## License

MIT
