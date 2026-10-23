# Specs

Specs live here; one file per topic. When behaviour changes, update the file in the same change. The
code on `main` is the authority: when a spec and `src/` disagree, fix the spec. Implementation plans are
in `docs/superpowers/plans/`.

| File | Covers | State | Original discussion |
| --- | --- | --- | --- |
| [container-system.md](container-system.md) | Umbrella for `kunj ct`: status of every container feature, invariants, code map, roadmap | — | https://claude.ai/artifact/TmtL5VdNYr55VaddMSVEwk |
| [branch-containers.md](branch-containers.md) | Phase 1: isolation, names and labels, image, start/resume/remove, network helper and firewall, credentials, forwarding, hooks, `list --json` | Shipped | https://claude.ai/artifact/8AhUG3mjYg5kDJNRNJW3xP |
| [blueprints.md](blueprints.md) | `.kunj/blueprint.json`, presets, `init`, snapshots built by `start`, host-made bundles | Shipped | https://claude.ai/artifact/FE8AfuYceDbFTguCDfWD86 |
| [container-phase-2.md](container-phase-2.md) | Sidecar services, `ct open`, `forward --auto`, `ct prune`, Docker-in-Docker, host MCP bridge | Shipped, except the MCP bridge (proposed) | https://claude.ai/artifact/77f7sDBjgq8ZTZbnfpXPUA |
| [workspace-ide.md](workspace-ide.md) | Phase 3: the workspace app driving the kunj CLI; its CLI contract (`kunj agent`, `kunj events`, `kunj ct file`, JSON types) | CLI contract shipped; app proposed, runtime pending a spike | https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y |
| [organize-windows.md](organize-windows.md) | Organize Windows in the macOS menu bar app | Shipped | — |

The Claude Docs linked above are where the discussions started; they are no longer kept in step.
