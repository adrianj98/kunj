# aj-log

Changes made with Claude, and why.

## 2026-10-22 — Branch containers: final review fix wave

- Blueprints task 3: `src/lib/container/presets.ts` (resolve repo/host/built-in presets, order, run as root with env in a file and the version read from `kunj_done`'s result file), `nodejs.org` always allowed by the firewall, preset fixes (go version lookup never matched, node `22.12` picked the newest 22.x, arch helpers yielded "" on unknown machines) and allowlist notes. Why: blueprint snapshots install their `tools` through these scripts.
- Blueprints task 2: `src/lib/container/blueprint.ts` (parse, resolve repo/host/file, lockfile ids, hash, snapshot tag, labels) and blueprint label keys in `LABEL`. Why: the blueprint file and its identity hash feed snapshot, status and start.
- Blueprints task 1: `ContainerBackend` gains `commitContainer`, `listImages` and `removeImage` (docker commit with LABEL changes, image ls + one inspect, tolerant image rm); FakeBackend's tag set is now `existingImages` and `images` holds `ImageInfo[]`. Why: blueprint snapshots are committed, listed and pruned as labelled images.
- Design: blueprints (`kunj ct blueprint init|snapshot|status|remove`) — a repo's `.kunj/blueprint.json`
  (`setup`/`maintain` commands) is run once in a sandbox and committed as `kunj-blueprint-<repo>:<hash>`
  with the tree at `/opt/kunj/seed`; new branch containers copy the seed instead of installing. Why:
  asked for a Devin-style blueprint so containers start with dependencies installed. Spec:
  `docs/superpowers/specs/2026-10-22-blueprints-design.md`; branch `feature/blueprints`.

- UTF-8 in the sandbox: `debian:bookworm-slim` has no locale, so Claude Code and tmux drew box glyphs as
  underscores. The image now sets `LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color`, tmux runs with `-u`,
  and interactive execs pass the host's `TERM`/`COLORTERM` plus `LANG=C.UTF-8`. Why: first real session
  looked broken in the VS Code terminal.

Why: the whole-branch review found one critical and ten important problems (plus five minors) in
`kunj container`; all landed in one pass, one commit per fix.

- Agent container runs with `--cap-drop ALL` plus CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID
  (`ContainerSpec.capDrop/securityOpt`). Why: root inside kept NET_RAW and could bypass the firewall.
- A recorded user of `''` means no `-u` everywhere; the effective user is resolved with `id -un`
  after READY and reported (labels cannot change after `docker run`). Why: images without `dev` broke.
- git-credential-kunj is streamed into `$HOME/.kunj/bin` of every container with a token, and
  `KUNJ_CREDENTIAL_HOST` is host:port. Why: only kunj-sandbox had the helper; git sends the port.
- Origin URL credentials are stripped before anything uses the URL. Why: tokens reached argv,
  `.git/config` and error output.
- Devcontainer image tags are lowercased; kunj-sandbox/kunj-nethelper tags carry a hash of their
  build context. Why: Docker rejects uppercase; edited Dockerfiles/firewall.sh were never rebuilt.
- Failed starts remove exactly what they created (new `volumeExists()`, main container listed
  before `run`); `--keep-on-error` still stops a container whose firewall never came up.
- Firewall accepts origin's addresses on origin's port before the private-range rejects; main
  container gets `--add-host host.docker.internal:host-gateway`. Why: a LAN/host origin could not clone.
- Hook `${...}` quoting follows the shell context (`"${worktree}"` works again).
- Warn before building a Dockerfile changed on the branch (builds have full network access).
- Remove guard fails closed when `git stash`/`git status` fail; create hooks skip on resume;
  README security notes; package.json `files` whitelist.
- Tests: `npm test` 257, `npm run test:docker` 9. Old `kunj-sandbox:1.0.0`/`kunj-nethelper:1.0.0`
  tags removed after the new ones built.

## 2026-10-22 — Implement branch containers, phase 1

Why: executed the phase-1 plan so `kunj container` (alias `ct`) exists end to end.

- 12 tasks: hook quoting fix, settings and hooks, names, devcontainer subset, backend + docker CLI,
  images, seed, lifecycle, forward, command + fast path, docs (this entry, README, CLAUDE.md), Docker
  integration tests.
- Review findings that changed the design: the main container runs `--entrypoint sleep` so no
  image code runs before the firewall is up; the firewall is a network-helper sidecar sharing the
  agent's network namespace (the agent holds no capabilities); names carry a hash suffix and reuse
  checks labels; the git credential helper is scoped to origin's host; `${...}` in `hooks.*` config
  commands is now shell-quoted (users must not add their own quotes).
- Docs: README section "Run a branch in a sandboxed container", CLAUDE.md "Branch Containers", and a
  line in `kunj hooks --help` about quoting.
- Tests: `npm test` 235, `npm run test:docker` 8.
- Deferred to phase 2+: sidecar services, `open`, `prune`/`--auto`, Docker-in-Docker, remote backend
  (`kunj serve`), VS Code extension and macOS app UI.

## 2026-10-21 — Design: branch containers (`kunj container`)

Why: asked for a feature that starts a session for a branch inside a Docker container, like
`kunj worktree` but sandboxed, mainly to run an AI agent with permissions skipped; later the Docker
daemon should be able to live on a remote machine behind a kunj service.

- Wrote `docs/superpowers/specs/2026-10-21-branch-containers-design.md`. Decisions reached in the
  brainstorm: real sandbox (own clone, no bind mounts, origin is the only channel in and out — the
  bundle idea was dropped as unnecessary), image from the repo's devcontainer else a kunj default,
  configurable credential forwarding, optional egress allowlist adapted from Anthropic's reference
  devcontainer, per-branch network with sidecar services, opt-in Docker-in-Docker (sysbox /
  privileged in an isolated VM), port forwarding over `docker exec`, agents in tmux, and a
  `ContainerBackend` interface so a remote backend can be added without redesign.
- Second pass (same day): an adversarial review found 15 issues; verified the two about existing
  code (`branchToDirName` collapses `feature/x`/`feature-x`; `hooks.*` config commands substitute
  `${branch}` as text into a `shell: true` command). Spec revised: hash suffix on names + label
  match on reuse, stronger remove guard, credential helper scoped to origin's host, root refused,
  firewall moved to a network-helper sidecar (agent container has no capabilities), host/LAN
  blocked by default, AWS keys only with Bedrock, DNS pinned, allowlist re-resolved, privileged
  needs an explicit setting, hook quoting fix as a prerequisite, idempotent seed, prune/`--auto`
  moved to later phases. A "what the sandbox does and does not protect" table was added.
- Spec approved. Wrote the phase-1 implementation plan
  `docs/superpowers/plans/2026-10-21-branch-containers-phase-1.md` (12 tasks: hook quoting fix,
  settings/hooks, names, devcontainer subset, backend + docker CLI, images, seed, lifecycle,
  forward, command + fast path, docs, Docker integration tests).
- Added `src/lib/container/names.ts` (+ tests): repo id from remote URL, hashed container/volume/network names and `kunj.*` labels, because `branchToDirName` collapses `feature/x` and `feature-x` and repo names can repeat.
- Added `src/lib/container/backend.ts` (`ContainerBackend` interface) and `docker.ts` (`LocalDockerBackend`, + tests): the single seam to Docker so lifecycle/forwarding/command code can be faked and a remote backend added later; docker is spawned with argv only, env goes through a 0600 `--env-file` so secrets stay out of `ps`, and a listing costs two subprocesses.
- Added `src/lib/container/image.ts` (+ tests), the `kunj-sandbox` (Debian, no sudo, uid 1000 `dev`, origin-scoped `git-credential-kunj`) and `kunj-nethelper` (Alpine + iptables/ipset `firewall.sh`) build contexts in `src/container/`, and `scripts/copy-container-assets.js` in `npm run build`: image resolution (setting, devcontainer hashed by Dockerfile/tree/args, else sandbox), build-on-first-use, and a dependency-free ustar writer, because containers need an image and the firewall must live outside the agent's container so the agent cannot undo it.
- Review fixes to `firewall.sh`: allowlist refreshes only add (a DNS timeout no longer drops a host), a start fails if origin or a required host does not resolve, `host.docker.internal`/`gateway.docker.internal`, 100.64/10 and 0/8 are blocked too, IPv6 without ip6tables refuses to start, a restarted helper swaps fresh sets in instead of flushing the live ones, and only connect-type curl errors count as "example.com blocked".
- Added `kunj container` (alias `ct`; `src/commands/container.ts` + tests) on the fast path: start/shell/exec/agent/attach/forward/list/stop/remove over the container library, `{ error: { code, message } }` in `--json`, `aliases`/`allowUnknownOption` in `CommandConfig`, `getVersion()` moved to `src/lib/version.ts` and `getOriginUrl()`/`getRepoCommonDir()` exported from config, so the branch containers have a user-facing command that lists in ~0.1 s without loading AWS.
- Added Docker integration tests (`src/lib/container/__tests__/integration.docker.test.ts`, `npm run test:docker`, excluded from `npm test`) against a `git daemon` origin, and fixed the allowlist's origin check, which only probed 443/22 and so refused any origin on another port: `KUNJ_FW_ORIGIN_PORT` (from `originPort()` in seed.ts) is now probed first, because this was the first end-to-end run of `kunj container` against real Docker.

## 2026-10-16 — Remove several worktrees at once (VS Code + macOS app)

Why: asked to multi-select worktrees to delete in both the macOS app and the VS Code extension.

- VS Code (`vscode-extension/src/extension.ts`, `package.json`): the Worktrees tree has
  `canSelectMany`; "Remove Worktree…" (inline trash or context menu) removes every selected
  worktree when the clicked one is part of the selection. From the command palette or the view's
  `…` menu it opens a multi-select quick pick. The main worktree and worktrees open in this window are
  skipped (and named in the confirmation). One modal lists every worktree with its warnings (open
  elsewhere, uncommitted changes); open/dirty ones are force-removed, and those git still refuses
  are offered a single "Force Remove" afterwards. The command is no longer hidden from the palette.
- macOS app: a checklist toggle in the panel header (or ⌘-click a row, or "Select" in a row's
  context menu) enters selection mode — rows show checkboxes (main cannot be checked), clicking toggles,
  and the footer shows "N selected" with Cancel and "Remove N Worktrees…". `AppStore.remove(_:)` now
  takes a list (the single remove goes through it): one confirmation, sequential removal, rows show
  "Removing…", one force prompt for refusals, one summary flash. Closing the panel leaves selection mode.
- `Support/Snapshot.swift` also renders `rows-selecting-light/dark.png`.
- Verified: extension builds and type-checks; macOS app builds, Swift tests pass (49), snapshots
  checked in light/dark, app reinstalled. Not clicked through live (removing real worktrees).

## 2026-10-15 — Organize Windows removes empty desktops

- After arranging, Organize Windows removes every desktop that has no window on it, on every attached
  display, last to first; each display's current desktop always stays. Why: asked for the rearrange to
  delete the empty desktops it leaves behind.
- "Empty" (`emptyDesktops()` in `KunjBarCore/EmptyDesktops.swift`, 4 tests): no ordinary (layer 0)
  window of any app is on it, minimized and off-screen windows included, read with
  `CGWindowListCopyWindowInfo` + `CGSCopySpacesForWindows` (`Spaces.spacesOfAllWindows()`). A window on
  several spaces (assigned to all desktops) keeps none of them alive.
- `MissionControl.removeDesktop()`: opens Mission Control, hovers the desktop's button and uses its
  remove action when it has one, else presses the close button that appears on hover (found near the
  button by its title/description/subrole), then polls until the space is gone. A failure is logged and
  stops removal on that display; the rest of the run is unaffected. Remembered desktops that were removed
  are forgotten.
- Settings → Organize: "Remove empty desktops afterwards" (on by default). The finish message adds
  "removed N empty desktops".
- Not verified live: running Organize moves the user's windows and needs a click in the menu, so the
  Mission Control removal (which button/action macOS 26 exposes) still has to be tried by hand; the log
  window shows what happened.

## 2026-10-15 — Release v1.2.0

- Tagged v1.2.0: the macOS app's Organize Windows (desktops per worktree pair, tiled editor/terminal
  windows) and the open worktree switcher (⌥⌘K, coloured PR badges). Minor bump because both are new
  features. Why: asked to push and create a new release.

