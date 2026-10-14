# Organize Windows — design

*2026-10-14. Kunj menu bar app (`macos-app/`).*

## Goal

One action, **Organize Windows**, that arranges the editor and terminal windows of every known
worktree: one desktop (macOS Space) per worktree on a chosen screen, the editor on one half and
the terminal on the other. It is independent of opening a worktree; the click, "Open in New
Window" and "Open Terminal" keep doing what they do today.

Windows that already fit the layout are left where they are. Running Organize twice in a row
does nothing the second time.

## What the user sees

- **Organize Windows** in the panel's ⚙ menu. The panel closes, the action runs for a few
  seconds (Mission Control opens and closes while it works), then the panel's flash line says
  what happened: `Organized 3 worktrees on 3 desktops`, or what was skipped and why. Keyboard
  and mouse should be left alone while it runs.
- A new **Organize** section in Settings:
  - **Screen**: the displays currently attached, by name, plus the main screen as default. Stored
    by display name; an unplugged screen falls back to the main one.
  - **Layout**: *Editor left, terminal right* (default) · *Terminal left, editor right* ·
    *Editor above terminal*.
  - **Editor** and **Terminal** toggles (both on by default): a kind that is off is left alone.
    When only one kind is on, that window fills the screen. Both off disables the menu item.
- The first run asks for the Accessibility permission with the system prompt and stops; the
  next run works. The README explains this and the rebuild catch (below).

## Which windows

Found through the Accessibility API (one permission for everything the feature does).

- **Editor windows**: windows of VS Code-like apps — bundle ids of Code, Cursor, VSCodium and
  Windsurf — whose title contains a listed worktree's folder name (`Worktree.name`), matched as a
  whole path component so `kunj` does not match `kunj-2`. The longest matching name wins when two
  worktrees' names nest. Windows that match no worktree are left alone.
- **Terminal windows**: windows of the apps in `Launcher.terminalApps` whose working directory is
  inside a listed worktree path. The directory comes from the window's `AXDocument` attribute
  (Terminal sets it to the cwd as a file URL); when it is absent, a title that contains the
  worktree folder name as a path component is accepted instead.
- Minimized windows are restored first. Several windows of the same kind for one worktree share a
  slot, the most recently focused on top.

Worktrees are taken from the current listing in the order the panel shows them. A worktree with no
matching window of an enabled kind is skipped.

## Desktops

Every desktop lives on one display. Organize only uses desktops of the chosen screen.

For each worktree, in order:

1. **Keep** — if all of its windows (of the enabled kinds) are already on one desktop of the
   chosen screen and no other listed worktree's windows share that desktop, that desktop is its
   desktop. Nothing moves between desktops.
2. **Remember** — otherwise, if Kunj remembered a desktop for this worktree path from an earlier
   run and that desktop still exists, it is reused.
3. **Create** — otherwise a new desktop is added at the end of the chosen screen's desktops and
   remembered for the worktree path.

Memory is a `UserDefaults` dictionary, worktree path → Space id. Entries whose Space no longer
exists are dropped on each run. Empty desktops are never removed; the user does that.

## Moving and tiling

Per worktree, after its desktop is known, with the chosen screen switched to that desktop:

- A window on **another display** gets its frame set on the chosen screen. macOS puts it on
  that screen's current desktop, which is the target.
- A window on **another desktop of the same display** is raised, which makes macOS switch to its
  desktop; Mission Control is opened and the window's thumbnail is dragged onto the target
  desktop's button in the Spaces bar with synthetic mouse events; then the chosen screen is
  switched back to the target desktop. This is the mechanism Hammerspoon's `hs.spaces` uses
  since the private add/remove calls stopped working.
- Then each window's frame is set to its slot: the screen's `visibleFrame` (menu bar and Dock
  excluded) split in half along the layout's axis, converted to Accessibility coordinates
  (top-left origin of the primary display). Position, size, then position again, the usual
  workaround for windows that clamp to their old screen. A window whose frame is already within
  a few points of its slot is not touched.

After the last worktree the chosen screen stays on the last desktop handled.

## How macOS is driven

- **Accessibility API** (`AXUIElement`): window lists, titles, `AXDocument`, frames, raise,
  un-minimize; Mission Control's Spaces bar in the Dock process — the "+" button and the desktop
  buttons.
