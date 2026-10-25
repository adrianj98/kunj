---
type: Architecture
title: Config Variables
description: The ${name} expansion available in any config string, how the repository variables are resolved cheaply, and the shell-aware quoting used for hook commands.
resource: src/lib/config-vars.ts
tags: [architecture, config, variables, shell-quoting, hooks]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Any string value in kunj's [configuration](/architecture/configuration.md) may reference
repository-derived values with `${name}`, for example the default `worktree.baseDir`
`${repoconfig}/kunj/worktrees`. Names match case-insensitively (`VARIABLE_PATTERN` is
`/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g`), and an unknown name is left verbatim, so a literal `${...}` in an
AI prompt or commit template survives.

Two expansion modes exist: plain substitution (`expandVariables`) for paths and values, and
shell-context-aware quoting (`expandVariablesQuoted`) for text that is handed to a shell, which is how
[hook](/features/hooks.md) commands keep a hostile branch name as data.

# Variables

`CONFIG_VARIABLES` documents them for `kunj config`:

| Name | Value | Where |
|------|-------|-------|
| `repoconfig` | The git common dir: `<root>/.git`, or the repository itself when bare | Everywhere in a repo |
| `repoRoot` | Main worktree directory | Everywhere in a repo |
| `repoName` | Basename of `repoRoot` (the folder, not the origin-derived `~/.kunj/<repo>` name) | Everywhere in a repo |
| `home` | `os.homedir()` | Always |
| `branch` | Branch name (directory-safe form for `worktree.baseDir`) | Where a branch is in scope |
| `worktree` | Worktree path | Worktree hooks |

Hooks add one camelCase variable per hook argument (`previous-branch` -> `${previousBranch}`), and the
container hooks get `branch`, `container`, `image`.

# Resolution

| Function | Purpose |
|----------|---------|
| `repoVariables(commonDir)` | Builds `{ repoconfig, repoRoot, repoName, home }` from a common dir the caller already has: no subprocess |
| `resolveConfigVariables(cwd?, extra?)` | One `git rev-parse --path-format=absolute --git-common-dir` per cwd, cached in `variableCache`; outside a repo only `home` |
| `hasVariables(value)` | Cheap `includes('${')` guard |
| `treeHasVariables(value)` | Any string in a config tree references a variable |
| `expandConfigStrings(value, vars)` | Deep-expands every string of a tree (used by `loadResolvedConfig()`) |

Rule: resolve variables from a git call already made. The worktree listing, `worktree add`, the
worktree hooks, `kunj events` and the repo registry all call `repoVariables()` on the common dir they
already know.

`worktree.baseDir` is expanded by `defaultWorktreePathFor()` in `src/lib/worktree.ts` with
`branch = branchToDirName(branch)`, `~` expanded, relative paths resolved from `repoRoot`, and the
branch directory appended unless the template names `${branch}`. `container.env` and `container.files`
values are expanded with `expandVariables()` in the container modules.

# Shell Quoting: expandVariablesQuoted

`expandVariablesQuoted(value, vars)` walks the command once, tracking POSIX quoting with a stack of
frames (`top`, `subst` for `$(...)`, `backtick` for `` `...` ``), each with a quote state
(`none`/`single`/`double`) and a parenthesis depth. A resolved variable is rendered for its context:

| Context of `${var}` | Rendering |
|---------------------|-----------|
| Bare | `shellQuote()`: `'value'` with `'` written as `'\''` |
| Inside `"..."` | `\`, `$`, `` ` ``, `"` backslash-escaped |
| Inside `'...'` | Spliced in, its `'` written as `'\''` |
| Inside `$(...)` or backticks | A fresh unquoted context, even inside `"..."`, so bare rules apply |
| Inside backticks (any depth) | The result escaped once more per enclosing backtick frame (`backtickEscape`) |

Backslash escapes outside single quotes are copied through unchanged. Every form therefore passes the
value literally, e.g. a branch named `x$(rm -rf ~)` stays a string.

`runHook()` in `src/lib/hooks.ts` applies it to each `hooks.<name>` command before running it with
`shell: true`.

# Caveat

Commands that read `hooks` from `loadResolvedConfig()` (the `kunj ct` container hooks, through the
command's shared context) get the repository variables (`repoRoot`, `repoconfig`, `repoName`, `home`)
already expanded by plain substitution before `expandVariablesQuoted()` runs, so those four are not
shell-quoted there; `branch`, `container` and `image` still are. The worktree hooks read
`loadConfig()` and quote everything.

# Related Concepts

* [Configuration](/architecture/configuration.md) - `loadConfig()` vs `loadResolvedConfig()`
* [Hooks](/features/hooks.md)
* [Worktrees](/features/worktrees.md) - `worktree.baseDir`
* [Container Hooks](/containers/container-hooks.md)

# Citations

[1] [src/lib/config-vars.ts](/src/lib/config-vars.ts)
[2] [src/lib/config.ts](/src/lib/config.ts)
[3] [src/lib/hooks.ts](/src/lib/hooks.ts)
[4] [src/lib/worktree.ts](/src/lib/worktree.ts)
[5] [src/lib/worktree-defaults.ts](/src/lib/worktree-defaults.ts)
[6] [src/commands/container.ts](/src/commands/container.ts)
[7] [src/commands/worktree.ts](/src/commands/worktree.ts)
[8] [CLAUDE.md](/CLAUDE.md)
