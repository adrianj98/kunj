# Workspace IDE (phase 3)

*Researched, reviewed and decided 2026-10-23. Checked against `main` on 2026-10-23. The CLI contract is
shipped; the app is a proposal. Its runtime is native (AppKit + SwiftTerm, Monaco in one WKWebView),
chosen after the native-shell spike.*

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
| Design package (`docs/workspace-app/design/`) | Received 2026-10-23; the app must match `mockups/warm.png` |
| The app (`workspace-app/`) | In progress; plan `docs/superpowers/plans/2026-10-23-workspace-app-v1.md` (native) |
| Runtime choice | Native: AppKit + SwiftTerm, Monaco in one WKWebView (spike 1c2aaa3, 0e41a24) |
| `kunj install workspace`, release job | Not started (in the app plan) |

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
  running, amber waiting for input, idle otherwise), *title · relative time*, then *branch · status
  verb* in mono. The title is the environment's task (the worktree description from kunj's branch
  metadata, else the branch); the status verb is derived from state ("Waiting for input", "Running",
  "Merged #398", "Clean", "Dirty", "Stopped"). A ⌘K search box on top, "+ New session" at the bottom,
  the agent count and kunj version under it.
- **Header:** title, then a mono meta line: repo / branch · kind · ahead/behind · PR (link) · ports.
  Actions right-aligned: Shell ⌘T, Agent ⌘⇧A, Open in VS Code ⌘O (outlined) and Create PR ⌘⇧P (the one
  filled button), plus an overflow menu with start/stop/remove and worktree remove.
- **Tab bar (left column):** segmented pills, one per terminal; a dot when its process has a notable
  state. Right side: `tmux <session> · uptime`, split and new-tab buttons.
- **Terminal tabs:** a login shell in the worktree, or `kunj ct shell <branch>` for a container.
- **Agent tab:** a terminal running `kunj agent <branch>` or `kunj ct agent <branch>`, which attaches
  to the environment's tmux session, so a session started from the CLI shows up in the app and the
  reverse.
- **Changes column (right, always visible):** header `N files · +adds −dels` and a scope select
  (vs origin/<base>, default: everything since the fork point, working tree included; Uncommitted;
  Last commit); a file list (A/M/D letter, name, ± counts); Monaco's diff editor for the selected file.
- **Status bar:** container name or worktree path · uptime · services · forwards; right side the agent
  state and the ⌘1–9 hint.
- **Editor tab** (v2): a file from the environment, edited in Monaco.
- **Preview tab** (v2): a webview on a forwarded port. v1 shows the ports as links that open the browser.
- **Themes:** warm (default, dark), light and graphite from `tokens.json`; light ↔ warm follow the
  system appearance, with an override in settings. The `term*` tokens are the terminal theme.

### The CLI is the contract

The app is the third consumer of `kunj … --json`, after the VS Code extension and the macOS app. It
runs kunj subprocesses and never imports `src/lib/**` or `dist/lib/**` at runtime; it imports only the
JSON types (`import type … from "kunj"`). Importing the library would bundle a second kunj at its own
version, with its own config loading and hooks, and the GUI would soon do things the CLI cannot.

- **Binary:** resolved from a login-shell `PATH` (as `macos-app/` does); `kunj -V` must meet a minimum
  version, and `1.0.0` (an `npm link`ed dev build) is accepted with a warning.
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
- **App state:** UI layout only, `~/.kunj/<reponame>/workspace.json`, `{ [branch]: { tabs, active } }`
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
<worktree> -e KUNJ_BRANCH=… -e KUNJ_REPO=… -e KUNJ_WORKTREE=… <command> ; set-option window-size latest`
(`-e` because a new session's environment comes from the tmux server; `TMUX` is dropped from the
environment so it works from inside a pane; `window-size latest` so the app and a CLI terminal attached
together are sized to the last one attached). Without tmux, or with `--no-tmux`, `start` runs the
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
and `ct list --json` report it as `agent.state` (`running | waiting | null`); `kunj events` watches the
host directory (an `agent` event with `state`) and includes it in the container status poll.

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
└─ WKWebView ×2 (one process pool)               Monaco: the Changes diff, and the editor tabs
```

**Package** `workspace-app/` (SwiftPM, no Xcode project, macOS 14+, like `macos-app/`):

| Target | Holds | Depends on |
| --- | --- | --- |
| `KunjWorkspaceCore` | Everything testable without a window: `Version`, the `Codable` mirrors of `json-types.ts`, `ShellEnvironment` (login PATH), `KunjCLI`, `EventStream`, `Environment` + `EnvironmentStore`, `TerminalSpec`, `DiffModel` + `DiffService`, `FileAccess`, `WorkspaceLayout`, `DesignTokens` (generated), `RelativeTime` | Foundation only |
| `KunjWorkspace` | The app: `AppDelegate` (menu, shortcuts), `Theme` (NSColor/NSFont from the tokens, system appearance), the views (`MainWindowController`, `SidebarView`, `HeaderView`, `TabBarView`, `TerminalColumn`, `ChangesColumn`, `StatusBarView`, `Controls`), `TerminalTab` (SwiftTerm), `MonacoWebView`, `ActionRunner`, `NewSessionSheet`, `SettingsWindow` | Core, SwiftTerm, AppKit, WebKit |
| `KunjWorkspaceCoreTests` | `swift test`, with `Tests/Fixtures/fake-kunj` (a `sh` script answering from `Tests/Fixtures/responses/*.json`) | Core |

