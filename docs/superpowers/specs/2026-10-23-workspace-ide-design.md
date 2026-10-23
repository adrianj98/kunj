# Kunj workspace IDE — design

*2026-10-23. Discussion document: the Claude Doc "Kunj Workspace IDE Spec"
(https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y), mirrored in `docs/specs/workspace-ide.md`. This file is the
engineering design the plans are written from. Reviewed and decided 2026-10-23; plans:
`docs/superpowers/plans/2026-10-23-workspace-cli-contract.md` (CLI additions, first) and
`docs/superpowers/plans/2026-10-23-workspace-app-v1.md` (the app).*

## Goal

A desktop app where every branch is an **environment** (a local worktree or a branch container) and
everything open for it (terminals, agent sessions, editors, previews) lives together. The left pane lists
environments grouped by repository; selecting one swaps the whole right side. Background environments keep
their panes alive. It orchestrates many branches and agents; it is not a replacement for VS Code, which stays
the hand-off editor (`kunj ct open`, `kunj worktree open`).

## Decisions (2026-10-23)

| Question | Decision |
|---|---|
| Runtime | **Electron** (macOS only in v1), `workspace-app/` beside `vscode-extension/` and `macos-app/`. Tauri 2 is a viable fallback if footprint ever matters more than terminal fidelity; the React renderer would move unchanged. |
| kunj integration | **The CLI is the only contract.** The app runs `kunj … --json` subprocesses and never imports `src/lib/**` or `dist/lib/**` at runtime. It imports kunj's *JSON types only* (`import type`), from a new `src/lib/json-types.ts` published as the package's `types` entry. |
| Worktree agents | **`kunj agent [branch]`**, a new CLI command: a host tmux session named by kunj, status reported by `worktree list --json` as `agent.running`. The app never names a tmux session itself. |
| Container files | **`kunj ct file read|write <branch> <path>`**, a small CLI addition; the app never runs `docker`. |
| Ports and previews | v1 shows the ports `ct list --json` reports (published, and forwarded once phase 2's `forward --auto` registry lands) and a button opens the browser. Webview preview tabs are v2. |
| List refresh | **`kunj events --json` first**: an NDJSON event stream the app subscribes to, then re-runs the listing for the repo that changed. No periodic polling in the app. |
| Diff viewer default | Against the base branch: everything since the fork point from `origin/<base>`, working tree included. Dropdown: uncommitted only, last commit. |
| State | UI layout only, in `~/.kunj/<reponame>/workspace.json` keyed by branch (the per-repo directory kunj already uses; one file, so slashes in branch names and `feature/x` vs `feature-x` are not a problem). |
| Long actions | `ct start`, `ct remove`, `blueprint snapshot` run in a terminal tab inside the app, so their progress shows as it does in a shell. NDJSON progress under `--json` is not needed for v1. |

## Corrections from the review (what the discussion doc got wrong)

- **tmux session names.** Inside a container the session is named `agent` (src/commands/container.ts) and
  stays that way: each container has its own tmux server. On the host there is one tmux server per user, so
  `kunj agent` names sessions `kunj-<readable>-<hash>` using the same readable part and `nameHash()` as
  container names (names.ts), with `.` and `:` replaced because tmux rejects them.
- **The forward registry** (`~/.kunj/container-forwards.json`) is phase 2 work (in progress). The app never
  reads it: forwarded ports arrive through `ct list --json` as `ports[].kind === 'forward'`.
- **cwd is the repo argument.** Every `kunj worktree` and `kunj ct` call resolves the repository from the
  working directory and the branch from the current branch. The app spawns every kunj command with `cwd`
  set to the repository root from `kunj repos --json` (`root`; the git dir itself for a bare repo) and always
  passes the branch explicitly.
- **Types.** The package had no `types` entry and `main` is the CLI entrypoint. The JSON contracts become
  named types in `src/lib/json-types.ts`, the commands build their output `satisfies` those types, and
  `package.json` gets `"types": "./dist/lib/json-types.d.ts"`.
- **Shared tmux attach.** The app and a CLI terminal attached to one session would be sized to the smaller
  client; both `kunj agent` and `kunj ct agent` set `window-size latest` on the session.
- **Version check.** The app requires a minimum kunj version (`kunj -V`); a build reporting `1.0.0` is an
  `npm link`ed dev build and is accepted with a warning.
- **Distribution.** Like the macOS app, the DMG is ad-hoc signed and not notarized, so `kunj install workspace`
  strips the quarantine attribute as `installMacApp()` does. node-pty is rebuilt for Electron in the app's
  build, on a macOS arm64 runner.

## Building blocks

| Part | Choice |
|---|---|
| Terminal view | xterm.js + WebGL addon (canvas fallback) + fit addon |
| PTY source | node-pty in the main process: `$SHELL -l` in a worktree, `kunj agent <branch>` for a worktree agent, `kunj ct shell <branch>` / `kunj ct agent <branch>` for containers |
| Agent persistence | tmux, owned by kunj (`agent` in containers, `kunj-<readable>-<hash>` on the host); nothing in the app |
| Editor | Monaco: diff editor first, plain editor for single files; no language servers in v1 |
| Files | worktrees: Node `fs` in main; containers: `kunj ct file read|write` |
| Diff content | worktrees: read-only `git` in the worktree; containers: `kunj ct exec <branch> -- git …`. State always comes from kunj; git is used only for diff content |
| kunj state | `kunj repos --json`, `kunj worktree list --json`, `kunj ct list --json`, pushed by `kunj events --json` |
| kunj actions | `worktree add|remove|open`, `ct start|stop|remove|open`, `agent`, `ct agent|shell|exec|file` |
| App state | `~/.kunj/<reponame>/workspace.json`: `{ [branch]: { tabs, active } }` |

## Architecture

```
renderer (React, sandboxed, contextIsolation)
  EnvironmentList · EnvironmentHeader · TabStrip · TerminalPane (xterm) · DiffPane (Monaco)
        │ IPC over contextBridge (typed channels)
main process
  KunjCli      resolve binary from a login-shell PATH, check version, run `kunj … --json` with cwd = repo root
  Environments repos → worktree list + ct list per repo → Environment[]; refreshed on events
  Events       one `kunj events --json` child, NDJSON → refresh the repo named in the event
  PtyManager   node-pty per (environment, tab); data/resize/exit over IPC
  Files        fs for worktrees, `kunj ct file` for containers
  Diff         git / `kunj ct exec -- git` → parsed unified diff → old/new text for Monaco
  Layout       workspace.json per repo
        │ child processes
kunj CLI → git, docker exec → tmux → claude ; VS Code via `kunj ct open` / `kunj worktree open`
```

## CLI additions (plan: workspace-cli-contract)

Shipped on main (merge 9822cc6): items 1 to 4. Item 5 belongs to the app plan.

1. `src/lib/json-types.ts`: `ReposJson`, `WorktreeListJson`, `ContainerListJson`, `AgentStatusJson`, `EventJson`,
   `ErrorJson`; `package.json` `types` entry. Shipped: 36e64a5.
2. `kunj agent [branch]`, `kunj agent status|stop [branch]`, setting `agent.command` (default `claude`, no
   permission skipping on the host), `worktree list --json` gains `agent: { running: boolean | null }` from one
   `tmux list-sessions` per listing (null when tmux is missing or `--no-status`). Shipped: 2974aef, 75380f3, ce52ad8.
3. `kunj ct file read|write <branch> <path>`: path relative to `/workspace`, no `..`, runs as the sandbox user. Shipped: 47fcefe, 5721f17.
4. `kunj events --json`: NDJSON stream of `git` (per repo, `.git` watched), `sessions`, `forwards`, `repos`,
   `container` (docker events through the backend), `agent` (host tmux sessions polled) and `backend` events,
   debounced; ends on SIGINT or when stdin closes. Shipped: 189d9ba, 3685ef6.
5. `kunj install workspace` and a `workspace-app` release job (in the app plan, with the packaging); not part of this plan.

Nothing else in `src/lib` changes for the app.

## Runtime options compared (kept for the record)

| Runtime | Terminal + editor | kunj integration | Effort | Footprint | Main risk |
|---|---|---|---|---|---|
| Electron (44.x) | xterm.js + node-pty + Monaco, VS Code's own stack | subprocess; JSON types importable | low | large (bundled Chromium) | native-module rebuilds per Electron major |
| Tauri 2 | xterm.js in WebKit; PTY in Rust (`portable-pty`; `tauri-plugin-pty` is 0.x) | subprocess | medium-high | small | WebKit canvas/WebGL quirks, hand-built PTY bridge |
| Eclipse Theia (1.70) | full workbench, Monaco, LSP, VS Code extensions via Open VSX | subprocess | medium | large | it is an IDE; environment-first layout fights the shell |
| Embedded VS Code server per environment | the real VS Code | subprocess | medium | one server per environment | web client dislikes iframes; marketplace terms; cost scales with environments |
| Native SwiftUI (extend `macos-app/`) | SwiftTerm; no real editor | subprocess (`--json`) | medium / high for editing | smallest | macOS only, editing stays a hand-off |

A VS Code extension is not an option: one window per workspace, cannot keep another environment's
terminals alive or let a sidebar drive the whole window. VS Code's remote protocol is internal to Microsoft's
VS Code and licensed only for it; VS Code reaches kunj containers on its own through `kunj ct open`.

## v1 scope

Environment list with status, terminals, agent tabs (worktree and container, reattaching to CLI-started
sessions), the diff viewer, container start/stop/remove and worktree add/remove run from the app, hand-off to
VS Code, ports as links. **v2:** Monaco file editing with a file tree, webview previews, the "agent waiting
for input" signal, Linux, tearing an environment into its own window.

## Still open

- "Agent waiting for input" signal: tmux hooks or Claude Code hooks writing a marker (v2).
- Whether this app replaces `macos-app/` eventually.
