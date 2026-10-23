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
| [container-phase-2.md](container-phase-2.md) | Sidecar services, `ct open`, `forward --auto`, `ct prune`, Docker-in-Docker, host MCP bridge | Shipped, except the MCP bridge |
| [workspace-ide.md](workspace-ide.md) | Phase 3: the workspace app and its CLI contract (`kunj agent`, `kunj events`, `kunj ct file`, JSON types) | CLI contract shipped; app proposed |
| [organize-windows.md](organize-windows.md) | Organize Windows in the macOS menu bar app | Shipped |

## Done

| Work | Spec | Commits |
| --- | --- | --- |
| Branch containers (phase 1) | [branch-containers.md](branch-containers.md) | — |
| Blueprints and snapshots | [blueprints.md](blueprints.md) | — |
| Sidecar services | [container-phase-2.md](container-phase-2.md) | ed136b3, 6273c61 |
| `kunj ct open` (editor attach) | [container-phase-2.md](container-phase-2.md) | 93b7ed3, f635113 |
| `kunj ct forward --auto` | [container-phase-2.md](container-phase-2.md) | b88466c |
| `kunj ct prune` | [container-phase-2.md](container-phase-2.md) | 893dc79, 4f7aa10 |
| Docker-in-Docker | [container-phase-2.md](container-phase-2.md) | d40b44c, c88430b |
| Published JSON types | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 36e64a5, d0a490a, 22a8444 |
| `kunj agent` for worktrees, tmux optional | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 2974aef, 75380f3, ce52ad8, 453f241, e5b15a4 |
| `kunj ct file read\|write` | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 47fcefe, 5721f17 |
| `kunj events --json` with status poll | [workspace-ide.md](workspace-ide.md#cli-contract-shipped) | 189d9ba, 3685ef6, ce5691d |
| Specs merged into one folder and checked against the code | this folder | f3a5e35, d1eea00 |

## In progress

| Work | Spec | Where it stands |
| --- | --- | --- |
| Native IDE spike (AppKit + SwiftTerm + Monaco in one WKWebView) | [workspace-ide.md](workspace-ide.md#runtime-options) | Running in `spikes/native-ide/`; verdict goes in its `REPORT.md` and decides the app's runtime |

## To do

| Work | Spec | Notes |
| --- | --- | --- |
| `kunj events` must exit when stopped while Docker hangs | [workspace-ide.md](workspace-ide.md) | The `docker info` / `docker ps` child is never killed after abort; kill it through a signal in `spawnDocker`, or exit once `watchEvents` resolves. Needed before the app. |
| Secret manager (`kunj secret`, `kunj run`, `.env` import) | [container-system.md](container-system.md#secrets) | Designed 2026-10-23; needs an implementation plan |
| Workspace app v1 | [workspace-ide.md](workspace-ide.md) | Plan written for Electron, on hold until the spike decides the runtime |
| Host MCP bridge | [container-phase-2.md](container-phase-2.md) | Proposed |
| Copy the safe parts of `~/.claude` into containers | [container-system.md](container-system.md#roadmap) | — |
| `kunj` inside the container | [container-system.md](container-system.md#roadmap) | — |
| Extra repos cloned next to the workspace | [container-system.md](container-system.md#roadmap) | — |
| Containers in the VS Code extension and the macOS app | [container-system.md](container-system.md#roadmap) | — |
| Remote Docker host (`kunj serve`) | [container-system.md](container-system.md#roadmap) | Later |
| Minor follow-ups from the CLI contract review | — | Ctrl-C in a tmux-less `kunj agent` can lose the exit code; the top-level git watcher in `kunj events` is not restarted on error |

## Waiting on you

| Item | Why |
| --- | --- |
| Check `kunj agent` with a real tmux (`-e` variables, `-A` reattach, `window-size latest`, run inside a tmux pane) | tmux is not installed on the machine that built it; the commands are in the CLI contract's final fixes report |
| Decide the workspace app runtime (Electron or native) | After reading the spike's `spikes/native-ide/REPORT.md` |

The Claude Docs where the discussions started are no longer kept in step: container system
<https://claude.ai/artifact/TmtL5VdNYr55VaddMSVEwk>, branch containers
<https://claude.ai/artifact/8AhUG3mjYg5kDJNRNJW3xP>, blueprints
<https://claude.ai/artifact/FE8AfuYceDbFTguCDfWD86>, phase 2
<https://claude.ai/artifact/77f7sDBjgq8ZTZbnfpXPUA>, workspace IDE
<https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y>.
