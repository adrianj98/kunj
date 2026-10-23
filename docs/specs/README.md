# Specs

On-disk copies of the container and workspace specs, so a fresh session can read them without the Claude
Docs. The design files under `docs/superpowers/specs/` are the engineering designs the plans were written
from; the files here are the discussion documents (status boards, decisions, drawings described in words).

| File | What | Claude Doc |
| --- | --- | --- |
| `container-system.md` | Umbrella: what `kunj ct` is, status board, code map, roadmap | https://claude.ai/artifact/TmtL5VdNYr55VaddMSVEwk |
| `branch-containers.md` | Phase 1 design discussion: isolation, network helper, credentials, commands | https://claude.ai/artifact/8AhUG3mjYg5kDJNRNJW3xP |
| `blueprints.md` | `.kunj/blueprint.json`, presets, snapshots | https://claude.ai/artifact/FE8AfuYceDbFTguCDfWD86 |
| `container-phase-2.md` | Services, editor attach, auto forward, prune, Docker-in-Docker, host MCP bridge; decisions and progress | https://claude.ai/artifact/77f7sDBjgq8ZTZbnfpXPUA |
| `workspace-ide.md` | Phase 3: the Electron workspace app driving the kunj CLI | https://claude.ai/artifact/Ti4R8bsdxtZC5YJ1J21z1y |

Order of work: phase 1 and blueprints are shipped; phase 2 is in progress (plan
`docs/superpowers/plans/2026-10-23-container-phase-2.md`, ledger `.superpowers/sdd/2026-10-23-container-phase-2/progress.md`);
phase 3 (the IDE) starts after phase 2.

The first four files were rebuilt on 2026-10-23 from the edits made through Claude Code, because the Claude
Docs live in another organization than the one the session was signed into; `workspace-ide.md` is a direct
export. When a spec changes, edit the file here and the doc together.
