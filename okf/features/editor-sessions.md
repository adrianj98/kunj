---
type: Feature
title: Editor Sessions
description: A global registry of which editor windows have which worktree open, kept in ~/.kunj/worktree-sessions.json and pruned by PID liveness.
resource: src/lib/worktree.ts
tags: [feature, worktree, editor, sessions, vscode]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Editors register the worktree they have open with `kunj worktree session start`, and every
[worktree listing](/features/worktrees.md) reports those sessions per worktree (`sessions`, `openCount`).
That lets the VS Code extension and the macOS app show "open in another window", and lets
`kunj worktree remove` refuse to delete a worktree an editor still has open.

Sessions are host-wide, not per repository: one file, `~/.kunj/worktree-sessions.json`
(`WORKTREE_SESSIONS_FILE`, path from `getSessionsPath()`). Registering a session is also the main way a
repository reaches `kunj repos`: `session start` calls `recordRepo()` on the folder's git common dir
([repo registry](/architecture/repo-identity-and-registry.md)).

# Session record

```ts
interface WorktreeSession {
  id: string;           // `${Date.now() base36}-${6 random base36}` unless --id is given
  path: string;         // normalized (realpath) worktree path
  pid: number;          // owning process
  host: string;         // os.hostname()
  editor: string;       // --editor, else 'unknown'
  label?: string;       // --label, a human readable window label
  registeredAt: string; // ISO time
  lastSeen: string;     // ISO time, refreshed by every start/heartbeat
}
```

The file is `{ "sessions": [...] }`, written atomically (temp file `<file>.<pid>.tmp`, then rename).

# Commands

| Command | Behaviour |
|---------|-----------|
| `kunj worktree session start [--pid] [--path] [--editor] [--label] [--id]` | Registers or refreshes. `--pid` defaults to the parent process (`process.ppid`); `--path` defaults to the current worktree (`git rev-parse --show-toplevel`) |
| `kunj worktree session heartbeat ...` | Same as `start` |
| `kunj worktree session end\|stop --id \| --pid [--path] \| --path` | Removes matching sessions; needs at least one of the three |
| `kunj worktree session list` (default) | Live sessions; `--json` gives `{ sessions }` |

`registerSession()` identifies a session by `--id`, or by `(host, pid, path)`, so calling `start`
repeatedly acts as a heartbeat: the existing record gets a new `lastSeen` (and editor/label when given)
instead of a duplicate. `unregisterSession()` matches by id; else by pid on this host (narrowed by path
when given); else by path. It returns the number removed. `kunj worktree remove` calls it with the
removed path.

# Liveness and pruning

`isSessionAlive()`:

* same host: `isProcessAlive(pid)`, i.e. `process.kill(pid, 0)`, where `EPERM` (another user's process)
  counts as alive;
* another host (a shared home directory): alive while `lastSeen` (or `registeredAt`) is younger than
  `SESSION_STALE_MS` = 24 hours.

`loadActiveSessions()`, called by every listing, drops dead sessions and writes the file back only when
something was dropped. `registerSession()` and `unregisterSession()` also filter dead sessions when they
write.

# Consumers

* The VS Code extension (`vscode-extension/src/sessionManager.ts`, `kunjCli.ts`) runs
  `worktree session start --path <p> --pid <pid> --editor vscode`, re-syncs every 5 minutes
  (`HEARTBEAT_MS`) and runs `session end --id <id>` on deactivate. It also watches
  `worktree-sessions.json` to refresh when other windows change it.
* [`kunj events`](/features/events-stream.md) watches `~/.kunj` and emits a `sessions` event when this
  file changes.
* `kunj worktree remove` refuses a worktree with sessions unless `--force` ("Worktree is open in ...").

# Related Concepts

* [Worktrees](/features/worktrees.md) - the listing that reports sessions
* [Repository identity and registry](/architecture/repo-identity-and-registry.md) - `recordRepo()` on session start
* [Events stream](/features/events-stream.md)
* [VS Code extension](/apps/vscode-extension.md), [macOS app](/apps/macos-app.md)

# Citations

[1] [src/lib/worktree.ts](/src/lib/worktree.ts)
[2] [src/commands/worktree.ts](/src/commands/worktree.ts)
[3] [src/lib/events.ts](/src/lib/events.ts)
[4] [vscode-extension/src/sessionManager.ts](/vscode-extension/src/sessionManager.ts)
[5] [vscode-extension/src/kunjCli.ts](/vscode-extension/src/kunjCli.ts)
[6] [CLAUDE.md](/CLAUDE.md)
