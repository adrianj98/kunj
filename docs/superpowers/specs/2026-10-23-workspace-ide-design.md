# Kunj workspace IDE — design (research + recommendation)

*2026-10-23. Source of truth for discussion: the Claude Doc "Kunj Workspace IDE Spec"
(https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y). This file mirrors its conclusions. Not yet approved;
no plan exists.*

## Goal

A desktop app where every branch is an **environment** (a local worktree or a branch container) and
everything open for it (terminals, agent sessions, editors, previews) lives together. The left pane lists
environments grouped by repository; selecting one swaps the whole right side. Background environments keep
their panes alive. It orchestrates many branches and agents; it is not a replacement for VS Code, which stays
the hand-off editor (`kunj ct open`, `kunj worktree open`).

## Building blocks

| Part | Choice |
|---|---|
| Terminal view | xterm.js + WebGL addon |
| PTY source | node-pty (`zsh` in a worktree, `docker exec -it <ctr> tmux new -A -s kunj-<branch>` for containers) |
| Agent persistence | tmux, same session names as `kunj ct agent`; nothing in the app |
| Editor | Monaco (diff editor first); no language servers in v1 |
| Files in containers | `docker exec cat` / `docker cp` in v1 (no bind mounts by design) |
| kunj logic | `kunj … --json` subprocesses (`repos`, `worktree list`, `ct list|start|stop|remove|forward`); binary from a login-shell PATH, version checked; the app imports only kunj's JSON types, never its runtime (decision: the CLI is the contract, so GUI and CLI cannot drift) |
| Preview | webview on a forwarded host port from `~/.kunj/container-forwards.json` |
| App state | UI layout only, `~/.kunj/workspace/<repo>/<branch>.json` |

## Runtime options compared

| Runtime | Terminal + editor | kunj integration | Effort | Footprint | Main risk |
|---|---|---|---|---|---|
| Electron (44.x) | xterm.js + node-pty + Monaco, VS Code's own stack | subprocess; JSON types importable | low | large (bundled Chromium) | native-module rebuilds per Electron major |
| Tauri 2 | xterm.js in WebKit; PTY in Rust (`portable-pty`; `tauri-plugin-pty` is 0.x) | subprocess / Node sidecar | medium-high | small | WebKit canvas/WebGL quirks, hand-built PTY bridge |
| Eclipse Theia (1.70) | full workbench, Monaco, LSP, VS Code extensions via Open VSX | subprocess (direct import possible, rejected: drift) | medium | large | it is an IDE; environment-first layout fights the shell |
| Embedded VS Code server per environment | the real VS Code | subprocess | medium | one server per environment | web client dislikes iframes; marketplace terms; cost scales with environments |
| Native SwiftUI (extend `macos-app/`) | SwiftTerm; no real editor | subprocess (`--json`) | medium / high for editing | smallest | macOS only, editing stays a hand-off |

A VS Code extension is not an option: one window per workspace, cannot keep another environment's
terminals alive or let a sidebar drive the whole window.

## Recommendation

**Electron**, as `workspace-app/` beside `vscode-extension/` and `macos-app/`, driving the installed `kunj`
CLI through `--json` (never importing its library), xterm.js + node-pty, Monaco for diff/file views, tmux for
agents, VS Code as hand-off. Reasons, in order: the CLI is the contract already shared with the VS Code
extension and the macOS app, so GUI and CLI cannot drift and the app works with whatever kunj is installed
(user's decision 2026-10-23); the terminal stack is proven at VS Code scale; the layout is the product and
Electron is a blank window; the cost (one Chromium) is bounded and does not grow per environment. With the
CLI as the contract Electron's margin over Tauri narrows to the terminal stack and one language, which is still
decisive. Fallback if footprint wins: native SwiftUI with SwiftTerm and no editor, a smaller product.

Architecture: sandboxed React renderer (environment list, tabs/panes) ↔ IPC over contextBridge ↔ main
process (`KunjCli` service: binary from a login-shell PATH, `kunj -V` checked, `repos`/`worktree list`/`ct
list|start|stop|remove|forward`; `PtyManager` keyed by environment+tab spawning `kunj ct shell|agent <branch>`
or `zsh`/tmux for worktrees; file/state service) → worktree shells, `docker exec` → tmux → claude, VS Code
hand-off. CLI additions the app will ask for: NDJSON progress under `--json` for `ct start` and `blueprint
snapshot`; later `kunj events --json` to replace polling; maybe `kunj ct file read|write`. Release:
`Kunj-workspace-<version>.dmg` in the release workflow and `kunj install workspace`.

VS Code's remote protocol is not an option for the app's own container access: the client–server wire protocol
and `vscode-server` are internal to Microsoft's VS Code and licensed only for it. VS Code attaches to kunj
containers on its own over `docker exec` (`kunj ct open`); kunj maintains no protocol for that. The open pieces
in that space are the Dev Container spec (kunj already reads `devcontainer.json`), LSP and DAP, which the app
can use later over `kunj ct exec`. The app therefore has exactly one contract to maintain: the kunj CLI.

## Open questions

- Preview tabs as webviews or a button that opens the browser.
- Agents in worktrees: app starts tmux itself, or kunj gains `kunj agent` for worktrees.
- "Agent waiting for input" signal: tmux hooks or Claude Code hooks writing a marker.
- Linux support and whether this app replaces `macos-app/`.
- Default diff base (base branch, last commit, agent's file list).
- Tearing an environment out into its own window.

Decided: Electron driving the kunj CLI (no library import); Monaco diff editor, no LSP in v1; tmux
`kunj-<branch>` shared with `kunj ct agent`; containers reached only via `kunj ct shell|agent|exec`; app state
is UI layout only.

Next step if approved: brainstorm the open questions, then a plan for a v1 of environment list, terminals,
agent attach and diff viewer; editor and previews in v2.
