# aj-log

Changes made with Claude, and why.

## 2026-10-14 — Organize Windows in the menu bar app

- `macos-app/Package.swift`: a `KunjBarCore` library target for the pure decisions and a
  `KunjBarCoreTests` target (swift-testing; the Command Line Tools have no XCTest). `scripts/test.sh`
  runs them with the SDK that has the macro plugins and clears the module caches when a failed
  compile leaves "plugin for module 'TestingMacros' not found" behind.
- `Sources/KunjBarCore/`: `Layout`/`WindowKind` and `slots()` (left/right or above/below halves,
  one kind fills the screen), `fits()` (4 pt tolerance), `axFrame()` (Cocoa → Accessibility
  coordinates); `matchWindows()` (document path first, then the title as a whole path component,
  longest worktree name first); `chooseDesktop()` (keep / remember / create); `resolveScreenName()`
  and `placements()`. 30 tests.
- `Sources/KunjBar/Support/AXWindows.swift`: the editor (VS Code, Cursor, VSCodium, Windsurf) and
  terminal apps' windows through Accessibility, frames, raise, un-minimize. `Spaces.swift`: desktops
  per display, the current one, and which desktop a window is on, through SkyLight's read-only
  `CGSCopyManagedDisplaySpaces` / `CGSCopySpacesForWindows` (dlsym). `MissionControl.swift`: add a
  desktop, switch to a space and drag a window thumbnail onto a desktop by driving Mission Control's
  Accessibility tree in the Dock (probed on macOS 26: `mc > mc.display > mc.spaces > mc.spaces.list`,
  `mc.spaces.add`, `mc.windows`), with a mouse-click fallback when a press changes nothing.
- `Organizer.swift`: the run. Accessibility lists only each display's current desktop, and the
  remote-token trick (`_AXUIElementCreateWithRemoteToken`) answers nothing on macOS 26, so when the
  window server knows of more windows the organizer visits the other desktops and switches back.
  Full-screen windows are left alone. Per worktree: keep its desktop when its windows already share
  one, else the remembered one, else a new one; windows on another display get a frame on the chosen
  screen, windows on another desktop of the same display are raised and dragged in Mission Control;
  then each window gets its slot unless it already fits. `AppStore.organizeWindows()` runs it off the
  main actor and flashes the outcome; the ⚙ menu has **Organize Windows**; Settings has an Organize
  section (screen, layout, editor/terminal toggles). Why: asked for the mac app to create desktops
  and organize the windows, as a separate action from opening, keeping windows that already fit.
- `scripts/bundle.sh`: `CODESIGN_IDENTITY` signs with a named certificate so the Accessibility
  grant survives rebuilds (ad-hoc signatures change every build; a stale TCC row for the bundle id
  had to be cleared with `tccutil reset Accessibility dev.kunj.KunjBar`). A self-signed "Kunj Dev"
  identity lives in `~/Library/Keychains/kunj-dev.keychain-db` on this Mac.
- Full-screen windows are organized too: discovery visits full-screen spaces as well, a matched
  window gets `AXFullScreen` set false and is moved once it is back on a desktop. `arrange()` puts
  two windows of one kind on the two halves (editors and terminals keep their own half when both are
  present; a lone window fills the desktop). `fits()` allows a character cell (16 pt) of slack
  because Terminal snaps to whole cells and was re-placed on every run. Why: the first run left one
  window per desktop and skipped the full-screen ones, which was not what was wanted.
- Verified by hand on this Mac (macOS 26, two displays): a desktop added on the external screen,
  switching, one worktree kept its desktop and the other got a new one with its editor dragged there
  and placed on the left half; a second run moved nothing.

## 2026-10-14 — Organize Windows design spec

- `docs/superpowers/specs/2026-10-14-organize-windows-design.md`: design for an **Organize Windows**
  action in the menu bar app: one desktop per worktree on a chosen screen, editor on one half and
  terminal on the other, with Settings for the screen, the layout and which kinds to include.
  Windows already in place stay put; desktops are remembered per worktree so a rerun reuses them.
  Driven through the Accessibility API and Mission Control, with read-only SkyLight calls to learn
  which desktop a window is on. Why: asked for the mac app to create desktops and organize the
  windows, as a separate action from opening a worktree. No code yet; the plan comes next.

