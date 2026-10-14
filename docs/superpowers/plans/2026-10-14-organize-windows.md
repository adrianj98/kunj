# Organize Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An **Organize Windows** action in the Kunj menu bar app that puts each worktree's editor and terminal windows on their own desktop of a chosen screen, tiled by a chosen layout, moving as little as possible.

**Architecture:** The pure decisions (slot geometry, window-to-worktree matching, which desktop a worktree gets) move into a new `KunjBarCore` library target with swift-testing tests. The app target gains three thin drivers over macOS: Accessibility windows, read-only SkyLight space queries, and Mission Control. `AppStore.organizeWindows()` strings them together and reports through the existing flash and log.

**Tech Stack:** Swift 6.4 toolchain under the Command Line Tools (no Xcode, no XCTest: tests use `import Testing`), SwiftPM, SwiftUI `MenuBarExtra`, `ApplicationServices` (AX), `CoreGraphics` events, `dlsym` into SkyLight.

**Spec:** `docs/superpowers/specs/2026-10-14-organize-windows-design.md`

## Global Constraints

- macOS 14 deployment target; developed and verified on macOS 26 with two displays.
- `swift build` must keep working under `/Library/Developer/CommandLineTools`; `scripts/bundle.sh` retries older SDKs when the newest one lacks the SwiftUI macro plugin. Run `swift test` with `SDKROOT` set to the SDK that builds if the default fails.
- Accessibility is the only permission the feature may need. No AppleScript, no Automation prompt, no Screen Recording.
- SkyLight is read-only: `CGSMainConnectionID`, `CGSCopyManagedDisplaySpaces`, `CGSCopySpacesForWindows`. Nothing else from SkyLight.
- Editor apps: bundle ids `com.microsoft.VSCode`, `com.todesktop.230313mzl4w4u92` (Cursor), `com.vscodium`, `com.exafunction.windsurf`. Terminal apps: the names in `Launcher.terminalApps`.
- Flash copy is fixed by the spec's Errors table and repeated in Task 9.
- Commit after every task; `aj-log.md` gets one entry for the feature in Task 10.

## Review Focus

1. Two listed worktrees whose folder names nest (`feature` and `feature-2`, or `kunj` under `kunj/worktrees/kunj`) — a window must match only the worktree whose name is a whole path component of its title or document path, longest name first. Pinned in Task 3.
2. A worktree with windows on both displays and the chosen screen's current desktop already holding another worktree's windows — Keep must not fire; Remember or Create must. Pinned in Task 4.
3. The chosen display name no longer attached (laptop unplugged) — the main screen is used and the flash says so. Pinned in Task 9 by a unit test of the screen resolver with a stubbed screen list.
4. Only one kind enabled with a worktree that has several windows of that kind — all of them get the full visible frame, none is skipped. Pinned in Task 2.
5. A window on a desktop of the chosen screen that is already within tolerance of its slot while a sibling window is not — the fitting one is not re-positioned (no flicker), the other is. Pinned in Task 2's `fits` test and Task 9's placement loop test.

---

### Task 1: Library target and test target

**Files:**
- Modify: `macos-app/Package.swift`
- Create: `macos-app/Sources/KunjBarCore/Layout.swift` (empty `public enum Layout` placeholder filled in Task 2)
- Create: `macos-app/Tests/KunjBarCoreTests/LayoutTests.swift`

**Interfaces:**
- Produces: library `KunjBarCore` (`Sources/KunjBarCore`), imported by `KunjBar`; test target `KunjBarCoreTests` depending on `KunjBarCore`.

- [ ] **Step 1:** Add `.target(name: "KunjBarCore")` and `.testTarget(name: "KunjBarCoreTests", dependencies: ["KunjBarCore"])` to `Package.swift`; add `"KunjBarCore"` to `KunjBar`'s dependencies.
- [ ] **Step 2:** Write `LayoutTests.swift` with `import Testing`, `@testable import KunjBarCore`, and one `@Test func layoutHasThreeCases()` asserting `Layout.allCases.count == 3`.
- [ ] **Step 3:** Run `swift test` → FAIL (no `Layout`). If the SwiftUI macro error appears instead, re-run with `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk` and use that for every later `swift test`.
- [ ] **Step 4:** Create `Layout.swift` with `public enum Layout: String, CaseIterable, Codable { case editorLeft, editorRight, editorAbove }`.
- [ ] **Step 5:** `swift test` → PASS. `swift build` → the app still builds.
- [ ] **Step 6:** Commit: `Add KunjBarCore library and test targets to the menu bar app`.

