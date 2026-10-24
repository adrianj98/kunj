# Kunj Workspace

A native macOS app (AppKit, SwiftPM, no Xcode project) that lists every worktree and branch
container kunj knows about as an environment, keeps terminals and agent sessions per environment,
shows each environment's changes in Monaco and edits files in editor tabs. Everything goes through
the installed `kunj` CLI (`kunj … --json`); the app never imports kunj, never runs `docker`, and runs
`git` only read-only (`GIT_OPTIONAL_LOCKS=0`). Its only state is UI layout in
`~/.kunj/<repo>/workspace.json` and three user defaults (`kunjCommand`, `theme`, `showChanges`).

Users install it with `kunj install workspace` (or `kunj install all` on macOS), which downloads
`Kunj-workspace-<version>.zip` from the GitHub release; what it does for them is in the user docs,
[docs-site/src/content/docs/workspace-app.mdx](../docs-site/src/content/docs/workspace-app.mdx).
It needs kunj 1.3.0 or newer (`MIN_KUNJ_VERSION`; a kunj reporting `1.0.0` is an `npm link`ed dev
build, accepted and shown as `dev`), tmux to keep agents alive across launches, and Docker for
containers.

Design: [docs/specs/workspace-ide.md](../docs/specs/workspace-ide.md) (Layout, Architecture,
Decisions, open questions) and [docs/workspace-app/design/](../docs/workspace-app/design/) (the app
must look like `mockups/warm.png`). Plan: `docs/superpowers/plans/2026-10-23-workspace-app-v1.md`.

Building needs macOS 14+, the Command Line Tools (Swift 6.x, used in Swift 5 language mode), Node
and npm (Monaco), `curl`, `git` and network access on the first build.

## Layout

| Path | What |
| --- | --- |
| `Package.swift` | Targets `KunjWorkspaceCore` (Foundation only, unit tested), `KunjWorkspace` (the app: Core + SwiftTerm + AppKit/WebKit), `KunjWorkspaceCoreTests` |
| `Sources/KunjWorkspaceCore/Design/DesignTokens.swift` | Generated from `docs/workspace-app/design/tokens.json`; do not edit |
| `Resources/Info.plist` | Bundle plist; `__VERSION__` is filled in by `bundle.sh`; `ATSApplicationFontsPath` = `fonts` |
| `Resources/web/` | The Monaco page (`index.html`); `vs/` is copied in by the build (ignored) |
| `Resources/fonts/` | Inter and JetBrains Mono, fetched by the build (ignored) |
| `vendor/SwiftTerm/` | SwiftTerm 1.20.0, fetched and patched by the build (ignored) |
| `web/` | npm package pinning `monaco-editor` 0.57.0; `npm run build` copies `min/vs` to `Resources/web/vs` |
| `Tests/Fixtures/fake-kunj` | `sh` script standing in for kunj in the tests (below) |
| `Tests/Fixtures/responses/` | Its canned outputs |

## Scripts

All run from anywhere (they `cd` to `workspace-app/`).

| Script | Does |
| --- | --- |
| `scripts/test.sh [swift test args]` | `swift test` (e.g. `scripts/test.sh --filter FakeKunjTests`). Fetches SwiftTerm first, since SwiftPM resolves every dependency even for the Core tests |
| `scripts/bundle.sh [--install]` | SwiftTerm, fonts, Monaco, a release build per architecture joined with `lipo`, `build/Kunj Workspace.app` (Info.plist, SwiftTerm's resource bundle, `web/`, `fonts/`), ad-hoc signed. `--install` replaces `/Applications/Kunj Workspace.app` and launches it |
| `scripts/gen-tokens.js` | `node scripts/gen-tokens.js` regenerates `DesignTokens.swift` after `tokens.json` changes; `DesignTokensTests` fails when they drift |
| `scripts/prepare-swiftterm.sh` | Clones SwiftTerm v1.20.0 into `vendor/` and changes `Shaders.metal` from `.process` to `.copy` so it builds without Xcode's `metal` (compiled at runtime instead), and makes the forked terminal child close every descriptor above 2 (`forkpty` leaves the app's pipes open in it). `vendor/SwiftTerm/.kunj-version` holds `1.20.0+kunj2`; bump the suffix when the patches change. Takes a lock, so parallel runs wait for one fetch |
| `scripts/fetch-fonts.sh` | Downloads Inter 4.1 and JetBrains Mono 2.304, checks pinned sha256s, extracts the TTFs and licences into `Resources/fonts/`; skips when present |

Environment variables:

