# Kunj - Git Branch Management CLI

A simple and intuitive command-line tool for managing Git branches.

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
kunj ct agent feature/x                # Claude in tmux; detach with Ctrl-b d
kunj ct attach feature/x               # come back to it later
kunj ct shell feature/x                # login shell in /workspace
kunj ct exec feature/x -- npm test     # run one command
kunj ct forward feature/x 3000         # localhost:3000 -> container port 3000
git fetch origin && git switch feature/x   # the agent's pushes arrive via origin
kunj ct list                           # containers of this repository (-a for all)
kunj ct stop feature/x                 # keeps the workspace
kunj ct remove feature/x               # refuses while work is unpushed (-f to override)
```

The branch defaults to the current one. `start` takes `--base <ref>`, `--image <img>`,
`--publish <ports>`, `--rebuild` and `--keep-on-error`; `remove` takes `--force` and
`--keep-volumes`; `--context <name>` picks a Docker context; `--json` works on every action. The
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

Network: by default the internet is open but the Docker host, the LAN and private ranges are
blocked, except origin itself on its own port (so a self-hosted origin on the LAN still works). Set `container.network.allow` to restrict egress to a list of domains (plus GitHub, npm
and the Anthropic API); `container.network.allowHost` opens the host again. The rules are applied
by a small helper container that shares the agent's network. The agent's container runs with all
capabilities dropped except CHOWN, DAC_OVERRIDE, FOWNER, SETUID and SETGID, so it cannot undo them
(no NET_ADMIN) or go around them (no NET_RAW), and nothing runs in the container until they are in
place.

Ports: `kunj ct forward <branch> 3000` or `8080:3000` forwards a local port into the container
over `docker exec`, so nothing is published. `--publish` and `container.publish` use Docker's own
port publishing instead.

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
