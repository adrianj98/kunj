---
type: Container
title: Container Agents
description: kunj ct agent runs container.agentCommand in a tmux session inside the branch container (agent or agent-<id>), kunj ct attach reattaches, and the agent's state is read back by STATUS_SCRIPT.
resource: src/commands/container.ts
tags: [container, agent, tmux, claude]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj ct agent [branch] [-- <args>]` starts the agent inside a running branch container, or reattaches to it
when it already runs. The command is `container.agentCommand`, default
`claude --dangerously-skip-permissions` (`CONTAINER_AGENT_COMMAND_DEFAULT`), run in a tmux session so it
outlives the terminal. Several agents can share one container, one per `--session <id>` (one per tab in the
[workspace app](/apps/workspace-app.md)). This is the container counterpart of
[worktree agents](/features/worktree-agents.md), and uses the same id check and hook settings from
`src/lib/agent-session.ts`.

# Sessions and state files

| Option | tmux session | State file |
| --- | --- | --- |
| none | `agent` | `/tmp/kunj-agent-state` (`CONTAINER_AGENT_STATE_FILE`) |
| `--session <id>` | `agent-<id>` | `/tmp/kunj-agent-state-<id>` |

`<id>` must match `[A-Za-z0-9_-]{1,32}` (`checkShellSessionId()`, error `bad-session-id`). One tmux server
runs per container, so names carry no repo or branch.

# Starting

`ContainerCommand.agent()`:

1. Requires a running container.
2. Unless `container.forward.auto` is false, spawns a detached `kunj ct forward <branch> --auto` when none is
   registered for the container and `forwarderProblem()` finds nothing wrong (see
   [Forwarding](/containers/forwarding.md)).
3. `ensureBridge()` starts a detached `kunj ct mcp` when `container.mcp` is set (see
   [MCP bridge](/containers/mcp-bridge.md)).
4. Builds the command: `KUNJ_AGENT_STATE=<stateFile> ` + `agentCommandLine(setting, args)` (the setting is
   shell text, extra args are `shellQuote`d), with `withAgentHooks()` appending
   `--settings '<claudeHookSettings()>'` when the command is `claude` and `agent.hooks` is not false. Those
   Claude Code hooks write `running`/`waiting` to the state file.
5. Probes `command -v tmux` as the container user. Without tmux it warns and runs `sh -lc <command>`
   directly (the agent stops when you leave).
6. Runs, interactively with a TTY, in `/workspace`:

```sh
tmux -u new-session -A -s <session> <command> \; set-option -t <session> window-size latest \
     \; set-option -t <session> status off   # on with agent.tmuxStatus
```

`-A` attaches when the session exists; `-u` forces UTF-8; `window-size latest` lets an IDE terminal and a
CLI one share the session. With `agent.tmux` false the agent runs directly, unless a session from before
the setting changed still runs (then it reattaches). The exit code is passed through.

`kunj ct agent` loads no secrets: container env secrets are in the env-file from creation (see
[Env and status](/containers/env-and-status.md)).

# Attach and kill

`kunj ct attach [branch] [--session <id>]` runs `tmux -u attach -t <session>`; a failure is
`No agent session; run kunj ct agent <branch>`. With `agent.tmux` false and no session running it explains
that there is nothing to attach to.

`kunj ct agent --kill [--session <id>]` ends `agent-<id>`, or without `--session` every `agent` and
`agent-*` session (`killAllScript()`). It always exits 0, also for a stopped or missing container; `--json`
prints `ShellKillJson` `{ "killed": boolean }`. The same mechanism serves `kunj ct shell --kill` for `sh-*`
sessions.

# Reading the state back

`STATUS_SCRIPT` lists the container's tmux sessions and prints `session=<name> <state>` for `agent` and each
`agent-<id>` from their state files; `parseStatus()` turns that into `agentRunning`, `agentState` (waiting
wins) and `agentSessions`, which `kunj ct list --json` reports as `agent: { running, state, sessions }` and
[kunj events](/features/events-stream.md) emits as a `container` event with `action: 'status'` when it
changes. Only state files of running sessions are read, since a crashed agent never fires `SessionEnd`.

# Related Concepts

* [Worktree agents](/features/worktree-agents.md) - host tmux sessions, shared helpers
* [Persistent shells](/features/persistent-shells.md) - `kunj ct shell --session`
* [Env and status](/containers/env-and-status.md) - `STATUS_SCRIPT`
* [Forwarding](/containers/forwarding.md), [MCP bridge](/containers/mcp-bridge.md)
* [Images](/containers/images.md) - the sandbox image ships tmux and Claude Code

# Citations

[1] [src/commands/container.ts](/src/commands/container.ts)
[2] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[3] [src/lib/container/env.ts](/src/lib/container/env.ts)
[4] [src/lib/container/defaults.ts](/src/lib/container/defaults.ts)
[5] [src/lib/json-types.ts](/src/lib/json-types.ts)
[6] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