- `SCRATCH=<dir>` (both scripts): the SwiftPM build directory, relative to `workspace-app/`, passed
  as `--scratch-path`. Give each shell or agent its own (`SCRATCH=.build/me`) so builds never wait on
  another's lock. `bundle.sh` uses `<dir>/release-<arch>` per architecture, because the build system
  writes every triple's products to the same `out/Products/Release`.
- `ARCHS="arm64"` (bundle): build one architecture while iterating (default `arm64 x86_64`).
- `VERSION=1.4.0` (bundle): the version in Info.plist (default `0.1.0`).
- `CODESIGN_IDENTITY` (bundle): sign with a real identity instead of ad hoc (`-`).
- `SDKROOT`: force an SDK. Otherwise both scripts try the default SDK, then the installed Command
  Line Tools SDKs newest first (some lack the plugins the toolchain needs), and remember the one that
  worked in `<scratch>/.kunj-sdk`. A build failing with "plugin for module 'TestingMacros' not
  found" after an interrupted compile is retried once with the module caches cleared. If it still fails
  on every SDK, `rm -rf <scratch>/out` and run again.

`build/` is shared: two agents bundling at once overwrite each other's app. Take a screenshot right
after your own bundle.

## Running

```bash
scripts/bundle.sh && open "build/Kunj Workspace.app"
scripts/bundle.sh --install            # replace /Applications/Kunj Workspace.app and launch it
"build/Kunj Workspace.app/Contents/MacOS/KunjWorkspace" --demo --screenshot /tmp/ws.png
```

Launch arguments (after the executable):

