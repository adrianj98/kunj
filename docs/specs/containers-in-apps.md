# Containers in the VS Code extension and the macOS app

Branch containers (`kunj ct`) shown and managed in the two older consumers of the CLI's JSON: the VS
Code extension (`vscode-extension/`) and the menu bar app (`macos-app/`). The workspace app already
has them ([workspace-ide.md](workspace-ide.md)).

## Status

| Part | State |
| --- | --- |
| CLI: `kunj worktree list --json --containers` | Shipped |
| VS Code extension: container rows and actions | Shipped, tried against live containers |
| macOS app: container rows and actions | Shipped, tried against live containers |
| Refresh on `kunj events` | Shipped |

## Principle

A container is another place a branch lives, and it should feel like a local worktree: same row, same
status, same actions, only a small container mark tells them apart. A branch that has both a worktree
and a container shows **two rows**, side by side, each with its own status (they can differ: another
HEAD, one dirty and the other not).

| Action | Worktree row | Container row |
| --- | --- | --- |
| Open in editor | open the folder | `kunj ct open <branch>` (attached window; resumes a stopped container) |
| Terminal | shell in the folder | `kunj ct shell <branch>` in a terminal |
| Agent | `kunj agent <branch>` | `kunj ct agent <branch>` |
| Status | dirty, ahead, PR, agent running/waiting | the same, from `workspace`, `agent` and `pullRequest` |
| Pull request | open / copy URL / create | the same (PRs are looked up by branch) |
| Ports | — | each port as `localhost:<host>`, opened in the browser; Forward Port… runs `kunj ct forward <branch> <port>` |
| Start / stop | — | `kunj ct start <branch>` (terminal) / `kunj ct stop <branch>` |
| New | Add Worktree… | the same dialog asks where: worktree or container (`kunj ct start -c <branch>`, terminal) |
| Remove | Remove Worktree… (guarded) | Remove Container… (`kunj ct remove <branch>` in a terminal, so its guard can ask) |
| Prune | Prune Stale Worktrees | Prune Containers… (`kunj ct prune` in a terminal) |

Long or interactive commands (start, create, remove, prune, rebuild) run in a terminal, as in the
workspace app's `ActionSpec`; quick ones (stop, open, forward) run directly and report errors.

## CLI contract

`kunj worktree list --json --containers` adds, without changing any existing field:

```ts
interface WorktreeListJson {
  // ...existing fields
  /** Present only with --containers */
  containers?: {
    /** false when Docker could not be asked; `items` is then empty and `message` says why */
    available: boolean;
    message?: string;
    items: BranchContainerJson[];
  };
}

/** A `kunj ct list --json` container plus the branch's pull request (same lookup as worktrees) */
type BranchContainerJson = ContainerJson & { pullRequest?: PullRequestInfo | null; prLabel: string | null };
```

The containers are listed (one `docker ps`, one status exec per running container, the same code as
`kunj ct list`) concurrently with the git calls, and the PRs come from the same single `gh pr list`. The
container module is imported lazily, only with `--containers`, so the plain listing stays on the fast
path. Docker being down never fails the listing. `--no-status` skips the per-container exec too.

The apps join nothing themselves: worktrees and containers are two lists, rows are ordered by branch
so a branch's two rows sit together, and a worktree row knows it has a container when a container with
the same exact branch name exists (`feature/x` and `feature-x` stay distinct).

## VS Code extension

The Worktrees view lists both kinds under each repository, ordered by branch (the main worktree first).
Container rows use the `package` icon (green running, grey stopped), description `container · ↑2 ·
dirty · #12`, a tooltip with image, ports and services, and `contextValue` flags (`container`,
`running`/`stopped`, `pr`/`nopr`, `ports`) for the menus. Clicking a container row runs Open (attach).
Ports are child rows of a running container (`localhost:3000 → 3000`); clicking one opens it with
`vscode.env.openExternal`. Setting `kunj.worktrees.showContainers` (default true) passes
`--containers`. When Docker is unavailable the containers are just absent (no error popup).

## macOS app

Each repository's section lists worktree rows and container rows ordered by branch. A container row
looks like a worktree row with a container glyph, the same status chips, and a context menu with the
actions above; terminal actions open Terminal (the app's existing launcher) with the `kunj` command.
`Show containers` in Settings (default on).

## Refresh

Both apps keep their refreshes (timer, focus, the `~/.kunj` watchers) and also follow one long-lived
`kunj events --json` child: the extension one per window with `--repo` for the repositories in the
view (a new child when that set changes), the macOS app one for every known repository (a new child on
a `repos` event, since `kunj events` resolves its repositories once). The child's stdin is held, so it
dies with the app; an exited child is started again after 2 s, doubling to 60 s.

| Event | Reaction |
| --- | --- |
| `git`, `forwards`, `agent`, `backend` | refresh |
| `container` with a `repo` | refresh |
| `container` with `repo: null` | ignored: `kunj events` reports every kunj container on the daemon, and another repository's (a functional test run, say) would refresh the view every second |
| `hello` | refresh only after a restart (events from the gap are lost) |
| `sessions`, `repos` | ignored (the file watchers refresh; `repos` restarts the macOS app's child) |

Refreshes are debounced to one a second, because a container start is several Docker events.
`EventFeed.swift` (KunjBarCore, tested) and `eventReaction()` in the extension's eventStream.ts decide.

## Decisions

- **2026-10-25** Tried against live containers (a throwaway repository with a `git daemon` origin): the
  listing, both apps' decoding and tree, stop and auto-forward. Found and fixed: a second
  `ct forward --auto --detach` started another forwarder (now reports the registered one,
  `alreadyRunning`), and `kunj events` container events of other repositories (now ignored by the apps).

- **2026-10-24** Containers and worktrees show as rows of the same kind; two rows when a branch has
  both. The CLI provides both lists in one call (with PRs); the apps do no matching of their own.
