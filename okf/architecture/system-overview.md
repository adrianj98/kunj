---
type: Architecture
title: System Overview
description: What kunj is, the pieces it ships as, how they talk to each other at runtime, and what lives under ~/.kunj.
resource: src
tags: [architecture, overview, cli, apps, kunj-dir]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

**kunj** is a Git branch, worktree and container CLI written in TypeScript (CommonJS, ES2022, strict
mode). It started as a branch switcher with auto-stash and AI commit messages (AWS Bedrock) and grew
into a manager for git worktrees, agent sessions in tmux, sandboxed per-branch Docker containers and
an encrypted secrets vault.

The CLI is the only component with logic. Three desktop/editor apps and a docs site sit around it;
the apps never import kunj code, they run `kunj ... --json` and read the
[published JSON contract](/architecture/json-contract.md).

# Pieces

| Piece | Where | What it is |
|-------|-------|------------|
| CLI | `src/` -> `dist/`, npm package `kunj`, bin `kunj` -> `dist/index.js` | Commander-based CLI, see [Command System](/architecture/command-system.md) |
| Container assets | `src/container/{sandbox,nethelper,sandbox-dind,presets}` | Docker build contexts and presets, copied to `dist/container` by `scripts/copy-container-assets.js` |
| Web dashboard | `src/ui/` (`kunj ui`) | Express server rendering commands that declare a `ui` widget config |
| VS Code extension | `vscode-extension/` | Separate npm package (esbuild), [VS Code Extension](/apps/vscode-extension.md) |
| macOS menu bar app | `macos-app/` | SwiftUI `MenuBarExtra`, SwiftPM, [macOS App](/apps/macos-app.md) |
| Workspace app | `workspace-app/` | AppKit + SwiftTerm + Monaco, [Workspace App](/apps/workspace-app.md) |
| Docs and landing page | `docs-site/` (Astro Starlight), `site/` | Published to GitHub Pages, [Docs Site](/apps/docs-site.md) |

# Runtime Topology

```
 VS Code extension   macOS menu bar app   Workspace app      shell / prompt / editor
        \                   |                  |                     /
         \__________ kunj <cmd> --json ________|____________________/
                            |              (kunj events --json: NDJSON stream)
                            v
                    kunj CLI (node dist/index.js)
                     |        |          |            |             |
                   git      gh/glab     tmux        docker      AWS Bedrock / Jira / Slack
               (worktrees) (PR lookup) (agents,   (branch        (AI commit / PR text,
                                       shells)    containers)    integrations)
                            |
                     ~/.kunj (config, registries, vault, per-repo state)
```

Frequently invoked commands skip the heavy imports through the [fast path](/architecture/fast-path.md).
Settings come from the [settings registry](/architecture/settings-registry.md) and the two-tier
[configuration](/architecture/configuration.md). Git is reached through the
[git layer](/architecture/git-layer.md); Docker only through the container backend
([Container Backend](/containers/backend.md)).

# ~/.kunj Layout

| Path | Written by | Contents |
|------|-----------|----------|
| `~/.kunj/config.json` | `kunj config --global` | Global config |
| `~/.kunj/repos.json` | `src/lib/repos.ts` | [Repository registry](/architecture/repo-identity-and-registry.md) |
| `~/.kunj/worktree-sessions.json` | `src/lib/worktree.ts` | [Editor sessions](/features/editor-sessions.md) |
| `~/.kunj/pr-cache.json` | `src/lib/worktree.ts` | [PR lookup cache](/features/pr-lookup-cache.md) |
| `~/.kunj/container-forwards.json`, `container-bridges.json` | container forward / MCP bridge | [Forwarding](/containers/forwarding.md), [MCP Bridge](/containers/mcp-bridge.md) |
| `~/.kunj/secrets.enc` | `kunj secret --global` | Global secrets ([Vault](/secrets/vault.md)) |
| `~/.kunj/hooks/`, `~/.kunj/presets/` | user | Global [hooks](/features/hooks.md) and [presets](/containers/presets.md) |
| `~/.kunj/<repo>/config.json` | `kunj config` | Per-repository config, shared by all worktrees |
| `~/.kunj/<repo>/branches.json` | `src/lib/metadata.ts` | [Branch metadata](/features/branch-metadata.md) |
| `~/.kunj/<repo>/work-logs/` | `src/lib/work-log.ts` | [Work logs](/features/work-log.md) |
| `~/.kunj/<repo>/keep/` | `src/lib/keep.ts` | [Keep files](/features/keep-files.md) |
| `~/.kunj/<repo>/hooks/` | user | Repository hooks |
| `~/.kunj/<repo>/secrets.enc` | `kunj secret` | Repo and branch secrets |
| `~/.kunj/<repo>/blueprint.json` | user | Host fallback [blueprint](/containers/blueprints.md) |
| `~/.kunj/<repo>/agent-state/` | Claude Code hooks kunj installs | Per-session agent state ([Worktree Agents](/features/worktree-agents.md)) |
| `~/.kunj/<repo>/workspace.json` | workspace app | UI layout only |

`<repo>` is the name `getKunjDir()` derives from the origin URL (see
[Configuration](/architecture/configuration.md)). Outside a git repository the per-repo directory is
`./.kunj`.

# Feature Areas

| Area | Commands | Docs |
|------|----------|------|
| Branches | `create`, `switch`, `list`, `delete`, `stash`, `diff`, `graph`, `branch-*` | [Branch Commands](/features/branch-commands.md), [Base Branch](/features/base-branch.md) |
| AI | `commit`, `pr`, `log` | [AI Commit](/features/ai-commit.md), [AI PR](/features/ai-pr.md), [Work Log](/features/work-log.md) |
| Integrations | `jira`, `issue`, `team`, `flow` | [Integrations](/features/integrations.md) |
| Worktrees | `worktree`, `agent`, `events`, `repos` | [Worktrees](/features/worktrees.md), [Events](/features/events-stream.md) |
| Containers | `container` / `ct` | [Containers Overview](/containers/overview.md) |
| Secrets | `secret`, `run` | [Secrets Overview](/secrets/overview.md) |
| Setup | `setup`, `install`, `config`, `completion`, `prompt-info`, `hooks`, `ui` | [Setup and Install](/features/setup-and-install.md), [Shell Integration](/features/shell-integration.md) |

# Related Concepts

* [Command System](/architecture/command-system.md)
* [Fast Path](/architecture/fast-path.md)
* [JSON Contract](/architecture/json-contract.md)
* [Release Process](/architecture/release-process.md)
* [Testing](/architecture/testing.md)

# Citations

[1] [CLAUDE.md](/CLAUDE.md)
[2] [package.json](/package.json)
[3] [src/index.ts](/src/index.ts)
[4] [src/commands/index.ts](/src/commands/index.ts)
[5] [src/lib/config.ts](/src/lib/config.ts)
[6] [src/lib/repos.ts](/src/lib/repos.ts)
[7] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[8] [scripts/copy-container-assets.js](/scripts/copy-container-assets.js)
[9] [ARCHITECTURE.md](/ARCHITECTURE.md)