### Task 2: Slot geometry

**Files:**
- Modify: `macos-app/Sources/KunjBarCore/Layout.swift`
- Create: `macos-app/Sources/KunjBarCore/Slots.swift`
- Test: `macos-app/Tests/KunjBarCoreTests/LayoutTests.swift`

**Interfaces:**
- Produces:
  - `public enum WindowKind: String, CaseIterable, Codable { case editor, terminal }`
  - `public func slots(for layout: Layout, kinds: Set<WindowKind>, in visible: CGRect) -> [WindowKind: CGRect]` — Cocoa coordinates (origin bottom-left), halves split exactly, no gap.
  - `public func fits(_ frame: CGRect, _ slot: CGRect, tolerance: CGFloat = 4) -> Bool` — every edge within tolerance.
  - `public func axFrame(_ cocoa: CGRect, primaryHeight: CGFloat) -> (origin: CGPoint, size: CGSize)` — flips y: `origin.y = primaryHeight - cocoa.maxY`.

- [ ] **Step 1:** Tests, `visible = CGRect(x: 0, y: 30, width: 1000, height: 600)`:
  - `editorLeft` both kinds → editor `(0,30,500,600)`, terminal `(500,30,500,600)`.
  - `editorRight` → mirrored.
  - `editorAbove` → editor `(0,330,1000,300)`, terminal `(0,30,1000,300)`.
  - kinds `[.terminal]` only → terminal gets `visible`, no editor key.
  - kinds empty → empty dictionary.
  - `fits`: identical → true; one edge off by 3 → true; off by 5 → false.
  - `axFrame((0,30,500,600), primaryHeight: 900)` → origin `(0, 270)`, size `(500,600)`.
- [ ] **Step 2:** `swift test` → FAIL.
- [ ] **Step 3:** Implement in `Slots.swift`.
- [ ] **Step 4:** `swift test` → PASS.
- [ ] **Step 5:** Commit: `Slot geometry for Organize Windows`.

### Task 3: Window-to-worktree matching

**Files:**
- Create: `macos-app/Sources/KunjBarCore/WindowMatching.swift`
- Test: `macos-app/Tests/KunjBarCoreTests/WindowMatchingTests.swift`

**Interfaces:**
- Produces:
  - `public struct FoundWindow: Hashable { public let id: UInt32; public let pid: pid_t; public let kind: WindowKind; public let title: String; public let documentPath: String?; public let frame: CGRect; public let minimized: Bool; public init(...) }` (frame in Cocoa coordinates).
  - `public struct WorktreeRef: Hashable { public let path: String; public let name: String }`
  - `public func matchWindows(_ windows: [FoundWindow], worktrees: [WorktreeRef]) -> [String: [FoundWindow]]` — keyed by worktree path; order of windows preserved from input.
  - `public func titleMatches(_ title: String, name: String) -> Bool` — `name` appears as a whole path component: preceded by start, `/`, space, `—`, `-`, `[`, `(`, `"` or `“` and followed by end, `/`, space, `—`, `]`, `)`, `"`, `”` or `:`.

- [ ] **Step 1:** Tests:
  - terminal window with `documentPath = "/r/wt/feature/src"` and worktrees `[("/r/wt/feature","feature"), ("/r/wt/feature-2","feature-2")]` → only `/r/wt/feature`.
  - terminal window `documentPath = "/r/wt/feature-2"` → only `/r/wt/feature-2`.
  - editor window title `"main.ts — feature-2 — Visual Studio Code"` → `/r/wt/feature-2`, not `feature`.
  - editor window title `"README.md — kunj — Visual Studio Code"` with worktrees `kunj` (`/p/kunj`) and `kunj` (`/p/kunj/.git/kunj/worktrees/kunj`) → both candidates share a name; the window goes to the first listed only (no duplicates across keys).
  - title `"feature-branch — Code"` and worktree `feature` → no match.
  - terminal with no documentPath and title `"feature — -zsh — 80x24"` → `/r/wt/feature`.
  - a window matching nothing is absent from every value.
- [ ] **Step 2:** `swift test` → FAIL.
- [ ] **Step 3:** Implement. Document path wins over title when present; names tried longest first; a window lands in at most one bucket.
- [ ] **Step 4:** `swift test` → PASS.
- [ ] **Step 5:** Commit: `Match editor and terminal windows to worktrees`.

### Task 4: Desktop choice