## 2026-10-15 — Open worktree switcher (global hotkey) in the menu bar app

- `macos-app/Sources/KunjBar/Support/HotKey.swift`: system-wide shortcut through Carbon's
  `RegisterEventHotKey` (no Accessibility / Input Monitoring permission needed) and a `Shortcut` type
  that displays itself (e.g. "⌥⌘K") using the current keyboard layout.
- `Support/Switcher.swift` + `Views/SwitcherView.swift`: the shortcut (default **⌥⌘K**) toggles a
  borderless, non-activating panel centred on the screen with the mouse (a little above the middle,
  like Spotlight), on the current desktop or full-screen space. It lists only worktrees open in an
  editor, across every repository; ↑/↓ move the selection (wrapping), ↩ or a click opens it
  (`AppStore.open`, which brings the existing editor window forward), esc or clicking elsewhere closes
  it, and pressing the shortcut again hides it. It refreshes the listing when shown and follows the store
  while visible. Why: asked for a hotkey that lists only open worktrees in the middle of the screen,
  usable with arrow keys + Enter or the mouse.
- Settings: "Open worktree switcher" section with an on/off toggle and a shortcut recorder (click, press
  a shortcut with ⌘/⌥/⌃; esc cancels; Reset returns to ⌥⌘K). The hotkey is suspended while recording.
  If another app owns the shortcut, the panel flashes a message instead of failing silently.
