---
type: Application
title: Workspace App (Kunj Workspace.app)
description: A native macOS app that shows every worktree and branch container as an environment with its own terminals, agent tabs, Changes diff and editor tabs, all driven through kunj's JSON commands.
resource: workspace-app
tags: [app, macos, appkit, swiftterm, monaco, workspace-ide, agents]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Kunj Workspace is phase 3 of the container system ([docs/specs/workspace-ide.md](/docs/specs/workspace-ide.md)):
one window where every branch is an **environment**, either a local worktree or a branch container,
grouped by repository. Selecting an environment swaps the right side (tab bar, terminals, Changes
column). Background environments keep their terminals alive. It sits beside VS Code; `kunj worktree open`
and `kunj ct open` hand off to the editor.

It is AppKit + SwiftTerm, with Monaco in WKWebViews, built as a SwiftPM package (macOS 14+, Swift 5
language mode). It is the third consumer of the [JSON contract](/architecture/json-contract.md). It runs
`kunj … --json` with `cwd` set to the repository root and the branch named. It never imports kunj or runs
`docker`, and runs `git` read-only with `GIT_OPTIONAL_LOCKS=0`. Its only state is UI layout in
`~/.kunj/<repo>/workspace.json` plus the user defaults `kunjCommand`, `theme` and `showChanges`.

`MIN_KUNJ_VERSION` (`CLI/Version.swift`) is `1.3.0`. A kunj reporting `1.0.0` is accepted as an
`npm link`ed dev build. Any JSON or command change the app relies on must stay additive.

# Targets and code map

| Path | What |
| --- | --- |
| `KunjWorkspaceCore` (Foundation only) | `CLI/` (`KunjCLI`, `ShellEnvironment`, `EventStream`, `ProcessRunner`, `Version`), `JSON/KunjJSON.swift` (Codable mirrors of `src/lib/json-types.ts`), `Model/` (`Environment` id `<repo>\|<kind>\|<branch>`, `EnvironmentList`, `EnvironmentStore`, `EnvironmentFilter`), `Terminal/` (`TerminalSpec`, `HiddenFeedScheduler`), `Diff/` (`DiffService`, `DiffModel`, `ChangesList`, `GitRunner`), `Files/` (`FileAccess`, `EditorSave`, `FileTree`), `Layout/WorkspaceLayout.swift`, `Actions/` (`ActionSpec`, `ContainerTokens`), `Design/` (generated `DesignTokens`) |
| `KunjWorkspace` (app) | `AppDelegate` (launch args, menus, wiring), `Views/` (sidebar, header, tab bar, terminal, Changes and Files columns, status bar), `Terminal/TerminalTab`, `Model/TabRegistry`, `Model/LayoutKeeper`, `Editor/MonacoWebView` + `EditorTab`, `Actions/ActionRunner`, `Sheets/NewSessionSheet`, `Settings/SettingsWindow`, `Theme/`, `Demo/` |
| `KunjWorkspaceCoreTests` | Swift Testing suites against `Tests/Fixtures/fake-kunj` (a `sh` script printing `responses/<name>.json`) |
| `Resources/web/` | Monaco page: `?mode=diff` (Changes) and `?mode=editor` (editor tabs) |
| `web/` | npm package pinning `monaco-editor` 0.57.0; `copy-monaco.js` copies `min/vs` into `Resources/web/vs` |

A spike in `spikes/monaco-vscode-api/` (2026-10-27) ran `@codingame/monaco-vscode-api` 38 as an editor only
(TextMate, VS Code themes, language extensions) in a WKWebView from the same `kunj` scheme: it works, for
about +30 MB and +0.4 s to first coloured code; `monaco.editor.defineTheme` is not available there. Not adopted yet.

# kunj commands it runs

