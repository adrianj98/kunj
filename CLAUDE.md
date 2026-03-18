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
- Local: `.kunj/config.json` (per-repository settings)
- Local overrides global via deep merge
- Config loaded via `loadConfig()` in src/lib/config.ts

### Branch Metadata

Per-branch metadata stored in `.kunj/branches.json`:
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

### Work Log System

Daily activity tracking in `.kunj/work-logs/`:
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
