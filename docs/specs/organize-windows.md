# Organize Windows (macOS menu bar app)

*Designed 2026-10-14; shipped and then reworked (two windows per desktop, full-screen windows, unlisted
editor windows, empty desktops removed). Checked against `macos-app/` on `main` on 2026-10-23.*

## Goal and status

One action, **Organize Windows**, arranges the editor and terminal windows of every worktree kunj
knows: two windows per desktop (macOS Space) on a chosen screen, one on each half. It is independent of
opening a worktree. Windows that already fit are left alone, so running it twice in a row does nothing
the second time.

| Feature | Status |
| --- | --- |
| Menu item, Settings section, Accessibility permission flow | Shipped |
| Window matching (document path, then title) | Shipped |
| Desktop choice: keep, remember, create | Shipped |
| Moving across displays and desktops through Mission Control; tiling | Shipped |
| Two windows per desktop, lone windows paired across worktrees | Shipped (8b0457a) |
| Full-screen windows brought back to a desktop | Shipped (d7be7af) |
| Editor windows of unlisted folders take part | Shipped (6f04b32) |
| Desktops left empty removed afterwards (toggle, on by default) | Shipped (8ac42e0) |
| `CODESIGN_IDENTITY` for a grant that survives rebuilds | Shipped (4631f74) |

## Design

### What the user sees

- **Organize Windows** in the panel's ⚙ menu ("Organizing Windows…" and disabled while it runs, or when
  both kinds are off). The run takes a few seconds while Mission Control opens and closes; keyboard and
  mouse should be left alone. The flash line then says what happened, e.g. `Organized 4 windows on 2
  desktops`, plus windows that could not be moved, empty desktops removed, desktops skipped, and the
  screen used when the chosen one is not attached.
- **Settings › Organize:** **Screen** (attached displays by name, default the main screen; an unplugged
  screen falls back to the main one), **Layout** (*Editor left, terminal right* (default), *Terminal
  left, editor right*, *Editor above terminal*), **Editor windows** and **Terminal windows** toggles
  (on; a kind that is off is left alone), **Remove empty desktops afterwards** (on).
- The first run shows the system Accessibility prompt and stops with `Grant Kunj Accessibility access
  in System Settings, then run Organize again`.

### Which windows

Found through the Accessibility API. The worktrees are those of every repository the panel lists, in
panel order. Accessibility lists only the windows on each display's current space, so when the window
server knows of more, Organize visits the other spaces of each display (desktops and full-screen
spaces), collects them and switches back.

- **Editor windows:** apps with the bundle ids of VS Code, Cursor, VSCodium and Windsurf.
- **Terminal windows:** the apps in `Launcher.terminalApps`. A window without a space of its own (a
  Terminal tab) is skipped.
- **Matching** (`matchWindows()`): a window's `AXDocument` path decides when it lies inside a worktree
  (the deepest worktree path wins); otherwise its title, where the worktree's folder name must appear as
  a whole component (`kunj` does not match `kunj-2`), longer names first, the first listed on a tie.
- **Unlisted editors:** every editor window that matches no worktree takes part as its own entry;
  terminals outside every worktree are left alone.
- Full-screen windows are taken out of full screen first.

### Grouping and layout

`groupWindows()`: each worktree's windows, editors first, are cut into pairs; a worktree's odd window
out is paired with the next worktree's, and a last one stands alone. Full pairs come first, then the
mixed pairs. Each pair gets one desktop.

`arrange()`: the screen's `visibleFrame` is always split into two halves along the layout's axis. An
editor takes the editor half and a terminal the terminal half, a lone window included, so the other half
stays free; two windows of the same kind take one half each. A window within 16 points of its slot (about
one terminal cell) is not touched. Frames are set position, size, position again (for windows that clamp
to their old screen), converted to Accessibility coordinates (top-left of the primary display).

### Desktops

Only desktops of the chosen screen are used. For each pair, in order (`chooseDesktop()`):

1. **Keep:** all its windows are on one desktop of the chosen screen that no other pair holds and no
   earlier pair took.
2. **Remember:** the desktop remembered for its first worktree from an earlier run, if it still exists
   and is free.
3. **Create:** a new desktop at the end of the screen's desktops, remembered for the pair's worktrees.

The memory is a `UserDefaults` dictionary, worktree path → Space id; entries whose Space is gone are
dropped on each run. A pair whose desktop cannot be made or reached is skipped and counted, and the rest
of the run continues.

