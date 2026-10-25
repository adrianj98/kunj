---
type: Application
title: VS Code Extension (Kunj Worktrees)
description: A VS Code extension that shows the repository's git worktrees and branch containers in a tree view and drives every action through the kunj CLI's JSON output.
resource: vscode-extension
tags: [app, vscode, extension, worktrees, containers, editor-sessions]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj-worktrees` (publisher `kunj`, id `kunj.kunj-worktrees`) adds a **Kunj** activity bar container with
one view, `kunjWorktrees`. The view lists every worktree of each repository open in the window, and
(when `kunj.worktrees.showContainers` is on) the repository's [branch containers](/containers/overview.md)
as rows that behave like worktrees. It shows which worktrees are open in other VS Code windows, their
status, their pull request and the agent state.

The extension never runs git or docker itself. Every read is a `kunj ... --json` call through
`KunjCli.run()` in `src/kunjCli.ts`, and long or interactive actions run `kunj` in an integrated
terminal. That makes it the first consumer of the [JSON contract](/architecture/json-contract.md), so the
CLI's JSON must stay backwards compatible.

It is a separate npm package with its own `package.json`, bundled by esbuild into `dist/extension.js`
(`--platform=node --target=node18 --external:vscode`), activated `onStartupFinished`, and requires
VS Code `^1.85.0`.

# Source layout

| File | Role |
| --- | --- |
| `src/extension.ts` | Activation, status bar item, refresh timer, `worktree-sessions.json` watcher, worktree commands |
| `src/kunjCli.ts` | `KunjCli` (spawn `kunj <args> --json`, parse, map errors to `KunjCliError` codes `not-found`, `not-a-repo`, `command-failed`) and TypeScript mirrors of the listing (`Worktree`, `BranchContainer`, `PullRequest`, `WorktreeListResult`) |
| `src/worktreeProvider.ts` | Tree data provider: `RepoNode`, `WorktreeNode`, container and port nodes, grouping by repository, `contextValue` flags for menus |
| `src/containerCommands.ts` | `kunj.containers.*` commands; helpers `runInTerminal` and `runToCompletion` (a `/bin/sh -c` terminal that closes itself on exit 0) |
| `src/eventStream.ts` | `EventStream`: one `kunj events --json --repo <root>…` child per window for the repositories in the view (a new child when that set changes, `reset()` when `kunj.cliPath` changes), stdin held, restarted after 2 s doubling to 60 s; `eventReaction()` decides which lines refresh, debounced to one a second |
| `src/sessionManager.ts` | Registers each workspace folder as an [editor session](/features/editor-sessions.md); heartbeat every 5 minutes (`HEARTBEAT_MS`) |

# kunj commands it runs

JSON calls (through `KunjCli.run`, `--json` appended):

| Call | Purpose |
| --- | --- |
| `worktree list [--no-status] [--no-pr] [--fresh] [--containers]` | The whole view, one call per repository |
| `worktree add <branch> [path] [--new-branch] [--base <b>] [--force]` | Add Worktree… |
| `worktree remove <path> [--force]` | Remove Worktree… (offers `--force` when open elsewhere or dirty) |
| `worktree prune` | Prune Stale Worktrees |
| `worktree path <target>` | Resolve a worktree |
| `worktree pr <path> --fresh` | Open Pull Request when the listing had none |
| `worktree session start --path <p> --pid <pid> --editor vscode [--label] [--id]` / `session end --id <id>` | Session registration (`end` also via `execFileSync` on deactivate) |
| `list --all` | Branch picker in Add Worktree… |
| `ct open <branch> [--new-window]` | Open Container (reads `uri`, `warning`, `exec` from the result) |
| `ct stop <branch>` | Stop Container |
| `ct forward <branch> --auto --detach` | Forward Ports Automatically |

Terminal commands: `agent` (in the worktree), `pr` (Create Pull Request…), `ct shell <b>`,
`ct agent <b>`, `ct start <b> [-c] [--base <b>]`, `ct start <b> --rebuild`, `ct remove <b>`,
`ct forward <b> <port>`, `ct prune`, and `gh pr create --web --head <b>` for a container's branch.

When the CLI rejects `--containers` with "unknown option", the provider sets `containersUnsupported`
and lists without it from then on, so older kunj versions still show worktrees.

# Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `kunj.cliPath` | `kunj` | Executable, may include leading args (`node /path/dist/index.js`) |
| `kunj.worktrees.clickAction` | `newWindow` | `newWindow`, `currentWindow` or `ask` |
| `kunj.worktrees.refreshInterval` | `30` | Seconds between refreshes, 0 disables |
| `kunj.worktrees.showStatus` | `true` | Omit to pass `--no-status` |
| `kunj.worktrees.showPath` | `true` | Path next to the branch |
| `kunj.worktrees.showStatusBar` | `true` | Current worktree in the status bar (click: `kunj.worktrees.pick`) |
| `kunj.worktrees.trackSessions` | `true` | Register sessions with `kunj worktree session` |
| `kunj.worktrees.showPullRequests` | `true` | Omit to pass `--no-pr` |
| `kunj.worktrees.showContainers` | `true` | Pass `--containers` |

# Refresh and sessions

```
activate ─> SessionManager.sync() ─> kunj worktree session start (per folder)
        ├─> timer (refreshInterval) ─┐
        ├─> window focus ────────────┼─> kunj worktree list --json [--containers]
        ├─> ~/.kunj/worktree-sessions.json changed (300 ms debounce,
        │   ignored within 2 s of our own write) ──┤
        ├─> kunj events: git, forwards, agent, backend, ──┤
        │   container with a repo (1 s debounce) ─┘
        └─> Refresh button ─> same call with --fresh (bypass the PR cache)
