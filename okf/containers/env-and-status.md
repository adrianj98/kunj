---
type: Container
title: Container Env and Status
description: What environment a branch container gets, how exec and shell run commands in it, and how STATUS_SCRIPT feeds the agent and git fields of kunj ct list --json and kunj events.
resource: src/lib/container/env.ts
tags: [container, env, status, list, json]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`src/lib/container/env.ts` holds the pure helpers around a container's environment and its status: which
host variables are forwarded (`forwardedEnv`), what the network helper gets (`firewallEnv`, see
[Network helper and firewall](/containers/network-helper-firewall.md)), the `STATUS_SCRIPT` exec'd in each
running container and its parser, and the remove guard parser (see [Lifecycle](/containers/lifecycle.md)).

# Forwarded environment

Only what `container.env` names reaches the container. Default (`CONTAINER_ENV_DEFAULT` in defaults.ts):
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `GH_TOKEN`.

| Entry | Effect |
| --- | --- |
| `NAME` | Copied from the host env when set |
| `NAME=value` | Passed literally, with `${...}` [config variables](/architecture/config-variables.md) expanded |
| Bedrock | When `CLAUDE_CODE_USE_BEDROCK` is truthy, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE` ride along |

Container-targeted env secrets override it, and `withHostTokens()` may add `GH_TOKEN` (see
[Tokens](/containers/tokens.md)). The result goes into the `docker run` env-file only, at create time;
`docker start` keeps it, so changed env secrets need `kunj ct start --rebuild`. Start warns when none of
`CLAUDE_AUTH_KEYS` is forwarded and the agent command starts with `claude`. `TOKEN_KEYS` is
`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`.

# exec and shell

`kunj ct exec [branch] -- <cmd...>` and `kunj ct shell` require a running container and run as the recorded
user (`kunj.options.user`; `''` passes no `-u`) in `/workspace`. `interactive()` passes only `TERM`,
`COLORTERM` and `LANG=C.UTF-8` with `-e`, never secrets. The shell is
`sh -lc 'exec $(command -v zsh || command -v bash || echo sh) -l'`, optionally inside tmux session `sh-<id>`
with `--session` (see [Persistent shells](/features/persistent-shells.md)). The exit code is passed through.
`splitCommand()` recovers the `--` split because Commander drops it.

# STATUS_SCRIPT

One `sh -c` exec per running main container, shared by `kunj ct list` and the
[events stream](/features/events-stream.md) poll:

```sh
s=$(tmux list-sessions -F '#{session_name}'); echo "tmux=$?"
# for each session: agent -> "session=agent <state>"   agent-<id> -> "session=agent-<id> <state>"
cd /workspace && git -c core.fsmonitor=false -c core.hooksPath=/dev/null status --porcelain=v2 --branch
```

States come from `/tmp/kunj-agent-state` and `/tmp/kunj-agent-state-<id>` (written by the agent's Claude Code
hooks). `SAFE_GIT` keeps git from running the agent-controlled fsmonitor or hooks. `parseStatus()` returns
`ContainerStatus`:

| Field | From |
| --- | --- |
| `agentRunning` | Any agent session; `null` unless `tmux=` was 0 or 1 (127: no tmux) |
| `agentState` | `waiting` if any session waits, else `running` if any runs, else null |
| `agentSessions` | `{ session, id, state? }`, only names matching `agent` / `agent-<[A-Za-z0-9_-]{1,32}>` |
| `head`, `ahead`, `dirty` | `# branch.oid`, `# branch.ab`, any non-header line |
| `status` | `ok`; `containerStatus()` gives `timeout` (2 s), `stopped` or `error` via `emptyStatus()` |

# kunj ct list --json

`collectList()` makes one `backend.list`, starts volume and network listings in parallel, execs
`STATUS_SCRIPT` in each running main (skipped with `--no-status`), and builds `ContainerListJson`:
`{ repo, backend: { kind: 'docker', context }, containers, orphans }`. Each `ContainerJson`:

| Field | Source |
| --- | --- |
| `branch`, `name`, `id`, `state`, `image`, `createdAt` | Container and `kunj.branch` |
| `imageInfo` | `{ tag, kind? }` from `kunj.options.imageKind` |
| `blueprint` | `{ hash, stale }` for snapshot-based containers (stale null when the hash is unknown) |
| `firewall`, `dind` | `kunj.options` (default `default`, `off`) |
| `ports` | Published (`kind: 'publish'`) plus registered forwards (`kind: 'forward'`, `pid`, `service?`) |
| `agent` | `{ running, state, sessions? }` |
| `workspace` | `{ head (7 chars), ahead, dirty }` |
| `status` | `ok`, `timeout`, `error`, `stopped` or `skipped` |
| `services`, `bridges` | Service states; MCP bridges from the registry |
| `secretsChanged` | This repo only: `kunj.secrets` differs from the vault files' stamp (never unlocks) |

`listJson()` serves `kunj worktree list --containers`. The shape is part of the
[JSON contract](/architecture/json-contract.md): fields are only added.

# Related Concepts

* [Container Lifecycle](/containers/lifecycle.md)
* [Container agents](/containers/container-agents.md)
* [Tokens](/containers/tokens.md)
* [Events stream](/features/events-stream.md)
* [Worktrees](/features/worktrees.md) - `list --containers`

# Citations

[1] [src/lib/container/env.ts](/src/lib/container/env.ts)
[2] [src/lib/container/defaults.ts](/src/lib/container/defaults.ts)
[3] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [src/lib/json-types.ts](/src/lib/json-types.ts)
[6] [src/settings/container.ts](/src/settings/container.ts)
