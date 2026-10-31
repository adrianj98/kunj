---
type: Feature
title: Worktree Agents
description: kunj agent runs an agent command (default claude) in a host tmux session per worktree, with optional extra sessions, waiting-for-input state via Claude Code hooks, and status in the worktree listing.
resource: src/lib/agent-session.ts
tags: [feature, agent, tmux, worktree, claude]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj agent` (`AgentCommand`, `src/commands/agent.ts`) runs `agent.command` (default `claude`) in a host
tmux session for a worktree, so the agent outlives the terminal or app tab that started it and can be
reattached. The session name is chosen by kunj, so `kunj worktree list --json` and
[`kunj events`](/features/events-stream.md) can report it. Helpers live in `src/lib/agent-session.ts`.
The command is on the [fast path](/architecture/fast-path.md).

The container equivalent is `kunj ct agent` ([container agents](/containers/container-agents.md)), which
shares `agentArgv()`, `withAgentHooks()` and `checkShellSessionId()`.

# Command

| Form | Behaviour |
|------|-----------|
| `kunj agent [start] [branch]` | Start or reattach (default; a first positional that is not an action is the branch) |
| `kunj agent status [branch]` | Whether the session(s) run; `AgentStatusJson` |
| `kunj agent stop [branch]` | Kill the session; `tmux-missing` without tmux, `not-running` when absent |
| `--session <id>` | One of several agents of the worktree, in its own session |
| `stop --all` / `stop --session <id>` | End all / that one; exit 0 even when nothing ran; reports `stopped` |
| `--command <cmd>`, `--no-tmux` | Override the command; run directly in this terminal |

`[branch]` defaults to the current branch. A branch without an existing, non-bare worktree is
`AgentError('no-worktree')`. `start` needs a TTY (`no-tty`).

# Session names

One tmux server serves the host, so names must be unique per repository and branch.
`agentSessionName(repoName, repoId, branch, id?)` takes the branch container name from
`containerNames()` (`kunj-<readable>-<hash of repo id and branch>`, see
[naming](/containers/naming-and-labels.md)) with `.` and `:` replaced by `-` (tmux target separators). With
an id it appends `-a-<id>`, keeping the `kunj-` prefix. Repo name and id come from
`repoIdentity({ commonDir, repoRoot })`, read from files.

`agentSessionsOf(sessions, base)` finds a branch's default and `-a-<id>` sessions in one tmux listing;
`agentSessionId()` validates the id against `SHELL_SESSION_ID` (`^[A-Za-z0-9_-]{1,32}$`).

# Starting

```
tmux -u new-session -A -s <name> -c <worktree> -e KUNJ_BRANCH=.. -e KUNJ_REPO=.. -e KUNJ_WORKTREE=.. -e KUNJ_AGENT_STATE=..
     <node> <kunj> run --hold --branch <b> -- $SHELL -lc '<command>'
     ';' set-option -t <name> window-size latest ';' set-option -t <name> status off
```

* `agentArgv()`: `-A` reattaches an existing session; `-e` (tmux 3.2+) is needed because a new session's
  environment comes from the tmux server, not the client. `window-size latest` makes the size follow the
  last attached client; the status line is off unless `agent.tmuxStatus`. Both options are re-set on
  every attach. `scripts/check-tmux-agent.sh` checks these behaviours in a throwaway Debian container.
* `TMUX` is removed from the environment so it works from inside a pane.
* `hostRunArgv()` wraps the command in `kunj run --hold`, which unlocks the vault inside the session and
  injects the branch's host secrets; values never go in argv ([kunj run](/secrets/kunj-run.md)).
* Direct mode (`--no-tmux`, `agent.tmux: false`, or tmux missing): `directArgv()` = `$SHELL -lc <cmd>`
  with `hostSecretEnv()` in-process, exit code passed through. When tmux is missing but wanted it prints
  `NO_TMUX_HINT` to stderr. With `agent.tmux: false` a session already running is still reattached.

`readTmuxSessions()` returns a list, `'missing'` (ENOENT) or `'failed'`; only "no server running" /
"error connecting to" count as no sessions, so a transient failure is never read as "no agents". When the
listing failed, `hasTmuxSession()` asks about the one name before starting a second agent.

# Waiting-for-input state

When the command's first word is `claude` and `agent.hooks` is not false, `withAgentHooks()` appends
`--settings '<json>'` from `claudeHookSettings()`: `UserPromptSubmit`/`PreToolUse` write `running`,
`Stop` and `Notification` (`permission_prompt|idle_prompt|elicitation_dialog`) write `waiting`, and
`SessionEnd` removes the file named by `KUNJ_AGENT_STATE` =
`~/.kunj/<repo>/agent-state/<session>` (`agentStateFile()`). `readAgentState()` reads it back;
`combineAgentStates()` gives `waiting` if any session waits, else `running` if any runs.

`SessionStart` copies its input (JSON with Claude Code's `session_id`) to `KUNJ_AGENT_RESUME` =
`~/.kunj/<repo>/agent-resume/<session>.json` (`agentResumeFile()`, host only, never removed).
`kunj agent start --resume` reads it with `readAgentResume()` when the tmux session is not running and
runs `claude --resume <id>` (`withAgentResume()`). The workspace app passes `--resume` for restored agent
tabs (docs/specs/tmux-sessions.md#quitting-and-resuming).

# Status in the listing

With status, `listWorktreesDetailed()` makes one `tmux list-sessions` call in the same `Promise.all` as
git and sets `WorktreeInfo.agent` for existing non-bare worktrees on a branch:

```ts
{ running: boolean | null, session: string, state?: 'running' | 'waiting' | null, sessions?: AgentSessionJson[] }
```

`running` is null (and `sessions` absent) when tmux could not be asked. `kunj agent status` reports the
same: without `--session`, `running` is any session; `sessions` lists `{ session, id, state? }`.

# Settings and errors

| Key | Default | Meaning |
|-----|---------|---------|
| `agent.command` | `claude` | Command to run |
| `agent.tmux` | `true` | false runs directly, like `--no-tmux` |
| `agent.tmuxStatus` | `false` | Show tmux's status line |
| `agent.hooks` | `true` | Pass the Claude Code state hooks |

`AgentError` codes (`jsonCode` in `--json`, printed without a stack trace): `tmux-missing`, `no-tty`,
`not-running`, `no-worktree`, `bad-session-id`.

# Related Concepts

* [Persistent shells](/features/persistent-shells.md) - same tmux machinery, `kunjsh-` names
* [Container agents](/containers/container-agents.md), [kunj run](/secrets/kunj-run.md)
* [Worktrees](/features/worktrees.md), [Events stream](/features/events-stream.md), [Workspace app](/apps/workspace-app.md)

# Citations

[1] [src/commands/agent.ts](/src/commands/agent.ts)
[2] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[3] [src/settings/agent.ts](/src/settings/agent.ts)
[4] [src/lib/worktree.ts](/src/lib/worktree.ts)
[5] [src/lib/repo-identity.ts](/src/lib/repo-identity.ts)
[6] [src/lib/container/names.ts](/src/lib/container/names.ts)
[7] [src/lib/json-types.ts](/src/lib/json-types.ts)
[8] [scripts/check-tmux-agent.sh](/scripts/check-tmux-agent.sh)
[9] [CLAUDE.md](/CLAUDE.md)
