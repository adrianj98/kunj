# Specs and status

Specs live here; one file per topic. When behaviour changes, update the file in the same change. The
code on `main` is the authority: when a spec and `src/` disagree, fix the spec. Implementation plans are
in `docs/superpowers/plans/`.

**This page is the tracker.** Every piece of work is one line in Done, In progress, To do or Waiting on
you, linking to the spec section that describes it. When something ships, move its line to Done with
the commits in the same change, and update the spec's own status table. Details stay in the specs; this
page only says where each thing stands.

## Specs

| File | Covers | State |
| --- | --- | --- |
| [container-system.md](container-system.md) | Umbrella for `kunj ct`: status of every container feature, invariants, secrets design, code map, roadmap | — |
| [branch-containers.md](branch-containers.md) | Phase 1: isolation, names and labels, image, start/resume/remove, network helper and firewall, credentials, forwarding, hooks, `list --json` | Shipped |
| [blueprints.md](blueprints.md) | `.kunj/blueprint.json`, presets, `init`, snapshots built by `start`, host-made bundles | Shipped |
| [container-phase-2.md](container-phase-2.md) | Sidecar services, `ct open`, `forward --auto`, `ct prune`, Docker-in-Docker, host MCP bridge | Shipped |
| [workspace-ide.md](workspace-ide.md) | Phase 3: the workspace app and its CLI contract (`kunj agent`, `kunj events`, `kunj ct file`, JSON types) | Shipped (CLI contract and the native app v1) |
| [organize-windows.md](organize-windows.md) | Organize Windows in the macOS menu bar app | Shipped |
| [remote-containers.md](remote-containers.md) | `kunj serve` on the Docker host, `RemoteKunjBackend`, `kunj remote`, the wire protocol, auth over an SSH tunnel | Shipped (SSH to a real second machine not yet tried) |
| [multi-remote-containers.md](multi-remote-containers.md) | A repository's containers across this Mac and several remotes: `ct list` and branch lookup ask every one; the workspace app's remote picker | Spec written |
| [tmux-sessions.md](tmux-sessions.md) | `kunj sessions`: kunj's tmux sessions with owner, attached terminals, CPU, memory, orphans; `kill`; the workspace app's Sessions window | Shipped |
| [search.md](search.md) | `kunj search`: worktrees (default), branches, containers, commits and work logs; `SearchJson`; the workspace app's Search panel | Shipped (CLI, workspace app); VS Code to do |
| [github-clone.md](github-clone.md) | `kunj repos github` / `kunj repos clone`, `repos.cloneDir`/`repos.cloneBare`, the workspace app's Clone from GitHub sheet | Shipped (CLI, workspace app) |

## Done

