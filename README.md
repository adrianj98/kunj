# Kunj - Git Branch Management CLI

A simple and intuitive command-line tool for managing Git branches.

## Installation

### Local Installation (for development)

```bash
npm install
npm run build
npm link
```

### Global Installation (from npm - if published stash)

```bash
npm install -g kunj
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
and `${repoRoot}` and the other config variables:

```bash
kunj config --set hooks.post-worktree-create="npm install"
kunj config --set hooks.pre-worktree-delete="docker compose down"
kunj config --set hooks.post-branch-switch="npm install"
kunj config --set hooks.pre-pr-create="npm test"
```

Edit `config.json` by hand to give a hook a JSON array of several commands.

### VS Code extension

The `vscode-extension/` folder contains **Kunj Worktrees**, a VS Code extension that lists worktrees, shows which ones are open in other windows along with their pull requests, and opens them on click. It uses the kunj CLI for everything. See [vscode-extension/README.md](./vscode-extension/README.md).

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
