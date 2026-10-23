<!-- On-disk copy of the Claude Doc "Kunj Workspace IDE Spec" (https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y), exported 2026-10-23. Drawings are noted in italics. The 2026-10-23 review decisions (Package layout, Decisions) are recorded here first; the Claude Doc still needs the same edits. -->

# Kunj Workspace IDE Spec

2026-10-23 · Adrian Jones

## Goal

A desktop app, built around kunj, where every branch you work on is an **environment**: a local worktree or a branch container. Everything you have open for it (terminals, agent sessions, editors, dev-server previews) lives together under that environment. Switching environment switches the whole set of panes, so moving between five branches is one click instead of five editor windows and a pile of terminal tabs.

It must:

- list environments on the left, grouped by repository, with status: worktree or container, running or stopped, agent active, dirty, ahead/behind, PR, forwarded ports;
- show, for the selected environment, its open terminals, agent sessions and editors as tabs or splits, kept alive in the background when you switch away;
- open a shell or an agent in a container or a worktree with one action, and reattach to agent sessions that are already running (including ones started from the CLI);
- edit files in the environment, including inside containers, with language support good enough for reading diffs and small fixes;
- drive everything through the kunj CLI and its JSON output, the contract the VS Code extension and the macOS app already use, so the app can never do something the CLI cannot, or drift from it;
- stay out of the way: no new daemon the user has to manage, no new state format beyond what kunj already keeps.

It is not a replacement for VS Code or Cursor for long editing sessions. It is the place you orchestrate many branches and agents, and it hands off to the full editor (`kunj ct open`, `kunj worktree open`) when you need one.

## Layout

*(drawing: workspace layout · environment list, header, tabs, two panes)*

The left pane is the environment list, grouped by repository: worktrees and containers side by side, a dot when an agent is running, the forwarded port or the state on the right. Selecting one swaps the whole right side: a header with the branch, kind, ahead/behind, PR and ports plus the three main actions; a tab strip with every terminal, agent, editor and preview open for that environment; and a pane area that can be split. Background environments keep their panes alive; their tab strip is simply hidden until you come back.

- **Terminal tab**: a shell in the worktree or `docker exec` into the container.
- **Agent tab**: a terminal attached to a tmux session named for the environment, so a Claude Code session started from the CLI with `kunj ct agent` shows up here and the reverse.
- **Editor tab**: a file from the environment's filesystem (local path, or read/written through the container).
- **Preview tab**: a webview on a forwarded port, listed from the forward registry.
- **Status bar**: container name, uptime, services, forwards; for worktrees the path and the kunj metadata (description, tags).

## Building blocks

Whatever the runtime, the app is assembled from the same few parts. The choice of runtime decides which of them come for free.