| Command | Purpose |
| --- | --- |
| `-V` | Version check at discovery |
| `repos` | The repositories to list |
| `worktree list`, `ct list` | Environments, merged by `EnvironmentList` |
| `events --json` | Long-lived NDJSON child with stdin held open; restarted with backoff ([Events Stream](/features/events-stream.md)) |
| `agent <b> [--session <id>]` / `agent stop <b> --session <id>` / `agent stop <b> --all` | Agent tabs on a worktree ([Worktree Agents](/features/worktree-agents.md)) |
| `worktree shell <b> --session <id> [--kill]`, `worktree shell <b> --kill` | Persistent shell tabs ([Persistent Shells](/features/persistent-shells.md)) |
| `ct agent <b> [--session <id>] [--kill]`, `ct shell <b> [--session <id>] [--kill]` | Same, in a container ([Container Agents](/containers/container-agents.md)) |
| `ct exec <b> -- git …` | Container diffs (`DiffService`) |
| `search --regexp=<q> [-F] [-i] [-w] --in worktrees\|containers [--branch=<b>]` | The Files column's Search mode ([Search](/features/search.md)) |
| `ct file read <b> <path>`, `ct file write <b> <path>` | Editor tabs on a container ([Container Files](/containers/files.md)) |
| `ct start <b> [--rebuild]`, `ct stop`, `ct remove`, `ct open`, `ct prune` | Header and overflow actions (`actionPlan`) |
| `worktree open <path> [--new-window]`, `worktree remove <path>` | Worktree actions |
| `worktree add <b> -c [--base <b>]`, `ct start <b> -c [--base <b>]` | New Session sheet (`newSessionPlan`) |
| `pr` | Create PR (in the host worktree of the branch) |
| `config --get <key> --global` / `config --set <key>=<v> --global` | Settings for `agent.tmux`, `agent.tmuxStatus`, `container.useGhToken` (`KunjSetting`) |
| `ct token status`, `ct token check --json` (Test), `ct token setup` (Set Up…, in a tab), `secret list --global`, `secret rm CLAUDE_CODE_OAUTH_TOKEN --global` | Settings › Containers ([Tokens](/containers/tokens.md), [Secrets](/secrets/overview.md)) |

Actions are planned in `ActionSpec.swift` as `terminal` (an action tab running `kunj <args>`), `run`
(`--json`), `external`, `local` or `disabled(reason:)`, so an unavailable action shows why.

# Behaviour

* Terminal and agent tabs reattach to kunj's tmux sessions, so agents survive an app relaunch. Hidden
  tabs are fed under a 4 ms budget (`HiddenFeedScheduler`).
* `EnvironmentStore` refreshes per repository, scoped by the event that arrived.
* The Changes column diffs against the base, uncommitted changes or the last commit (`DiffService`),
  via `git` for worktrees or `kunj ct exec` for containers.
* ⌘-click on a file path in a terminal opens it in an editor tab (`terminalLinkPaths()` in
  `KunjWorkspaceCore/Terminal/TerminalLink.swift`, wired through `TerminalTab.onOpenLink` and
  `TabRegistry.onOpenFile`); URLs and paths outside the environment go to SwiftTerm's default opener.
* Selecting over mouse reporting (`TerminalTab.mouseDown`): ⌥/⇧-drag selects where a program has the
  mouse; a shell tab selects on every press, because tmux's `mouse on` copy never reaches the clipboard.
* Terminal colours (`TerminalTab.apply`): background, text, cursor, selection and ANSI red/green/amber/blue
  come from the theme, magenta and cyan are fixed real hues, and colours 16-255 are xterm's
  (`ansi256PaletteStrategy = .xterm`), because SwiftTerm's default re-tinted them with the theme.
* Tab pills have an × (`PillView.onClose`), and the Changes and Files bars a close button.
* The sidebar, the terminal/Changes split, the Files column and the Changes file list are resized by
  dragging their hairlines (`DividerHandle`, `PaneSizes` in KunjWorkspaceCore fitted to the window,
  saved as `paneSizes` in user defaults; double-click resets).
