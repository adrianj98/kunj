# Workspace IDE (phase 3)

*Researched, reviewed and decided 2026-10-23. Checked against `main` on 2026-10-23. The CLI contract is
shipped; the app is being built. Its runtime is native (AppKit + SwiftTerm, Monaco in WKWebViews),
chosen after the native-shell spike. The architecture was reviewed on 2026-10-23; the review's fixes are
folded in below and its open items are under Open questions.*

## Goal and status

A desktop app built around kunj where every branch is an **environment**: a local worktree or a branch
container. Everything open for it (terminals, agent sessions, editors, previews) lives together;
selecting an environment swaps the whole right side, and background environments keep their panes
alive, so moving between five branches is one click instead of five editor windows and a pile of
terminal tabs. It orchestrates many branches and agents; it is not a replacement for VS Code or Cursor,
which stay the hand-off editors (`kunj ct open`, `kunj worktree open`).

It must list environments grouped by repository with their status (kind, running, agent active, dirty,
ahead/behind, PR, ports); open a shell or an agent in a worktree or container with one action and
reattach to sessions started from the CLI; show what the agent did (diffs, files) and allow small fixes;
drive everything through `kunj … --json`, so it can never do what the CLI cannot; and add no daemon and
no state beyond UI layout.

| Part | Status |
| --- | --- |
| Published JSON types (`src/lib/json-types.ts`, package `types` entry) | Shipped (36e64a5, d0a490a, 22a8444) |
| `kunj agent [start\|status\|stop] [branch]` and `agent` in `worktree list --json` | Shipped (2974aef, 75380f3, ce52ad8) |
| `kunj ct file read\|write [branch] <path>` | Shipped (47fcefe, 5721f17) |
| `kunj events --json` | Shipped (189d9ba, 3685ef6; status poll, origin-based repo ids and `hello` when ready in ce5691d) |
| tmux optional for `kunj agent` (`--no-tmux`) | Shipped (453f241, e5b15a4) |
| Persistent shells: `kunj worktree shell [branch] --session <id> [--kill]` (host tmux `kunjsh-…-sh-<id>`) and `kunj ct shell [branch] --session <id> [--kill]` (container tmux `sh-<id>`) | Shipped (b51dfa1) |
| Several agents per environment and kill-all: `kunj agent [start\|status\|stop] [branch] --session <id>` (host tmux `kunj-…-a-<id>`), `kunj agent stop --all`, `agent.sessions` in `worktree list --json` and `agent status`; `kunj ct agent [branch] --session <id> [--kill]` (container tmux `agent-<id>`), `kunj ct attach --session <id>`, `agent.sessions` in `ct list --json`; `worktree shell` / `ct shell --kill` without `--session` end every shell session of the branch | Shipped (ead40a6) |
| Design package (`docs/workspace-app/design/`) | Received 2026-10-23; the app must match `mockups/warm.png` |
| The app (`workspace-app/`) | Shipped (v1, native); plan `docs/superpowers/plans/2026-10-23-workspace-app-v1.md` (native). Scaffold (package, tokens, scripts, fake-kunj, skeleton window) in 0e8ab41; `KunjCLI`, login PATH and version check in e6feedc; JSON mirrors and the environment model in 53fdf6b; diff and file access core (`DiffModel`, `DiffService`, `FileAccess`) in 831d215; the Changes column (Monaco diff page, `MonacoWebView`, `ChangesColumn`; `--demo` matches `warm.png`'s column) in f3c01a5; event stream and environment store (`EventStream`, `EnvironmentStore`; wired into the app by Task 7) in 8f49f54; sidebar, header, status bar, window chrome and the discovery error state (`--demo` matches `warm.png`) in 95410df, d7b79fa; terminals, agent tabs and the tab bar (`TerminalTab`, `TabRegistry`, `TabBarView`, `HiddenFeedScheduler`), the store and `kunj events` wired into the app, Environment and Tabs menus in 5158fe4, 45756ae; layout file, tab restore and last activity (`LayoutStore`, `LayoutKeeper`) in 062d22d, 2d972db; editor tabs (`EditorTab`, `EditorSave`, the `?mode=editor` page, the diff header's `Edit`, File > Save) in 54a0685; actions, New session, search, shortcuts, Settings, the Changes toggle and live themes (`ActionRunner`, `NewSessionSheet`, `SettingsWindow`) in fb62af9; user docs (`docs-site/.../workspace-app.mdx`), README and CLAUDE.md sections in f44b785; review fixes in 29be7f1, 3c0627d, 5e4a829, 7808f6f and c09bbd7 (login-shell timeout); final review fixes in 22336bb (descriptors, symlinks, `kunjName`, per-repository refresh queue) |
| Runtime choice | Native: AppKit + SwiftTerm, Monaco in one WKWebView (spike 1c2aaa3, 0e41a24) |
| `kunj install workspace`, release job | Shipped (7d497a6) |

## Design

### Layout

The look is the design package in `docs/workspace-app/` (received 2026-10-23): `design/DESIGN.md`
for principles, layout, type and themes, `design/tokens.json` for every colour and layout constant,
and `design/mockups/warm.png` as the reference the app must match. The package is design only; its
technical remarks (xterm.js, Electron, CSS variables) are superseded by the runtime below.

```
┌──────────┬────────────────────────────────────────────────────┐
│ sidebar  │ header  52px  (title, meta line, actions)           │
│ 272px    ├─────────────────────────────┬──────────────────────┤
│ ⌘K       │ tab bar 40px                │ Changes bar 40px     │
│ sessions ├─────────────────────────────┼──────────┬───────────┤
│ grouped  │ terminal (SwiftTerm)        │ file list│ diff      │
│ by repo  │ 11fr                        │ 196px    │ (Monaco)  │
│ + New    ├─────────────────────────────┴──────────┴───────────┤
│ session  │ status bar 28px                                     │
└──────────┴────────────────────────────────────────────────────┘
```

- **Sidebar:** sessions grouped by repository, one row per environment: status dot (green agent
  running, amber waiting for input, idle otherwise), *title · relative time*, then *kind · status
  verb* in mono. The title is the branch (task titles need metadata the CLI does not report; see
  Decisions); the status verb comes from `Environment.statusVerb` (see Data flow). A ⌘K search box on
  top, "+ New session" at the bottom, the agent count and kunj version under it. Only **open
  sessions** are listed (`sidebarGroups`): environments with tabs in the app or saved in the layout
  file, a running or waiting agent, and the selection; each repository ends in an `N more…` row
  (11 px `faint`) that lists the rest too (`Show fewer`), and a search lists every match, so any
  environment can be opened. A row's right-click menu (`ActionRunner.rowMenu`) has the menu bar app's
  row actions, opening into the panel: Open, New Shell, New Agent, New Antigravity Agent (worktrees
  only; `kunj agent --agent antigravity`, also Environment > Antigravity Agent ⌘⌥A, tab titled
  `antigravity`), Open in VS Code (and in a new
  window for a worktree), Open / Copy Pull Request URL or Create Pull Request…, Start / Stop / Rebuild
  Container, Reveal in Finder, Copy Path (Container Name), Copy Branch Name, Close Session, and Delete
  Worktree… / Delete Container… (the same confirmation, with Force, as the overflow menu). The row
  menu and Environment > Close Session ⌘⇧W close the session:
  every tab (an unsaved editor asks), then `kunj worktree shell <b> --kill` and `kunj agent stop <b>
  --all` (containers: `kunj ct shell <b> --kill`, `kunj ct agent <b> --kill`), so its tmux sessions
  end too, the ones started outside the app included; its saved tabs are cleared.