**Moving:** a window on another display gets its frame set on the chosen screen (macOS puts it on that
screen's current desktop, which is the target). A window on another desktop of the same display is
raised (macOS switches to its desktop), Mission Control is opened, its thumbnail is dragged onto the
target desktop's button in the Spaces bar with synthetic mouse events, and the screen is switched back.
When several thumbnails share a title, the one whose position in the thumbnail area is nearest the
window's position on the screen is used (`nearestThumbnail()`).

**Removing empty desktops** (when on): afterwards, on every display, last to first, each desktop no
window is on is removed through Mission Control; a window assigned to all desktops keeps none alive, and
each display's current desktop always stays.

### How macOS is driven

- **Accessibility** (`AXUIElement`): window lists, titles, `AXDocument`, frames, raise, un-minimize,
  leaving full screen; Mission Control's Spaces bar in the Dock process (the "+" button, desktop
  buttons, their remove buttons).
- **Synthetic events** (`CGEvent`): the thumbnail drag, Escape. Covered by the Accessibility permission.
- **Read-only SkyLight calls** through `dlsym`: `CGSMainConnectionID`, `CGSCopyManagedDisplaySpaces`
  (desktops per display, current one) and `CGSCopySpacesForWindows` (which desktops a window is on).
  Private but widely used (Rectangle, AltTab, Hammerspoon), no SIP change, read only; they make "keep
  windows where they are" possible. A missing symbol stops the run with a flash naming it. Nothing
  writes through SkyLight: creating, switching and removing desktops goes through Mission Control,
  opened with `open -b com.apple.exposelauncher` and closed with Escape. The Spaces bar's tree is probed
  at run time, and each step polls for what it needs instead of sleeping.

### Errors

| Situation | Behaviour |
| --- | --- |
| Accessibility not granted | System prompt, flash, stop |
| Both kinds off | Menu item disabled |
| No window to organize | `Nothing to organize` |
| Chosen screen not attached | Main screen, said in the flash |
| Mission Control cannot be driven | `Could not drive Mission Control (macOS <version>): <step>` |
| A window cannot be moved | Skipped, counted in the flash |
| A pair's desktop cannot be made or reached | Skipped, counted (`desktops skipped (see the log)`) |
| SkyLight symbol missing | Flash naming the symbol |

The action never runs twice at once. The log window gets one line per step.

### Signing

The app is ad-hoc signed, and macOS ties the Accessibility grant to the signature, so a rebuild can
silently lose it until Kunj is toggled off and on in System Settings. `scripts/bundle.sh` signs with
`CODESIGN_IDENTITY` when set (a self-signed certificate from Keychain Access is enough), and the grant
then survives rebuilds. Release builds are unchanged.

## Decisions

- **2026-10-14** One permission (Accessibility) for everything; SkyLight only for reads, Mission Control
  for every change, as Hammerspoon's `hs.spaces` does since the private add/remove calls stopped working.
- **2026-10-14** Keep windows that already fit; remember a desktop per worktree path.
- **Later** Two windows per desktop rather than one desktop per worktree's kinds: a lone window takes
  its own half and pairs with another worktree's lone window, never fills the screen (51c6f05, 8b0457a).
- **Later** Editor windows of folders kunj does not list take part too (6f04b32).
- **Later** Empty desktops are removed afterwards by default, with a toggle (8ac42e0); this reverses
  the first design's "never remove desktops".
- **Later** A failing pair is skipped, not the whole run, so the desktop memory stays right (5ee22cf).

## Out of scope

Naming desktops, more than two slots, per-worktree layouts; browsers and other apps' windows; running
automatically after opening a worktree.

## Code map

| File | Role |
| --- | --- |
| `Sources/KunjBarCore/` | Pure decisions: `WindowMatching`, `Grouping`, `DesktopChoice`, `Slots`, `Layout`, `OrganizePlan`, `Thumbnails`, `EmptyDesktops` |
| `Sources/KunjBar/Support/Organizer.swift` | One run: discover, group, choose desktops, move, tile, remove empty desktops |
| `Sources/KunjBar/Support/AXWindows.swift`, `Spaces.swift`, `MissionControl.swift` | Accessibility driver, SkyLight reads, Mission Control |
| `Sources/KunjBar/Support/Preferences.swift` | `organizeScreen`, `organizeLayout`, `organizeEditor`, `organizeTerminal`, `organizeRemoveEmpty`, `organizeDesktops` |
| `Sources/KunjBar/Store/AppStore.swift` | `organizeWindows()`, the flash, `isOrganizing` |
| `Sources/KunjBar/Views/SettingsView.swift`, `PanelView.swift` | The Organize section; the menu item |
| `Tests/KunjBarCoreTests/` | Matching, grouping, layout, desktop choice, empty desktops, thumbnails, plan |

Driving Mission Control is verified by hand (macOS 26, two displays) and logged.
