---
type: Architecture
title: Fast Path
description: The startup shortcut that loads only the requested command for frequently invoked commands, and the performance rules that keep those commands cheap.
resource: src/commands/fast.ts
tags: [architecture, performance, startup, lazy-imports]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`getAllCommands()` imports every command module and, through them, the AWS SDK, LangChain, Jira,
Slack and inquirer. That costs close to a second of startup. Editors, shell prompts and the desktop
apps call some commands many times a minute (`kunj worktree list --json`, `kunj prompt-info`,
`kunj events`), so `src/commands/fast.ts` maps those command names to a loader that imports only that
one module.

`src/index.ts` calls `loadFastCommand(process.argv[2])`. When it returns a command, the registry holds
only that command; otherwise (including plain `kunj --help`) it falls back to `getAllCommands()`, which
`src/index.ts` itself imports lazily.

# FAST_COMMANDS

| First argument | Loads |
|----------------|-------|
| `container`, `ct` | `./container` -> `ContainerCommand` |
| `agent` | `./agent` -> `AgentCommand` |
| `worktree` | `./worktree` -> `WorktreeCommand` |
| `repos` | `./repos` -> `ReposCommand` |
| `events` | `./events` -> `EventsCommand` |
| `secret` | `./secret` -> `SecretCommand` |
| `run` | `./run` -> `RunCommand` |
| `prompt-info` | `./prompt-info` -> `PromptInfoCommand` |

`isFastCommand(name)` checks membership with `hasOwnProperty` (tests assert `secret` and `run` are in
it). Only the first CLI argument is matched, so `kunj --json worktree list` takes the slow path.

# Version Before Everything

`kunj -V` / `kunj --version` (as the only argument) is answered in `main()` before any command is
loaded, by `getVersion()` in `src/lib/version.ts`, which `require`s `package.json` at runtime (see
[Release Process](/architecture/release-process.md) for why it is never inlined).

# Rules for Fast-Path Modules

* **No heavy top-level imports.** No AWS, LangChain, Jira or Slack modules. `inquirer` is imported
  inside the function that prompts (`src/commands/worktree.ts` does `await import('inquirer')`; it costs
  about 0.2 s). The container module is imported lazily from `worktree list --containers`.
* **Type-only imports from the contract.** `src/lib/json-types.ts` has no runtime code, so fast-path
  commands import it freely.
* **Bounded subprocesses.** A worktree listing (`listWorktreesDetailed()` in `src/lib/worktree.ts`)
  makes one `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`, one
  `git worktree list --porcelain`, one `git status --porcelain=v2 --branch` per worktree and, with
  status, one `tmux list-sessions` call for all worktrees, all started in one `Promise.all`. The PR
  lookup is one `gh`/`glab` call, cached ([PR Lookup Cache](/features/pr-lookup-cache.md)).
* **Derive, do not ask again.** Repo variables come from a common dir already in hand
  (`repoVariables()`, [Config Variables](/architecture/config-variables.md)); repo identity for agent
  session names is read from `<commonDir>/config` by `readOriginUrl()` without a git call
  ([Repo Identity](/architecture/repo-identity-and-registry.md)).
* **Hooks cost nothing when absent.** `src/lib/hooks.ts` avoids heavy imports and git subprocesses;
  worktree hooks get their variables passed in ([Hooks](/features/hooks.md)).
* **Registry writes are rare.** `recordRepo()` only reads `~/.kunj/repos.json` unless the entry is new
  or older than an hour.
* **Settings are cheap.** `src/lib/config.ts` imports `src/constants`, which initializes the
  [settings registry](/architecture/settings-registry.md); the settings modules import only small
  constant modules such as `src/lib/worktree-defaults.ts` and `src/lib/hook-defs.ts`.

# Related Concepts

* [Command System](/architecture/command-system.md)
* [Worktrees](/features/worktrees.md)
* [Events Stream](/features/events-stream.md)
* [Containers Overview](/containers/overview.md)

# Citations

[1] [src/commands/fast.ts](/src/commands/fast.ts)
[2] [src/index.ts](/src/index.ts)
[3] [src/lib/version.ts](/src/lib/version.ts)
[4] [src/lib/worktree.ts](/src/lib/worktree.ts)
[5] [src/commands/worktree.ts](/src/commands/worktree.ts)
[6] [src/lib/repos.ts](/src/lib/repos.ts)
[7] [src/lib/json-types.ts](/src/lib/json-types.ts)
[8] [src/constants/index.ts](/src/constants/index.ts)
[9] [CLAUDE.md](/CLAUDE.md)
