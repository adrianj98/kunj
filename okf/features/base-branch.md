---
type: Feature
title: Base Branch Resolution
description: How kunj picks the start point for a new branch - --base, preferences.defaultBaseBranch or the repo default, fetched from origin unless turned off, never tracked.
resource: src/lib/base-branch.ts
tags: [feature, branches, git, origin]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj create`, `kunj switch -c` and `kunj worktree add -b/-c` all start a new branch from the same
place, worked out by `resolveBaseRef()` in `src/lib/base-branch.ts`. The goal is that a new branch
starts from the latest remote commit of the right base, not from whatever happens to be checked out
or from a stale local `main`.

The module imports only `child_process` and `util`, because `kunj worktree add` uses it on the
[fast path](/architecture/fast-path.md). Its git calls swallow errors (`git()` returns null).

# Resolution order

```
requested = --base  ||  preferences.defaultBaseBranch  ||  detectDefaultBranch()
              |                                             origin/HEAD, else main, else master
              v                                             (local or on origin)
   null? ──> return null  (git's default: branch from HEAD)
              |
   "origin/x" with an origin remote ──> branch "x", origin forced
   not a branch locally or on origin, but a valid commit (tag, sha, HEAD~2) ──> used as given
              |
   fromOrigin (preferences.baseFromOrigin, not --no-origin) and origin exists:
       git fetch --quiet origin <branch>
         fetched and refs/remotes/origin/<branch> exists ──> origin/<branch>
         fetch failed but the remote ref exists       ──> origin/<branch> + warning (offline)
         otherwise                                     ──> warning, fall through
              |
   local <branch> exists ──> <branch> (+ warning if origin was wanted)
   else throw Error("Base branch '<x>' not found [locally or on origin]"), name BaseBranchError
```

`BaseBranchError` is printed by `BaseCommand` without a stack trace
([Command System](/architecture/command-system.md)).

# API

| Export | Purpose |
|--------|---------|
| `resolveBaseRef(options)` | Returns `ResolvedBase` `{ ref, branch, fromOrigin, warning? }` or null. `options`: `base`, `defaultBase`, `fromOrigin`, `cwd`. |
| `detectDefaultBranch(cwd?)` | `symbolic-ref refs/remotes/origin/HEAD`, else `main`/`master` as a local or remote ref. Also used by `kunj ct` for container bases and blueprint lookups. |
| `describeBase(base)` | `" from origin/main"` for log lines, empty for null. |

# Callers

| Caller | How it creates the branch |
|--------|---------------------------|
| `CreateCommand` (`src/commands/create.ts`) | `git switch --no-track -c <branch> <ref>` (plain `git switch -c` when the base is null) |
| `SwitchCommand.createAndSwitchToBranch()` | same as create |
| `kunj worktree add` (`src/commands/worktree.ts`) | passes `base.ref` to `addWorktree()` only when a branch is being created; prints `Branching from <ref>` |
| `kunj container` (`src/commands/container.ts`) | uses `detectDefaultBranch()` only |

Every caller resolves the base before doing anything else (stashing, pre-creating a worktree), so a
missing base leaves the working tree untouched. The `--no-track` flag means the new branch never takes
the base as its upstream; the first push sets one with `-u` as usual (`kunj commit` and `kunj pr`
both push with `-u` when there is no upstream).

# Settings and flags

| Setting / flag | Default | Effect |
|----------------|---------|--------|
| `preferences.defaultBaseBranch` | `''` | Base for new branches; also the target of `kunj pr` when set |
| `preferences.baseFromOrigin` | `true` | Fetch and branch from `origin/<base>` |
| `--base <ref>` | - | Overrides the setting for one command |
| `--no-origin` | - | Uses the local branch for one command |

Note that `kunj pr` does not call `resolveBaseRef()`: it uses `--base`, else `defaultBaseBranch`, else
an interactive pick among `main`, `master`, `develop`, `development`, `dev` ([AI Pull Requests](/features/ai-pr.md)).

# Related Concepts

* [Branch Commands](/features/branch-commands.md)
* [Worktrees](/features/worktrees.md)
* [Git Layer](/architecture/git-layer.md)
* [Settings Registry](/architecture/settings-registry.md)

# Citations

[1] [src/lib/base-branch.ts](/src/lib/base-branch.ts)
[2] [src/commands/create.ts](/src/commands/create.ts)
[3] [src/commands/switch.ts](/src/commands/switch.ts)
[4] [src/commands/worktree.ts](/src/commands/worktree.ts)
[5] [src/commands/container.ts](/src/commands/container.ts)
[6] [src/settings/core.ts](/src/settings/core.ts)
[7] [CLAUDE.md](/CLAUDE.md)
