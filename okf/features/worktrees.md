---
type: Feature
title: Worktrees
description: The kunj worktree command, which wraps git worktree to list, create, remove, prune and open worktrees with status, pull requests, editor sessions and agents in one listing.
resource: src/lib/worktree.ts
tags: [feature, worktree, git, listing, editor]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj worktree` (`WorktreeCommand` in `src/commands/worktree.ts`) wraps `git worktree` and adds what an
editor or app needs to show a repository's checkouts at a glance: git status, the branch's pull request,
which editor windows have it open ([editor sessions](/features/editor-sessions.md)) and whether a
[worktree agent](/features/worktree-agents.md) runs in it. The library is `src/lib/worktree.ts`.

Every action supports `--json`. The VS Code extension, the macOS menu bar app and the workspace app all
drive it (`kunj worktree list --json` is the main read), so its output is part of the
[JSON contract](/architecture/json-contract.md) (`WorktreeListJson`, `WorktreeJson`). The command is on the
[fast path](/architecture/fast-path.md) (`worktree` in `FAST_COMMANDS`), so it loads without the AWS,
LangChain or Jira modules; `inquirer` and the container module are imported lazily.

# Actions

| Action | What it does |
|--------|--------------|
| `list` (default) | Listing (below); `--no-status`, `--no-pr`, `--fresh`, `--containers` |
| `add <branch> [path]` | `git worktree add`; `-b` new branch, `-c` create only if missing, `--base <ref>`, `--no-origin`, `-p`, `-f`, `--no-hooks` |
| `remove <branch\|path>` | `git worktree remove`; refuses the main worktree, the current one and one open in an editor unless `--force` |
| `prune` | `git worktree prune -v` |
| `open [target]` | Opens the worktree in `worktree.editorCommand` (`-n` new window) |
| `path [target]` | Prints the worktree path |
| `pr [target]` | Shows the branch's pull request (`-w` opens it in the browser); see [PR lookup cache](/features/pr-lookup-cache.md) |
| `session start\|heartbeat\|end\|stop\|list` | [Editor sessions](/features/editor-sessions.md) |
| `keep [add\|apply\|delete\|list]` | [Keep files](/features/keep-files.md) |
| `shell [branch] [--session <id>] [--kill]` | [Persistent shells](/features/persistent-shells.md) |

A target is resolved by `findWorktreeIn()`: branch or worktree name first, then a path. Without a target,
`open`, `path` and `pr` use the main worktree.

# Listing

`listWorktreesDetailed()` runs its independent work in one `Promise.all`:

```
git worktree list --porcelain        -> parseWorktreeList()
git rev-parse --path-format=absolute --git-common-dir --show-toplevel   -> getRepoPaths()
fetchPullRequestsCached()            (only with PRs)
listTmuxSessions()                   (only with status: one tmux call for the whole listing)
```

then, per existing non-bare worktree, one `git status --porcelain=v2 --branch --untracked-files=normal`
(`getWorktreeStatus()`, parsed by `parseStatusV2()` into `dirty`, `changedFiles`, `ahead`, `behind`,
`upstream`). That status call runs with `GIT_OPTIONAL_LOCKS=0`, so git does not rewrite a stale index,
which [`kunj events`](/features/events-stream.md) would report as a change. Do not add per-worktree
subprocesses here: the listing is called many times a minute by the apps.

`--show-toplevel` fatals in a bare repository, but git prints the common dir first, so `getRepoPaths()`
keeps stdout from the failed call and treats a missing toplevel as standing in the bare entry. The
agent session name needs the repo name and id; `repoIdentity({ commonDir, repoRoot })` reads them from
`<commonDir>/config` without a git call. `list` also calls `recordRepo()` so the repository reaches
`kunj repos` ([repo registry](/architecture/repo-identity-and-registry.md)).

Each `WorktreeInfo` carries `path`, `name` (branch, or `detached@<sha7>`), `head`, `branch`, `detached`,
`bare`, `locked`/`lockedReason`, `prunable`/`prunableReason`, `isMain` (first porcelain block),
`exists`, `status?`, `pullRequest?`, `sessions`, `isCurrent` and `agent?`. The JSON adds `openCount`,
`changedFiles` and `prLabel` (`#<n> <state>`).