- **Header:** title, then a mono meta line: repo / branch · kind · ahead/behind · PR (link) · ports.
  Actions right-aligned: Shell ⌘T, Agent ⌘⇧A, Open in VS Code ⌘O (outlined) and Create PR ⌘⇧P (the one
  filled button), plus an overflow menu with start/stop/remove and worktree remove.
- **Tab bar (left column):** segmented pills, one per terminal or editor tab; a dot when its process
  has a notable state, or a `text2` dot on an editor tab with unsaved changes, and an × at its right
  that closes it (like ⌘W; `faint`, `muted` on the active tab, `text` on a `raised2` square when
  hovered). Right side: `tmux <session> · uptime`, the split button (disabled until v2) and
  new-tab.
- **File links in terminals:** ⌘-click on a path SwiftTerm detects (⌘ underlines it) opens it in an
  editor tab. `terminalLinkPaths()` (Core) drops a `:line[:col]`/`#L…` suffix and makes the path
  relative to the worktree, or `/workspace` in a container: a relative one against the shell's OSC 7
  directory first, then the root; absolute and `file://` ones only inside the root. In a worktree the
  first candidate that exists opens; in a container the first one (a missing file shows the editor's
  message). Anything else (a URL, a path outside the root) goes to SwiftTerm's default opener.
- **Terminal tabs:** a login shell in the worktree (`kunj worktree shell <branch> --session <id>`), or
  `kunj ct shell <branch> --session <id>` for a container: with tmux (on the host, or in the image)
  each shell tab is its own tmux session, so quitting the app keeps it and the next launch
  reattaches; closing the tab (⌘W, its pill's menu) ends the session (`--kill`). Without tmux it is a
  plain login shell. The id (8 hex) is saved with the tab.
- **Many agents:** Agent ⌘⇧A opens a new agent tab each time, `kunj agent <branch> --session <id>`
  (`kunj ct agent … --session <id>`), each its own tmux session; closing the tab stops that agent
  (`kunj agent stop <b> --session <id>`, `kunj ct agent <b> --kill --session <id>`). An agent tab
  saved before sessions has no id and attaches to the default session. The tab dots show the
  environment's combined agent state.
- **Agent tab:** a terminal running `kunj agent <branch>` or `kunj ct agent <branch>`, which attaches
  to the environment's tmux session, so a session started from the CLI shows up in the app and the
  reverse.
- **Changes column (right, hidden by default):** the terminal column takes the full width until it is
  opened with the Changes toggle (a `Changes` pill with the uncommitted-file count at the right of the tab bar,
  `Changes` alone at 0, since the base scope can still show committed work;
  View > Show Changes ⌘⇧C); it closes the same way. Open or closed is one app-wide UI setting,
  remembered across launches; while closed the column does not compute diffs. When open: header
  `N files · +adds −dels` and a scope select
  (vs origin/<base>, default: everything since the fork point, working tree included; Uncommitted;
  Last commit); a file list (A/M/D letter, name, ± counts); Monaco's diff editor for the selected file.
  An × at the right of its bar closes it (the same toggle).
- **Files column (right edge, hidden by default):** a file explorer of the selected environment
  (`git ls-files` tracked + untracked, plus the ignored entries of `git status --ignored=matching`
  in `faint`, so `.env` shows while `node_modules` is one folder without its contents; through
  `kunj ct exec` in a running container), folders first, opened with a `Files` pill after `Changes` in the tab bar or View > Show
  Files ⌘⇧E, 260 px wide at the window's right edge (the terminal and Changes columns keep 11:9 of
  the rest). A double-click (or Return) on a file opens an editor tab. Open folders are kept per
  environment for the session; it reloads 1 s after a `git` event of its repository; over 50,000
  files only the first 50,000 are listed. One app-wide setting (`showFiles`), remembered; closed it
  lists nothing. An × at the right of its bar closes it. `FileLister`/`buildFileTree` in Core,
  `FilesColumn` in the app.
- **Status bar:** container name or worktree path · uptime · services · forwards; right side the agent
  state and the ⌘1–9 hint.
- **Editor tab** (v1): a changed file of the environment, edited in Monaco (see Editor tabs).
- **Preview tab** (v2): a webview on a forwarded port. v1 shows the ports as links that open the browser.
- **Themes:** warm (default, dark), light and graphite from `tokens.json`; light ↔ warm follow the
  system appearance, with an override in settings. The `term*` tokens are the terminal theme.

### The CLI is the contract

The app is the third consumer of `kunj … --json`, after the VS Code extension and the macOS app. It
runs kunj subprocesses and never imports `src/lib/**` or `dist/lib/**` at runtime; it imports only the
JSON types (`import type … from "kunj"`). Importing the library would bundle a second kunj at its own
version, with its own config loading and hooks, and the GUI would soon do things the CLI cannot.

- **Binary:** the `kunjCommand` default (`kunj`, or a command line such as `node /path/dist/index.js`;
  `-kunjCommand "…"` on the command line for one run) started through `/usr/bin/env` on a login-shell
  `PATH` (as `macos-app/` does); `kunj -V` must meet `MIN_KUNJ_VERSION`, and `1.0.0` (an `npm link`ed
  dev build) is accepted and labelled `dev`. env exiting 127 for kunj itself is `not-found`
  (`npm install -g kunj`); for what kunj's `#!` names (`env: node: …`, nvm not loaded) it is
  `command-failed` with that line, because installing kunj would not help. The version shows at the
  sidebar's foot (`kunj 1.0.0 dev`).
- **cwd is the repo argument:** every call runs with `cwd` set to the repository's `root` from
  `kunj repos --json` (the git dir for a bare repo) and names the branch explicitly.
- **State** comes from `kunj repos --json`, `kunj worktree list --json` and `kunj ct list --json`,
  refreshed when `kunj events --json` says so; the app never asks git or Docker for state and never
  reads `~/.kunj/container-forwards.json` (forwards arrive as `ports[].kind === "forward"`).