- **Synthetic events** (`CGEvent`): the drag of a window thumbnail onto a desktop button. Posting
  events is covered by the Accessibility permission.
- **Read-only SkyLight calls**, loaded with `dlsym`: `CGSMainConnectionID`,
  `CGSCopyManagedDisplaySpaces` (desktops per display, their ids and the current one) and
  `CGSCopySpacesForWindows` (which desktop a window is on). These are private but widely used
  (Rectangle, AltTab, Hammerspoon), need no change to System Integrity Protection and are only
  read. They are what makes "keep windows where they are" possible without visiting every
  desktop. If a symbol is missing the action stops with a flash naming it rather than guessing.
  Nothing writes through SkyLight: creating and switching desktops goes through Mission Control.
- Mission Control is opened with `open -b com.apple.exposelauncher` and closed with Escape. The
  Spaces bar's Accessibility tree is probed at run time (the group whose frame lies on the chosen
  screen), because its shape has changed between macOS versions. Each step polls for the element
  it needs with a short timeout instead of fixed sleeps.

## Errors

| Situation | Behaviour |
|---|---|
| Accessibility not granted | System prompt (`AXIsProcessTrustedWithOptions`), flash `Grant Kunj Accessibility access in System Settings, then run Organize again`, stop |
| Both kinds off | Menu item disabled |
| No worktree has a matching window | Flash `Nothing to organize` |
| Chosen screen not attached | Main screen used, said in the flash |
| Mission Control's Spaces bar not found | Stop; flash `Could not drive Mission Control` with the macOS version; nothing moved |
| A window cannot be dragged or placed | Skipped, counted in the flash: `Organized 2 worktrees, 1 window could not be moved` |
| SkyLight symbol missing | Stop with a flash naming the symbol |

The action never runs twice at once; the menu item is disabled while it runs. The log window
gets one line per step, so a failure can be read back.

## Code

New files under `Sources/KunjBar/`:

- `Support/Spaces.swift` — SkyLight reads (`displays → [Space]`, `space(of window)`), Mission
  Control driving (`addDesktop(on screen)`, `switch(to space)`, `drag(window, to space)`), the
  worktree → Space memory.
- `Support/WindowFinder.swift` — enumerates candidate apps and their Accessibility windows,
  returns `[FoundWindow]` (element, window id, app kind, title, document path, frame, minimized)
  and the pure `match(windows, worktrees) -> [worktree path: [FoundWindow]]`.
- `Support/WindowTiler.swift` — pure `slots(for layout, kinds, in visibleFrame) -> [Kind: CGRect]`,
  the `fits(frame, slot)` tolerance check, the Accessibility frame setter and coordinate flip.
- `Store/AppStore.swift` — `organizeWindows()`: permission check, plan, run on a background task
  with progress lines to the log, flash at the end; `isOrganizing` for the menu item.
- `Support/Preferences.swift` — `organizeScreen`, `organizeLayout`, `organizeEditor`,
  `organizeTerminal`, `organizeDesktops` (the memory).
- `Views/SettingsView.swift` — the Organize section. `Views/PanelView.swift` — the menu item.

A test target `KunjBarTests` is added to `Package.swift` (the package has none today) for the
pure parts: slot maths for the three layouts and the one-kind case, the coordinate flip, the
tolerance check, window-to-worktree matching (nested names, path components, `AXDocument`
versus title) and the desktop choice (keep / remember / create) given a table of where windows
are. Driving Mission Control is verified by hand on this Mac (macOS 26, two displays) and the
steps logged.

## Signing

The app is ad-hoc signed, and macOS ties the Accessibility grant to the code signature, so a
rebuild can silently lose it until the user toggles Kunj off and on in System Settings.
`scripts/bundle.sh` gains `CODESIGN_IDENTITY`: when set, the app is signed with that identity
(a self-signed "Kunj Dev" certificate from Keychain Access is enough) and the grant survives
rebuilds. The README's build section says so. Release builds are unchanged.

## Out of scope

- Removing desktops, naming desktops, more than two slots, per-worktree layouts.
- Windows of other apps (browsers, Claude Code windows) and worktrees kunj does not list.
- Organize running automatically after opening a worktree.
