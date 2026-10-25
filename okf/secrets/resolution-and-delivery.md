---
type: Secrets
title: Secret Resolution and Delivery
description: How the secrets for a branch and target are resolved, and how they reach host commands, worktree files and branch containers.
resource: src/lib/secrets/resolve.ts
tags: [secrets, delivery, containers, worktrees]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`resolve.ts` decides which secrets apply; `deliver.ts` renders file deliveries and writes them into a host
worktree; `host.ts` and `src/lib/container/lifecycle.ts` hand env values to host processes and containers.
A value only ever goes into a child's environment, a `docker run` env file or a git-ignored (or
`.git/info/exclude`d) file: never argv, `docker exec -e`, a label, `--json` or a snapshot image.

# Resolution

`resolveSecrets(global, repo, branch, target)`:

1. Global entries, with `delivery` reduced to `{ env }` (globals are env only).
2. Repo entries without `scope.branch` override by name.
3. When `branch` is given, repo entries with `scope.branch === branch` override by name.
4. Keep only entries whose `targets` include `target` (`host` or `container`), sorted by name.

`envOf(entries)` maps entries with `delivery.env` to `{ NAME: value }`. `loadSecrets({ branch, target, ... })`
is `openVaults()` + `resolveSecrets()` (outside a repository `getKunjDir()` is `./.kunj`; when that makes the repo
file the global one, `openVaults()` reads it once, as global, and `kunj secret` refuses repo and branch scope); `openVaults()` unlocks nothing when no vault file exists (see
[Key Providers](/secrets/key-providers.md)).

# Rendering files

`renderFiles(entries)` groups entries with `delivery.file` by file and returns `Map<relPath, content>`; each
line is `NAME="value"\n`, sorted by name, with `\\`, `"` and newline escaped so `parseDotenv` reads it back
(a raw CR does not survive). Several secrets may share one file.

# Host worktree files

`writeHostFiles(worktreeRoot, files, { force })` checks every path before writing any:

| Check | Result |
|-------|--------|
| Absolute, empty, `..` escape | Error, always |
| A `.git` path component | Error, always (even with `--force`) |
| A symlinked directory leading outside the worktree (`realInside`) | Error, always |
| `git check-ignore -q` says not ignored (tracked files count as not ignored) | `not-ignored` unless `force` |

Then each file is written as `<file>.kunj-tmp-<pid>` (mode 0600, `wx`) and renamed, so a symlink at the path
is replaced, not written through. Returns the relative paths written.

| Caller | When | Failure |
|--------|------|---------|
| `addWorktree()` (`src/lib/worktree.ts`) via `hostSecrets` | `kunj worktree add`, after keep files (a rendered `.env` replaces a kept one) | Warning in `secretWarnings`; `secretFiles` listed in `worktree add --json` |
| `kunj secret apply [-a] [--force]` | On demand, one or every worktree | Error |
| `hostSecrets` (`kunj run`, tmux-less agent/shell) | Before the command | Warning on stderr; command still runs |

See [Worktrees](/features/worktrees.md) and [Keep Files](/features/keep-files.md).

# Host environment

`hostSecrets({ branch, root, unlock, warn })` (`src/lib/secrets/host.ts`) loads `target: 'host'`, renders
files into `root` if given, and returns `{ env, files }`. Unlock errors are thrown; file errors go to `warn`.
Used by [kunj run](/secrets/kunj-run.md), `hostSecretEnv()` in `src/lib/agent-session.ts` (the no-tmux paths
of [kunj agent](/features/worktree-agents.md) and [kunj worktree shell](/features/persistent-shells.md)) and
`addWorktree()`. The tmux paths run their command under `kunj run` via `hostRunArgv()`.

# Containers

`ContainerCommand.containerSecrets(branch)` (`src/commands/container.ts`) runs on every `startOrResume`
(`kunj ct start`, and `kunj ct open` only when it resumes): `loadSecrets({ branch, target: 'container' })`,
then `{ env: envOf(...), files: renderFiles(...), stamp: vaultStamp([global, repo]) }`, then `checkSecrets()`.
This happens before the `pre-container-create` hook, the snapshot and anything created, so a locked vault,
a multi-line env value or a bad path fails the start early. `kunj ct agent` loads none.

In `startContainer` (`lifecycle.ts`), as `StartOptions.secrets`:

| Piece | Behaviour |
|-------|-----------|
| `checkedSecrets()` | Ignored for a snapshot build (`namesFor` set): snapshots get no secrets |
| `env` | Merged last into the host env (`{ ...forwardedEnv(...), ...secrets.env }`): a stored secret wins over `container.env`, and a stored token means `gh auth token` is not asked. Goes only into the `docker run` env file |
| `checkSecrets()` | Env value with CR/LF: `StartError` (env file is line based; deliver as a file). Each file path through `secretFilePath()` |
| `secretFilePath()` | `ContainerError` `bad-path` for control characters, outside `/workspace`, or a `.git` component |
| `renderSecretFiles()` | Adds `/<path>` (gitignore-escaped) to `.git/info/exclude`, then extracts a tar stream into `/workspace` as the sandbox user, mode 0600. Run on create and on every resume |
| `stamp` | Recorded as label `kunj.secrets` (`LABEL.secrets` in `names.ts`) on create |

`docker start` keeps the env of `docker run`, so a changed env secret reaches a container only on
`kunj ct start --rebuild`. On resume, when the branch has container env secrets and the label differs from
the stamp, `secretsRebuildHint()` is printed. `kunj ct list --json` sets `secretsChanged` (this repository's
containers only) by comparing the label (absent = `''`) with `vaultStamp`, without unlocking.

# Related Concepts

* [Secret Manager](/secrets/overview.md)
* [Vault](/secrets/vault.md) - `vaultStamp`
* [kunj run](/secrets/kunj-run.md)
* [Container Lifecycle](/containers/lifecycle.md)
* [Container Tokens](/containers/tokens.md)
* [Env and Status](/containers/env-and-status.md) - `ct list --json`
* [Snapshots](/containers/snapshots.md) - built without secrets

# Citations

[1] [src/lib/secrets/resolve.ts](/src/lib/secrets/resolve.ts)
[2] [src/lib/secrets/deliver.ts](/src/lib/secrets/deliver.ts)
[3] [src/lib/secrets/host.ts](/src/lib/secrets/host.ts)
[4] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[5] [src/commands/container.ts](/src/commands/container.ts)
[6] [src/lib/container/names.ts](/src/lib/container/names.ts)
[7] [src/lib/worktree.ts](/src/lib/worktree.ts)
[8] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[9] [src/lib/json-types.ts](/src/lib/json-types.ts)
[10] [docs/specs/container-system.md](/docs/specs/container-system.md)
