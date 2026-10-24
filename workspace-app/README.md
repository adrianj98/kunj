# Kunj Workspace

A native macOS app (AppKit, SwiftPM, no Xcode project) that lists every worktree and branch
container kunj knows about as an environment, keeps terminals and agent sessions per environment,
and shows each environment's changes. Everything goes through the installed `kunj` CLI
(`kunj … --json`); the app never imports kunj, never runs `docker`, and runs `git` only read-only.

Design: [docs/specs/workspace-ide.md](../docs/specs/workspace-ide.md) and
[docs/workspace-app/design/](../docs/workspace-app/design/) (the app must look like
`mockups/warm.png`). Plan: `docs/superpowers/plans/2026-10-23-workspace-app-v1.md`.

Needs macOS 14+, the Command Line Tools (Swift 6.x, used in Swift 5 language mode), Node and npm
(Monaco), `curl`, `git` and network access on the first build.

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
| `scripts/prepare-swiftterm.sh` | Clones SwiftTerm v1.20.0 into `vendor/` and changes `Shaders.metal` from `.process` to `.copy` so it builds without Xcode's `metal` (compiled at runtime instead). Takes a lock, so parallel runs wait for one fetch |
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
scripts/bundle.sh && "build/Kunj Workspace.app/Contents/MacOS/KunjWorkspace" --screenshot /tmp/ws.png
open "build/Kunj Workspace.app"
```

`--screenshot <png>` renders the window after its first layout, writes the PNG (sRGB, 2x) and
quits; compare it with `docs/workspace-app/design/mockups/warm.png`. On launch the app logs to
stderr whether the bundled fonts registered (they only do inside the `.app`). It runs kunj as the
`kunjCommand` default (`defaults write <bundle id> kunjCommand "node /path/dist/index.js"`, or
`-kunjCommand "…"` after the executable for one run), else `kunj` on the login shell's PATH, and
shows its version at the sidebar's foot or the error in red on the status bar. Not notarized: if
macOS refuses to open it, right-click > Open, or
`xattr -dr com.apple.quarantine "/Applications/Kunj Workspace.app"`.

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