| Work | Spec | Commits |
| --- | --- | --- |
| Branch containers (phase 1) | [branch-containers.md](branch-containers.md) | — |
| Blueprints and snapshots | [blueprints.md](blueprints.md) | — |
| Blueprint `image` key (sandbox or an image, over container.image and the devcontainer) | [blueprints.md](blueprints.md) | de46ded |
| Blueprint `lockfiles` optional, none hashed by default | [blueprints.md](blueprints.md) | 8a53c51 |
| Clone from GitHub: `kunj repos github`, `kunj repos clone`, workspace app sheet (⌥⌘N) | [github-clone.md](github-clone.md) | cc07138 |
| Quit asks Leave Running / Close All Sessions (20 s timeout); Close All Sessions…; Claude agents resume (`kunj agent --resume`) | [tmux-sessions.md](tmux-sessions.md#quitting-and-resuming) | 68e1b3e |
| Blueprint `"*"` tool values; snapshot seeds skip LFS smudge, containers `git lfs pull` | [blueprints.md](blueprints.md) | f3a4222 |
| bun preset installs unzip (`kunj_need_pkg`) | [blueprints.md](blueprints.md) | 872fa13 |
| Blueprint `aliases` (to `/etc/profile.d/kunj-aliases.sh` in the snapshot) | [blueprints.md](blueprints.md) | 12bdcc5 |
| Agent and shell sessions follow their worktree across a checkout (CLI and workspace app tabs) | [tmux-sessions.md](tmux-sessions.md#following-a-checkout) | c5c543f, 2ea490e |
| `kunj sessions` and the workspace app's Sessions window (owner, attached, CPU/memory, orphans, kill); `@kunj_worktree` tag | [tmux-sessions.md](tmux-sessions.md) | f98e051 |
| Workspace app sidebar rows show their worktree's session CPU and memory | [tmux-sessions.md](tmux-sessions.md#workspace-app) | 7ab0568 |
| Workspace app: resizable sidebar, Changes split, Files column and file list; a folder named like its branch is not repeated | [workspace-ide.md](workspace-ide.md) | 015729a |
| Sidecar services | [container-phase-2.md](container-phase-2.md) | ed136b3, 6273c61 |
| `kunj ct open` (editor attach) | [container-phase-2.md](container-phase-2.md) | 93b7ed3, f635113 |
| `kunj ct forward --auto` | [container-phase-2.md](container-phase-2.md) | 5710902, b88466c |
| `kunj ct prune` | [container-phase-2.md](container-phase-2.md) | 893dc79, 4f7aa10 |
| Docker-in-Docker | [container-phase-2.md](container-phase-2.md) | d40b44c, c88430b |
| Host MCP bridge (Chrome DevTools MCP on the Mac for the agent): deny-by-default tool and argument allowlists, pinned server, throwaway profile without downloads, listener as the sandbox user; plus the legacy `./.kunj` migration copying only untracked files | [container-phase-2.md](container-phase-2.md#6-host-mcp-bridge) | c4ac53d, cf544d8, 92b14ef, d235d85 |
| Phase 2 follow-ups: helper refreshed on `start` (forwarders and bridges follow it), atomic firewall reload, services added on resume, failed resume stops what it started, structural compose check (no `include`/`extends.file`, no `env_file`/`label_file`, no Unicode line breaks), `--rebuild` drops removed services' volumes, seeds keep only the right origin refs, prune keeps live snapshot builds, visible forwarder errors in private logs, `ct agent` window size, `logs --json`, bridge hardening, slow tests given room | [container-phase-2.md](container-phase-2.md) | 8c88318, 1cb0c9b, 0637441, f47a9e0, 8f8f23c, 19151f4, a335d6a |
| Opt-in functional test suite: the real `kunj` CLI against real Docker (lifecycle, exec, blueprint, services, forward, prune, Docker-in-Docker refusals, MCP bridge), `npm run test:functional`, never run by `npm test` or `test:docker` | [container-system.md](container-system.md) | 3ffbe08 (written, not yet run) |
| Phase 2 cross-feature fixes: forwards and polls through the network helper, forwarder bound to one container run, compose deps on dropped services, 10-minute orphan grace, migrations in `maintain`, manual forwards registered | [container-phase-2.md](container-phase-2.md) | a32bc90 |
| Published JSON types | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 36e64a5, d0a490a, 22a8444 |
| `kunj agent` for worktrees, tmux optional | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 2974aef, 75380f3, ce52ad8, 453f241, e5b15a4 |
| Agent waiting-for-input state (`agent.hooks`: Claude Code hooks write `agent.state`, reported by `worktree list`, `ct list` and `kunj events`) | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | ace71b1 |
| No tmux status line in kunj's agent sessions (`kunj agent`, `kunj ct agent`) | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 008eb18 |
| Agent tmux settings: `agent.tmux` (off runs agents directly, like `--no-tmux`) and `agent.tmuxStatus` (tmux status line, default off); the app's Settings shows both (Task 11) | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | efd858b |
| `kunj ct file read\|write` | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 47fcefe, 5721f17 |
| `kunj events --json` with status poll; exits when stopped even while Docker hangs | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 189d9ba, 3685ef6, ce5691d, e1078df |
| `kunj agent` checked with a real tmux 3.8: `-e` gives this branch's `KUNJ_*` with another tmux server running, a rerun reattaches (`-A`, same pane, no second agent), it starts from inside a tmux pane without the nesting error, the session has `window-size latest` | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | verified 2026-10-23 with tmux 3.8 on macOS, and 3.3a and 3.5a in Debian containers (`scripts/check-tmux-agent.sh`); no code change |
| Workspace app v1 (native): `workspace-app/` (AppKit, SwiftTerm, Monaco): environments of every repo, terminals and agent tabs kept per environment, Changes column, editor tabs, actions and New session, layout restore, settings and themes; `kunj install workspace` and the release job; user docs | [workspace-ide.md](workspace-ide.md#architecture) | ace71b1, 0e8ab41, e6feedc, 53fdf6b, 8f49f54, 831d215, 95410df, d7b79fa, f3c01a5, a4ec693, 5158fe4, 45756ae, 062d22d, 2d972db, 54a0685, fb62af9, 7d497a6, f44b785; reviews 29be7f1, 3c0627d, 5e4a829, 7808f6f and c09bbd7; final review fixes 22336bb; plan `docs/superpowers/plans/2026-10-23-workspace-app-v1.md` |
| Specs merged into one folder and checked against the code | this folder | f3a5e35, d1eea00 |
| Native IDE spike: SwiftTerm handles five live Claude TUIs (6% CPU idle), Monaco diff in one WKWebView in under 1 s, menu shortcuts work with the webview focused; caveat: hidden tabs still parse on the main thread | [spikes/native-ide/REPORT.md](../../spikes/native-ide/REPORT.md) | 1c2aaa3, 1730cd1, 0e41a24 |
| monaco-vscode-api spike (option B, editor only): works in a WKWebView from the `kunj` scheme, TextMate colours every language, kunj theme as a VS Code theme extension, about +30 MB and +0.4 s to first coloured code vs. Monaco 0.57; `defineTheme` is gone | [spikes/monaco-vscode-api/REPORT.md](../../spikes/monaco-vscode-api/REPORT.md) | bfc1e5a |
| Secret manager: `kunj secret` (encrypted global, repo and branch secrets; `.env` import), `kunj run`, delivery to host commands, agents, new worktrees and branch containers, the kept `.env` import hint and `kunj setup` offer, user docs, the workspace app's Settings › Containers (GitHub token source, `container.useGhToken`, Claude Code token), `kunj ct token setup|check` (Claude Code token extracted from `claude setup-token` and validated); plan `docs/superpowers/plans/2026-10-23-secret-manager.md` | [container-system.md](container-system.md#secrets) | c2a722f, d2c82e4, 1429ed9, bc006de, 8901b6b, 6b63a50, 009958c, a10f544, 6c08cd1, 70b398d, 4a15833, 8fd3733, 20c95f9, 45a9e6b, 3bbe9af |
| Containers in the VS Code extension and the macOS app | [containers-in-apps.md](containers-in-apps.md) | 4d99265, 60206aa, df59f3f, 2e76fd8, 0ebd0ed, d3031e0, 6e7e330 |
| Multi-remote containers: the fleet, `ct list` and branch lookup across every remote, events, the workspace app's "Run on" picker | [multi-remote-containers.md](multi-remote-containers.md) | Spec written; the serve/container.ts work it waited on is in (cc94eb0) |
| Workspace app: ⌘-click file paths in terminals open an editor tab; × on tabs and on the Changes and Files columns | [workspace-ide.md](workspace-ide.md#layout) | 50c5edb, b01b4b1 |
| Workspace app: reopening restores every running agent tab of an environment, not just one | [workspace-ide.md](workspace-ide.md#layout) | 622c27e |
| Remote containers: `kunj serve`, `RemoteKunjBackend`, `kunj remote`, `--remote` / `container.remote`, TTY over the Engine API, SSH tunnel | [remote-containers.md](remote-containers.md) | aab2a76, 8b4d3e2, fbb95e0, d1ad96c, 662b060, 125f6e2, b086c66, 3235471, 648bc7d, ffd0f1b, 78a8df6; merged to main 2653373 |
| Workspace app: syntax colours in editor tabs; no false TypeScript import errors | [workspace-ide.md](workspace-ide.md) | dad2757 |
| Workspace app: ⌥-drag selects in a terminal whose program has the mouse | [workspace-ide.md](workspace-ide.md#layout) | f684bc6 |
| Workspace app: a plain drag selects in a shell tab (tmux copy never reached the clipboard) | [workspace-ide.md](workspace-ide.md#layout) | 69b486e |
| Container shells no longer open zsh's new-user wizard (stub moved to /etc/zsh/zshenv) | [branch-containers.md](branch-containers.md) | 294ea02 |
| kunj icon: app icons (menu bar app, Workspace app), VS Code icon, docs and landing favicon/logo from `assets/icon/` via `scripts/gen-icons.sh` | — | 1405575 |
| kunj serve hardening: named volumes only, kunj volumes/networks only, no extra capabilities without --allow-privileged; tunnels closed per command | [remote-containers.md](remote-containers.md) | cc94eb0 |
| Workspace app: terminal shows programs' own 256 colours (theme no longer re-tints them) | [workspace-ide.md](workspace-ide.md#layout) | 2d4a3b3 |
| Remote containers: `kunj remote add --url http://… --allow-insecure-http` (plain http over a tailnet or WireGuard) | [remote-containers.md](remote-containers.md#transport-and-auth) | ad5b992 |
| Workspace app: ignored files (`.env`) in the Files column, ignored folders as one faint entry | [workspace-ide.md](workspace-ide.md) | 053fa54 |
| Antigravity as an agent: `kunj agent --agent antigravity`, Antigravity Agent tabs in the workspace app (worktrees; no waiting state) | [workspace-ide.md](workspace-ide.md) | a18c172 |
| Workspace app: Settings › Containers **Test** for the Claude Code token (`kunj ct token check --json`), Set Up… through `kunj ct token setup` | [workspace-ide.md](workspace-ide.md#layout) | 14778e6 |
| `kunj search`: every worktree by default; `--in branches,containers,commits,logs` / `--all`; `SearchJson` | [search.md](search.md) | 4b23f81 |
| Workspace app: Search mode in the Files column (⌘⇧F), the selected worktree or container by default, all worktrees (and containers) from its menu; a match opens at its line | [search.md](search.md#workspace-app) | 4f97760 |

## In progress

| Work | Spec | Notes |
| --- | --- | --- |
| Containers in the VS Code extension and the macOS app | [containers-in-apps.md](containers-in-apps.md) | CLI 4d99265, 60206aa; extension df59f3f; macOS app shipped. Left: try both against a live container; refresh on `kunj events` |

## To do

| Work | Spec | Notes |
| --- | --- | --- |
| Search in the VS Code extension: a quick pick over `kunj search --json` | [search.md](search.md) | — |
| Remote containers: try an `--ssh` remote against a real second machine (and a Linux Docker host) | [remote-containers.md](remote-containers.md) | Everything so far ran with `kunj serve` on the same Mac |
| Copy the safe parts of `~/.claude` into containers | [container-system.md](container-system.md#roadmap) | — |
| `kunj` inside the container | [container-system.md](container-system.md#roadmap) | — |
| Extra repos cloned next to the workspace | [container-system.md](container-system.md#roadmap) | — |
| Phase 2 follow-ups left | [container-phase-2.md](container-phase-2.md) | `container.services` registered as a string setting (the registry has no object type); a snapshot copy reuses its own local branch on `ct start -c <same name>` (optional `switch -C`) |
| MCP bridge follow-ups | [container-phase-2.md](container-phase-2.md#open-questions-and-roadmap) | Verify the download block in a visible browser |
| Agent state follow-ups | [workspace-ide.md](workspace-ide.md#open-questions) | A killed session's leftover state shows until the next hook; `--settings` lands after a pipe in a compound `agent.command` |
| Workspace app: move Monaco to monaco-vscode-api 38 (option B) as the AMD→ESM move: Vite build, themes as VS Code colour themes from `tokens.json`, language by file name, explicit worker labels; then measure two web views | [workspace-ide.md](workspace-ide.md#open-questions) | Spike says go ([REPORT](../../spikes/monaco-vscode-api/REPORT.md)); waiting on the decision to adopt |
| Minor follow-ups from the CLI contract review | — | Ctrl-C in a tmux-less `kunj agent` can lose the exit code; the top-level git watcher in `kunj events` is not restarted on error |

## Waiting on you

| Item | Why |
| --- | --- |
| Verify Docker-in-Docker `sysbox` mode on a real daemon | Docker Desktop has no `sysbox-runc`; needs a Linux host or a VM with sysbox. `privileged` was only smoke-tested outside kunj |
| Delete a stray test file: `~/Library/Application Support/Code/User/globalStorage/ms-vscode-remote.remote-containers/imageConfigs/kunj-sandbox%3a1.3.0.json` | Left by an early `kunj ct open` test run before it was made hermetic; the agent was not allowed to delete it |
| Delete the duplicate outline-only doc <https://claude.ai/artifact/VE9Ltof3P1N62yWZyyExDW> | Created by mistake; it is in a different claude.ai organization than the agent session, so delete it from claude.ai yourself |

The Claude Docs where the discussions started are no longer kept in step: container system
<https://claude.ai/artifact/TmtL5VdNYr55VaddMSVEwk>, branch containers
<https://claude.ai/artifact/8AhUG3mjYg5kDJNRNJW3xP>, blueprints
<https://claude.ai/artifact/FE8AfuYceDbFTguCDfWD86>, phase 2
<https://claude.ai/artifact/77f7sDBjgq8ZTZbnfpXPUA>, workspace IDE
<https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y>.