- The switcher's PR badge uses the panel's `PullRequestBadge`, so it is coloured the same way (green checks
  passing, red failing, amber pending, purple merged, outlined for drafts/closed), with a white outline on
  the selected row; clicking it opens the PR. Why: asked to show the PR colour in the switcher.
- `Support/Snapshot.swift` also renders `switcher-light/dark.png`; `SwitcherView(scrolls: false)` exists
  because ImageRenderer draws nothing inside a ScrollView.
- Verified: builds, snapshots render in light and dark mode, app reinstalled. The hotkey itself could
  not be pressed from the agent (osascript has no permission to send keystrokes) — needs a manual try.

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
- Two windows per desktop, not one worktree per desktop: `groupWindows()` cuts each worktree's
  windows (editors first) into pairs and pairs the leftover single windows across worktrees; the
  organizer works per pair (keep / remembered / new desktop, each worktree in the pair remembers it)
  and the flash counts windows and desktops. Why: asked for two per desktop, several times; the
  per-worktree rule left one window per desktop when a worktree had no terminal.
- `worktreeEntries()`: editor windows that match no listed worktree take part as their own entry
  (keyed `window:<id>`), so they pair up too; terminals outside every worktree are still left alone.
  Why: a VS Code window for an unlisted folder sat alone on its desktop.
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

