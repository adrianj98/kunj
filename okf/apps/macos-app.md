---
type: Application
title: macOS Menu Bar App (Kunj.app)
description: A SwiftUI menu bar app that lists the worktrees and branch containers of every repository kunj knows, opens them, notifies on pull request changes and organizes editor and terminal windows across desktops.
resource: macos-app
tags: [app, macos, swiftui, menu-bar, worktrees, containers, window-management]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`macos-app/` is a SwiftPM package (no Xcode project, macOS 14+) that builds `Kunj.app`, bundle id
`dev.kunj.KunjBar`, executable `KunjBar`, an `LSUIElement` agent with no Dock icon. It is a SwiftUI
`MenuBarExtra` plus `Window`s for Settings and a log. It offers the [VS Code extension](/apps/vscode-extension.md)'s
features for every repository in `kunj repos`, not just one editor window.

Like the extension it never runs git: `KunjCLI` (`Sources/KunjBar/CLI/KunjCLI.swift`) runs `kunj <args>
--json` through `/usr/bin/env` and decodes the result with `Codable` models in `Models.swift`. Apps
launched from Finder get a minimal `PATH`, so `ShellEnvironment.path` resolves it once from `$SHELL -l -i`
(5 s cap) and appends a Homebrew/system fallback. `NO_COLOR` and `FORCE_COLOR` are removed from the
child environment because kunj hands its environment on to the editor it opens.

# Targets

| Target | Contents |
| --- | --- |
| `KunjBarCore` | Pure, tested logic: `Slots`, `Layout`, `Grouping`, `OrganizePlan`, `PlaceOrder`, `DesktopChoice`, `EmptyDesktops`, `WindowMatching`, `Thumbnails` |
| `KunjBar` | The app: `CLI/` (`KunjCLI`, `Models`), `Store/AppStore.swift`, `Views/` (`PanelView`, `WorktreeRow`, `ContainerRow`, `NewWorktreeView`, `SettingsView`, `SwitcherView`), `Support/` (Accessibility, Mission Control, Spaces, hot key, launcher, notifier, organizer, preferences, watcher) |
| `KunjBarCoreTests` | Swift tests for `KunjBarCore`, run with `scripts/test.sh` |

# kunj commands it runs

| Command | Where |
| --- | --- |
| `repos` / `repos add <path>` / `repos remove <path>` | Repository list, Add Repository…, Remove from List (cwd = home) |
| `worktree list [--no-status] [--no-pr] [--fresh] [--containers]` | One call per repository, all concurrently (`withTaskGroup`); retried without `--containers` when the CLI rejects it |
| `worktree open <path> [--new-window]` | Click a worktree (`worktree.editorCommand`); the spinner waits up to 15 s for the editor's session |
| `worktree add <branch> [path] [--new-branch] [--base <b>] [--no-origin]` | New Worktree window, stderr streamed as progress |
| `worktree remove <path> [--force]`, `worktree prune`, `worktree pr <path> --fresh` | Row actions |
| `list --all` | Branch picker |
| `ct open <b> [--new-window]`, `ct stop <b>`, `ct forward <b> --auto --detach` | Container rows (JSON) |
| `ct shell`, `ct agent`, `ct start [--rebuild]`, `ct remove`, `ct prune`, `ct start <b> -c` | Run in the chosen terminal app via `Launcher.runInTerminal` (a temporary `.command` file) |
| `pr` | Create Pull Request, in a terminal |

# Refresh

