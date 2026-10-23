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
| The app (`workspace-app/`) | Not started; the Electron plan is being rewritten for the native runtime |
| Runtime choice | Native: AppKit + SwiftTerm, Monaco in one WKWebView (decided after the spike, 1c2aaa3, 0e41a24) |
| `kunj install workspace`, release job | Not started (in the app plan) |

## Design

### Layout

*Drawing: environment list on the left, grouped by repository; on the right a header (branch, kind,
ahead/behind, PR, ports, the main actions), a tab strip and a pane area that can be split.*

- **Terminal tab:** a login shell in the worktree, or `kunj ct shell <branch>` for a container.
- **Agent tab:** a terminal attached to the environment's tmux session, so a session started from the
  CLI shows up in the app and the reverse.
- **Diff tab:** Monaco's diff editor, default against the base branch (everything since the fork point
  from `origin/<base>`, working tree included); a dropdown for uncommitted only and last commit.
- **Editor tab** (v2): a file from the environment, edited in Monaco.
- **Preview tab** (v2): a webview on a forwarded port. v1 shows the ports as links that open the browser.

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
non-bare worktree on a branch `agent: { running, session }` from one `tmux list-sessions` per listing;
`running` is `null` only when tmux is not installed, and the field is absent with `--no-status`.

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

### App design (proposed)

