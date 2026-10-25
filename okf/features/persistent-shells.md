---
type: Feature
title: Persistent Shells
description: kunj worktree shell and kunj ct shell with --session keep a login shell in a tmux session so a terminal tab survives the app that opened it.
resource: src/commands/worktree.ts
tags: [feature, shell, tmux, worktree, container, workspace-app]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The workspace app's shell tabs need to survive the app quitting. `kunj worktree shell [branch]` runs a
login shell in a worktree; with `--session <id>` it runs inside a host tmux session that `new-session -A`
reattaches next time. `kunj ct shell [branch] --session <id>` does the same inside a branch container.
Both reuse the [worktree agent](/features/worktree-agents.md) machinery in `src/lib/agent-session.ts`.

The workspace app builds these commands in `terminalSpec()`
(`workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift`) and saves the tab's session id.

# Host: kunj worktree shell

`WorktreeCommand.shell()` in `src/commands/worktree.ts`:

1. Validates the id with `checkShellSessionId()` (`^[A-Za-z0-9_-]{1,32}$`, else
   `AgentError('bad-session-id')`).
2. Finds the worktree (target, else the current one) from one listing without status or PRs.
3. `--kill`: ends the session and returns; see below.
4. Refuses a missing, bare or deleted worktree (`no-worktree`).
5. With a session, when `agent.tmux` is not false and tmux is installed: runs
   `agentArgv(name, worktree, hostRunArgv(branch, [$SHELL, '-l']), {}, { status: agent.tmuxStatus })`,
   i.e. `tmux -u new-session -A -s <name> -c <worktree> <node> <kunj> run --hold --branch <b> -- $SHELL -l`
   plus the `window-size latest` / `status` options. No `KUNJ_*` variables: it is not an agent.
6. Otherwise (no `--session`, tmux missing, or `agent.tmux: false`): `$SHELL -l` directly, with the
   branch's host secrets from `hostSecretEnv()`.

The shell is `loginShell()` = `$SHELL`, else `sh`. `TMUX` is removed from the environment so it works
from inside a pane. Host secrets reach the tmux shell through `kunj run` inside the session, never
through `new-session -e` ([kunj run](/secrets/kunj-run.md)).

# Session names

| Where | Name |
|-------|------|
| Host | `shellSessionName(repoName, repoId, branch, id)` = the agent session name with `kunj-` replaced by `kunjsh-`, plus `-sh-<id>` |
| Container | `sh-<id>` (one tmux server per container, so no repo or branch) |

The `kunjsh-` prefix matters: [`kunj events`](/features/events-stream.md)' agent poll and the worktree
listing match `kunj-`, so a shell is never taken for an agent.

# Ending sessions

`--kill` always exits 0, also for a removed worktree (the name needs only the branch) or a stopped
container. With `--json` it prints `ShellKillJson` = `{ killed: boolean }`.

| Form | Host | Container |
|------|------|-----------|
| `--kill --session <id>` | `killTmuxSessionIfExists(name)` (`kill-session -t =<name>`) | `tmux kill-session -t =sh-<id>` |
| `--kill` | `killTmuxSessionsWithPrefix(<name with empty id>)`: every `kunjsh-...-sh-<id>` of the branch | `killAllScript('sh-*')`: every `sh-*` session |

# Container: kunj ct shell

`ContainerCommand.shell()` in `src/commands/container.ts` requires a running container, then runs
`sh -lc 'exec $(command -v zsh || command -v bash || echo sh) -l'` as the container user. With
`--session` and `agent.tmux` not false it probes `command -v tmux` in the container; when present the
command is wrapped in `agentArgv('sh-<id>', '/workspace', ...)`. Without tmux the shell runs directly.
See [container agents](/containers/container-agents.md) and [env and status](/containers/env-and-status.md).

# Related Concepts

* [Worktree agents](/features/worktree-agents.md) - `agentArgv`, tmux probing, `AgentError`
* [Container agents](/containers/container-agents.md)
* [kunj run](/secrets/kunj-run.md) - `hostRunArgv`
* [Workspace app](/apps/workspace-app.md)

# Citations

[1] [src/commands/worktree.ts](/src/commands/worktree.ts)
[2] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[3] [src/commands/container.ts](/src/commands/container.ts)
[4] [src/lib/json-types.ts](/src/lib/json-types.ts)
[5] [workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift](/workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift)
[6] [CLAUDE.md](/CLAUDE.md)