`AppStore` refreshes on a timer (`refreshInterval`, default 60 s), when the panel opens, and when
`KunjDirWatcher` sees `worktree-sessions.json` or `repos.json` change in `~/.kunj` (directory watched,
modification times compared against a snapshot taken after each refresh, so its own listings do not
loop), and on [`kunj events --json`](/features/events-stream.md): `EventStream` (`CLI/EventStream.swift`)
keeps one child for every known repository with its stdin held (it dies with the app), started again
after 2 s doubling to 60 s. `eventReaction()` (`KunjBarCore/EventFeed.swift`, tested) refreshes on
`git`, `forwards`, `agent`, `backend` and on `container` events that carry a `repo` (`repo: null` is
another repository's container: the daemon reports them all), on `hello` only after a restart, and
restarts the child on `repos` (kunj events resolves its repositories once); `sessions` is left to the
watcher. Event refreshes are debounced to one a second.
A failed listing keeps the last good one for that repository.

# Features

* Rows per repository with dirty count, ahead/behind, editor sessions, PR state, checks and review;
  container rows right after their branch's worktree, with ports, agent state and actions.
* `Notifier`: notifications when a PR's checks fail or pass, or it is approved or merged; failing
  checks counted in the menu bar (`badgeFailingChecks`).
* Filter field and an "Open only" toggle (`onlyOpenWorktrees`).
* `Switcher`: a global hot key (default Option-Command-K, `Shortcut.defaultSwitcher`) shows a panel of
  worktrees open in an editor.
* **Organize Windows** (`Organizer`, design in `docs/specs/organize-windows.md`): editor windows (VS Code,
  Cursor, VSCodium, Windsurf) and terminal windows (`Launcher.terminalApps`) are matched to worktrees by
  `AXDocument` path, then title, paired two per desktop on a chosen screen, and moved by driving Mission
  Control. Needs Accessibility access. Settings: screen, layout (`editorLeft` default), which kinds take
  part, and "Remove empty desktops afterwards" (`organizeRemoveEmpty`, on). Each worktree's desktop is
  remembered in `organizeDesktops`.

# Preferences (UserDefaults)

| Key | Default |
| --- | --- |
| `cliPath` | `kunj` |
| `refreshInterval` | `60.0` |
| `showStatus`, `showPullRequests`, `showContainers` | `true` |
| `showPath` | `false` |
| `terminalApp` | `Terminal` (one of Terminal, iTerm, Ghostty, Warp, WezTerm, kitty, Alacritty) |
| `notifyPullRequests`, `badgeFailingChecks` | `true` |
| `organizeScreen` / `organizeLayout` / `organizeEditor` / `organizeTerminal` | `""` / `editorLeft` / `true` / `true` |
| `switcherEnabled` | `true` |

# Build and release

`scripts/bundle.sh` runs `swift build -c release --arch arm64 --arch x86_64`, retrying with older
Command Line Tools SDKs when the default one lacks the SwiftUI macro plugin, writes
`build/Kunj.app` with `Resources/Info.plist` (`__VERSION__` from `VERSION`, default `0.1.0`) and signs it
ad hoc, or with `CODESIGN_IDENTITY` so the Accessibility grant survives rebuilds. `--install` copies it to
`/Applications` and launches it with `NO_COLOR`/`FORCE_COLOR` unset. The release workflow's `macos-app`
job (macos-15) zips it as `Kunj-macos-<version>.zip` and attaches it; `kunj install macos` finds it by
`/^Kunj-macos-.*\.zip$/`, quits `KunjBar`, unzips with `ditto`, clears the quarantine and opens it. Not
notarized. `KUNJBAR_SNAPSHOT=<dir>` renders sample rows to PNGs for colour checks.

# Related Concepts

* [Repository Identity and Registry](/architecture/repo-identity-and-registry.md) - `kunj repos`, `repos.json`
* [Worktrees](/features/worktrees.md), [Editor Sessions](/features/editor-sessions.md)
* [Events Stream](/features/events-stream.md)
* [Container Editor Open](/containers/editor-open.md), [Forwarding](/containers/forwarding.md)
* [VS Code Extension](/apps/vscode-extension.md), [Workspace App](/apps/workspace-app.md)
* [Setup and Install](/features/setup-and-install.md) - `kunj install`

# Citations

[1] [macos-app/Package.swift](/macos-app/Package.swift)
[2] [macos-app/Sources/KunjBar/CLI/KunjCLI.swift](/macos-app/Sources/KunjBar/CLI/KunjCLI.swift)
[3] [macos-app/Sources/KunjBar/Store/AppStore.swift](/macos-app/Sources/KunjBar/Store/AppStore.swift)
[4] [macos-app/Sources/KunjBar/Support/Preferences.swift](/macos-app/Sources/KunjBar/Support/Preferences.swift)
[5] [macos-app/Sources/KunjBar/Support/Launcher.swift](/macos-app/Sources/KunjBar/Support/Launcher.swift)
[6] [macos-app/Sources/KunjBar/Support/KunjDirWatcher.swift](/macos-app/Sources/KunjBar/Support/KunjDirWatcher.swift)
[7] [macos-app/Sources/KunjBar/Views/ContainerRow.swift](/macos-app/Sources/KunjBar/Views/ContainerRow.swift)
[8] [macos-app/scripts/bundle.sh](/macos-app/scripts/bundle.sh)
[9] [macos-app/README.md](/macos-app/README.md)
[10] [docs/specs/organize-windows.md](/docs/specs/organize-windows.md)
[11] [docs/specs/containers-in-apps.md](/docs/specs/containers-in-apps.md)
[12] [.github/workflows/release.yml](/.github/workflows/release.yml)
[13] [src/lib/apps.ts](/src/lib/apps.ts)
[14] [macos-app/Sources/KunjBarCore/EventFeed.swift](/macos-app/Sources/KunjBarCore/EventFeed.swift)
[15] [macos-app/Sources/KunjBar/CLI/EventStream.swift](/macos-app/Sources/KunjBar/CLI/EventStream.swift)
