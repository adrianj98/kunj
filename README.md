# Kunj - Git Branch Management CLI

A simple and intuitive command-line tool for managing Git branches.

## Installation

### Local Installation (for development)
```bash
npm install
npm run build
npm link
```

### Global Installation (from npm - if published)
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