SwiftTerm is vendored at an exact tag by `scripts/prepare-swiftterm.sh` (the spike's one-line
`Shaders.metal` patch, so it builds with the Command Line Tools). Monaco's `min/vs` build is copied
into `Resources/web/vs` by `web/copy-monaco.js`; Inter and JetBrains Mono (OFL) are fetched at pinned
versions into `Resources/fonts` by `scripts/fetch-fonts.sh` and registered through
`ATSApplicationFontsPath`. `scripts/gen-tokens.js` turns `docs/workspace-app/design/tokens.json` into
`Sources/KunjWorkspaceCore/Design/DesignTokens.swift` (committed; a test fails when they drift).
`scripts/bundle.sh` builds `build/Kunj Workspace.app` (ad-hoc signed; `--install` copies it to
/Applications) and `scripts/test.sh` runs `swift test` with the same SDK fallback as `macos-app/`.

**Data flow.** `EnvironmentStore` holds `[RepoEnvironments]` and is the only source for the views. A
refresh runs `kunj repos --json` (hidden and missing repos skipped), then per repo `worktree list --json`
and `ct list --json` in parallel (a failing `ct list` marks that repo's backend unavailable; the worktrees
still show), and merges them into `Environment` values (`id = "<repo>|<kind>|<branch>"`; a worktree and a
container on the same branch are two rows). `EventStream` reads `kunj events --json` line by line on a
background thread; the store maps `git`/`container`/`agent` events to a refresh of that repo and
`repos`/`backend`/`sessions`/`forwards` to a full refresh, coalesced per repo (300 ms), and notifies the
views on the main thread. The app never asks git or Docker for state. The status verb and dot are pure
functions of an `Environment` (`Environment.statusVerb`, `Environment.dot`), in this order: missing
worktree, stopped container, agent waiting, agent running, PR merged, PR open, dirty (`N changed files`),
ahead (`↑N unpushed`), `Clean`. The relative time is the app's own `lastActivity` per environment
(bumped when its state hash changes or a tab of it is used; persisted in the layout file).

**Agent state.** Running comes from tmux (`agent.running`); *waiting for input* comes from Claude Code
hooks that kunj installs: `kunj agent` and `kunj ct agent` append `--settings '<json>'` to a command
whose first word is `claude` (setting `agent.hooks`, default true) with `UserPromptSubmit` and
`PreToolUse` → `running`, `Stop` and `Notification` (`permission_prompt|idle_prompt|elicitation_dialog`)
→ `waiting`, `SessionEnd` → remove, each a `printf` into the file named by `KUNJ_AGENT_STATE` (host:
`~/.kunj/<repo>/agent-state/<session>`; container: `/tmp/kunj-agent-state`). `worktree list --json`
reports it as `agent.state` (`running | waiting | null`), `ct list --json` reads it in `STATUS_SCRIPT`,
and `kunj events` watches the host directory and includes `state` in the container status poll
(`EventJson.agent` gains `state`). No tmux hooks, no polling of panes.

