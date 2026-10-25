---
type: Feature
title: Keep Files
description: Files deliberately left out of git (such as .env) stored per repository under ~/.kunj/<repo>/keep/ and copied into every new worktree.
resource: src/lib/keep.ts
tags: [feature, worktree, keep, dotenv]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A fresh `git worktree add` lacks the untracked local files a checkout needs to run (`.env`, local
config, certificates). Keep files solve that: the user saves a copy once, and kunj restores it into every
worktree it creates. The store is per repository, `~/.kunj/<repo>/keep/` (`getKeepDir()` =
`getKunjDir()` + `KEEP_DIR`), so all worktrees of a repository share it
([configuration](/architecture/configuration.md)).

Entries are stored under their path relative to the worktree root, with `/` separators: keeping
`config/local.json` writes `~/.kunj/<repo>/keep/config/local.json`. The library is `src/lib/keep.ts`; the
command is `kunj worktree keep` in `src/commands/worktree.ts`.

For secrets, the [secrets vault](/secrets/overview.md) is the newer route: `addWorktree()` renders the
branch's host secret files after keep files, so a rendered `.env` replaces a kept one, and
`kunj secret list` / `kunj setup` suggest importing a kept `.env` into the vault.

# Commands

| Command | Behaviour |
|---------|-----------|
| `kunj worktree keep` | Interactive menu (inquirer, loaded lazily): add, apply here, apply to all, delete (checkbox + confirm), show. With `--json` it lists instead |
| `kunj worktree keep add <file>` | Copies the file or directory into the store; `--json`: `{ kept, keepDir }` |
| `kunj worktree keep <file>` | Any unknown sub-action is treated as a file to add |
| `kunj worktree keep apply [-a]` | Copies every kept file into the current worktree, or with `-a` into every worktree (missing directories skipped); `--json`: `{ applied: { <worktree>: [files] } }` |
| `kunj worktree keep delete\|remove <file>` | Removes the entry; accepts a path on disk or a stored relative path; `--json`: `{ deleted }` |
| `kunj worktree keep list` | `--json`: `{ keepDir, files }` |

Relative paths are taken against the current worktree root (`git rev-parse --show-toplevel`, else the
working directory).

# Functions

| Function | Behaviour |
|----------|-----------|
| `toRelativeKeepPath(file, root, cwd)` | Resolves the path and throws `File must be inside the worktree` when it leaves the root |
| `keepFile(relative, root)` | Throws when the source is missing; replaces any existing entry (`rmSync` then `cpSync` recursive) |
| `listKeptFiles()` | Walks the store and returns sorted relative file paths (a kept directory shows as its files) |
| `applyKeptFiles(root)` | Copies every file into the worktree, creating directories and overwriting existing files; returns the list |
| `deleteKeptFile(relative)` | Removes the entry, then prunes empty parent directories up to the store root; false when absent |
| `hasKeptFile(relative)` | Whether the entry exists |

# When they are applied

* `addWorktree()` calls `applyKeptFiles()` right after `git worktree add`; a failure is swallowed, so keep
  files never fail worktree creation. The applied list comes back as `keptFiles` in the `worktree add
  --json` output, and `post-worktree-create` runs after them.
* `kunj worktree keep apply [-a]` re-applies on demand.

* Branch containers: when `container.keepFiles` is not false (default true), `src/lib/container/lifecycle.ts`
  streams every kept file into `/workspace` of a new container as a tar (copied, not bind-mounted,
  file mode kept) ([lifecycle](/containers/lifecycle.md)). Snapshots force `keepFiles: false`, so no kept
  file ends up in an image ([snapshots](/containers/snapshots.md)).

# Related Concepts

* [Worktrees](/features/worktrees.md) - `addWorktree()` applies keep files
* [Secrets resolution and delivery](/secrets/resolution-and-delivery.md) - file deliveries rendered after keep files
* [Configuration](/architecture/configuration.md) - `getKunjDir()`

# Citations

[1] [src/lib/keep.ts](/src/lib/keep.ts)
[2] [src/commands/worktree.ts](/src/commands/worktree.ts)
[3] [src/lib/worktree.ts](/src/lib/worktree.ts)
[4] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[5] [src/lib/container/snapshot.ts](/src/lib/container/snapshot.ts)
[6] [src/settings/container.ts](/src/settings/container.ts)
[7] [src/commands/secret.ts](/src/commands/secret.ts), [src/commands/setup.ts](/src/commands/setup.ts)
[8] [CLAUDE.md](/CLAUDE.md)