`--containers` adds `containers: { available, message?, items }`: `ContainerCommand.listJson()` imported
lazily and raced against a 10 s timeout (`CONTAINER_LIST_TIMEOUT_MS`, which calls `abortDockerCalls()`),
each item given its branch's `pullRequest` from the same PR lookup. Docker being down yields
`available: false`, never a failed listing.

# Creating and removing

`add` loads the raw config, makes one listing (for existing worktrees and `repoVariables()` of the
common dir) and picks the path: the explicit path, else `defaultWorktreePathFor(branch,
worktree.baseDir, commonDir)`. It refuses a branch that already has a worktree (unless `-b`). A new branch
(`-b`, or `-c` when `branchExists()` finds no `refs/heads/<b>` or `refs/remotes/*/<b>`) gets its base from
`resolveBaseRef()` ([base branch](/features/base-branch.md)) and is created with `--no-track`.

`addWorktree()` then runs `git worktree add`, applies [keep files](/features/keep-files.md), then the
branch's host secret files (`hostSecrets()` from `src/lib/secrets/host.ts`, lazily imported; failures are
warnings), so a rendered `.env` replaces a kept one. `pre-worktree-create` runs before (a failure aborts),
`post-worktree-create` after, inside the new worktree ([hooks](/features/hooks.md)). In `--json` mode
progress goes to stderr so stdout stays one document.

`remove` runs `pre-worktree-delete` inside the worktree, `git worktree remove`, `unregisterSession({ path
})`, then `post-worktree-delete` from the main worktree.

# Default location

`DEFAULT_WORKTREE_BASE_DIR` (`src/lib/worktree-defaults.ts`, its own module so the settings registry can
import it without the git helpers) is `${repoconfig}/kunj/worktrees`: inside `.git` for a normal repo,
inside the repository for a bare one. `defaultWorktreePathFor()` expands
[config variables](/architecture/config-variables.md) plus `${branch}` (= `branchToDirName(branch)`,
`feature/x` -> `feature-x`), expands a leading `~`, resolves relative paths from the repo root, and
appends the branch directory unless the template names `${branch}`.

# Opening an editor

`buildOpenCommand(command, target, { newWindow, existing })` splits `worktree.editorCommand`. For
VS Code-like binaries (`code`, `code-insiders`, `codium`, `vscodium`, `cursor`, `windsurf`; `isVSCodeLike()`)
without a window flag already, it adds `-n` for a new window, else `-r` unless `existing`. `open` passes
`existing: true`, so the editor may focus a window it already has. An empty command returns null and
`open` just prints the path. `openWorktree()` spawns detached and unrefs. `kunj ct open` reuses
`buildOpenCommand` ([editor open](/containers/editor-open.md)).

# Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `worktree.baseDir` | `${repoconfig}/kunj/worktrees` | Where new worktrees go |
| `worktree.editorCommand` | `code` | Editor for `worktree open` (empty disables) |

# Related Concepts

* [Editor sessions](/features/editor-sessions.md), [Keep files](/features/keep-files.md), [PR lookup cache](/features/pr-lookup-cache.md)
* [Worktree agents](/features/worktree-agents.md), [Persistent shells](/features/persistent-shells.md)
* [Fast path](/architecture/fast-path.md), [JSON contract](/architecture/json-contract.md), [Hooks](/features/hooks.md)
* [VS Code extension](/apps/vscode-extension.md), [macOS app](/apps/macos-app.md), [Workspace app](/apps/workspace-app.md)

# Citations

[1] [src/commands/worktree.ts](/src/commands/worktree.ts)
[2] [src/lib/worktree.ts](/src/lib/worktree.ts)
[3] [src/lib/worktree-defaults.ts](/src/lib/worktree-defaults.ts)
[4] [src/settings/worktree.ts](/src/settings/worktree.ts)
[5] [src/lib/repo-identity.ts](/src/lib/repo-identity.ts)
[6] [src/lib/json-types.ts](/src/lib/json-types.ts)
[7] [src/commands/fast.ts](/src/commands/fast.ts)
[8] [CLAUDE.md](/CLAUDE.md)
