---
type: Feature
title: Hooks
description: Git-style user hooks that run before and after kunj actions, from global and per-repo script directories and hooks.* config commands, plus the kunj hooks command to list, scaffold and test them.
resource: src/lib/hooks.ts
tags: [feature, hooks, extensibility, config]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Hooks let users run their own scripts around kunj actions - creating a worktree, switching branch,
committing, opening a PR, creating a container - in the same spirit as git hooks, but around kunj
commands rather than every git operation. A failing `pre-*` hook aborts the action; `post-*` failures
are warnings.

The hook list lives in `src/lib/hook-defs.ts`, which has no imports so the settings registry and types
can use it without an import cycle through `config.ts`. The runner is `src/lib/hooks.ts` (on the
worktree [fast path](/architecture/fast-path.md), so it avoids heavy imports and git subprocesses).
`kunj hooks` (`src/commands/hooks.ts`) inspects, scaffolds and tests them.

# Hook list

| Hook | Arguments | Run by |
|------|-----------|--------|
| `pre/post-worktree-create` | `worktree-path`, `branch` | `kunj worktree add` (post runs in the new worktree after keep files) |
| `pre/post-worktree-delete` | `worktree-path`, `branch` | `kunj worktree remove` (pre runs in the worktree, post from the main worktree) |
| `pre/post-branch-create` | `branch`, `previous-branch` | `kunj create`, `kunj switch -c` |
| `pre/post-branch-switch` | `branch`, `previous-branch` | `kunj switch` (post after the stash is restored) |
| `pre/post-branch-delete` | `branch` | `kunj delete` |
| `pre-commit` | `branch` | `kunj commit`, after staging |
| `commit-msg` | `message-file`, `branch` | `kunj commit`; may edit the file |
| `post-commit` | `branch` | `kunj commit`, before pushing |
| `pre/post-pr-create` | `branch`, `base-branch`, `title` (+ `pr-url` for post) | `kunj pr` |
| `pre/post-stash` | `branch`, `message` | `kunj stash` and the auto-stash in `src/lib/stash.ts` |
| `pre/post-container-create` | `branch`, `container`, `image` | `kunj container start` (skipped on resume) - see [Container Hooks](/containers/container-hooks.md) |
| `pre/post-container-delete` | `branch`, `container`, `image` | `kunj container remove` |

`abortsOnFailure` is true for every `pre-*` hook and `commit-msg`.

# Where hooks come from

For each hook, `runHook()` runs everything found, in order:

1. `~/.kunj/hooks/` (global, `getHooksDir('global')`)
2. `~/.kunj/{reponame}/hooks/` (repo, `getHooksDir('repo')`)
   - in both: a file named after the hook, or a `<hook>.d/` directory run in sorted order;
     `*.sample` files and dotfiles are ignored; non-executable files are reported as skipped
     ("not executable (chmod +x to enable)")
3. `hooks.<name>` config setting: a string or array of shell commands (`shell: true`), with `${...}`
   variables expanded by `expandVariablesQuoted()` ([Config Variables](/architecture/config-variables.md))

The `hooks.<name>` settings are registered automatically from `HOOKS` in `src/settings/hooks.ts`
(type string, default `''`, category `hooks`).

# What a hook receives

| Channel | Content |
|---------|---------|
| Positional args | the hook's `args`, in order |
| Environment | each arg as `KUNJ_<ARG>` (`argEnvName()`: `previous-branch` -> `KUNJ_PREVIOUS_BRANCH`), plus `KUNJ_HOOK`, `KUNJ_REPO_ROOT`, `KUNJ_REPO_CONFIG`, `KUNJ_REPO_NAME` |
| `${...}` variables (config commands) | each arg in camelCase (`argVariableName()`: `${previousBranch}`, `${prUrl}`), the repo variables, and for worktree hooks `${branch}` and `${worktree}` |
| Working directory | worktree hooks: the worktree if it exists, else the repo root (`worktreeHookContext()`); others: where kunj was run (`actionHookContext()`) |

In `--json` mode hook stdin is closed and stdout/stderr go to stderr (`stdio: ['ignore', 2, 2]`) so the
JSON on stdout stays clean.

# Runner API

| Function | Behaviour |
|----------|-----------|
| `runHook(name, context, options)` | Runs the queue; on a failing aborting hook throws `HookError` and stops; returns `HookRunResult` `{ hook, enabled, executions, ok }` |
| `runActionHook(name, values, options)` | For non-worktree commands: returns immediately (no git call) unless `hasHookSources()`; resolves repo variables with `resolveConfigVariables()`, runs, and prints post failures with `warnHookFailures()` |
| `worktreeHookContext(repo, path, branch)` | Context built from `repoVariables()` the worktree command already has, avoiding a subprocess |
| `findHookScripts()`, `listHookSources()`, `configuredHookCommands()` | Discovery |
| `hookTemplate()`, `createHookScript(name, scope, force)` | Scaffolding |

`HookError` is printed by `BaseCommand` without a stack trace. Commands expose `--no-hooks`
(`skip: options.hooks === false`): create, switch, delete, commit, pr, stash, worktree and container.

To add a hook to a command: add a definition to `HOOKS`, then call
`runActionHook(name, { <arg>: value }, { hooks: config.hooks, jsonMode, skip: options.hooks === false })`
and give the command `--no-hooks`.

# kunj hooks

| Action | Behaviour |
|--------|-----------|
| `kunj hooks` / `list` | Every hook with description, args and installed sources; `--json`: `{ hooksDir: { global, repo }, hooks: [{ name, description, abortsOnFailure, args, env, sources }] }` |
| `add <hook> [-g] [-f]` | Writes an executable `/bin/sh` template listing args and `KUNJ_*` variables to the repo (or global) hooks dir; leaves an existing file unless `--force` |
| `run <hook> [target]` | Runs the hook now: target is a worktree for worktree hooks, a branch otherwise; sample values for the rest, a throwaway `COMMIT_EDITMSG` for `commit-msg`; `--json`: `{ success, ...subject, result }` |
| `path [-g]` | Prints the hooks directory |

The long `--help` text is generated from `HOOKS`, so it cannot drift from the definitions.

# Related Concepts

* [Config Variables](/architecture/config-variables.md) - `${...}` quoting for hook commands
* [Branch Commands](/features/branch-commands.md), [AI Commit Messages](/features/ai-commit.md), [AI Pull Requests](/features/ai-pr.md)
* [Worktrees](/features/worktrees.md) - worktree hooks
* [Container Hooks](/containers/container-hooks.md)
* [Settings Registry](/architecture/settings-registry.md)

# Citations

[1] [src/lib/hook-defs.ts](/src/lib/hook-defs.ts)
[2] [src/lib/hooks.ts](/src/lib/hooks.ts)
[3] [src/commands/hooks.ts](/src/commands/hooks.ts)
[4] [src/settings/hooks.ts](/src/settings/hooks.ts)
[5] [src/lib/stash.ts](/src/lib/stash.ts)
[6] [src/commands/commit.ts](/src/commands/commit.ts)
[7] [CLAUDE.md](/CLAUDE.md)