- **Actions:** `worktree add|remove|open`, `ct start|stop|remove|open`, `agent`, `ct agent|shell|exec|file`.
  Long ones (`ct start`, `ct remove`, `blueprint snapshot`) run in a terminal tab, so progress shows as
  in a shell.
- **Diff content:** read-only `git` in a worktree, `kunj ct exec <branch> -- git …` in a container. The
  app's own git calls run with `GIT_OPTIONAL_LOCKS=0`; otherwise they refresh the index, which
  `kunj events` reports, and the app would refresh in a loop.
- **App state:** UI layout only, `~/.kunj/<reponame>/workspace.json`, `{ "<kind>:<branch>": { tabs, active, lastActivity } }`
  (one file per repo, so slashes in branch names do not matter). tmux and Docker hold the real state.

### CLI contract (shipped)

**JSON types.** `src/lib/json-types.ts` declares `ReposJson`, `WorktreeListJson` (with `WorktreeJson`),
`ContainerListJson` (with `ContainerJson`, `ContainerPortJson`), `FileReadJson`, `FileWriteJson`,
`AgentStatusJson`, `AgentStopJson`, `EventJson`, `AgentState` and `ErrorJson`; `package.json` has
`"types": "./dist/lib/json-types.d.ts"`. Commands build their output against these types (`satisfies`
or an annotation), so the file and the output cannot drift. Type-only, so the fast path can import it.
Changes are additive.

