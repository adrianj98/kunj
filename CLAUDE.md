# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kunj is a Git branch management CLI tool with AI-powered features for commit message and PR description generation. It uses AWS Bedrock Claude 3.5 Sonnet for AI capabilities and follows a pluggable command architecture.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Build the project (TypeScript → dist/)
npm run build

# Run in development mode
npm run dev <command> [options]

# Test locally after building
node dist/index.js <command> [options]

# Link for global CLI testing
npm link

# Run tests
npm test

# Run tests in watch mode
npm test:watch

# Run tests with coverage
npm test:coverage

# Type checking (no emit)
npm run lint
```

also commit and push changes

## Testing

- Tests are located in `src/**/__tests__/` directories
- Test files follow the pattern `*.test.ts`
- Uses Jest with ts-jest preset
- Run single test file: `npm test -- path/to/test.test.ts`

## Architecture

### Pluggable Command System

Commands inherit from `BaseCommand` (src/lib/command.ts) and are registered via `CommandRegistry`:

1. Each command extends `BaseCommand` with a `CommandConfig` (name, description, options)
2. Commands implement the `execute()` method
3. All commands are exported from `src/commands/index.ts` via `getAllCommands()`
4. The registry applies commands to the Commander.js program in `src/index.ts`

To add a new command:
1. Create a new file in `src/commands/` extending `BaseCommand`
2. Export it from `src/commands/index.ts`
3. Add it to the `getAllCommands()` array

### Settings Registry Pattern

Settings are registered via a centralized registry (src/lib/settings-registry.ts):

- Settings are defined with metadata (type, default value, description, validation)
- Organized by category (core, ai, branch-filtering, stash)
- All settings initialized in `src/settings/index.ts`
- Default config is dynamically generated from registered settings
- Settings support hierarchical keys (e.g., `ai.commitStyle`, `preferences.autoStash`)

### Configuration System

Two-tier config (global + local):
- Global: `~/.kunj/config.json` (user-wide settings)
- Local: `~/.kunj/{reponame}/config.json` (per-repository settings, shared by all worktrees of the repo)
- Local overrides global via deep merge
- Config loaded via `loadConfig()` in src/lib/config.ts

The per-repository directory is resolved by `getKunjDir()` in src/lib/config.ts. `{reponame}` comes from the
`origin` remote URL, falling back to the basename of the git common dir. Outside a git repository it falls back
to `./.kunj`. A legacy `./.kunj` directory is copied to the new location the first time it is seen.

### Branch Metadata

Per-branch metadata stored in `~/.kunj/{reponame}/branches.json`:
- Descriptions, tags, notes, related issues
- Stash history with timestamps
- Last switched timestamp
- Managed via src/lib/metadata.ts

### AI Integration

AI features use AWS Bedrock Claude 3.5 Sonnet:
- **Commit Messages** (src/lib/ai-commit.ts): Analyzes staged diffs and generates commit messages
- **PR Descriptions** (src/lib/ai-pr.ts): Analyzes branch diffs and commit history
- **Work Log Generation**: AI-powered daily standup bullets

Project context is read from `claude.md`, `.claude.md`, `CLAUDE.md`, `.claude/context.md`, or `README.md` (first 1000 chars cached).

AWS credentials and region resolved via standard AWS SDK chain (env vars, config files, IAM roles).

Commit styles (conventional, semantic, simple, gitmoji, custom) are defined in src/lib/commit-styles.ts.

### Worktrees and Keep Files

`kunj tree` (src/commands/tree.ts) wraps `git worktree`:
- Worktrees live under `worktree.dir` (default `~/.kunj/{reponame}/worktrees`), one folder per branch named with `/` replaced by `_` (src/lib/worktree.ts)
- If the branch is already checked out in any worktree, that path is reused; otherwise the branch is created from the current branch (or tracked from `origin/<branch>`)
- After creating or switching, the worktree is opened with `worktree.openCommand` (default `code`). VS Code-like editors get `-r` (reuse window) or `-n` (`--new-window`)
- Keep files (src/lib/keep.ts) are stored in `~/.kunj/{reponame}/keep/` with their path relative to the worktree root and are applied to every newly created worktree

### Work Log System

Daily activity tracking in `~/.kunj/{reponame}/work-logs/`:
- Markdown files named `YYYY-MM-DD.md`
- Automatically appends commit activity with timestamps
- AI-generated standup format with bullets
- Managed via src/lib/work-log.ts

## Key Commands

- `kunj create <branch>` - Create and switch to new branch (with auto-stash)
- `kunj switch [branch]` - Switch branches (interactive if no arg)
- `kunj list` - List branches with filtering options
- `kunj commit` - Interactive commit with AI-generated messages
- `kunj pr` - Create PR with AI-generated description
- `kunj log` - View/manage work logs
- `kunj config` - Manage global/local settings
- `kunj setup` - Interactive onboarding
- `kunj delete <branch>` - Delete branch
- `kunj completion` - Manage shell completion (--install/--uninstall)
- `kunj prompt-info` - Output PR# for shell prompts
- `kunj tree <branch>` - Create or switch to a git worktree for the branch and open it in the editor (`-n` new window, `-p` print path only)
- `kunj tree keep [file|apply|delete|list]` - Manage keep files copied into every worktree (interactive menu with no args)

## Shell Integration

### Autocomplete

Enable tab completion for commands and options:

```bash
# Install completion
kunj completion --install

# Reload shell
source ~/.zshrc  # or ~/.bashrc
```

### PR# in Shell Prompt

Display current PR number in your shell prompt. Add to `~/.zshrc`:

```zsh
# Function to show PR# in prompt
kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " $pr"
}

# Add to right prompt
RPROMPT='$(kunj_prompt_pr)'
```

See `docs/SHELL_INTEGRATION.md` for detailed setup instructions and advanced configurations.

## Git Operations

Core git operations abstracted in src/lib/git.ts:
- All git commands use `child_process.exec` wrapped with `promisify`
- Functions return structured results or throw errors
- File status parsing handles standard git status codes (M, A, D, R, C, U)


## Release Process

Tag-based automatic releases via GitHub Actions:

1. Commit changes to main
2. Create version tag: `git tag v1.2.3`
3. Push tag: `git push origin v1.2.3`
4. Workflow automatically publishes to NPM and creates GitHub release

See `.github/workflows/README.md` for details. Requires `NPM_TOKEN` secret.

## Code Conventions

- TypeScript strict mode enabled
- Target ES2022, CommonJS modules
- Source in `src/`, output in `dist/`
- Chalk for colored output (v4.1.2 for CommonJS compatibility)
- Inquirer for interactive prompts
- Commander.js for CLI parsing
