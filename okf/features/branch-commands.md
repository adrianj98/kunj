---
type: Feature
title: Branch Commands
description: The everyday branch commands - create, switch, delete, list, stash, diff and graph - and the auto-stash that carries uncommitted work between branches.
resource: src/commands
tags: [feature, branches, stash, git]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

These are the original kunj commands: thin, opinionated wrappers over `git switch`, `git branch`,
`git stash`, `git diff` and `git log` that also keep per-branch metadata up to date
([Branch Metadata](/features/branch-metadata.md)). Each is a `BaseCommand` subclass in
`src/commands/` registered through `getAllCommands()` ([Command System](/architecture/command-system.md));
none of them is on the [fast path](/architecture/fast-path.md).

All of them check `checkGitRepo()` first and exit 1 outside a repository. Git calls go through
`executeGitCommand()` and friends in `src/lib/git.ts` ([Git Layer](/architecture/git-layer.md)).

# Commands

| Command | Main options | What it does |
|---------|--------------|--------------|
| `kunj create <branch>` | `--no-stash`, `-d/--desc`, `-t/--tag`, `--base`, `--no-origin`, `--no-hooks` | Resolves the base ([Base Branch](/features/base-branch.md)), auto-stashes, runs `git switch --no-track -c <branch> <base>`, records `lastSwitched`/description/tags, links a Jira key found in the name when `jira.enabled`. `--json` prints `{ success, branch, previousBranch, base, description, tags }`. |
| `kunj switch [branch]` | `--no-stash`, `-a/--all`, `-w/--wip`, `--configured`, `-c/--create`, `-d`, `-t`, `--base`, `--no-origin`, `--no-hooks` | Without a branch: an inquirer list of branches (sorted by `preferences.branchSort`, filtered, showing alias, description, `#tags` and stash details). With one: auto-stash, `git switch`, pop that branch's kunj stash. `-c` creates a missing branch (prompting for a name if none given). |
| `kunj delete <branch>` | `-f/--force`, `--no-hooks` | Refuses the current branch; `git branch -d` (or `-D`). Explains "not fully merged" failures. |
| `kunj list` | `-a`, `-w`, `-c/--configured`, `-v/--verbose` | Branches with last activity, alias, description, tags, notes (`-v`) and stash counts. `--json` gives `{ branches: [{ name, current, lastActivity, alias, description, tags, notes, jiraIssueKey, jiraIssueStatus, jiraIssueTitle, stashCount, stashes }] }`. |
| `kunj stash [action]` | `-l/--list`, `-p/--pop`, `-a/--apply <index>`, `-d/--drop <index>`, `-m/--message`, `-u/--include-untracked`, `--no-hooks` | Default: list changed files, generate a message with `generateStashMessage()` ([AI Commit](/features/ai-commit.md)) unless `-m`, confirm, `git stash push`. `--list` is interactive (pop, apply, show, drop). |
| `kunj diff` | `-f/--file`, `-s/--side-by-side`, `--summary`, `--staged` | Interactive file picker and coloured diff via `formatDiff`/`formatSideBySideDiff`/`formatDiffSummary` (`src/lib/diff-formatter.ts`). `--json`: `{ files: [{ path, status, staged, additions, deletions }], summary }`. |
| `kunj graph` | `-a/--all`, `-n/--limit` (20), `-o/--oneline`, `-u/--unicode`, `--style`, `--author`, `--since`, `--until` | `git log --graph --color=always` run from the git root, with a colour scheme per style. |

# Filtering (switch and list)

Unless `--all` is passed, two filters apply:

* **Configured** (`--configured` or `preferences.showOnlyConfigured`): only branches that have an entry in `branches.json`.
* **WIP** (`--wip` or `preferences.showOnlyWIP`): `isBranchWIP()` in `src/lib/utils.ts`. With `preferences.personalWIPMode` (default) a branch is WIP when it is current, was switched to within `preferences.recentDays`, or has a kunj stash younger than `preferences.stashAgeDays`. Otherwise it is tag based, using `preferences.wipTags` / `preferences.doneTags` (a branch with no tags counts as WIP).

# Auto-stash

`src/lib/stash.ts` gives each branch its own stash so switching never loses or leaks work:

```
create/switch ──> createStash(current)            switch ──> popStashForBranch(target)
                  git stash push --include-untracked          find message in `git stash list`
                  -m "kunj-auto-stash-<branch>-<ms>"          git stash pop stash@{n}
                  record BranchStash in branches.json         drop the record (also on conflict)
```

* Runs when `preferences.autoStash` (default true) is on and `--no-stash` is not given.
* `createStash()` records `{ ref, message, timestamp, files, additions, deletions }` (from `git diff --stat`) at the front of the branch's `stashes` array.
* It runs the `pre-stash`/`post-stash` hooks ([Hooks](/features/hooks.md)); a failing `pre-stash` rethrows `HookError` so the command stops instead of carrying changes to another branch. Other errors make it return false.
* `popStashForBranch()` looks up the newest record by message; a record whose stash no longer exists is dropped.
* `getAllStashesWithBranch()` builds the "Auto-stashed 2 hours ago (3 files, +10, -2)" text shown by switch and list.

The base is resolved before stashing, so a missing base branch leaves the working tree untouched.

# Settings

| Key | Default | Used by |
|-----|---------|---------|
| `preferences.autoStash` | `true` | create, switch |
| `preferences.branchSort` | `recent` (`recent`/`alphabetical`) | switch, list |
| `preferences.pageSize` | `15` | switch menu |
| `preferences.showStashDetails` | `true` | stash display |
| `preferences.stashAgeDays` | `30` | WIP detection |
| `preferences.showOnlyWIP` / `showOnlyConfigured` | `false` | filters |
| `preferences.personalWIPMode` | `true` | WIP detection |
| `preferences.recentDays` | `7` | WIP detection |
| `preferences.wipTags` / `doneTags` | `wip, in-progress, working, draft` / `done, completed, merged, ready` | tag-based WIP |
| `preferences.graphUnicode` / `graphStyle` | `false` / `default` | graph |

Branch aliases come from the top-level `aliases` map in the config, which is not part of the settings
registry (`defaultConfig` in `src/constants/index.ts`).

# Related Concepts

* [Base Branch](/features/base-branch.md) - where create and switch -c start from
* [Branch Metadata](/features/branch-metadata.md) - `branches.json`, which these commands write
* [Hooks](/features/hooks.md) - branch, stash hooks and `--no-hooks`
* [Worktrees](/features/worktrees.md) - the worktree alternative to switching
* [Settings Registry](/architecture/settings-registry.md)

# Citations

[1] [src/commands/create.ts](/src/commands/create.ts)
[2] [src/commands/switch.ts](/src/commands/switch.ts)
[3] [src/commands/delete.ts](/src/commands/delete.ts)
[4] [src/commands/list.ts](/src/commands/list.ts)
[5] [src/commands/stash.ts](/src/commands/stash.ts)
[6] [src/commands/diff.ts](/src/commands/diff.ts)
[7] [src/commands/graph.ts](/src/commands/graph.ts)
[8] [src/lib/stash.ts](/src/lib/stash.ts)
[9] [src/lib/utils.ts](/src/lib/utils.ts)
[10] [src/lib/diff-formatter.ts](/src/lib/diff-formatter.ts)
[11] [src/settings/core.ts](/src/settings/core.ts), [src/settings/stash.ts](/src/settings/stash.ts), [src/settings/branch-filtering.ts](/src/settings/branch-filtering.ts)
