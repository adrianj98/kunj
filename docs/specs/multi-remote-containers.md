# Multi-remote containers: one repository, containers on several machines

[remote-containers.md](remote-containers.md) lets a repository run its containers on one `kunj serve`
box, chosen by `container.remote`. This spec lets each branch's container live on any of them: this
Mac's Docker or any remote in `~/.kunj/remotes.json`, picked when the container is created (`kunj ct start
--remote <name>`, the workspace app's New session sheet), and found again afterwards by asking every one.

## Status

| Part | State |
| --- | --- |
| Spec | Written 2026-10-25 |
| CLI: the fleet, `ct list` across backends, branch lookup, `ambiguous-remote` | Not started |
| `kunj events` and `worktree list --containers` across backends | Not started |
| Workspace app: remote picker in New session, remote on rows, actions pass `--remote` | Not started |

## Decisions

- **2026-10-25** Ask every remote; no record of where a branch's container lives (the user's choice
  over remembering it per branch in `branches.json`, or one remote per repository). Docker labels on
  each machine stay the only container state, as in phase 1. The cost: every listing and every
  branch command without `--remote` asks this Mac and every registered remote, in parallel, so it is
  as slow as the slowest box that answers within the lookup timeout.

## The fleet

A repository's **fleet** is this Mac's Docker (`container.dockerContext` / `--context`) plus every
remote in `~/.kunj/remotes.json`. Its **default** backend is the one `selectBackend()` picks today:
`--remote`, else `container.remote`, else this Mac. Registered remotes that no repository uses are still
asked: a remote is cheap to remove (`kunj remote remove`) and that keeps "where is it" free of state.

`fleet()` (src/lib/container/fleet.ts) opens every member in parallel, each raced against
`LOOKUP_TIMEOUT_MS` (5 s; an SSH tunnel that has not come up by then counts as unreachable), and returns
`{ name, selection | error }` per member. Tunnels opened for one command are closed by
`closeBackends()` as now. Nothing opens the fleet when `--remote` is given: an explicit backend is used
alone, exactly as before.

## Listing

`kunj ct list` without `--remote` lists the fleet: one `backend.list` per reachable member, statuses as
now per container. `--remote <name>` (or `local`) lists that one only.

`ContainerListJson`, fields only added:

- each container gains `remote?: string` (absent on this Mac's Docker);
- `backends: Array<{ kind: 'docker' | 'remote'; remote?: string; context: string; available: boolean;
  message?: string; features }>`, one per member asked;
- `backend` stays and still describes the default backend, so consumers that read it keep working.

An unreachable member gives `available: false` with its message; its containers are missing from that
listing, never reported as gone by anything that diffs listings (the apps grey that remote instead).
Text output gains a REMOTE column when any member is a remote; an unreachable one is one warning line.

`orphans`, `secretsChanged` and the snapshot staleness check are per member, as each machine has its own
objects. The same branch on two members is listed twice (one row each).

## Branch commands

Every command that acts on one branch's container (`start`, `stop`, `remove`, `shell`, `exec`, `agent`,
`attach`, `logs`, `forward`, `open`, `file`, `mcp`, `token`) resolves its backend with `locate(branch)`
when no `--remote` is given:

1. Ask every member for the branch's main container (`list` by `kunj.repo` + `kunj.branch`), in
   parallel.
2. Found on exactly one: use it.
3. Found on several: `ContainerError('ambiguous-remote')` naming them, with the hint to pass
   `--remote <name>` (`local` for this Mac).
4. Found on none: the default backend. For `start` that is where a new container is created. If a
   member was unreachable, `start` refuses with `remote-unreachable` naming it (the branch's container
   may be there, and a second one would be made silently); `--remote <name>` creates where asked. Other
   commands fail as today ("No container for …") and name the unreachable members.

Detached children (`forward --auto`, the MCP bridge) get the located backend's `--remote <name>`, or
`--remote local` (plus `--context`) for this Mac, so they never locate again.

`ct prune` and `ct blueprint *` stay on the default backend unless `--remote` is given: they act on a
machine, not a branch.

## Events

`kunj events` watches every member of each repository's fleet. Members are shared across repositories
(one connection per remote, as now); `backendFor(repo)` becomes `backendsFor(repo)` returning the
reachable members. A member that cannot be reached at startup gets one `backend unavailable` and is
retried every 10 s like the local daemon is today. `container` events carry `remote?` (additive on
`EventJson`).

## Worktree listing

`kunj worktree list --containers` uses `ct list`'s collection, so it lists the fleet. Its
`containers.available` stays true while any member answered; `containers.backends` repeats the list.

## Workspace app

- **New session:** under Container, a "Run on" popup: "This Mac" and each name from
  `kunj remote list --json`, preselected to the default backend from the repository's
  `ct list --json` (`backend.remote`). It passes `--remote <name>` (or `--remote local`) to
  `kunj ct start -c`. Container stays disabled only when no member of the fleet answers.
- **Rows:** a container on a remote shows the remote's name in its meta line. A remote that does not
  answer greys its rows (kept from the last listing) instead of dropping them.
- **Actions and tabs:** every `kunj ct …` the app runs for a container (shell and agent tabs, start,
  stop, remove, file read and write) passes `--remote <row.remote ?? local>`, so it never locates.
- `MIN_KUNJ_VERSION` does not change: `--remote local` exists since remote containers shipped, and the
  new JSON fields are optional.

## Tests

- Unit: `fleet()` with fake members (one slow past the timeout, one failing), `locate()` for one, none,
  several and none-with-an-unreachable member, `ct list --json` merging two `FakeBackend`s, detached
  child args, events with two backends per repo.
- Workspace app: the picker's options and default from fixture JSON; `fake-kunj` answers
  `remote list --json`.
- `npm run test:remote` unchanged (explicit `--remote`).