```

A worktree click uses `vscode.openFolder`; when another window already has it, VS Code focuses that
window. Containers open through `kunj ct open`, which launches an attached Dev Containers window; the
returned `warning` (editor credentials) is shown once. Remote workspaces work when kunj is installed on
the remote side.

# Build and release

`npm run build` (esbuild), `npm run lint` (`tsc --noEmit`), `npm run package` (`vsce package
--no-dependencies`). The release workflow's `release` job runs `npm ci`, sets the version and packages the
`.vsix`, attaching `kunj-worktrees-<version>.vsix` to the GitHub release. `kunj install vscode
[--editor <cli>]` finds that asset by `/^kunj-worktrees-.*\.vsix$/` and runs `<editor> --install-extension
<vsix> --force` (`src/lib/apps.ts`, see [Setup and Install](/features/setup-and-install.md)).

# Related Concepts

* [Worktrees](/features/worktrees.md) - the `kunj worktree` command it wraps
* [Editor Sessions](/features/editor-sessions.md) - how "open in other windows" works
* [PR Lookup Cache](/features/pr-lookup-cache.md) - why periodic refreshes do not hit the network
* [Container Editor Open](/containers/editor-open.md) - `kunj ct open`
* [JSON Contract](/architecture/json-contract.md)
* [macOS Menu Bar App](/apps/macos-app.md) - the same feature set outside the editor
* [Release Process](/architecture/release-process.md)

# Citations

[1] [vscode-extension/package.json](/vscode-extension/package.json)
[2] [vscode-extension/src/kunjCli.ts](/vscode-extension/src/kunjCli.ts)
[3] [vscode-extension/src/extension.ts](/vscode-extension/src/extension.ts)
[4] [vscode-extension/src/containerCommands.ts](/vscode-extension/src/containerCommands.ts)
[5] [vscode-extension/src/sessionManager.ts](/vscode-extension/src/sessionManager.ts)
[6] [vscode-extension/src/worktreeProvider.ts](/vscode-extension/src/worktreeProvider.ts)
[7] [vscode-extension/README.md](/vscode-extension/README.md)
[8] [.github/workflows/release.yml](/.github/workflows/release.yml)
[9] [src/lib/apps.ts](/src/lib/apps.ts)
[10] [docs/specs/containers-in-apps.md](/docs/specs/containers-in-apps.md)
[11] [vscode-extension/src/eventStream.ts](/vscode-extension/src/eventStream.ts)
