---
type: Architecture
title: Git Layer
description: How kunj talks to git - the shared helpers in src/lib/git.ts, the worktree-specific helpers, status parsing (porcelain v1 and v2), bare-repository handling and GIT_OPTIONAL_LOCKS.
resource: src/lib/git.ts
tags: [architecture, git, status, porcelain, performance]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

kunj shells out to the `git` binary; there is no libgit binding. The original branch commands share
`src/lib/git.ts`, which runs shell strings through `child_process.exec` wrapped with `promisify`. The
newer, performance-sensitive code (worktrees, events, containers, secrets) keeps its own small git
helpers next to it, often with `execFile` and an argv array, so it can control the environment and
stay on the [fast path](/architecture/fast-path.md).

Functions in `git.ts` either return a structured result (`GitCommandResult = { success, message }`,
arrays, booleans) or swallow errors and return an empty value; few throw.

# src/lib/git.ts

| Area | Functions |
|------|-----------|
| Repository | `getGitRoot()` (cached), `checkGitRepo()`, `executeGitCommand(cmd)` (runs from the git root) |
| Branches | `getCurrentBranch()` (`git branch --show-current`), `getAllBranches(includeRemote)`, `getBranchesWithActivity(sort)` (`git for-each-ref` with `%(refname:short)\|%(committerdate:relative)`), `branchExists()`, `deleteBranch(name, force, remote)`, `createBranchFrom()`, `switchBranch()`, `ensureBranchExists()`, `mergeBranch()`, `createTag()` |
| Remote | `pullBranch()`, `pushBranch(name, setUpstream)` |
| Working tree | `hasUncommittedChanges()`, `getFileStatuses()`, `stageFiles()`, `createCommit()`, `revertFile()`, `deleteFile()`, `getFileStats()` |
| History and diffs | `getRecentCommitMessages(limit)`, `getMainBranch()` (main, master, then `origin/main`/`origin/master`, default `main`), `getCommitsSinceBranch(base)` (via `git merge-base`), `getFileDiff()`, `getFileDiffWithMain()` |

Callers include `create`, `switch`, `list`, `delete`, `stash`, `diff`, `graph`, `flow`, `jira`,
`branch-*` and `src/lib/stash.ts` / `src/lib/git-flow.ts`.

## Bare repositories

`git rev-parse --show-toplevel` fails in a bare repository. `getGitRoot()` then asks
`git rev-parse --is-bare-repository --absolute-git-dir` and uses the git dir itself as the root.
Code that must work in bare repos asks for `--git-common-dir` first (see below).

## Status parsing (porcelain v1)

`getFileStatuses()` parses `git status --porcelain=v1` into `FileStatus { path, status, staged,
oldPath?, additions?, deletions? }`:

* `old -> new` lines become `renamed` (staged when the index column is `R`);
* an untracked directory (`?? dir/`) is expanded with `git ls-files --others --exclude-standard`;
* the index/work-tree columns map `A` -> `new`, `D` -> `deleted`, `M` -> `modified`, `C` -> `copied`,
  `U` -> `unmerged`, `??` -> `new`; `staged` is true when the code is in the index column;
* line counts come from one `git diff --numstat --cached` and one `git diff --numstat`, and for new
  files from `wc -l`.

Commands are built by string interpolation with double quotes around paths and messages; `stageFiles()`
adds files one by one with `git add -- "<path>"` to report the failing ones.

# Worktree Helpers (src/lib/worktree.ts)

| Function | Git call |
|----------|----------|
| `getGitCommonDir(cwd)` | `git rev-parse --path-format=absolute --git-common-dir` |
| `getCurrentWorktreePath(cwd)` | `git rev-parse --show-toplevel` (null on failure) |
| `getMainWorktreePath(cwd)` | common dir -> `repoVariables().repoRoot` |
| `getRepoPaths(cwd)` (internal) | One `rev-parse --git-common-dir --show-toplevel`; keeps stdout even when the toplevel part fails in a bare repo |
| `parseWorktreeList()` | Parses `git worktree list --porcelain` |
| `getWorktreeStatus(path)` | `git status --porcelain=v2 --branch --untracked-files=normal` -> `parseStatusV2()` |

`parseStatusV2()` returns `{ dirty, changedFiles, ahead, behind, upstream }` from one call:
`# branch.upstream`, `# branch.ab +A -B`, and every non-`#` line counted as a changed file.

`src/lib/config.ts` has its own synchronous `gitSync()` (`execSync`) for repository name resolution
([Configuration](/architecture/configuration.md)), and `src/lib/base-branch.ts` resolves the base for new
branches ([Base Branch](/features/base-branch.md)).

# GIT_OPTIONAL_LOCKS

`git status` refreshes stale stat information in `.git/index`. `kunj events` watches the git common dir
and treats `index` as a trigger, so that write would cause an event, a refresh, another listing and
another write. Read-only status calls therefore run with `GIT_OPTIONAL_LOCKS=0`:

| Where | Call |
|-------|------|
| `getWorktreeStatus()` in `src/lib/worktree.ts` | the per-worktree status of every listing |
| The status poll in `src/lib/events.ts` | `git worktree list --porcelain` and `git status --porcelain=v2 --branch` (via `execFile`) |
| `src/lib/secrets/deliver.ts` | `git check-ignore -q` before rendering a secret file |

The workspace app follows the same rule for the git commands it runs itself.

# Related Concepts

* [Fast Path](/architecture/fast-path.md) - subprocess budget of a listing
* [Worktrees](/features/worktrees.md)
* [Events Stream](/features/events-stream.md)
* [Branch Commands](/features/branch-commands.md)
* [Config Variables](/architecture/config-variables.md) - `repoVariables()`

# Citations

[1] [src/lib/git.ts](/src/lib/git.ts)
[2] [src/lib/worktree.ts](/src/lib/worktree.ts)
[3] [src/lib/events.ts](/src/lib/events.ts)
[4] [src/lib/secrets/deliver.ts](/src/lib/secrets/deliver.ts)
[5] [src/lib/config.ts](/src/lib/config.ts)
[6] [src/types/index.ts](/src/types/index.ts)
[7] [CLAUDE.md](/CLAUDE.md)