**Terminals.** `TerminalTab` is a `LocalProcessTerminalView` per tab, created from a `TerminalSpec`
(`shell`: `$SHELL -l` in the worktree, or `kunj ct shell <b>`; `agent`: `kunj agent <b>` or
`kunj ct agent <b>`; `action`: `kunj <args…>` with `exec` semantics, the tab closing itself on exit 0).
Every tab's view stays in the window, hidden when not shown, so switching environments never touches a
process; a hidden tab batches its output into 250 ms feeds so a flood in a background environment
does not draw. The environment of every PTY: `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG`
(user's or `en_US.UTF-8`), PATH from the login shell (resolved once, off the main thread, 5 s cap),
the Claude Code and terminal-program markers removed. The theme's `term*` tokens are the terminal
colours (`termMuted` as bright black, `termAccent` as blue).

**Changes column.** `DiffService` lists `ChangedFile`s (`status A/M/D/R`, `added`, `deleted`) for the
scope: `base` (default: `git diff --numstat -M <merge-base(origin/<base>, HEAD)>` plus untracked files),
`uncommitted` (`HEAD`), `last` (`HEAD~1 HEAD`). `<base>` is the PR's base branch, else
`refs/remotes/origin/HEAD`, else `main`/`master`. Contents are `git show <ref>:<path>` and the working
file (fs in a worktree, `kunj ct file read` in a container). Monaco's diff editor renders the selected
file read-only; the Monaco theme is built from the tokens (`bg`, `addBg`, `faintest` line numbers).

**Editor tabs.** Double-clicking a changed file (or "Edit" in the diff header) opens it as a tab in the
left column, in the second WKWebView (`?mode=editor`, one Monaco model per open file). ⌘S saves through
`FileAccess` (`fs` for a worktree, `kunj ct file write` for a container); the tab shows a dot while
dirty; a save over a file that changed since it was opened asks before overwriting. Closing a dirty tab
asks. No language servers.

**Layout file** `~/.kunj/<reponame>/workspace.json`: `{ "<branch>": { "tabs": [{ "kind": "shell|agent|editor",
"title", "path"? }], "active", "lastActivity" } }`, written atomically, debounced 500 ms; action tabs
are never saved. On selecting an environment for the first time in a session its tabs are restored
(agent tabs reattach to tmux; editor tabs reopen the file).

**Actions** (`ActionRunner`): Shell ⌘T, Agent ⌘⇧A, Open in VS Code ⌘O (`worktree open` / `ct open`),
Create PR ⌘⇧P (`kunj pr` in an action tab, in the worktree; for a container environment the host
checkout of that branch is used when it exists, else the button is disabled with a tooltip), New
session ⌘N (a sheet: repo, branch, base, worktree or container, start an agent; runs `worktree add -c`
or `ct start -c` in an action tab), the overflow menu (container start/stop/remove/rebuild, worktree
remove, copy path, reveal in Finder, `ct prune`), ports as links (`open http://localhost:<host>`),
⌘K search filtering the sidebar, ⌘1–9 selecting the nth row, ⌘⇧] / ⌘⇧[ and ⌘W for tabs. Destructive
actions confirm with an `NSAlert`. Settings (⌘,): the kunj command (default `kunj`) and the theme
(`auto` = light ↔ warm by system appearance, `warm`, `light`, `graphite`).

**Window.** Transparent title bar with the traffic lights inside the sidebar's 52 px top (as in the
mockup), `NSVisualEffectView` (`.sidebar`) under the sidebar tinted with `side`, everything else opaque
in `bg`; all sizes from `tokens.json` (`layout`), radii 5/6 px, 1 px hairlines in `border`, one filled
button. `--demo` renders the mockup's data from fixtures and `--screenshot <png>` writes the window
(the spike's snapshot code), so the look can be compared against `warm.png` without a person.

**Distribution:** a `workspace-app` job in the release workflow attaching `Kunj-workspace-<version>.zip`
(ad-hoc signed, not notarized, like the macOS app); `kunj install workspace` finds it by name and
installs it as `installMacApp()` does. `MIN_KUNJ_VERSION` is the first release with the CLI contract;
`1.0.0` (an `npm link`ed dev build) is accepted and shown as `dev`.

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
  one WKWebView, chosen after the native-shell spike (small footprint, no bundled Chromium, terminals as
  fast as Terminal.app). Parsing hidden tabs' output off the main thread, or throttling it, is an early
  task.
- **The CLI is the only contract;** the app imports JSON types only.
- **Worktree agents through `kunj agent`**, sessions named by kunj; the app never names a tmux session.
- **Container files through `kunj ct file`;** the app never runs `docker`.
- **Refresh through `kunj events --json`,** built before the app; no polling in the app.
- **Editor level: Monaco with the diff editor;** no language servers in v1; VS Code/Cursor as hand-off.
- **Diff default against the base branch,** with uncommitted-only and last-commit options.
- **The UI is the design package** (`docs/workspace-app/design/`, 2026-10-23): two columns under the
  header, terminals left and the Changes column always on the right, sidebar rows titled by task with a
  status verb, three themes from `tokens.json`. The package's technical remarks are ignored.
- **Ports in v1 as links;** webview previews and split panes in v2 (2026-10-23: the user kept them out of
  this build; the agent waiting state and editor tabs are in).
- **Session titles are branch names** (2026-10-23); the design's task titles need metadata the CLI does
  not report, left for later.
- **Agent waiting state through Claude Code hooks** that `kunj agent`/`kunj ct agent` pass with
  `--settings` (see Architecture), not tmux hooks.
- **Fonts bundled:** Inter and JetBrains Mono, fetched at pinned versions by the build.
- **App state is UI layout only,** in `~/.kunj/<reponame>/workspace.json`.
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

- [ ] Linux, and whether this app replaces `macos-app/` eventually.
- [ ] Multiple windows: tearing an environment out for a second monitor (v2).

## Plans

- `docs/superpowers/plans/2026-10-23-workspace-cli-contract.md`: the CLI contract above. Done.
- `docs/superpowers/plans/2026-10-23-workspace-app-v1.md`: the app (environment list, terminals, agent
  attach, Changes column), native, rewritten 2026-10-23 from the Electron draft.

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