| Argument | Does |
| --- | --- |
| `--demo` | Shows the mockup's environments, tabs and diff (`Demo/`) instead of kunj's, in the warm theme with the Changes column open; nothing is read from or written to `workspace.json` |
| `--screenshot <png>` | Renders the window after its first layout (waiting for Monaco's page, at most 8 s), writes the PNG (sRGB, 2x) and quits. Compare a `--demo` render with `docs/workspace-app/design/mockups/warm.png` |
| `--theme warm\|light\|graphite` (or `-theme`) | The theme for this run, not saved |
| `--changes` / `--no-changes` | The Changes column open or closed for this run, not saved |
| `--loading` | With `--demo`: the startup state (spinner, "Loading sessions…", "Finding kunj") instead of the demo data |
| `-kunjCommand "<command>"` | The kunj command for this run (`node /path/dist/index.js` for a dev build) |
| `-openTabs "<env id>#<kind>,…"` | After the first listing, selects each environment and opens the tab (`kunj\|worktree\|main#shell,kunj\|worktree\|main#agent`); an entry without `#kind` only selects, which restores its saved tabs. For checking PTYs live without assistive access |

The kunj command is the `kunjCommand` default (Settings, or
`defaults write dev.kunj.workspace kunjCommand "node /path/dist/index.js"`), else `kunj` on the login
shell's PATH (`$SHELL -l -i`, 5 s cap, then `$SHELL -l` when that times out). The app shows its
version at the sidebar's foot, or the error (`npm install -g kunj`) as the window's one message; after
a login-shell timeout the line under it says so, with the PATH it used. On launch it logs to stderr whether the bundled fonts registered (they
only do inside the `.app`). Not notarized: if macOS refuses to open it, right-click > Open, or
`xattr -dr com.apple.quarantine "/Applications/Kunj Workspace.app"`.

The app has no automated UI tests. A change to the views ends with `scripts/bundle.sh`, a
`--demo --screenshot` compared against `warm.png` (and `light.png`/`graphite.png` with `--theme`),
and a run against the real kunj. `--screenshot` composites the Changes diff page and the visible
terminals, not the editor page.

## Code map

| Path | What |
| --- | --- |
| `Sources/KunjWorkspaceCore/CLI/` | `KunjCLI` (runs kunj through `/usr/bin/env` with the login PATH, the version check), `ShellEnvironment` (login PATH, the PTY environment), `EventStream` (`kunj events --json` with stdin held open, restart with backoff), `ProcessRunner`, `Version` |
| `Sources/KunjWorkspaceCore/JSON/KunjJSON.swift` | `Codable` mirrors of `src/lib/json-types.ts` (fields optional where kunj may omit them) |
| `Sources/KunjWorkspaceCore/Model/` | `Environment` (id `<repo>\|<kind>\|<branch>`, `statusVerb`, `dot`, meta line), `EnvironmentList` (merging `worktree list` and `ct list`), `EnvironmentStore` (refreshes scoped by event, `onChange`, `onRepoChanged`), `EnvironmentFilter` (⌘K) |
| `Sources/KunjWorkspaceCore/Terminal/` | `TerminalSpec` (shell, agent and action tabs, refused with a reason for a missing worktree or stopped container), `tabDot`, `exitCode(waitStatus:)`, `HiddenFeedScheduler` (hidden tabs fed under a 4 ms budget) |
| `Sources/KunjWorkspaceCore/Diff/` | `DiffService` (scopes base/uncommitted/last, via `git` or `kunj ct exec`), `DiffModel`, `ChangesList` (row names), `GitRunner` |
| `Sources/KunjWorkspaceCore/Files/` | `FileAccess` (worktree fs or `kunj ct file`), `EditorSave` (`saveDecision`, `editorRefusal`) |
| `Sources/KunjWorkspaceCore/Layout/` | `WorkspaceLayout`, `LayoutStore` (debounced atomic writes), `restorePlan`, `ActivityTracker` |
| `Sources/KunjWorkspaceCore/Actions/` | `actionPlan` (what is enabled, with the reason), `newSessionPlan`, `runOutcome`, `KunjSetting` |
| `Sources/KunjWorkspaceCore/Design/` | `DesignTokens` (generated), `HexColor`, `RelativeTime` |
| `Sources/KunjWorkspace/AppDelegate.swift` | Launch arguments, menus and shortcuts, discovery, wiring of the store, tabs and layout, quit (stops `kunj events`, closes every tab) |
| `Sources/KunjWorkspace/Views/` | `MainWindowController` (window chrome, snapshot) and the sidebar, header, tab bar, terminal column, Changes column and status bar |
| `Sources/KunjWorkspace/Terminal/`, `Model/` | `TerminalTab` (SwiftTerm), `TabRegistry` (tabs per environment), `LayoutKeeper` (layout file, `lastActivity`) |
| `Sources/KunjWorkspace/Editor/` | `MonacoWebView` (the `kunj://` page, one-object page functions), `EditorTab` |
| `Sources/KunjWorkspace/Actions/`, `Sheets/`, `Settings/` | `ActionRunner` (header, overflow menu, alerts), `NewSessionSheet`, `SettingsWindow` |
| `Sources/KunjWorkspace/Theme/`, `Demo/` | `Theme`/`ThemeManager` (NSColor/NSFont from the tokens, system appearance), the `--demo` data |
| `Resources/web/index.html`, `app.js` | The Monaco page: `?mode=diff` for the Changes column, `?mode=editor` for editor tabs |

## Release

The release workflow's `workspace-app` job (`.github/workflows/release.yml`, on `macos-15`) runs
`npm ci` in `web/`, `scripts/bundle.sh` with `VERSION` set to the release version, zips the app with
`ditto -c -k --keepParent "build/Kunj Workspace.app" "Kunj-workspace-$VERSION.zip"` and attaches it to
the release. `kunj install workspace` (`src/lib/apps.ts`) finds that asset by the name pattern
`Kunj-workspace-*.zip`, so keep the name in step. The app is ad-hoc signed, not notarized.

## Tests and fake-kunj

`KunjWorkspaceCoreTests` use Swift Testing (`import Testing`, `@Test`), which the Command Line
Tools ship (XCTest is not always there). Shared helpers are in
`Tests/KunjWorkspaceCoreTests/Support.swift`: `appRoot`, `repoRoot`, `fixturesDir`,
`responsesDir`, `fakeKunjPath`, `fakeKunjResponseName(_:)`, `tempDirectory()`, `runFakeKunj(_:)`,
and `fakeKunjCLI(environment:path:)`, a `KunjCLI` running fake-kunj through `env K=V …` so the test
process's environment is never changed (values cannot contain `"`).

`Tests/Fixtures/fake-kunj` answers `kunj <args>` by printing `responses/<name>.json`, where
`<name>` is the arguments with `--json` dropped, a leading `--` stripped from the others, `/`
replaced by `-`, joined with `_`:

| Command | Fixture |
| --- | --- |
| `kunj worktree list --json` | `worktree_list.json` |
| `kunj worktree list --no-pr --json` | `worktree_list_no-pr.json` |
| `kunj ct file read feature/x src/a.ts --json` | `ct_file_read_feature-x_src-a.ts.json` |

A missing fixture prints `{"error":{"code":"fixture-missing","message":"<name>"}}` and exits 1.
`kunj -V` prints `$FAKE_KUNJ_VERSION` or `responses/version.txt`. Switches: `FAKE_KUNJ_RESPONSES`
(another responses directory), `FAKE_KUNJ_STDOUT` (print this instead, no newline added),
`FAKE_KUNJ_EXIT` (exit status), `FAKE_KUNJ_LOG` (append `<cwd><TAB><args>` per call, to check the
working directory and arguments kunj was run with). The script's header is the reference; keep it,
`fakeKunjResponseName` and this table in step.