**Errors in `--json` mode** (`ErrorJson`): `kunj ct` always prints `{ "error": { "code", "message" } }`
(`code` is the start error code, `hook`, the error's `jsonCode`, else `error`). Elsewhere coded errors are
opt-in: BaseCommand prints `{ code, message }` only for an error with a string `jsonCode` (`AgentError`:
`tmux-missing`, `no-tty`, `not-running`, `no-worktree`; `ContainerError` with a code: `bad-path`,
`not-found`, `write-failed`); every other error stays `{ "error": "<message>" }`.

**`kunj agent [start|status|stop] [branch]`** (src/commands/agent.ts, src/lib/agent-session.ts) runs
`agent.command` (default `claude`, no permission skipping on the host) in a host tmux session for a
worktree. One tmux server serves the host, so the name is `agentSessionName()`: the container name from
`containerNames()` with `.` and `:` replaced by `-` (`kunj-<readable>-<hash>`); inside a container, which
has its own tmux server, the session stays `agent`. `start` runs `tmux -u new-session -A -s <name> -c
<worktree> -e KUNJ_BRANCH=… -e KUNJ_REPO=… -e KUNJ_WORKTREE=… <command> ; set-option window-size latest ; set-option status off`
(`-e` because a new session's environment comes from the tmux server; `TMUX` is dropped from the
environment so it works from inside a pane; `window-size latest` so the app and a CLI terminal attached
together are sized to the last one attached; `status off` because the app's tab bar and status bar already show the session, and tmux's line would cost the agent a row; it is a session option, so other tmux sessions keep theirs, and `kunj ct agent` sets it on the container's `agent` session too; `agent.tmuxStatus: true` keeps the line). `agent.tmux: false` makes `start` (and `kunj ct agent`) run the agent directly, as `--no-tmux` does, without the hint, except that an agent still running in the worktree's (or container's) session from before the change is reattached rather than joined by a second agent; `kunj ct attach` then explains that there is no session to attach to instead of suggesting `kunj ct agent`. Without tmux, or with `--no-tmux`, `start` runs the
command directly through `$SHELL -lc` in the worktree with the same `KUNJ_*` environment, after a
one-line stderr hint that the agent stops when the terminal closes. It needs a terminal (`no-tty`). `status --json` prints
`AgentStatusJson`, `stop --json` `AgentStopJson`. `kunj worktree list --json` gives each existing,
non-bare worktree on a branch `agent: { running, session, state }` from one `tmux list-sessions` per listing;
`running` is `null` only when tmux is not installed, and the field is absent with `--no-status`.

**Agent state** (`agent.hooks`, default true): when the agent command is `claude`, `kunj agent` and
`kunj ct agent` append `--settings` with Claude Code hooks that write `running` (UserPromptSubmit,
PreToolUse) or `waiting` (Stop; Notification for permission, idle and elicitation prompts) into
`$KUNJ_AGENT_STATE`, and remove it on SessionEnd. On the host the file is
`~/.kunj/<repo>/agent-state/<session>`, in a container `/tmp/kunj-agent-state`. `worktree list --json`
and `ct list --json` report it as `agent.state` (`running | waiting | null`), only while the agent's
tmux session exists (a crashed agent never fires SessionEnd). `kunj events` watches the host directory
and emits an `agent` event with `state` and `repo` only when the value changes (PreToolUse rewrites it
on every tool call), none for a deleted file (the tmux poll reports the end), and includes the state in
the container status poll.

**`kunj ct file read|write [branch] <path>`** (src/lib/container/files.ts): the path is relative to
`/workspace` (absolute, `..`-escaping, empty and NUL paths are `bad-path`); it runs as the sandbox user
in a running container; `read` prints the content (`FileReadJson`), `write` takes stdin and creates
parent directories (`FileWriteJson`).

**`kunj events --json`** (src/lib/events.ts, src/commands/events.ts): an NDJSON stream for every
repository in `~/.kunj/repos.json` (or those given with `--repo <path>…`), debounced per key (250 ms). The first line is `{ "type": "hello", version, repos }`; a first line
that is anything else is an `ErrorJson`. Each later line says what to refresh, not what changed:

- `git` (a repo): fs watches on its git refs, HEAD and index, debounced per repository;
- `sessions`, `forwards`, `repos`: the registry files in `~/.kunj`;
- `container`: Docker lifecycle events of kunj containers, passed through except exec, attach and copy
  events (which `ct list` itself causes); `repo` is mapped from `git remote get-url origin`, the same id
  as the containers' `kunj.repo` label, and is `null` for a container of no watched repository;
- a **status poll** every 10 s (`statusPollMs`) runs `git status` in each worktree and the `ct list`
  status script in each running container, and emits `git`, or `container` with `action: "status"`,
  when the result changes (the watches cannot see a file edited in a worktree or work inside a container);
- `agent`: a host tmux session `kunj-…` appeared or went away (polled every 5 s);
- `backend`: the container engine became unavailable or available again (retried).

It ends on SIGINT/SIGTERM or when stdin closes, so it dies with its parent.

### Architecture

Decided 2026-10-23, before the app was started. One process, no daemon: the app owns AppKit views, a
handful of child processes and one WebKit content process.

```
Kunj Workspace.app
├─ kunj repos | worktree list | ct list --json   short-lived, one per refresh, cwd = repo root
├─ kunj events --json                            one long-lived child; stdin held open, restarted with backoff
├─ PTYs (SwiftTerm LocalProcess)                 $SHELL -l · kunj agent <b> · kunj ct shell|agent <b> · kunj <long action>
├─ git (read-only, GIT_OPTIONAL_LOCKS=0)         diff content in a worktree; kunj ct exec <b> -- git … in a container
└─ WKWebView ×2 (one process pool, one origin)  Monaco: the Changes diff, and the editor tabs
```

**Package** `workspace-app/` (SwiftPM, no Xcode project, macOS 14+, like `macos-app/`):

| Target | Holds | Depends on |
| --- | --- | --- |
| `KunjWorkspaceCore` | Everything testable without a window: `Version`, the `Codable` mirrors of `json-types.ts`, `ShellEnvironment` (login PATH), `KunjCLI`, `EventStream`, `Environment` + `EnvironmentStore`, `TerminalSpec` + `tabDot` + `exitCode(waitStatus:)`, `HiddenFeedScheduler`, `DiffModel` + `DiffService`, `FileAccess`, `WorkspaceLayout` + `LayoutStore` + `restorePlan` + `ActivityTracker`, `saveDecision` + `editorRefusal` (EditorSave), `actionPlan` + `newSessionPlan` + `runOutcome` + `KunjSetting` (ActionSpec), `discoveryErrorDetail` (ShellEnvironment), `DesignTokens` (generated), `RelativeTime` | Foundation only |
| `KunjWorkspace` | The app: `AppDelegate` (menu, shortcuts), `Theme` (NSColor/NSFont from the tokens, system appearance), the views (`MainWindowController`, `SidebarView`, `HeaderView`, `SidebarRowView`, `TabBarView`, `TerminalColumn`, `ChangesColumn`, `StatusBarView`, `Controls`), `DemoData` (`--demo`), `TerminalTab` (SwiftTerm), `EditorTab`, `TabRegistry` (terminals and editors as `WorkspaceTab`), `LayoutKeeper` (layout file and `lastActivity`), `MonacoWebView`, `ActionRunner`, `NewSessionSheet`, `SettingsWindow` | Core, SwiftTerm, AppKit, WebKit |
| `KunjWorkspaceCoreTests` | `swift test` (Swift Testing), with `Tests/Fixtures/fake-kunj` (a `sh` script answering from `Tests/Fixtures/responses/*.json`) and the helpers in `Support.swift` | Core |

SwiftTerm is vendored at an exact tag by `scripts/prepare-swiftterm.sh` (the spike's one-line
`Shaders.metal` patch, so it builds with the Command Line Tools, and a second patch in `Pty.swift`:
the forked child closes every descriptor above 2 before `execve`, because `forkpty` does not and a
shell's background job would otherwise hold `kunj events`' stdin open after the app is gone). Monaco's `min/vs` build is copied
into `Resources/web/vs` by `web/copy-monaco.js`; Inter and JetBrains Mono (OFL) are fetched at pinned
versions into `Resources/fonts` by `scripts/fetch-fonts.sh` and registered through
`ATSApplicationFontsPath`. `scripts/gen-tokens.js` turns `docs/workspace-app/design/tokens.json` into
`Sources/KunjWorkspaceCore/Design/DesignTokens.swift` (committed; a test fails when they drift).
`scripts/bundle.sh` builds `build/Kunj Workspace.app` (one `swift build --triple` per architecture,
joined with `lipo`; ad-hoc signed; `--install` copies it to /Applications) and `scripts/test.sh` runs
`swift test` (Swift Testing, not XCTest) with the same SDK fallback as `macos-app/`; both take
`SCRATCH=<dir>` so parallel builds do not share a build directory. `workspace-app/README.md` documents
the scripts, their variables and `fake-kunj`'s fixture naming rule.

**Data flow.** `EnvironmentStore` holds `[RepoEnvironments]` and is the only source for the views. A
refresh runs `kunj repos --json` (hidden and missing repos skipped), then per repo `worktree list --json`
and `ct list --json` in parallel (a failing `ct list` marks that repo's backend unavailable; the worktrees
still show), and merges them into `Environment` values (`id = "<repo name>|<kind>|<branch>"`, the name as `kunj repos`
reports it; a worktree and a container on the same branch are two rows; bare and detached worktrees are
left out). `repos` runs in the user's home, everything else in the repo's root. `EventStream` runs
`kunj events --json` in the home directory with stdin held open (closing it ends the child; `stop()`
waits 2 s, then SIGTERM, then SIGKILL), reads it line by line on a background thread and restarts it
with doubling backoff (1–30 s, reset after a child outlived 30 s). The store maps `git`/`container`/`agent`
events to a refresh of that repo and `repos`/`backend`/`sessions`/`forwards`, or an event for a repo it
does not know, to a full refresh, coalesced per key (300 ms from the first event; a pending full refresh
swallows scoped ones; one repository's refreshes run one at a time, a full refresh waits for all of
them and they for it, so one repository's slow `ct list` does not hold up another's), and calls `onChange` on the main actor only when
`repos` or `lastError` changed. `kunj events` resolves its repositories once, so a full listing whose
roots differ from the ones the stream started with restarts it. The app never asks git or Docker for state. The status verb and dot are pure
functions of an `Environment` (`Environment.statusVerb`, `Environment.dot`), in this order: missing
worktree, stopped container, agent waiting, agent running, PR merged, PR open, dirty (`N changed files`),
ahead (`↑N unpushed`), `Clean`. `ct list` reports a container's dirty state without a count, upstream
or PR, so a dirty container reads `Changed files` and its meta line shows `↑N` alone; the dot is amber for waiting, green for running, idle otherwise. An
agent's `state` counts only while `agent.running` is true: a crashed agent never fires SessionEnd and
leaves its last state behind. Refreshes are scoped to what changed: a `git` event re-runs only that
repo's `worktree list --json`, a `container` event only its `ct list --json` (which execs into every
container), `agent` (which carries `repo` when kunj knows it) the repo's `worktree list`, and
`repos`/`backend`/`sessions`/`forwards` everything. After the event stream restarts, the store does a
full refresh, because events from the gap are lost (the first `hello`, which follows the app's initial
refresh, is skipped). The relative time is the app's own `lastActivity` per environment
(bumped when the environment differs from the last listing that had it, or a key is pressed in one of
its tabs, at most every 5 s; an environment missing from one listing, after a failed `ct list` or
`worktree list`, and a pull request that appears or disappears are not activity; persisted in the layout file).

**Agent state.** Running comes from tmux (`agent.running`); *waiting for input* comes from Claude Code
hooks that kunj installs: `kunj agent` and `kunj ct agent` append `--settings '<json>'` to a command
whose first word is `claude` (setting `agent.hooks`, default true) with `UserPromptSubmit` and
`PreToolUse` → `running`, `Stop` and `Notification` (`permission_prompt|idle_prompt|elicitation_dialog`)
→ `waiting`, `SessionEnd` → remove, each a `printf` into the file named by `KUNJ_AGENT_STATE` (host:
`~/.kunj/<repo>/agent-state/<session>`; container: `/tmp/kunj-agent-state`). `worktree list --json`
reports it as `agent.state` (`running | waiting | null`), `ct list --json` reads it in `STATUS_SCRIPT`,
and `kunj events` watches the host directory and includes `state` in the container status poll
(`EventJson.agent` gains `state` and `repo`). No tmux hooks, no polling of panes. Events come only on
a change and carry the repo; the container status script reports the state only while the `agent`
tmux session exists.

**Terminals.** `TerminalTab` is a `LocalProcessTerminalView` per tab, created from a `TerminalSpec`
(`shell`: `$SHELL -l` in the worktree, or `kunj ct shell <b>`; `agent`: `kunj agent <b>` or
`kunj ct agent <b>`; `action`: `kunj <args…>` with `exec` semantics, the tab closing itself on exit 0,
except `kunj pr`, whose tab stays open so its PR URL can be read). A shell that exits 0 closes itself
too; an agent tab or a failed process stays with `[process exited with code N]` (the code from the
wait status, 128 + N for a signal). `TabRegistry` keeps the tabs per environment id and the active one;
closing a tab, or quitting, sends SIGHUP before SwiftTerm's SIGTERM, as closing a terminal window does
(an interactive zsh ignores SIGTERM; `tmux attach` detaches, so the agent's session stays), and
signals nothing once the process has exited. Tab titles are the spec's (`zsh`, `agent`, `shell`, the
action's first two words); a program's OSC title is only the pill's tooltip. The tab bar's dot is green
for a live agent or action tab, amber for an agent tab while its environment waits; its right side is
`tmux <session> · <uptime>` when the environment has an agent tab (a container's session is `agent`).
Every tab's view stays in the window, hidden when not shown, so switching environments never touches a
process. The spike's bottleneck is parsing on the main thread, not drawing, so batching output alone
does not help: a hidden tab queues its bytes and feeds them in slices under a time budget per run-loop
turn (4 ms for all hidden tabs together), so a flood in a background environment delays that tab's
catch-up instead of the UI. Nothing is ever dropped: cutting the stream can split an escape sequence
and leave the terminal in the wrong mode. A shown tab is fed at once. The environment of every PTY: `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG`
(user's or `en_US.UTF-8`), PATH from the login shell (resolved once per discovery, off the main thread: `$SHELL -l -i -c` capped
at 5 s; when that times out, `$SHELL -l -c` with the same cap, which reads `.zprofile` but not
`.zshrc`, and a `kunj not found` then says the shell timed out, shows the PATH used and points to
Settings; until the first listing is in, the window shows a spinner, "Loading sessions…" and the step,
`Finding kunj` then `Listing worktrees and containers`, from `emptyStateText()` in Core),
the Claude Code and terminal-program markers removed; kunj's own `--json` calls get the same
environment, so nothing kunj spawns inherits the markers. The theme's `term*` tokens are the terminal
colours (`termMuted` as bright black, `termAccent` as blue).

**Changes column.** `DiffService` lists `ChangedFile`s (`status A/M/D/R`, `added`, `deleted`) for the
scope: `base` (default: `git diff --numstat -M <merge-base(origin/<base>, HEAD)>` plus untracked files,
whose line counts come from one `find … -type f -exec wc -l {} +` for all of them, never one exec per
file in a container; at most 500 are counted), `uncommitted` (`HEAD`, plus untracked), `last`
(`HEAD~1 HEAD`). `<base>` is `origin/<PR base>` when that was fetched, else `origin/HEAD`, else
`origin/main`, else `origin/master`, all read from one `for-each-ref refs/remotes/origin/` (the app
never fetches, so a PR base may be missing); a base that does not exist, or shares no commit with
HEAD, is an error the column shows, never a fallback to a local branch. Every git call passes
`--no-optional-locks -c core.quotePath=false`, because a container does not get the host's
`GIT_OPTIONAL_LOCKS`. Contents are `git show <ref>:<path>` and the working file (fs in a worktree,
`kunj ct file read` in a container; a worktree symlink reads as its target text, as git stores it).
Monaco's diff editor renders the selected file read-only (inline at the column's width, unchanged
regions folded to 3 lines of context; a file with one empty side in a single-side editor with every
line marked `+` or `−`); the Monaco theme is built from the tokens (`bg`, `addBg`, `faintest` line
numbers) and leaves the diff's code monochrome; editor tabs (`?mode=editor`) add muted syntax colours
(`SYNTAX` in app.js). TypeScript/JavaScript semantic diagnostics are off in both pages (the page has one
file and no node_modules, so every import was an error); syntax errors still show. The page's functions take one argument object
(`window.kunj.showDiff({original, modified, language, path})`). The column reloads 500 ms after a
`git` event of its repository or a container `status` event (`EnvironmentStore.onRepoChanged`), keeps
the selected path and the scope per environment, and refetches the selected file without re-sending
an identical diff, so the view does not jump back to the top.

**Editor tabs.** Double-clicking a changed file (or "Edit" in the header row over the diff: the
file's path and the button, 29 px in `raised2`) opens it as a tab in the left column, in the second
WKWebView (`?mode=editor`, one Monaco model per open file, one page shared by every editor tab; an
open tab of the same file is activated instead). A binary file (a NUL byte), one that is not UTF-8 (a
replacement character after the lossy decode) and one over 5 MB are refused with an inline message,
since saving their decoded text would corrupt them. ⌘S (File > Save, or inside Monaco) saves through
`FileAccess` (`fs` for a worktree, `kunj ct file write` for a container; paths relative, no `..`; a
worktree read takes regular files only, a write goes through a symlink and keeps the file's mode;
every symlink is resolved and a path that lands outside the worktree is refused, read or write, since
a branch can carry `config.ts -> ~/.zshrc`) and
reloads the Changes column; the tab shows a `text2` dot while dirty (status colours stay for agent
states), and text typed while a save is in flight stays dirty. The file is read again before a save:
one that changed since it was opened asks before overwriting, one that was deleted asks before
recreating it, one that already holds the text is not written. Closing a dirty tab asks Save / Don't
Save / Cancel, and quitting with dirty tabs asks Cancel / Quit Without Saving. Key presses in the
editor count as the environment's activity. A crashed editor page is reloaded with every file read
again (unsaved text is lost). No language servers. The web views never name a file to Swift: a save message carries only the
tab id, and Swift holds the path, so content from a container cannot steer a write.

**Layout file** `~/.kunj/<reponame>/workspace.json` (`<reponame>` is `kunjName` from `kunj repos --json`,
named after origin as kunj names the directory, not the folder; an older kunj without it: the folder
without `.git`): `{ "<kind>:<branch>": { "tabs": [{ "kind": "shell|agent|editor",
"title", "path"?, "session"?, "agent"? }], "active", "lastActivity" } }` (`agent`: the `--agent` name
of a non-default agent tab, so it reattaches with its title) (keyed by kind too, because a worktree and a container
on the same branch are two environments), written atomically, debounced 500 ms; action tabs
are never saved; entries or tabs that do not decode are skipped, not the whole file. On selecting an
environment for the first time in a session, once it can run them (worktree present, container running;
until then its entry is not saved over), its tabs are restored with the titles of their specs: shell
and agent tabs reattach to their tmux sessions by the saved `session` id (a shell without one
restarts; each agent tab comes back only while its session is among the listing's `agent.sessions`,
once per session, so an ended agent is not started again; with a kunj that reports no `sessions`,
one agent tab while any agent runs), editor tabs reopen
the file by its saved `path` (one that cannot be read closes). The app writes pending changes when it
quits, and remembers the selected environment (`selectedEnvironment`), selected again after the first
listing so its tabs reattach.

**Actions** (`ActionRunner`): Shell ⌘T, Agent ⌘⇧A, Open in VS Code ⌘O (`worktree open` / `ct open`),
Create PR ⌘⇧P (`kunj pr` in an action tab, in the worktree; for a container environment the host
checkout of that branch is used when it exists, else the button is disabled with a tooltip), New
session ⌘N (a sheet: repo, branch, base, worktree or container, start an agent; runs `worktree add -c`
or `ct start -c` in an action tab), the overflow menu (container start/stop/remove/rebuild, worktree
remove, copy path, reveal in Finder, `ct prune`), ports as links (`open http://localhost:<host>`),
⌘K search filtering the sidebar (Esc clears it, Esc again returns to the terminal), ⌘1–9 selecting
the nth row the search leaves, ⌘⇧] / ⌘⇧[ and ⌘W for tabs. The overflow menu lists only the items of
the environment's kind and greys the rest with the reason as tooltip. Destructive actions confirm with
an `NSAlert` with a "Force" checkbox. A `.run` action that fails, or answers `success: false` (`worktree
open` when the editor did not start), shows an alert; `ct open`'s `exec` (an editor that cannot attach)
is shown as information. New session's action tab runs in the repository's main worktree, and the new
environment is selected (its agent opened when asked) once a listing shows it usable. Settings (⌘,): the kunj command (default `kunj`), the theme
(`auto` = light ↔ warm by system appearance, `warm`, `light`, `graphite`), and two agent toggles that
are kunj settings, not app state: "Run agents in tmux" (`agent.tmux`) and "Show tmux status line"
(`agent.tmuxStatus`), read with `kunj config --get <key> --global --json` and written with
`kunj config --set <key>=<bool> --global`, so the CLI and the app share them (an unset key reads as
kunj's default). Containers: where a new container's GitHub token comes from (`kunj ct token status
--json`; a stored global container `GH_TOKEN` wins, and kunj then never asks gh), "Use gh's GitHub
token" (`container.useGhToken`, the same way), and the Claude Code token (`kunj secret list --global
--json`, which may unlock the vault): Set Up… opens an action tab in the selected environment running
`kunj ct token setup` (it takes the token from `claude setup-token`, checks and stores it, so the app
never sees it); Test runs `kunj ct token check --json` in the home directory (timeout 120 s) and shows
its `message` under the row, ✓ in `green` when `valid`, ✗ in `red` when not, `muted` when null
(`TokenCheckJson`, `claudeTokenCheckText()`); Remove runs `kunj secret rm CLAUDE_CODE_OAUTH_TOKEN --global` after asking. Changing the kunj command rediscovers kunj and rebuilds the store and the event
stream; open tabs keep the command they started with. They apply to agents
started afterwards; a running session keeps its mode.

**Window.** Transparent title bar with the traffic lights inside the sidebar's 52 px top (as in the
mockup), `NSVisualEffectView` (`.sidebar`) under the sidebar tinted with `side`, everything else opaque
in `bg`; all sizes from `tokens.json` (`layout`), radii 5/6 px, 1 px hairlines in `border`, one filled
button. Controls carry accessibility labels (the design's `aria-*` rules, in AppKit). `--demo` renders the mockup's data from fixtures and `--screenshot <png>` writes the window
(the spike's snapshot code), so the look can be compared against `warm.png` without a person.

**Distribution:** a `workspace-app` job in the release workflow attaching `Kunj-workspace-<version>.zip`
(ad-hoc signed, not notarized, like the macOS app); `kunj install workspace` finds it by name and
installs it as `installMacApp()` does. `MIN_KUNJ_VERSION` is `1.3.0`, the first release after v1.2.0
and so the first with the CLI contract; `1.0.0` (an `npm link`ed dev build) is accepted and shown as
`dev`. The fonts' SIL Open Font License text ships in `Resources/fonts/` with them.

**v1:** environment list with status, terminals, agent tabs reattaching to CLI sessions, the agent
waiting state, the Changes column, editor tabs, container start/stop/remove and worktree add/remove,
hand-off to VS Code, Create PR, ports as links, three themes. **v2:** webview preview tabs, split
panes, a file tree, Linux, tearing an environment into its own window.

### Runtime

**Native-shell spike** (`spikes/native-ide/REPORT.md`, 1c2aaa3, 1730cd1, 0e41a24, closed): AppKit with
SwiftTerm terminals and Monaco in one WKWebView. Five live Claude Code sessions cost 6% CPU and about
75 MB; `claude`, `vim`, `top` and truecolor drew correctly through resizes; big output was faster than
Terminal.app on `seq` and `cat`, slower on a `yes` flood; Monaco's diff showed in under 1 s (its web
process 340–420 MB, Monaco's cost in any runtime); menu shortcuts, real key presses and live resize
worked. Weakness: every tab parses output on the main thread, hidden or not, so five flooding tabs pin
it at 95% and typing in them lags 0.5–1.2 s.

## Decisions

All 2026-10-23.

- **Runtime: native** in `workspace-app/`, macOS only in v1: AppKit + SwiftTerm terminals, Monaco in
  WKWebViews (two since editor tabs joined v1: the diff and the editors are on screen together), chosen after the native-shell spike (small footprint, no bundled Chromium, terminals as
  fast as Terminal.app). Parsing hidden tabs' output off the main thread, or throttling it, is an early
  task.
- **The CLI is the only contract;** the app imports JSON types only.
- **Worktree agents through `kunj agent`**, sessions named by kunj; the app never names a tmux session.
- **Container files through `kunj ct file`;** the app never runs `docker`.
- **Refresh through `kunj events --json`,** built before the app; no polling in the app.
- **Editor level: Monaco with the diff editor;** no language servers in v1; VS Code/Cursor as hand-off.
- **Diff default against the base branch,** with uncommitted-only and last-commit options.
- **The UI is the design package** (`docs/workspace-app/design/`, 2026-10-23): two columns under the
  header, terminals left and the Changes column on the right, sidebar rows titled by task with a
  status verb, three themes from `tokens.json`. The package's technical remarks are ignored.
- **The Changes column is hidden by default and opens on demand** (user, 2026-10-23), unlike the
  design's always-visible column: the terminal gets the width, and the toggle (tab-bar pill with the
  file count, ⌘⇧C) brings the diff in when needed.
- **A Files column at the right edge** (user, 2026-10-24), not in the design: hidden until opened
  (`Files` pill, ⌘⇧E), styled like the Changes file list.
- **Ports in v1 as links;** webview previews and split panes in v2 (2026-10-23: the user kept them out of
  this build; the agent waiting state and editor tabs are in).
- **Session titles are branch names** (2026-10-23); the design's task titles need metadata the CLI does
  not report, left for later.
- **Agent waiting state through Claude Code hooks** that `kunj agent`/`kunj ct agent` pass with
  `--settings` (see Architecture), not tmux hooks.
- **Fonts bundled:** Inter and JetBrains Mono, fetched at pinned versions by the build.
- **App state is UI layout only,** in `~/.kunj/<reponame>/workspace.json`, keyed by kind and branch.
- **Architecture review** (2026-10-23): hidden tabs are fed under a time budget, never truncated;
  refreshes are scoped per event type; a full refresh follows every event-stream restart;
  `MIN_KUNJ_VERSION` is 1.3.0; the layout key includes the kind; the `kunj pr` tab stays open.
- **Long actions run in a terminal tab;** no NDJSON progress under `--json` for v1.
- **tmux is optional for worktree agents.** With tmux, `kunj agent` and the app use a host tmux session,
  so agents survive the app quitting, crashing or updating, and the CLI can attach. Without it,
  `kunj agent` runs the agent directly and prints a hint, and `--no-tmux` forces that mode; the app then
  runs `claude` in its own terminal tab (hidden tabs keep running while the app runs; the tab says
  "install tmux to keep agents running when the app closes"), and on reopen offers `claude --continue`
  in that worktree, since Claude Code saves the conversation itself. `worktree list --json` reports
  `agent.running: null` when tmux is missing. Containers always use tmux inside the image. Shipped in
  e5b15a4; `stop` without tmux still fails with `tmux-missing`, since there is no session to stop.

## Open questions

From the architecture review (2026-10-23):

- [ ] A state file left by a killed session (no SessionEnd) shows its old value when a new session on
  the same worktree starts, until the first hook fires; `kunj agent start` could clear it first.
- [ ] `withAgentHooks` appends `--settings` to the end of the whole command, so an `agent.command` with
  a pipe or `&&` (`claude | tee log`) gets no hooks and passes the flag to the wrong program.
- [ ] The tmux-less agent flow in Decisions (the "install tmux" hint in the tab, `claude --continue` on
  reopen) has no place in the Architecture or the plan yet.
- [ ] Two WKWebViews may cost two Monaco web processes (the spike measured 340–420 MB for one);
  measure, and fall back to one view hosting both modes if it doubles.
- [ ] Monaco 0.57's AMD build is deprecated; moving to the ESM build is a later cost.

From the scaffold (Task 2):

- [x] The sidebar tint: Task 6 kept the vibrancy and raised the `side` tint to 94 %
  (`MainWindowController.sideTintAlpha`); the render samples `#2c2725` against the mockup's `#2b2724`,
  and a bright desktop still shows faintly. Drop the effect view if any tint is unwanted.
- [x] Fonts: Task 6's `Theme.sans`/`Theme.mono` route every font through Inter/JetBrains Mono by
  PostScript name, with the system fonts as fallback.

From `KunjCLI` (Task 3):

- [ ] The login PATH is read with `printf … "$PATH"` in `$SHELL -l -i -c`, as `macos-app/` does; fish
  expands a quoted `$PATH` with spaces, so a fish user gets only the fallback directories. Reading
  `/usr/bin/printenv PATH` between two marker lines would work in every shell.
- [x] A discovery error is now the window's error state (Task 6), with `npm install -g kunj` under it.

From the environment model (Task 4):

- [ ] Environment ids (and so the layout keys) use the repo's name from `kunj repos`, which comes from
  origin's URL: two clones of one repository registered at once get the same ids. Keying on `root`
  would be unique but would change with the directory.
- [ ] A worktree in the middle of a rebase is detached and has no branch in `worktree list`, so its row
  disappears until the rebase ends. Task 7's tabs are keyed by environment id and never closed by a
  listing, so they survive; while the row is gone the window shows "Select an environment".
- [ ] `ct list` carries no PR for a container and no upstream, so a container row cannot show `PR #N`
  or `↑N from main` as the mockup does; reporting them would be a CLI addition.

From the event stream and store (Task 5):

- [ ] The tmux poll's `agent` events (an agent starting or ending) carry no `repo`, so each runs a full
  refresh, whose `ct list` execs into every container of every repo; kunj could map the session name
  to its repo as it does for the hook-state events. A `container` event whose origin kunj could not
  map (`repo: null`) does the same.
- [ ] A scoped `worktree list` failure sets `lastError`, which only that repo's next success clears; a
  full refresh's partial error (one repo dropped) stays until the next full refresh, so the status
  bar can show an error for a repo that recovered through a scoped refresh.

From the window chrome (Task 6):

- [ ] The traffic lights are moved into the sidebar's 52 px top by resizing the titlebar container;
  the header's buttons sit under that container, so whether clicks reach them needs a person to check
  (else an `NSToolbar(.unified)` or a hit-test pass-through).
- [ ] The status bar's `up 2h 14m` counts from the container's `createdAt`; a container stopped and
  resumed shows time since creation, not since its last start. `ct list` would need a `startedAt`.
- [ ] A row filtered out by the search stays selected, so the right side can show an environment the
  list hides.

From the diff and file core (Tasks 9–10):

- [ ] The `last` scope on a repository with one commit fails (no `HEAD~1`); diffing against git's
  empty tree would show the first commit instead of an error.
- [ ] In a container the working side of a symlink comes from `kunj ct file read`, which follows the
  link, so a changed symlink diffs its target's content against the link text (and a link to
  `/dev/zero` never ends); `ct file read` could refuse non-regular files, or the service could
  `readlink` first.
- [ ] `wc -l` counts newlines, so an untracked file without a final newline shows one line fewer than
  git would count once it is added.
- [ ] A path removed from the index but kept on disk (`git rm --cached`) lists twice: deleted from
  `git diff` and added as untracked. The column selects rows by path, so they should be merged.
- [ ] `DiffError.commandFailed` names the command and exit code only (the runner drops stderr), so a
  failing `git` in a container shows no reason.

From the Changes column (Task 9):

- [ ] A binary file (numstat `-`, counts 0) is decoded lossily and sent to Monaco as text, and a large
  file is sent whole; the column could show "Binary file" (a NUL in the first 8 KB, as git checks) and
  cap the size it diffs.
- [ ] Monaco shows no `@@ … @@` hunk text as `warm.png` does; the folded regions stand in for
  them. Task 10 added one header row over the diff (the path and `Edit`), not one per hunk.
- [ ] Any `git` event of the repository reloads the column, also one from another worktree of it;
  `kunj events` could name the worktree so only its environment reloads.

From the terminals (Task 7):

- [ ] SwiftTerm's overlay scroller is hidden while `--screenshot` renders (cacheDisplay draws its
  track); whether it stays out of the way on screen has not been checked by a person.
- [ ] `-openTabs "<envId>#<kind>,…"` is a launch argument for checking PTYs without assistive access;
  Task 8 kept it (an entry without `#kind` only selects, which restores) for live checks.

From the layout file (Task 8):

- [ ] Any other change of an `Environment` counts as activity, e.g. a pull request's checks or review
  state, a container's ports or services, or Docker coming back with containers stopped; a narrower
  activity signature (head, dirty, ahead, agent) would need `head` in the model.
- [ ] Two apps (or two repositories with the same kunj repo name) write the same `workspace.json`;
  the last save wins, there is no merge.
- [ ] Key presses that are menu shortcuts (⌘W, ⌘1) while a tab has focus count as input.
- [ ] A hidden tab's queue is fed whole when its process exits, on the main thread, so a large
  backlog in a background tab can stall the UI once at exit.

From the editor tabs (Task 10):

- [ ] Typing, the dirty dot, ⌘S, the conflict alert, the close and quit prompts, double-click and a
  file in a running container have not been checked by hand; neither has whether ⌘S inside Monaco
  also reaches File > Save (two saves would race, harmlessly but with two alerts on a conflict).
- [ ] `--screenshot` does not composite the editor page (`snapshotPNG` draws only the diff page and
  the terminals), so an editor tab cannot be compared by screenshot.
- [ ] Monaco normalises a file's line endings to its majority and drops a UTF-8 BOM, so saving a file
  with mixed endings or a BOM changes those bytes too.
- [ ] An `EditorTab` keeps the `Environment` it was opened with; a container stopped (or a worktree
  removed) since fails at save with an alert, and the tab stays open.
- [ ] A restored editor tab whose file is gone closes without a message (only logged).

From actions, settings and themes (Task 11):

- [ ] Not checked by hand: each header and overflow action on real worktrees and containers, New
  session end to end (worktree and container, with an agent), the removal sheets, ⌘K/⌘1–9 while a
  terminal or the editor page has focus, the Settings toggles writing the global config, and a kunj
  command change while tabs are open.
- [ ] `kunj config --get … --global` answers the merged value; it is run in `$HOME`, so a home
  directory that is itself a git repository would read that repository's local config.
- [x] New session now stays on its action tab until kunj exits (the create hooks' output, e.g.
  `post-worktree-create` running `yarn`, is seen as it runs), keeps the tab open afterwards, and
  selects the new environment only after exit 0; a failure stays on the tab.

From distribution and the final checks (Task 12):

- [ ] Launched through LaunchServices (`open -n`, as from Finder or after `kunj install workspace`),
  `$SHELL -l -i` ran past its 5 s cap while the same shell takes about 2 s from a terminal; the
  user's `.zshrc` sources files in `~/Downloads`, so the likely cause is a privacy (TCC) prompt for
  that folder, not confirmed. The review added the `-l -c` retry and the timeout message; whether
  `-l` alone finds kunj (nvm is usually set up in `.zshrc`) and whether a longer cap is wanted needs
  a launch from Finder by a person.
- [ ] The `workspace-app` release job has not run yet: `macos-15` builds with Xcode's Swift, not the
  6.4 Command Line Tools the app was built with, and `bundle.sh`'s SDK fallback only applies to the
  Command Line Tools. The first tagged release will tell.
- [ ] Not checked with the installed app: the whole loop (select, shell, agent attached to the CLI's
  tmux session, Changes, edit and save, Create PR, quit without orphans); the live check ran a copy
  from a terminal.
- [ ] `kunj install workspace` (and `bundle.sh --install`) quit a running copy with `pkill`
  (SIGTERM), which skips the app's quit path: unsaved editor tabs are lost without the prompt and
  the layout is not flushed.

From the final review:

- [ ] Environment ids are `<repo name>|<kind>|<branch>` with the folder name, so two registered
  repositories whose folders share a name share ids (in memory only; the layout file is per
  `kunjName`). Keying them by root was not done: it touches every id and needs a person to hit it.
- [ ] `ct list` keeps its 120 s timeout; with refreshes queued per repository it holds up only its
  own repository.
- [ ] Minor findings deferred (in the ledger): a `contents` call landing in the next environment of
  the Changes column, `git diff` without `--` and `--numstat` without `-z`, a timed-out kunj call
  leaving its `docker` child, a late failure of a cancelled discovery, New session filed under
  another repository's id when its repository has none, ⌘W on a running action tab not asking, no
  progress for `ct stop`/`ct open`, two non-token default colours in `TabBarView`, Swift 5 mode
  without strict concurrency, and `LayoutStore.save` writing while holding its lock.

- [ ] Linux, and whether this app replaces `macos-app/` eventually.
- [ ] Multiple windows: tearing an environment out for a second monitor (v2).

## Plans

- `docs/superpowers/plans/2026-10-23-workspace-cli-contract.md`: the CLI contract above. Done.
- `docs/superpowers/plans/2026-10-23-workspace-app-v1.md`: the app (environment list, terminals, agent
  attach, Changes column), native, rewritten 2026-10-23 from the Electron draft. Done (Tasks 1–12).

## Code map

| File | Role |
| --- | --- |
| `src/lib/json-types.ts` | Published JSON types |
| `src/commands/agent.ts`, `src/lib/agent-session.ts`, `src/settings/agent.ts` | `kunj agent`, session names, `agent.command` |
| `src/lib/worktree.ts` | `agent` in `worktree list --json` |
| `src/lib/container/files.ts`, `src/commands/container.ts` | `kunj ct file` |
| `src/lib/events.ts`, `src/commands/events.ts` | `kunj events` |
| `src/lib/command.ts` | The opt-in `jsonCode` error rule |
| `spikes/native-ide/` | The native-shell spike and `REPORT.md` |
| `docs/workspace-app/design/` | The design package: `DESIGN.md`, `tokens.json`, mockups |
| `workspace-app/` | The app (Swift package, `scripts/bundle.sh`) |

## Sources

- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm), [Monaco](https://microsoft.github.io/monaco-editor/), [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient)
- Comparable products: [Conductor](https://www.conductor.build/), [graith](https://github.com/d0ugal/graith)