**Files:**
- Create: `macos-app/Sources/KunjBarCore/DesktopChoice.swift`
- Test: `macos-app/Tests/KunjBarCoreTests/DesktopChoiceTests.swift`

**Interfaces:**
- Produces:
  - `public typealias SpaceID = UInt64`
  - `public enum DesktopChoice: Equatable { case keep(SpaceID), remember(SpaceID), create }`
  - `public func chooseDesktop(windows: [FoundWindow], spaceOf: [UInt32: SpaceID], screenSpaces: [SpaceID], remembered: SpaceID?, takenSpaces: Set<SpaceID>) -> DesktopChoice` — `spaceOf` maps window id → space; `takenSpaces` are desktops already assigned to earlier worktrees in this run or holding another listed worktree's windows.

- [ ] **Step 1:** Tests:
  - all windows on space 7, `screenSpaces` contains 7, 7 not taken → `.keep(7)`.
  - windows on 7 and 8 → not keep; `remembered = 9` in `screenSpaces` → `.remember(9)`.
  - all on 7 but 7 in `takenSpaces` → `.remember(9)` when remembered valid, else `.create`.
  - all on 7 but 7 not in `screenSpaces` (other display) → `.remember` / `.create`.
  - `remembered = 9` not in `screenSpaces` → `.create`.
  - `remembered` in `takenSpaces` → `.create`.
  - a window missing from `spaceOf` counts as not on any space → not keep.
- [ ] **Step 2:** `swift test` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `Choose a desktop per worktree: keep, remember or create`.

### Task 5: Preferences and the Organize settings section

**Files:**
- Modify: `macos-app/Sources/KunjBar/Support/Preferences.swift`
- Modify: `macos-app/Sources/KunjBar/Views/SettingsView.swift`

**Interfaces:**
- Produces: `Pref.organizeScreen` (String, default `""` = main screen), `Pref.organizeLayout` (String raw value of `Layout`, default `editorLeft`), `Pref.organizeEditor` (Bool, true), `Pref.organizeTerminal` (Bool, true), `Pref.organizeDesktops` (`[String: String]`, worktree path → decimal `SpaceID`). `UserDefaults` accessors `kunjOrganizeScreen`, `kunjOrganizeLayout: Layout`, `kunjOrganizeKinds: Set<WindowKind>`, `kunjOrganizeDesktops: [String: SpaceID]` with a setter.

- [ ] **Step 1:** Add the keys, defaults and accessors.
- [ ] **Step 2:** Add `Section("Organize")` after "Worktrees": `Picker("Screen")` listing `Text("Main screen").tag("")` plus `NSScreen.screens` by `localizedName`; `Picker("Layout")` with "Editor left, terminal right", "Terminal left, editor right", "Editor above terminal"; `Toggle("Editor windows")`, `Toggle("Terminal windows")`; caption: "Organize Windows (⚙ menu) gives each worktree a desktop on this screen and tiles its windows. Needs Accessibility access."
- [ ] **Step 3:** `swift build` → builds. Run `.build/debug/KunjBar`, open Settings, check the section renders and the pickers persist across relaunch.
- [ ] **Step 4:** Commit: `Settings for Organize Windows`.

### Task 6: Accessibility window driver

**Files:**
- Create: `macos-app/Sources/KunjBar/Support/AXWindows.swift`

**Interfaces:**
- Produces, in `enum AXWindows`:
  - `static func isTrusted(prompt: Bool) -> Bool` (`AXIsProcessTrustedWithOptions`).
  - `static func candidateWindows(terminalApps: [String]) -> [(FoundWindow, AXUIElement)]` — walks `NSWorkspace.shared.runningApplications`, keeps editor bundle ids (Global Constraints) and apps whose `localizedName` is in `terminalApps`; per app reads `kAXWindowsAttribute`, and per window `kAXTitleAttribute`, `kAXDocumentAttribute` (file URL → path), `kAXPositionAttribute`/`kAXSizeAttribute` (converted to Cocoa coordinates with the primary screen height), `kAXMinimizedAttribute`, and the window id through `_AXUIElementGetWindow` (declared `@_silgen_name`). Skips windows with `kAXSubroleAttribute != kAXStandardWindowSubrole`.
  - `static func setFrame(_ w: AXUIElement, cocoa: CGRect)` — position, size, position.
  - `static func raise(_ w: AXUIElement, pid: pid_t)` — unminimize, `NSRunningApplication(processIdentifier:)?.activate()`, `kAXRaiseAction`.
  - `static func frame(of w: AXUIElement) -> CGRect?` (Cocoa).

