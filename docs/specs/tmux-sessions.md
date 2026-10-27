# tmux sessions: list, usage, orphans

`kunj sessions` and the workspace app's Sessions window: every tmux session kunj started (host agents
and shells, and with `--containers` the ones inside running branch containers), what is attached to
each, its CPU and memory, and whether it is orphaned, so stray sessions can be found and ended.

## Status

| Part | State |
| --- | --- |
| `kunj sessions list [--containers] [--idle-hours n] [--json]` (`SessionsJson`) | Shipped |
| `kunj sessions kill <names…> [--container c] [--orphans] [--if-detached] [--json]` (`SessionsKillJson`) | Shipped |
| `@kunj_worktree` tag on host agent and shell sessions | Shipped |
| Workspace app: Window > Sessions (⌘⇧S) | Shipped |
| Opening a listed session as a tab | Not done (Copy Attach Command instead) |

## Why

Sessions outlive the tabs and worktrees that started them: quitting the app keeps them (by design),
removing a worktree does not end them, and a detached agent can keep using a core. Nothing listed them
with their owner, so they piled up (21 on the author's Mac, 9 for removed worktrees, one at 96% CPU).

## What is listed

Only names kunj gives: `kunj-…` (agents) and `kunjsh-…` (shells) on the host; `agent`, `agent-<id>` and
`sh-<id>` in a container. The user's own tmux sessions are never listed or ended.

One shell call, `SESSIONS_SCRIPT` (src/lib/sessions.ts), reads `tmux list-sessions` (name, created, last
activity, `@kunj_worktree`), `list-panes -a` (pid, command, directory), `list-clients` (tty, pid) and
`ps -axo pid=,ppid=,pcpu=,rss=,comm=`. Fields are separated by a literal tab (tmux formats do not
expand `\t`). The same script runs on the host and, as the sandbox user, in each running container
(`ContainerCommand.sessionsExec`, 4 at a time, 5 s per exec, 15 s for all of Docker).

* **Owner.** A host session belongs to a worktree when its `@kunj_worktree` tag is that worktree's path
  (`agentArgv(…, { worktree })`, set by `kunj agent` and `kunj worktree shell`), so it follows the
  worktree to another branch. An untagged (older) session is matched by the names
  `agentSessionName`/`shellSessionName` give each worktree's current branch (`git worktree list` once
  per repository in `repos.json`). Unmatched: the repository by its readable name prefix (longest wins).
  A container session belongs to its container (and the branch it was created for).
* **Usage.** CPU% and RSS added up over every process under each pane (each once). macOS `pcpu` is a
  recent average; 100 is one core. Null when `ps` is missing (an image without procps).
* **Attached.** Each client's tty and pid, and `via`: the nearest ancestor of the client that is not tmux,
  a shell, `login`, `env`, `node` or `kunj`, named by its `.app` bundle or command basename
  (`Kunj Workspace`, `Terminal`, `iTerm2`, `Code`).
* **Orphan.** Never while a terminal is attached. `worktree-gone`: a host session known to have lost its
  worktree: its tagged directory is missing, or (untagged) no worktree of its repository has its name
  and that repository's worktrees were listed. A tagged directory that exists is never gone, whatever
  spelling git uses (realpath compared), and a repository whose `git worktree list` failed makes none of
  its sessions orphans. `idle`: no activity for `--idle-hours` (default 24). Container sessions are
  never `worktree-gone`.

## Ending sessions

`kill` refuses any other name (`not a kunj session name`). Host: `tmux kill-session -t =<name>`.
Container: `--container <name>` must be a running branch container; the kill is exec'd there as the
sandbox user. `--orphans` adds every host session flagged orphaned at that moment. `--if-detached` (implied by
`--orphans`) asks tmux for the session's attached count again right before each kill and leaves it
running (`a terminal is attached; left running`) when one attached since the listing; in a container
that check and the kill are one exec (`KILL_IF_DETACHED_SCRIPT`). With `--json` the
reply lists `killed` and `failed` and the exit code is 0 (as `worktree shell --kill`); without it a
failure exits 1.

## Workspace app

Window > Sessions (⌘⇧S), `SessionsWindow` (workspace-app/Sources/KunjWorkspace/Sessions/), model and
argument builders in `KunjWorkspaceCore/Sessions/Sessions.swift`. A table: kind, worktree or container,
command, attached (tooltip: tty and pid), CPU (amber at 50%+), memory, last activity, status, tmux name;
sortable by CPU, memory, activity, place and status. Filter: All, Orphans, Detached. The Containers box
(remembered) adds `--containers`. Refreshed every 5 s while visible. A session whose id is one of the
open tabs' session ids shows "Tab open" and is not ended by End Orphans. End Selected, End Orphans and
the row menu's End Session confirm first (saying how many are attached or open in a tab), then run one
`kill` for the host sessions and one per container; End Orphans passes `--if-detached`, since the
listing is up to 5 s old and the sheet may stay open longer. The row menu also copies the session name and an
attach command (`tmux attach -t …`, or `docker exec -it <container> tmux attach -t …`).

## Code map

| File | What |
| --- | --- |
| src/lib/sessions.ts | `SESSIONS_SCRIPT`, parsing, process-tree usage, `clientVia`, owners, orphan rules |
| src/commands/sessions.ts | `kunj sessions list|kill`; on the fast path |
| src/commands/container.ts | `sessionsExec`, `killContainerSession` |
| src/lib/agent-session.ts | `SESSION_WORKTREE_OPTION`, the tag in `agentArgv` |
| src/lib/json-types.ts | `SessionsJson`, `TmuxSessionJson`, `SessionAttachJson`, `SessionsKillJson` |
| workspace-app/…/Sessions/SessionsWindow.swift | the window |
| workspace-app/…/KunjWorkspaceCore/Sessions/Sessions.swift | decoding, kill arguments, display text |