## 2026-10-08 — Still no colour; live CLI output in New Worktree

- A brand-new window still had `NO_COLOR=1 FORCE_COLOR=0`. Cause: the Kunj app itself had them. It was
  relaunched by `bundle.sh --install` from a Claude Code session in a window that still had them, and `open`
  passes its environment to the app, which passed it to kunj, then to VS Code, then to the terminals.
  Fixes: the app removes both variables from kunj's environment (KunjCLI.swift), and `bundle.sh` relaunches
  the app without them.
- New Worktree window shows a terminal-style box with what the CLI is doing, live. `kunj worktree add` now
  reports progress (creating, fetching the base, branching from, git's own output, keep files restored) - on
  stderr in `--json` mode so stdout stays one JSON document; hook output already went to stderr there. The app
  streams stderr through a new `onOutput` callback on `run()`.
- Released as v1.1.4.

## 2026-10-08 — New Worktree in a bare repository: "Could not list branches"

- `getGitRoot()` (src/lib/git.ts) used `git rev-parse --show-toplevel`, which fails in a bare repository, so
  `kunj list` found no branches and the macOS app's New Worktree sheet showed "No branches found". It now falls
  back to the repository directory (`--absolute-git-dir`) when the repository is bare.
- `kunj list --json` printed plain text when there were no branches; it now prints `{"branches": []}`.
- Released as v1.1.3.

## 2026-10-08 — Colour in editors opened by KunjBar, click feedback

- The macOS app and VS Code extension no longer run kunj with `NO_COLOR=1 FORCE_COLOR=0`. `kunj worktree open`
  inherited them and VS Code handed them on to every terminal in the window, so tools there (e.g. Claude Code)
  lost all colour. Instead the CLI turns chalk off itself whenever `--json` is passed (src/index.ts), which
  also covers an inherited `FORCE_COLOR=1` - chalk already skips colour when output is piped.
- macOS app: clicking a worktree row now shows it was clicked — the row tints blue and shows "Opening…" with a
  spinner until the open finishes (at least 0.6s so it is visible). Repeat clicks while opening are ignored.
  A first version also tracked the mouse-down with a `DragGesture(minimumDistance: 0)`; that swallowed the
  row's tap so clicking opened nothing, and it was removed.
- The spinner replaces the row's icon and stays until the editor registers its session (the worktree turns
  "open"), up to 15s, instead of disappearing as soon as the CLI returns.
- Released as v1.1.1.
- macOS app: the panel closes after clicking a worktree, "Open in New Window" or "Open Terminal"
  (`MenuBarAnchor.closePanel()`). Released as v1.1.2.
- Colour was still missing in a window opened at 10:51: the installed VS Code extension was the old build,
  which still set NO_COLOR when it ran `kunj worktree open`. Reinstalled it from the repo. VS Code itself
  doesn't need restarting (its main process never had the variables); only windows opened before the fix do.

## 2026-10-07 — Release v1.1.0

Released everything since v1.0.1 so `kunj repos` / `kunj install` reach npm and the release carries the
macOS app zip (`kunj install macos` needs a release that has one).

- `kunj repos` — registry of repositories kunj has been used in (`~/.kunj/repos.json`), so the macOS app can discover them.
- macOS menu bar app (`macos-app/`) — same features as the VS Code extension; open worktrees first and highlighted,
  "Open only" toggle, adaptive light/dark palette, panel stays pinned under the menu bar when it shrinks.
- Release workflow attaches `Kunj-macos-<version>.zip` (unsigned) next to the `.vsix`.
- `kunj install [vscode|macos|all]` — downloads and installs the companion apps; offered at the end of `kunj setup`.
- Also in this release: hooks, new branches from the fetched default branch, `worktree add -c`, config variables,
  bare repository support, keep files.