## Shell-quote hook variables
- `shellQuote` / `expandVariablesQuoted` in src/lib/config-vars.ts; configured hook commands (src/lib/hooks.ts) now
  substitute `${branch}`-style values shell-quoted. Why: a branch name like `x$(cmd)` was executed by the shell.
  Hook commands that wrapped variables in their own quotes now see literal single quotes.
- Container settings (task 2): `container.*` settings (src/settings/container.ts), `container` block in KunjConfig, defaults in src/lib/container/defaults.ts, and four `pre/post-container-create/delete` hooks in hook-defs.ts. Why: foundation for `kunj container`.
- Devcontainer parser (task 4): src/lib/container/devcontainer.ts parses the supported devcontainer.json subset (JSONC, build paths, ports, post commands) and refuses root/0 remoteUser. Why: the file comes from the branch, which an agent can edit, so it must not grant root.
- Devcontainer build paths (task 4 fix): parseDevcontainer rejects absolute or repo-escaping build.dockerfile/context. Why: the file is agent-editable.
- Container seed script (task 7): src/lib/container/seed.ts builds the in-container clone/switch script and runs the host-side origin checks (inspect, ls-remote, push, git identity). Why: the container clones the branch from origin, so the host must know whether it is pushed first.
- Container lifecycle (task 8): src/lib/container/lifecycle.ts starts (origin/push checks, image, network, volumes, container, network helper, seed after the firewall is ready, keep files, devcontainer post commands, rollback), resumes, stops, removes behind an unpushed-work guard and reports per-container status; pure env/firewall/parsing helpers in src/lib/container/env.ts, FakeBackend for tests. Why: the orchestration `kunj container` start/stop/remove/list sit on.
- Container lifecycle fixes (task 8 review): the main container runs with `--entrypoint sleep` (new `ContainerSpec.entrypoint`), nothing is exec'd in it before the network helper is ready (start, resume and the remove guard share one bring-up), resume no longer requires the branch on origin, and the remove guard counts a detached HEAD and failed rev-lists as unpushed and runs git with fsmonitor/hooks off. Why: code from the branch could open connections before the firewall existed, and the guard had false negatives.
- Port forwarding (task 9): src/lib/container/forward.ts listens on 127.0.0.1 and tunnels each connection through `docker exec -i <ctr> socat` (bash /dev/tcp fallback), with port-spec parsing and free-port lookup; FakeBackend's stdin reader no longer attaches an error listener, matching docker.ts. Why: `kunj ct forward` reaches container ports without publishing them, and a reset client must not crash the CLI.
- Port forwarding fix (task 9 review): each connection feeds exec through a PassThrough that is ended when the socket closes, and FakeBackend's stdin reader finishes only on 'end' and records `stdinEnded`. Why: a reset or destroyed socket never emits 'end', so the piped `docker exec`/socat kept running and could hold the CLI open.