* The Files column has a Search mode (Find in Files ⌘⇧F, `SearchPanel`): `kunj search` in the selected
  worktree or container by default, all worktrees (and containers) from its scope menu; a match opens
  an editor tab at its line with the match selected (`EditorTab.reveal`, `revealLine` on the editor page, which turns kunj's character columns into UTF-16). Model in
  `KunjWorkspaceCore/Search/Search.swift`.
* Clone from GitHub… (⌥⌘N, `CloneRepoSheet`): `kunj repos github --json`, filtered by a search field,
  repositories already here last and disabled; Clone runs `kunj repos clone <owner/name> --json` and reloads.
* Shortcuts include New Shell (⌘T), New Session (⌘N), Clone from GitHub (⌥⌘N), Search Sessions (⌘K), Show Changes, Show Files,
  Close Tab (⌘W) and Session 1-9.
* Launch arguments: `--demo`, `--screenshot <png>`, `--theme warm|light|graphite`,
  `--changes`/`--no-changes`, `--files`/`--no-files`, `--loading`, `-kunjCommand`, `-openTabs`, `-searchQuery`, `-searchOpen`.
* The kunj command is the `kunjCommand` default, else `kunj` on the login shell's PATH (`$SHELL -l -i`,
  5 s cap, then `$SHELL -l`).

# Build and release

`scripts/prepare-swiftterm.sh` clones SwiftTerm 1.20.0 into `vendor/` and patches it (shaders copied,
child closes descriptors above 2). `scripts/fetch-fonts.sh` downloads Inter and JetBrains Mono
(sha256-pinned), and `scripts/gen-tokens.js` regenerates `DesignTokens.swift` from
`docs/workspace-app/design/tokens.json`. `scripts/test.sh` runs `swift test`. `scripts/bundle.sh
[--install]` builds each architecture, joins them with `lipo` and writes an ad-hoc signed
`build/Kunj Workspace.app`. `SCRATCH`, `ARCHS`, `VERSION`, `CODESIGN_IDENTITY` and `SDKROOT` tune the
build. The release workflow's `workspace-app` job runs `npm ci` in `web/` and `bundle.sh`, then attaches
`Kunj-workspace-<version>.zip`. `kunj install workspace` installs it as `Kunj Workspace.app` (quitting
`KunjWorkspace` first). There are no UI tests; view changes are checked with a `--demo --screenshot`
against `docs/workspace-app/design/mockups/warm.png`.

# Related Concepts

* [Events Stream](/features/events-stream.md) - what drives refreshes
* [Worktree Agents](/features/worktree-agents.md), [Persistent Shells](/features/persistent-shells.md), [Container Agents](/containers/container-agents.md)
* [Container Files](/containers/files.md), [Env and Status](/containers/env-and-status.md)
* [JSON Contract](/architecture/json-contract.md)
* [macOS Menu Bar App](/apps/macos-app.md), [VS Code Extension](/apps/vscode-extension.md)
* [Testing](/architecture/testing.md), [Release Process](/architecture/release-process.md)

# Citations

[1] [workspace-app/Package.swift](/workspace-app/Package.swift)
[2] [workspace-app/README.md](/workspace-app/README.md)
[3] [workspace-app/Sources/KunjWorkspaceCore/CLI/Version.swift](/workspace-app/Sources/KunjWorkspaceCore/CLI/Version.swift)
[4] [workspace-app/Sources/KunjWorkspaceCore/CLI/EventStream.swift](/workspace-app/Sources/KunjWorkspaceCore/CLI/EventStream.swift)
[5] [workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift](/workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift)
[6] [workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift](/workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift)
[7] [workspace-app/Sources/KunjWorkspaceCore/Actions/ContainerTokens.swift](/workspace-app/Sources/KunjWorkspaceCore/Actions/ContainerTokens.swift)
[8] [workspace-app/Sources/KunjWorkspaceCore/Diff/DiffService.swift](/workspace-app/Sources/KunjWorkspaceCore/Diff/DiffService.swift)
[9] [workspace-app/Sources/KunjWorkspace/AppDelegate.swift](/workspace-app/Sources/KunjWorkspace/AppDelegate.swift)
[10] [workspace-app/web/package.json](/workspace-app/web/package.json)
[11] [docs/specs/workspace-ide.md](/docs/specs/workspace-ide.md)
[12] [.github/workflows/release.yml](/.github/workflows/release.yml)
[13] [src/lib/apps.ts](/src/lib/apps.ts)
