---
type: Secrets
title: kunj run
description: Runs a host command with the branch's host-targeted secrets in its environment, and is how kunj agent and kunj worktree shell start their tmux commands without putting values in argv.
resource: src/commands/run.ts
tags: [secrets, host, cli, tmux]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj run [--branch b] [--hold] -- <cmd...>` (`src/commands/run.ts`) unlocks the vault, puts the branch's
host-targeted env secrets into the environment of `<cmd>`, renders file deliveries into the current worktree
first, and exits with the command's code. It is on the [fast path](/architecture/fast-path.md).

It exists so that host processes, including tmux sessions started by [worktree agents](/features/worktree-agents.md)
and [persistent shells](/features/persistent-shells.md), get secrets without the values ever appearing in argv.
`tmux new-session -e NAME=value` would expose them in `ps`, so tmux runs `kunj run` instead and the vault is
unlocked inside the session.

# Behaviour

| Step | Detail |
|------|--------|
| Branch | `--branch`, else `getCurrentBranch()`, else none (no branch layer) |
| Root | `getCurrentWorktreePath()`; `null` outside a worktree, then no files are rendered |
| Secrets | `hostSecrets({ branch, root, warn })` from `src/lib/secrets/host.ts` |
| Files | Rendered via `writeHostFiles` (without `force`); a failure is a `⚠` warning on stderr and the command still runs |
| Unlock failure | Thrown before the command starts; with `--hold`, prints `✗ <message>` and `Press Enter to close.` and waits first |
| Run | `runAttached(argv, { ...process.env, ...env })`; `process.exitCode` is the command's code |

`--hold` exists because tmux closes a pane with its process: without the wait the error would vanish and leave
only `[exited]`. `waitForEnter` returns at once when stdin is not a TTY.

# runAttached

`runAttached(argv, env, cwd?)` spawns with inherited stdio and resolves with:

| Outcome | Exit code |
|---------|-----------|
| Normal exit | the child's code |
| Killed by a signal | 128 + signal number |
| Command not found (ENOENT) | 127, with `✗ <cmd>: command not found` on stderr |
| Other spawn error | 126 |

While waiting, kunj ignores SIGINT and SIGQUIT (the terminal delivers them to the child) and forwards SIGTERM
and SIGHUP to the child; the handlers are removed afterwards.

# hostRunArgv

`src/lib/agent-session.ts`:

```ts
hostRunArgv(branch, argv) =
  [process.execPath, kunjEntry(), 'run', '--hold', ...(branch ? ['--branch', branch] : []), '--', ...argv]
```

`kunjSelf()` gives `[process.execPath, kunjEntry()]` (`kunjEntry` in `src/lib/self.ts`). The result is passed to
tmux as an argv array, no shell quoting.

| Caller | Command under `kunj run` |
|--------|--------------------------|
| `kunj agent` (tmux) | `hostRunArgv(wt.branch, [loginShell(), '-lc', <agent command>])` |
| `kunj worktree shell --session <id>` (tmux) | `hostRunArgv(branch, [shell, '-l'])` |

Without tmux, both commands call `hostSecretEnv(branch, worktreePath)` in-process instead, which uses
`hostSecrets` and prints file warnings to stderr; it is imported lazily so the worktree listing never loads
the vault code. The `KUNJ_*` agent variables still go through `new-session -e`, since they are not secrets.

# Test seams

`RunCommandDeps`: `unlock` (`UnlockSeam`: mode, env, platform, run, prompt, tty), `currentBranch`,
`worktreeRoot`, `waitForEnter`.

# Related Concepts

* [Secret Manager](/secrets/overview.md)
* [Resolution and Delivery](/secrets/resolution-and-delivery.md) - `hostSecrets`, `writeHostFiles`
* [Worktree Agents](/features/worktree-agents.md)
* [Persistent Shells](/features/persistent-shells.md)
* [Key Providers](/secrets/key-providers.md) - why an app launched from Finder can still unlock (keychain)

# Citations

[1] [src/commands/run.ts](/src/commands/run.ts)
[2] [src/lib/secrets/host.ts](/src/lib/secrets/host.ts)
[3] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[4] [src/commands/agent.ts](/src/commands/agent.ts)
[5] [src/commands/worktree.ts](/src/commands/worktree.ts)
[6] [src/commands/fast.ts](/src/commands/fast.ts)
[7] [docs/specs/container-system.md](/docs/specs/container-system.md)