| Part | Choice |
| --- | --- |
| Shell | AppKit (Swift, SwiftPM, no Xcode project), macOS only, like `macos-app/` |
| Terminal view | SwiftTerm (`LocalProcessTerminalView`), one per tab; hidden tabs have their output parsed off the main thread or throttled (the spike's one weakness) |
| PTY source | SwiftTerm's local process: `$SHELL -l` in a worktree, `kunj agent <branch>`, `kunj ct shell\|agent <branch>`; the app never knows container or session names |
| Agent persistence | tmux owned by kunj; nothing in the app, so quitting the app or using the CLI loses nothing |
| Editor | Monaco in one shared WKWebView: the diff editor first, single files later; no language servers in v1; a standard Edit menu routes Cmd+F/C/V into it |
| Files | `fs` for worktrees, `kunj ct file` for containers |

*Drawing: AppKit views (EnvironmentList, EnvironmentHeader, TabStrip, TerminalPane, DiffPane in the
WKWebView) ↔ Swift models (KunjCli, Environments, Events, Files, Diff, Layout) → kunj CLI → git,
docker exec → tmux → claude.* The JSON contract is decoded with Swift `Codable` types mirroring
`src/lib/json-types.ts`.

**Distribution:** `workspace-app/` next to `vscode-extension/` and `macos-app/`; a `workspace-app` job in
the release workflow attaching `Kunj-workspace-<version>.dmg`, ad-hoc signed and not notarized like the
macOS app, so `kunj install workspace` strips the quarantine attribute as `installMacApp()` does; Monaco is
bundled as static files inside the app. SwiftTerm needs a one-line `Package.swift` patch to build
without Xcode (see the spike report).

**v1:** environment list with status, terminals, agent tabs reattaching to CLI sessions, the diff viewer,
container start/stop/remove and worktree add/remove, hand-off to VS Code, ports as links. **v2:** Monaco
editing with a file tree, webview previews, the "agent waiting for input" signal, Linux, tearing an
environment into its own window.

### Runtime options

| Runtime | Terminal and editor | Footprint | Main risk |
| --- | --- | --- | --- |
| Electron (44.x) | xterm.js + node-pty + Monaco, VS Code's own stack; TypeScript throughout | Large (bundled Chromium, ~150 MB) | Native-module rebuilds per Electron major; a third Chromium on the machine |
| Tauri 2 | xterm.js in WebKit; PTY in Rust (`portable-pty`; `tauri-plugin-pty` is 0.x) | Small | Hand-built PTY bridge; WebKit canvas/WebGL quirks, 60 fps cap |
| Eclipse Theia (1.70) | Full workbench, Monaco, LSP, VS Code extensions through Open VSX | Large | It is an IDE; the environment-first layout fights its shell |
| Embedded VS Code server per environment | The real VS Code | One server per environment | Web client dislikes iframes; marketplace terms; cost grows with environments |
| Native shell (AppKit/SwiftUI, extending `macos-app/` ideas) | SwiftTerm terminals; Monaco only inside a web view | Smallest | macOS only; the editor needs a web view anyway |

A VS Code extension cannot host this (one window per workspace; it cannot keep another environment's
terminals alive or let a sidebar drive the whole window). VS Code's remote protocol is internal to
Microsoft's VS Code and licensed only for it; VS Code reaches kunj containers on its own through
`kunj ct open`, and the app through `kunj ct shell|agent|exec`, so the app keeps one contract. The open
standards in the space are the Dev Container spec (kunj reads `devcontainer.json` but does not run the
devcontainer CLI, which bind-mounts the workspace and has no firewall), LSP and the Debug Adapter
Protocol; language features in a container, if ever wanted, are LSP over `kunj ct exec`.

**Native-shell spike** (`spikes/native-ide/REPORT.md`, 1c2aaa3, 1730cd1, 0e41a24, closed): AppKit with
SwiftTerm terminals and Monaco in one WKWebView. Five live Claude Code sessions cost 6% CPU and about
75 MB; `claude`, `vim`, `top` and truecolor drew correctly through resizes; big output was faster than
Terminal.app on `seq` and `cat`, slower on a `yes` flood; Monaco's diff showed in under 1 s (its web
process 340–420 MB, Monaco's cost in any runtime); menu shortcuts, real key presses and live resize
worked. Weakness: every tab parses output on the main thread, hidden or not, so five flooding tabs pin
it at 95% and typing in them lags 0.5–1.2 s (xterm.js has the same design).

## Decisions

All 2026-10-23.

- **Runtime: native** in `workspace-app/`, macOS only in v1: AppKit + SwiftTerm terminals, Monaco in
  one WKWebView. Electron was chosen first, then reopened for the native-shell spike; after its report
  the user chose native (smallest footprint, no bundled Chromium, terminals as fast as Terminal.app).
  Parsing hidden tabs' output off the main thread, or throttling it, is an early task. Electron stays
  the fallback.
- **The CLI is the only contract;** the app imports JSON types only.
- **Worktree agents through `kunj agent`**, sessions named by kunj; the app never names a tmux session.
- **Container files through `kunj ct file`;** the app never runs `docker`.
- **Refresh through `kunj events --json`,** built before the app; no polling in the app.
- **Editor level: Monaco with the diff editor;** no language servers in v1; VS Code/Cursor as hand-off.
- **Diff default against the base branch,** with uncommitted-only and last-commit options.
- **Ports in v1 as links;** webview previews in v2.
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

- [ ] `kunj ct agent` does not set `window-size latest` on its session yet (`kunj agent` does), so the app
  and a CLI terminal attached to a container agent are sized to the smaller one.
- [ ] "Agent waiting for input" in a background environment: tmux silence/activity hooks or Claude Code
  hooks writing a marker (v2).
- [ ] Linux, and whether this app replaces `macos-app/` eventually.
- [ ] Multiple windows: tearing an environment out for a second monitor (v2).

## Plans

- `docs/superpowers/plans/2026-10-23-workspace-cli-contract.md`: the CLI contract above. Done.
- `docs/superpowers/plans/2026-10-23-workspace-app-v1.md`: the app (environment list, terminals, agent
  attach, diff viewer). Written for Electron; being rewritten in Swift for the native runtime.

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

## Sources

- [Electron releases](https://releases.electronjs.org/); [Tauri 2 webview versions](https://v2.tauri.app/reference/webview-versions/), [tauri-plugin-pty](https://docs.rs/tauri-plugin-pty), [WebKit bug 264268](https://bugs.webkit.org/show_bug.cgi?id=264268)
- [Eclipse Theia 1.70](https://eclipsesource.com/blogs/2026/04/16/eclipse-theia-1-70-release-news-and-noteworthy/); [VS Code web client in an iframe](https://gitlab.com/gitlab-org/gitlab/-/issues/368980)
- [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty), [Monaco](https://microsoft.github.io/monaco-editor/), [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient)
- Comparable products: [Conductor](https://www.conductor.build/), [graith](https://github.com/d0ugal/graith)
