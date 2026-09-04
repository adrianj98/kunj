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

### Work in a git worktree

```bash
kunj tree feature/bob        # create (or switch to) a worktree for feature/bob and open it in your editor
kunj tree feature/bob -n     # open it in a new editor window
kunj tree -p feature/bob     # print the worktree path only (for `cd "$(kunj tree -p feature/bob)"`)
kunj tree                    # interactive worktree picker
kunj tree list               # list worktrees
kunj tree remove feature/bob # remove a worktree (branch is kept)
```

Worktrees are created under `~/.kunj/<repo>/worktrees/<branch>` (with `/` replaced by `_`,
so `feature/bob` becomes `feature_bob`). Change the base directory with
`kunj config set worktree.dir=~/worktrees/{repo}` and the editor with `worktree.openCommand`.

### Keep files across worktrees

Keep files are local, untracked files (like `.env`) that should exist in every worktree.
They are stored in `~/.kunj/<repo>/keep/` and copied into each new worktree automatically.

```bash
kunj tree keep .env               # save a copy of .env
kunj tree keep apply              # copy all keep files into this worktree
kunj tree keep apply --all        # ...into every worktree
kunj tree keep delete .env        # stop keeping .env
kunj tree keep list               # show keep files
kunj tree keep                    # interactive menu
```

### Delete a branch

```bash
kunj delete <branch-name>
```

Deletes the specified branch (must not be the current branch).

For force deletion:

```bash
kunj delete <branch-name> --force
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