- [ ] **Step 1:** Implement. No unit tests (needs a live session); verification in Task 9.
- [ ] **Step 2:** `swift build` → builds.
- [ ] **Step 3:** Commit: `Accessibility window driver`.

### Task 7: SkyLight space queries

**Files:**
- Create: `macos-app/Sources/KunjBar/Support/Spaces.swift`

**Interfaces:**
- Produces, in `enum Spaces`:
  - `struct DisplaySpaces { let displayUUID: String; let current: SpaceID; let spaces: [SpaceID] }` — user desktops only (`type == 0`), in bar order.
  - `static func displays() throws -> [DisplaySpaces]` — `CGSCopyManagedDisplaySpaces(CGSMainConnectionID())`, parsed from the array of dictionaries (`Display Identifier`, `Current Space.ManagedSpaceID`, `Spaces[].ManagedSpaceID` and `type`).
  - `static func space(of windowIDs: [UInt32]) throws -> [UInt32: SpaceID]` — `CGSCopySpacesForWindows(cid, 7, [ids])` per window.
  - `static func displayUUID(of screen: NSScreen) -> String?` — `CGDisplayCreateUUIDFromDisplayID` on `NSScreenNumber`.
  - `struct MissingSymbol: Error { let name: String }` thrown when `dlsym` returns nil; symbols loaded once with `dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify by hand: add a temporary `KUNJBAR_SPACES=1` env check in `applicationDidFinishLaunching` that prints `displays()` and exits; run `.build/debug/KunjBar`; expect two displays with the current space and this Mac's desktops. Remove the env check before committing.
- [ ] **Step 3:** Commit: `Read desktops and window spaces through SkyLight`.

### Task 8: Mission Control driver

**Files:**
- Create: `macos-app/Sources/KunjBar/Support/MissionControl.swift`

**Interfaces:**
- Produces, in `enum MissionControl` (all synchronous, called off the main actor, each step polls up to 3 s):
  - `static func open() throws` — `/usr/bin/open -b com.apple.exposelauncher`, then wait until the Dock process exposes a group whose `kAXIdentifierAttribute`/description names the Spaces bar (probe on this Mac first, see Step 1).
  - `static func close()` — post Escape with `CGEvent(keyboardEventSource:virtualKey:53)`, wait until the bar is gone.
  - `static func spacesBar(on screen: NSScreen) throws -> AXUIElement` — the Dock's Spaces bar group whose frame lies within the screen's frame.
  - `static func addDesktop(on screen: NSScreen) throws -> SpaceID` — count `Spaces.displays()` for the screen's display UUID, open, hover and press the add button of the bar, close, poll `Spaces.displays()` until one more desktop appears, return the new last id.
  - `static func switchTo(_ space: SpaceID, on screen: NSScreen) throws` — index of `space` in the display's list, open, press the bar's desktop button at that index, poll until `current == space`.
  - `static func drag(window: UInt32, title: String, to space: SpaceID, on screen: NSScreen) throws` — open (the window must be on the current desktop of its display), find the window thumbnail button in the Dock tree whose title matches, drag it to the centre of the destination desktop button with `CGEvent` mouse down / moves / up (6 moves, 40 ms apart), close, poll `Spaces.space(of:)` until it reports `space`.
  - `struct Failure: Error, CustomStringConvertible { let step: String }`.

- [ ] **Step 1:** Probe the AX tree once: a scratch Swift script in the session scratchpad that opens Mission Control, dumps the Dock process's AX tree (role, subrole, identifier, description, title, frame) three levels under each top-level group, and closes it. Record the element paths for the Spaces bar, the add button, desktop buttons and window thumbnails in a comment at the top of `MissionControl.swift`.
- [ ] **Step 2:** Implement against what the probe found; match on roles and identifiers, not fixed indices.
- [ ] **Step 3:** Verify by hand with a temporary `KUNJBAR_MC_TEST=add|switch:<id>` env hook, same pattern as Task 7 Step 2: a desktop appears on the chosen screen; a switch lands on it. Remove the hook.
- [ ] **Step 4:** Commit: `Drive Mission Control: add, switch to and drag windows onto desktops`.

### Task 9: `organizeWindows()` and the menu item

**Files:**
- Create: `macos-app/Sources/KunjBarCore/OrganizePlan.swift`
- Create: `macos-app/Sources/KunjBar/Support/Organizer.swift`
- Modify: `macos-app/Sources/KunjBar/Store/AppStore.swift`
- Modify: `macos-app/Sources/KunjBar/Views/PanelView.swift` (⚙ menu)
- Test: `macos-app/Tests/KunjBarCoreTests/OrganizePlanTests.swift`

**Interfaces:**
- `OrganizePlan.swift` (pure): `public func resolveScreenName(_ wanted: String, available: [String], main: String) -> (name: String, fellBack: Bool)`; `public struct Placement { let window: FoundWindow; let slot: CGRect; let needsMove: Bool }`; `public func placements(windows: [FoundWindow], slots: [WindowKind: CGRect]) -> [Placement]` — `needsMove = !fits(window.frame, slot)`.
- `Organizer.swift` (app): `final class Organizer { init(log: @escaping (String) -> Void); func run(worktrees: [WorktreeRef], screenName: String, layout: Layout, kinds: Set<WindowKind>, remembered: [String: SpaceID]) throws -> Outcome }` with `struct Outcome { var worktrees = 0; var desktopsCreated = 0; var windowsMoved = 0; var windowsFailed = 0; var remembered: [String: SpaceID]; var screenFellBack = false }`. Runs the spec's per-worktree sequence: find windows → match → per worktree choose desktop (Task 4) → ensure desktop (create/switch) → bring windows (other display: `setFrame`; same display other space: `raise` + `drag`) → placements → `setFrame` where `needsMove`. Every step logs one line.
- `AppStore`: `private(set) var isOrganizing = false`; `func organizeWindows()` — guards `isTrusted(prompt: true)` else flash, builds `WorktreeRef`s from `repos` in panel order, runs `Organizer` on a detached task, stores `outcome.remembered`, flashes per the table below.
- `PanelView` ⚙ menu: `Button("Organize Windows") { store.organizeWindows(); MenuBarAnchor.closePanel() }.disabled(store.isOrganizing || kinds.isEmpty)`.

Flash copy:

| Case | Flash |
|---|---|
| not trusted | `Grant Kunj Accessibility access in System Settings, then run Organize again` |
| nothing matched | `Nothing to organize` |
| success | `Organized N worktrees on N desktops` (+ `, M windows could not be moved` when `windowsFailed > 0`; + ` on <main screen name> (<wanted> is not attached)` when `screenFellBack`) |
| Mission Control failure | `Could not drive Mission Control (macOS <version>): <step>` |
| missing symbol | `SkyLight symbol <name> is missing` |

- [ ] **Step 1:** Tests for `resolveScreenName` (wanted present → itself, false; wanted `""` → main, false; wanted absent → main, true) and `placements` (fitting window → `needsMove == false`, sibling off by 20 → true; two windows of one kind both get the same slot).
- [ ] **Step 2:** `swift test` → FAIL. **Step 3:** Implement `OrganizePlan.swift`. **Step 4:** PASS.
- [ ] **Step 5:** Implement `Organizer.swift`, the store method and the menu item.
- [ ] **Step 6:** `swift build`; run the debug binary; grant Accessibility when prompted (the debug binary's grant is separate from the installed app's); open two worktrees in VS Code and a Terminal in each; run Organize from the ⚙ menu; expect two desktops on the chosen screen, each with the editor on the left half and the terminal on the right. Run it again → flash `Organized 2 worktrees on 2 desktops`, nothing visibly moves, under 2 s.
- [ ] **Step 7:** Commit: `Organize Windows: one desktop per worktree, editor and terminal tiled`.

### Task 10: Signing identity, docs, log, install

**Files:**
- Modify: `macos-app/scripts/bundle.sh`
- Modify: `macos-app/README.md`
- Modify: `aj-log.md`

- [ ] **Step 1:** `bundle.sh`: `codesign --force --sign "${CODESIGN_IDENTITY:--}" "$APP"`; comment explaining the Accessibility grant and the self-signed certificate.
- [ ] **Step 2:** README: a feature bullet for Organize Windows and the Settings; a paragraph under "Build and install" on the Accessibility permission and `CODESIGN_IDENTITY`.
- [ ] **Step 3:** `aj-log.md`: the feature entry under a 2026-10-14 heading (what, where, why).
- [ ] **Step 4:** `scripts/bundle.sh --install`; grant Accessibility to `/Applications/Kunj.app`; run Organize once more from the installed app.
- [ ] **Step 5:** Commit: `Document Organize Windows; optional signing identity for a stable Accessibility grant`. Push.
