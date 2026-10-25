---
type: Feature
title: Events Stream
description: kunj events, a long-lived NDJSON stream telling the workspace app which repository, container or agent to refresh, built from file watches, tmux and status polls and Docker events.
resource: src/lib/events.ts
tags: [feature, events, ndjson, watch, workspace-app]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj events [--json] [--repo <path>...]` lets one process tell a consumer (the
[workspace app](/apps/workspace-app.md)) what to refresh, instead of the app polling every repository.
Each line says what to refresh, not what changed. The command (`src/commands/events.ts`) picks the
repositories and prints; the watching is `watchEvents()` in `src/lib/events.ts`. Lines are `EventJson`
from the [JSON contract](/architecture/json-contract.md); text mode prints `formatEvent()` lines
(`HH:MM:SS <type> ...`). It is on the [fast path](/architecture/fast-path.md).

Without `--repo` it watches every known, visible, existing repository from `~/.kunj/repos.json`
([repo registry](/architecture/repo-identity-and-registry.md)). A `--repo` path not in the registry is
resolved through `git rev-parse --git-common-dir`; a non-repository fails with `EventsError`
(`jsonCode` `not-a-repo`), printed as the first line instead of `hello`.

# Event types

```ts
type EventJson = { at: string } & (
  | { type: 'hello'; version: string; repos: number }
  | { type: 'git' | 'sessions' | 'forwards' | 'repos'; repo?: { name: string; root: string } }
  | { type: 'container'; repo: { name; root } | null; branch: string | null; container: string; action: string }
  | { type: 'agent'; session: string; running: boolean; state?: 'running' | 'waiting' | null; repo?: { name; root } }
  | { type: 'backend'; status: 'available' | 'unavailable'; message?: string }
);
```

# Sources

| Source | Emits | Mechanism |
|--------|-------|-----------|
| Git common dir | `git` (with `repo`) | `fs.watch` of the top level (not recursive), plus `refs/` and `worktrees/` recursively once they exist |
| Registry files in `~/.kunj` | `sessions`, `forwards`, `repos` | watch of the directory for `worktree-sessions.json`, the forwards file (`forwardsFile()`), `repos.json` |
| Agent state files | `agent` with `state` | watch of `~/.kunj/<repo>/agent-state/` (`kunj-*` files); only a changed value emits |
| tmux | `agent` (`running` true/false) | `listTmuxSessions()` every 5 s, `kunj-` sessions only; first poll is the baseline, a failed listing is skipped |
| Worktree status poll | `git` | every 10 s: `git worktree list --porcelain` per repo, `git status --porcelain=v2 --branch` per worktree, sha1 compared |
| Docker events | `container` | `backend.events({ kunj.repo })`, mapped to a repo by id |
| Container status poll | `container`, `action: 'status'` | every 10 s: `backend.list` per repo, `STATUS_SCRIPT` exec (2 s timeout) per running main container |
| Backend health | `backend` | one `unavailable` on failure, then `info()` retried every 10 s until `available` |

Details that keep the stream quiet:

* Never watch the whole common dir recursively: worktrees live in `.git/kunj/worktrees` by default,
  with their `node_modules`. `gitPathMatters()` accepts `HEAD`, `ORIG_HEAD`, `index`, `packed-refs`,
  `worktrees`, `refs/...` and `worktrees/<name>/...` except `logs`, and ignores `*.lock`.
* Every git call runs with `GIT_OPTIONAL_LOCKS=0`; `getWorktreeStatus()` in the listing does too.
  Otherwise `git status` rewrites a stale index, which is a `git` event, which triggers another listing.
* `containerActionMatters()` drops `exec_*`, `attach`, `detach`, `resize`, `top`, `archive-path`,
  `extract-to-dir`, because `kunj ct list` execs into each container and would trigger its own refresh.
* The container hash covers `{ agentRunning, agentState, agentSessions, head, ahead, dirty }` from
  `parseStatus()` ([env and status](/containers/env-and-status.md)).
* A worktree or container seen for the first time only primes; one that fails is skipped (keeping its
  last hash). Poll ticks never overlap (`every()` skips while busy). Docker calls are raced against the
  abort signal (`untilAbort()`).
* Debounce: one pending event per key, 250 ms, the first change starts the timer.

The `refs/`, `worktrees/` and agent-state watches are resynced on every status tick, so a directory that
appears later (the first linked worktree) or a watch that errored is picked up again.

# Repo ids for containers

Container labels carry `kunj.repo` = `repoIdFromUrl()` of origin. `originRepoId()` computes it once per
repository at startup from `git remote get-url origin` (which applies `insteadOf` and includes), with
userinfo stripped by `stripUserinfo()`. A container whose repo is not watched is reported with
`repo: null`. `WatchEventsOptions.repoId` is the test seam.

# Lifecycle

1. Arm the watches and compute repo ids.
2. Run the first tmux and worktree polls.
3. `onReady()` prints `hello` (`version`, `repos` count): any change after it is reported. Docker is
   not awaited.
4. Start the container poll and the backend event loop.
5. Stop on SIGINT, SIGTERM, stdout `EPIPE`, or stdin ending (the parent app holds stdin, so the child
   dies with it). The finally block calls `LocalDockerBackend.killChildren()` so a hung `docker` call
   cannot keep the process alive.

Missing directories are skipped. `kunj events` never unlocks the secrets vault.

# Related Concepts

* [Workspace app](/apps/workspace-app.md) - the consumer
* [Worktree agents](/features/worktree-agents.md) - tmux names and agent-state files
* [Editor sessions](/features/editor-sessions.md), [Forwarding](/containers/forwarding.md), [Repo registry](/architecture/repo-identity-and-registry.md)
* [Container backend](/containers/backend.md), [Naming and labels](/containers/naming-and-labels.md)
* [Git layer](/architecture/git-layer.md)

# Citations

[1] [src/lib/events.ts](/src/lib/events.ts)
[2] [src/commands/events.ts](/src/commands/events.ts)
[3] [src/lib/json-types.ts](/src/lib/json-types.ts)
[4] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[5] [src/lib/worktree.ts](/src/lib/worktree.ts)
[6] [src/lib/repo-identity.ts](/src/lib/repo-identity.ts)
[7] [CLAUDE.md](/CLAUDE.md)