| Part | What it does | Options | Notes |
| --- | --- | --- | --- |
| Terminal view | Renders a PTY in the UI | [xterm.js](https://xtermjs.org/) (what VS Code uses) with the WebGL addon | The only serious web terminal. Needs a PTY source behind it. |
| PTY source | Spawns the shell and owns the file descriptors | [node-pty](https://github.com/microsoft/node-pty) (Node), [portable-pty](https://docs.rs/portable-pty) (Rust), or `docker exec -it` wrapped by either | node-pty is a native module: it has to be rebuilt per Electron version. |
| Persistent agent sessions | Keep a Claude Code session alive when the pane closes or the app restarts | tmux inside the container or on the host (`kunj ct agent` already uses tmux); or a daemon that owns the PTYs like [graith](https://github.com/d0ugal/graith) | tmux is already in the sandbox image and in `kunj ct agent`, so attaching to the same session name works for both the CLI and the app. |
| Container attach | Shell or agent inside a branch container | `docker exec -it <ctr> tmux new -A -s kunj` through the PTY source | No daemon in the container; same command the CLI runs. |
| Code editor | View and edit files, syntax colours, basic language features | [Monaco](https://microsoft.github.io/monaco-editor/) (VS Code's editor as a library), CodeMirror 6, or the full VS Code workbench (see Editor options) | Monaco alone has no file tree, search, git gutter or language servers; those are app work. |
| Language support | Diagnostics, go to definition | [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient) talking to a language server spawned in the environment over the PTY/exec channel | Only worth it if the app is used for real editing; skip in v1. |
| File access | Read/write files in a worktree or container | Local: Node `fs`. Container: `docker cp`/`docker exec cat` for v1; a small file server in the container later | Containers have no bind mount by design, so every file access goes through Docker. |
| kunj logic | Worktrees, containers, blueprints, forwards, PR cache, metadata | `kunj … --json` subprocesses (`repos`, `worktree list`, `ct list\|start\|stop\|remove\|forward`), the binary resolved from a login-shell PATH with a version check | The CLI is the contract already shared with the VS Code extension and the macOS app. The app imports only kunj's JSON types, never its runtime, so GUI and CLI cannot drift. |
| Preview | Show a dev server on a forwarded port | A webview/iframe on `localhost:<hostPort>` from `~/.kunj/container-forwards.json` | Same registry phase 2 auto-forwarding writes. |
| State | Which tabs are open per environment, layout | A JSON file under `~/.kunj/workspace/` keyed by repo and branch | tmux session names carry the agent state; the app only stores UI layout. |

Two things are worth stating once. First, the terminal is the product: ten environments with live agents means ten or more PTYs rendered fast, and xterm.js with WebGL is the only renderer that does that well inside a web view. Second, agent persistence does not belong in the app. It belongs in tmux, where it already is, so closing the app, or using the CLI instead, loses nothing.

## Runtime options

Five realistic ways to build it. The first column is the one that matters most for this app: how much of the terminal, editor and kunj integration each runtime gives you for free.

| Runtime | Terminal + editor | kunj integration | Effort to first usable build | Footprint | Main risk |
| --- | --- | --- | --- | --- | --- |
| **Electron** (Chromium + Node, current line 44.x) | xterm.js + node-pty, Monaco: the exact stack VS Code uses | Shell out to `kunj --json`; TypeScript on both sides, so kunj's JSON types can be imported for typing | Low: everything is TypeScript, one language | Large (bundled Chromium, roughly 150 MB on disk, 150+ MB idle) | Native-module rebuilds per Electron version; one more Chromium on the machine |
| **Tauri 2** (system WebView + Rust) | xterm.js in the WebView; PTY in Rust via `portable-pty` (the `tauri-plugin-pty` crate is early stage) | Shell out to `kunj --json` from Rust, or run a Node sidecar | Medium-high: a second language, PTY plumbing written by hand | Small (single-digit MB binary, uses the OS WebKit) | WebKit quirks with canvas/WebGL terminals; no Node, so kunj is a subprocess |
| **Eclipse Theia** (IDE platform, Electron-based, 1.70 in April 2026) | Full workbench: terminal, Monaco, file tree, git, VS Code extensions via Open VSX, a Terminal Manager and Theia Coder agent integration | Shell out from a Theia extension (importing `src/lib/**` is possible but would drift from the CLI) | Medium: learn the Theia extension model, inversify DI, custom layout | Large (Electron) | You inherit a whole IDE; bending its layout into "environment list + panes" is the hard part |
| **Embedded VS Code server** (openvscode-server / `code serve-web` in a webview per environment) | The real VS Code, one instance per environment | Shell out; the shell app is thin | Medium: the shell is easy, the per-environment servers and their auth/origin rules are not | Large: one VS Code server process per environment plus the shell | Web VS Code refuses to work well inside an iframe (folder URLs), marketplace/proprietary-extension licensing, memory per environment |
| **Native SwiftUI** (extend the existing `macos-app/`) | SwiftTerm for terminals; no serious native code editor (Runestone/CodeEditor are viewers, not Monaco) | Shell out to `kunj --json`, as the menu bar app does | Medium for terminals, high for an editor | Smallest | macOS only; editing stays a hand-off to VS Code |

*(drawing: runtime options · footprint against what comes for free)*

The bottom-right quadrant is empty: nothing is both light and complete. The choice is between a light app that hands editing off (SwiftUI, Tauri) and a heavy one that includes it; among the heavy ones only Electron's cost stays flat as environments are added.

### Electron

- Pro: the whole app is TypeScript, like the CLI and the VS Code extension, and it can import kunj's JSON types from the `kunj` package for a typed contract without importing its runtime.
- Pro: xterm.js, node-pty and Monaco are first-class citizens; VS Code itself proves this stack scales to dozens of terminals.
- Pro: mature packaging, signing, notarizing and auto-update tooling (electron-builder, electron-updater).
- Con: size and memory. For a tool that runs next to Docker Desktop and VS Code, a third Chromium is not free. ([Electron releases](https://releases.electronjs.org/))
- Con: node-pty is a native addon; it must be rebuilt for each Electron major, and the sandbox and context isolation rules mean PTY data goes main-to-renderer over IPC.

### Tauri 2

- Pro: small binary, fast start, low idle memory. The front end is still web, so xterm.js and Monaco work. ([Tauri webview versions](https://v2.tauri.app/reference/webview-versions/))
- Con: no Node. kunj becomes a subprocess (`kunj … --json`) or a sidecar Node binary, which is the same integration the VS Code extension has today, not a step up.
- Con: the PTY layer is yours to write in Rust (`portable-pty` is solid; `tauri-plugin-pty` is 0.x with a failing docs build) and every byte of terminal output crosses the Rust/WebView bridge. Proof-of-concept projects exist ([tauri-terminal](https://github.com/marc2332/tauri-terminal), [Terax](https://github.com/crynta/terax-ai)); none at VS Code scale.
- Con: WebKit on macOS has a history of canvas/WebGL rendering bugs with xterm.js ([WebKit bug 264268](https://bugs.webkit.org/show_bug.cgi?id=264268)) and WKWebView is capped at 60 fps.

### Theia

- Pro: closest existing thing to "a custom IDE": terminal, Monaco with language servers, file explorer, git, settings, keybindings and the VS Code extension API all exist and are maintained by Eclipse ([Theia 1.70](https://eclipsesource.com/blogs/2026/04/16/eclipse-theia-1-70-release-news-and-noteworthy/)). Theia AI already integrates Claude Code.
- Pro: backend is Node, so kunj's library can be imported in a Theia extension.
- Con: it is an IDE first. The environment-centred layout (left list drives the entire right side, panes kept alive per environment) is not how Theia's shell thinks; you would be fighting the application shell or writing a custom one.
- Con: Theia-specific concepts (inversify DI, contribution points, its own build) are a learning curve, and the result is still Electron-sized.

### Embedded VS Code server

- Pro: the editor is the real thing: extensions, language servers, git, everything.
- Con: VS Code's web client is not designed to be framed. Reports of the web client breaking inside an iframe because it cannot control the location bar ([GitLab issue](https://gitlab.com/gitlab-org/gitlab/-/issues/368980)); and the proprietary builds' marketplace terms do not cover third-party hosts, so you would ship openvscode-server + Open VSX.
- Con: one server process per environment, inside each container or on the host, means the memory cost scales with environments, which is exactly the axis this app wants to scale on.
- Con: in the container, the server must get through the firewall for extension downloads (an allowlist entry) and adds a persistent process the sandbox otherwise does not have.

### Native SwiftUI

- Pro: the smallest, fastest, most Mac-like option, and `macos-app/` already has the repo list, `kunj repos --json` and `kunj worktree list --json` plumbing plus the login-shell PATH resolution.
- Pro: SwiftTerm is a capable terminal view; `docker exec` into tmux is a one-liner.
- Con: there is no native Monaco. Editing would be a viewer with syntax colours at best; anything real stays a hand-off to VS Code (which may be fine, see Editor options).
- Con: macOS only, and kunj's library cannot be reused except as JSON over a subprocess.

### Not an option: a VS Code extension

The existing `vscode-extension/` can list worktrees and open them, but VS Code's model is one window per workspace. It cannot keep an environment's terminals alive while showing another environment's, cannot render another container's terminals in the same window, and its sidebar cannot drive the whole window. It stays the hand-off target, not the host.

## Editor options

The editor decides how much of an IDE this becomes. Three levels, in increasing cost.

| Level | What you get | What you build | Cost |
| --- | --- | --- | --- |
| **Viewer + hand-off** | Open any file read-only with syntax colours; one click sends the environment to VS Code or Cursor (`kunj ct open`, `kunj worktree open`) | A file tree and a Monaco/CodeMirror instance in read-only mode | Days |
| **Monaco editor** | Editing with syntax colours, find/replace, multi-cursor, diff view (Monaco has a built-in diff editor), optional language servers via monaco-languageclient | File tree, open/save through the environment (local `fs` or Docker), dirty-state and conflict handling, a git gutter if wanted, LSP wiring per environment | Weeks for the basics, ongoing for everything VS Code already does |
| **Real VS Code** | Everything, extensions included | Either embed a VS Code server per environment (see Runtime options) or use Theia's workbench as the whole app | Weeks to months, and it changes the character of the product from "orchestrator" to "yet another IDE" |

For this app the agent does most of the editing. What a person needs in the IDE itself is to **read** what the agent did (diffs, a file), make small fixes, and jump to a full editor for anything bigger. That is the Monaco level, with the diff editor as the headline feature, and VS Code as the hand-off for everything else.

Language servers are a deliberate v1 exclusion: running `typescript-language-server` per environment, inside each container, over an exec channel is real work and most of the value (diagnostics while typing) belongs to the long editing sessions this app is not for.

## Recommendation

**Build it in Electron, as a sibling package `workspace-app/` in this repo, driving the installed `kunj` CLI through its `--json` output (never importing its library), xterm.js + node-pty for terminals, Monaco for the diff and file views, tmux for agent persistence, and VS Code as the hand-off editor.**

Why Electron over the others, in order of weight:

1. **The CLI is the contract.** The VS Code extension and the macOS app already drive `kunj … --json`; this app is a third consumer of the same contract, so none of them can drift from each other or from what the CLI does, and the app works with whatever kunj is installed, including an `npm link`ed dev build. Importing the library instead would bundle a second copy of kunj at its own version, with its own config loading and hooks, and the GUI would soon do things the CLI cannot.
2. **The terminal stack is proven at this scale.** VS Code runs this exact combination with dozens of terminals. Tauri's equivalent is a hand-built Rust PTY bridge with WebKit rendering quirks; SwiftUI has no editor at all.
3. **The layout is the product.** Theia and an embedded VS Code give you an IDE and make you fight it for the environment-first layout. Electron gives you a blank window, which is what this layout needs.
4. **The cost is disk and memory,** and that cost is bounded: one Chromium, however many environments. The embedded-VS-Code option is the one whose cost grows per environment.

With the CLI as the contract, Electron's margin over Tauri narrows to the terminal stack and one language. That is still decisive: the PTY layer is the part that has to be solid on day one. If footprint turns out to matter more than editing, the fallback is the native SwiftUI app with SwiftTerm, extending `macos-app/`, with no editor at all. It is a smaller product, not a smaller version of this one.

*(drawing: architecture · renderer, main process, host targets)*

The renderer never touches the OS: it asks the main process for a PTY, a file or a list and renders what comes back. The main process is the only place child processes are spawned, which keeps the sandbox and context-isolation defaults on. Agent sessions are tmux sessions owned and named by kunj (`agent` inside a container, which has its own tmux server; `kunj-<readable>-<hash>` on the host, where one tmux server is shared), so the CLI and the app attach to the same thing and nothing is lost when either closes.

*(drawing: agent sessions · one tmux session shared by the CLI and the app)*

Whichever side starts first creates the session; the other attaches. The app's agent tab is a terminal attached to tmux, not a process the app owns, which is why nothing is lost when the app quits or the CLI is used instead.

### Why not VS Code's remote protocol for containers

It is not available as a protocol. The wire protocol between the VS Code client and `vscode-server`, and the server binary itself, are internal to Microsoft's VS Code and licensed only for use with it; there is no public client library and no stability promise. The only way to "speak" it is to embed VS Code's own web client, which is the embedded-server option above.

There is also no second protocol to maintain. VS Code reaches a kunj container on its own: `kunj ct open` hands it an `attached-container` URI and the Dev Containers extension installs its server over `docker exec`. kunj implements nothing for that. The app reaches the same container through `kunj ct shell|agent|exec`, which is also `docker exec` underneath. So the app has one contract to keep, the kunj CLI, and VS Code's is Microsoft's.

The open standards in that space are the Dev Container spec (kunj already reads `devcontainer.json` for the image, compose services and features; it deliberately does not run the devcontainer CLI, which bind-mounts the workspace and has no firewall), LSP and the Debug Adapter Protocol. If the app ever wants language features inside a container, LSP over `kunj ct exec` is the standard way, and it is editor-neutral.

### Package layout

- `workspace-app/` next to `vscode-extension/` and `macos-app/`: its own `package.json`, electron-vite + electron-builder, React, xterm.js, Monaco. It depends on the `kunj` package for its TypeScript JSON types only (`import type` from the package's `types` entry, `src/lib/json-types.ts`).
- A `KunjCli` service in the main process resolves the `kunj` binary from a login-shell PATH (as `macos-app/` does), checks `kunj -V` against the minimum version the app needs (a `1.0.0` dev build is accepted with a warning), and runs `kunj repos --json`, `kunj worktree list --json`, `kunj ct list --json`, `ct start|stop|remove|open`, `worktree add|remove|open`. Every call runs with the working directory set to the repository root from `kunj repos --json` and names the branch explicitly, because kunj resolves both from where it is run. Nothing else in the app asks git or Docker for state.
- Terminals: a `PtyManager` in main keyed by environment and tab id; `node-pty` spawns `kunj ct shell <branch>` or `kunj ct agent <branch>` for containers and the login shell or `kunj agent <branch>` for worktrees, so the app never knows container or session names. Resize, data and exit go over IPC. Long actions (`ct start`, `ct remove`, `blueprint snapshot`) run in a terminal tab too, so their progress shows as in a shell.
- Files: `kunj ct file read|write <branch> <path>` for containers (a small CLI addition that scripts can use too), `fs` for worktrees.
- Diff content: read-only `git` in a worktree, `kunj ct exec <branch> -- git …` in a container; parsed and shown in Monaco's diff editor.
- Ports: whatever `ct list --json` reports (published ports, and forwards once phase 2's `forward --auto` lands); the app never reads `~/.kunj/container-forwards.json` itself.
- State: `~/.kunj/<reponame>/workspace.json`, one file per repository keyed by branch, with the open tabs and splits; nothing else, since tmux and Docker hold the real state.
- CLI additions the app needs, each useful on its own: `kunj agent` for worktrees, `kunj ct file`, and `kunj events --json` so the list never polls.
- Release: a `workspace-app` job in the release workflow attaching `Kunj-workspace-<version>.dmg`, and `kunj install workspace` next to `vscode` and `macos`.

## Decisions and open questions

Decided 2026-10-23 (spec review in Claude Code; engineering detail in `docs/superpowers/specs/2026-10-23-workspace-ide-design.md`):

- Electron, in `workspace-app/`, macOS only in v1, driving the kunj CLI through `--json`; the app imports only kunj's JSON types, never its runtime. Tauri 2 stays a viable fallback if footprint ever outweighs terminal fidelity.
- Editor level: Monaco with the diff editor; no language servers in v1; VS Code/Cursor as the hand-off.
- Agent persistence lives in tmux owned by kunj: `agent` inside containers (as today) and a new `kunj agent [branch]` for worktrees, whose sessions `worktree list --json` reports as `agent.running`.
- Containers are reached only through kunj commands (`ct shell`, `ct agent`, `ct exec`, and a new `ct file read|write`); no new process inside the sandbox image.
- Ports: v1 lists what `ct list --json` reports and opens the browser; webview preview tabs are v2.
- Refresh: `kunj events --json` is built before the app; the app subscribes instead of polling.
- Diff viewer default: against the base branch (everything since the fork point from `origin/<base>`, working tree included); dropdown for uncommitted only and last commit.
- State the app owns is UI layout only, in `~/.kunj/<reponame>/workspace.json`.

Still open:

- [ ] **Notifications**: when an agent in a background environment stops and waits for input, the list should show it. tmux can run a hook on silence/activity; Claude Code hooks can write a marker file. Which one to rely on (v2).
- [ ] **Linux**: Electron makes it nearly free; the macOS menu bar app does not exist there. Worth deciding whether this app replaces `macos-app/` eventually.
- [ ] **Multiple windows**: one window with the list, or allow tearing an environment out into its own window for a second monitor (v2).

Plans: `docs/superpowers/plans/2026-10-23-workspace-cli-contract.md` (CLI additions, first), then `docs/superpowers/plans/2026-10-23-workspace-app-v1.md` (the app: environment list, terminals, agent attach, diff viewer; editor and previews as v2).

## Sources

- [Electron releases](https://releases.electronjs.org/) and [Electron 44.8.0 package listing](https://community.chocolatey.org/packages/electron/44.8.0)
- [Tauri 2 webview versions](https://v2.tauri.app/reference/webview-versions/), [tauri-plugin-pty on docs.rs](https://docs.rs/tauri-plugin-pty), [tauri-terminal](https://github.com/marc2332/tauri-terminal), [Terax](https://github.com/crynta/terax-ai), [WebKit bug 264268 (xterm.js canvas artifacts)](https://bugs.webkit.org/show_bug.cgi?id=264268)
- [Eclipse Theia 1.70 release notes](https://eclipsesource.com/blogs/2026/04/16/eclipse-theia-1-70-release-news-and-noteworthy/), [Theia community release 2026-05](https://eclipsesource.com/blogs/2026/06/19/the-eclipse-theia-community-release-2026-05/), [Theia IDE vs VS Code](https://eclipsesource.com/blogs/2024/07/12/vs-code-vs-theia-ide/)
- [VS Code web client in an iframe (GitLab issue)](https://gitlab.com/gitlab-org/gitlab/-/issues/368980), [code-server FAQ](https://coder.com/docs/code-server/latest/FAQ)
- [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty), [Monaco editor](https://microsoft.github.io/monaco-editor/), [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient)
- Comparable products: [Conductor](https://www.conductor.build/) (Mac app running Claude Code and Codex in isolated worktrees), [graith](https://github.com/d0ugal/graith) (daemon-owned PTYs, one worktree per agent)
