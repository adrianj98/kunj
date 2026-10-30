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
| Workspace app: CPU and memory of a worktree's host sessions on its sidebar row | Shipped |
| Sessions follow their worktree across a checkout (CLI: listing, `agent`, `worktree shell`) | Shipped |
| Workspace app: tabs follow their worktree across a checkout | Shipped |
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

## Following a checkout

An agent that runs `git checkout`/`git switch` in its worktree changes the worktree's branch, but its
tmux session keeps the name it was started with (`kunj-<repo>-<old branch>-<h>[-a-<id>]`). Every
lookup that computed the name from the current branch then missed it: the listing reported no agent,
a reattach (`kunj agent <new branch> --session <id>`) started a second one, and closing the
environment left it running.

Host sessions carry `@kunj_worktree`, so lookups match on it: `readTaggedTmuxSessions()` lists names
with their tag in the same one tmux call, and `worktreeAgentSessions()` / `worktreeShellSessions()`
take a tagged session by its tag (whatever branch it was named after; one tagged with another
worktree is never taken, even when its name matches) and an untagged one by name as before. The id is
read from the name (`-a-<id>`, `-sh-<id>` after the 6-hex hash, the id form first). `pickSession()`
prefers the current branch's name, then any of the worktree's sessions with that id. Used by
`worktree list` (`agent.session`, `agent.sessions`), `kunj agent start|status|stop` and
`kunj worktree shell [--kill]`; `--kill` still ends the current names as before and the tagged ones on
top. Container sessions are unaffected: a container is named after its branch label, not its checkout.

The workspace app keys an environment by `repo|worktree|branch`, so a checkout gives the worktree a new
id. `worktreeMoves()` (KunjWorkspaceCore) finds a worktree listed at the same path under another
branch, when the old id is gone and the new one was not listed before; `EnvironmentStore` reports
them through `onWorktreesMoved` before `onChange`. The app then moves, in this order, the layout
keeper's restored state and saved entry (tabs, `lastActivity`; not over an entry the new branch
already has), the registry's tabs (`TabRegistry.move`: a terminal's `envId` and link handler, an
editor's `env`; the processes keep running) and the selection. A tab's spec is never re-run, and
closing a moved tab runs `kunj agent stop <new branch> --session <id>`, which the CLI resolves by tag.

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

The sidebar rows show the CPU and memory of their worktree's host sessions, summed
(`sessionUsageByWorktree()`, matched on the standardized worktree path), right of the status line as
`65% 425M` (`formatUsageShort()`, amber at 50%+), only while the mouse is over the sidebar and only
when the kind icon, folder and status verb still fit whole. The icon is a branch (worktree) or a box
(container); the worktree's folder follows it only when it does not have the branch's letters and
digits (`sidebarFolder()`; `feature-x` for `feature/x`, any case). The app runs `kunj sessions list --json` without
`--containers` when the mouse enters the sidebar and every 5 s while it stays there, so container rows show none (that would be
an exec per container); after three failures in a row (a kunj without `sessions`, a hung tmux) the rows
show none and it retries once a minute.

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
