---
type: Feature
title: Search
description: kunj search greps every worktree of a repository (uncommitted work included) and, on request, branches without a worktree, running branch containers, commit messages and work logs, with a JSON shape for the apps.
resource: src/lib/search.ts
tags: [feature, search, worktrees, containers, json]
timestamp: 2026-10-27T00:00:00Z
---

# Overview

`kunj search <pattern> [paths...]` (src/commands/search.ts) answers "where is this, in any of my
checkouts?". The default scope is every [worktree](/features/worktrees.md) of the repository; `--in`
adds `branches`, `containers`, `commits` and `logs`, `--all` all of them. Spec: docs/specs/search.md.

# Engine

Everything that searches files is `git grep -n --column -z -I` (src/lib/search.ts):

* **worktrees**: one `git grep --untracked` per worktree (`mapLimit`, 6 at a time), so untracked
  files are found and ignored ones are not. The listing comes from `listWorktreesDetailed({ includeStatus: false })`.
* **branches**: `branchRefs()` turns `git for-each-ref` into local branches without a worktree (and,
  with `--origin`, origin-only ones); one `git grep` over all their refs, records split by the
  `<ref>:` prefix (`parseGrepOutput`).
* **containers**: `ContainerCommand.searchJson()` lists the repository's main containers, skips
  stopped ones and `<branch>:snapshot` builds, and runs `grepContainer()` through
  `ContainerBackend.exec` as the sandbox user in `/workspace` (see [Backend](/containers/backend.md)).
  The output is cut by `head` in the container; git's exit status comes back on fd 3 as
  `kunj-grep-exit=<n>`.
* **commits**: one `git log --grep` (`commitLogArgs`, `parseCommitLog`); `-w` is filtered afterwards.
* **logs**: the [work log](/features/work-log.md) files read in Node (`searchWorkLogs`).

On the host the `git grep` child is killed once `--max-count` (default 200) matches are read.
`searchRegExp()` turns the query into a JavaScript RegExp to recompute the match's column in
characters and its length (for highlighting); patterns it cannot read keep git's column.

# JSON

`SearchJson` in src/lib/json-types.ts ([JSON Contract](/architecture/json-contract.md)): the query,
`searched` counts, `sources` (only those that matched or failed: `kind`, `branch`, `path`/`ref`/`container`,
`matches`, `truncated`, `error`), and `containers`, `commits` and `logs` when their scope was asked.

# Performance

On the [fast path](/architecture/fast-path.md); the container module is imported only for the
containers scope, and Docker being down gives `containers.available: false`.
