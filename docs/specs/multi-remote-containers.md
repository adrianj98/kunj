# Multi-remote containers: one repository, containers on several machines

[remote-containers.md](remote-containers.md) lets a repository run its containers on one `kunj serve`
box, chosen by `container.remote`. This spec lets each branch's container live on any of them: this
Mac's Docker or any remote in `~/.kunj/remotes.json`, picked when the container is created (`kunj ct start
--remote <name>`, the workspace app's New session sheet), and found again afterwards by asking every one.

## Status

| Part | State |
| --- | --- |
| Spec | Written 2026-10-25 |
| CLI: `ct list` across the fleet (`remote` per container, `backends`), `worktree list --containers` passes `backends` on | Shipped 2026-11-16 (`collectList()` in src/commands/container.ts) |
| CLI: branch lookup (`locate()`), `ambiguous-remote`, `remote-unreachable` on start | Not started: a `kunj ct <verb> <branch>` typed without `--remote` still uses the default backend only |
| `kunj events` across backends | Not started: the app hears about a non-default remote's containers on its next refresh, not from an event |
| Workspace app: "Run on" in New session, remote on rows, every container command passes `--remote` | Shipped 2026-11-16 |
| Workspace app: grey the rows of a remote that does not answer (kept from the last listing) | Not started: they leave the list until it answers |

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

As built, the listing does this itself in `collectList()` (src/commands/container.ts): this machine's
Docker is given the time it takes, as before, and each remote is raced against `FLEET_OPEN_TIMEOUT_MS`
(5 s to open: an SSH tunnel, `/v1/info`) and `FLEET_LIST_TIMEOUT_MS` (8 s to list, under
`worktree list --containers`' own 10 s). A separate `fleet()` module comes with `locate()`. The plan was:
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

**One daemon, several names (added 2026-11-16).** A remote may be a `kunj serve` on this same Docker
(a local test server), and two remote names may point at one box. Their listings are the same
containers, so a container **id** is listed once, under the first member that has it (this machine,
then remotes by name); orphans are deduplicated the same way. When no member answers, the default
backend's error is thrown, as a single-backend listing always did. The text listing marks a remote's
rows `[on <name>]` (no REMOTE column) and prints one line per member that did not answer.

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

- **New session:** under Container, a "Run on" popup: "This Mac" and each remote, preselected to the
  default backend from the repository's `ct list --json` (`backend.remote`) when it answers, else the
  first that does. The names come from that listing's `backends` (as built: no `kunj remote list`
  call, and it knows who answers), so a remote that did not answer is listed "(not answering)" and
  cannot be picked. The popup shows only for a container and only when a remote is registered. It
  passes `--remote <name>` (or `--remote local`) to `kunj ct start -c`; with no popup nothing is
  passed. Container stays disabled only when no member of the fleet answers. `runOnChoices()` in
  `EnvironmentList.swift`.
- **Rows:** a container on a remote shows the remote's name after its icon in the sidebar row and
  `container on <name>` in the header's meta line. A remote that does not answer greys its rows
  (kept from the last listing) instead of dropping them: **not built**, the rows leave the list.
- **One row per branch (as built):** an environment's id, tabs and saved layout are keyed by
  repository, kind and branch, so a branch with a container on two backends shows the first listed
  only. The CLI lists both.
- `ct open` is disabled for a container on a remote, with the reason (the CLI refuses it too).
- **Actions and tabs:** every `kunj ct …` the app runs for a container (shell and agent tabs and
  their `--kill`, start, stop, remove, rebuild, file read and write, `ct exec` for the Changes column
  and the file list) passes `--remote <row.remote ?? local>` (`Environment.remoteArguments`), so it
  never locates. `ct prune`, `kunj search --in containers` and `kunj sessions --containers` are not
  per container and still use the default backend.
- `MIN_KUNJ_VERSION` does not change: `--remote local` exists since remote containers shipped, and the
  new JSON fields are optional.

## Tests

- Unit: `fleet()` with fake members (one slow past the timeout, one failing), `locate()` for one, none,
  several and none-with-an-unreachable member, `ct list --json` merging two `FakeBackend`s, detached
  child args, events with two backends per repo.
- Workspace app: the picker's options and default from fixture JSON; `fake-kunj` answers
  `remote list --json`.
- `npm run test:remote` unchanged (explicit `--remote`).
