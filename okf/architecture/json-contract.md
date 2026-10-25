---
type: Architecture
title: JSON Contract
description: The published, type-only JSON contract of `kunj ... --json` in src/lib/json-types.ts, its consumers, the error shapes and the additive-only compatibility rule.
resource: src/lib/json-types.ts
tags: [architecture, json, contract, api, compatibility]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The VS Code extension, the macOS menu bar app and the workspace app never import kunj; they run
`kunj <command> --json` and parse stdout. `src/lib/json-types.ts` declares those output shapes as
TypeScript types. It has type-only imports and no runtime code, so fast-path commands import it freely.

The file is the npm package's `types` entry (`"types": "./dist/lib/json-types.d.ts"` in
`package.json`), so a TypeScript consumer can `import type { WorktreeListJson } from 'kunj'`.

Commands build their output against these types with `satisfies` (or a type annotation), so the
compiler fails when output and contract drift. `src/lib/__tests__/json-types.test.ts` and
`json-types.contract.test.ts` are type-level checks that fail to compile when fields disappear.

# Compatibility Rule

Fields are only ever **added**, never renamed or removed. The workspace app accepts kunj from
`MIN_KUNJ_VERSION` 1.3.0 (`workspace-app/Sources/KunjWorkspaceCore/CLI/Version.swift`), so any JSON or
command change it relies on must stay additive. New fields are made optional when older output lacks
them.

# Types

| Type | Command |
|------|---------|
| `WorktreeListJson` (`worktrees: WorktreeJson[]`, `pullRequestLookup`, `pullRequestsFromCache`, `containers?`) | `kunj worktree list --json` |
| `WorktreeListContainersJson`, `BranchContainerJson` | `worktree list --containers`: `{ available, message?, items }` |
| `ReposJson` / `RepoJson` (`KnownRepoInfo` + `kunjName`) | `kunj repos --json` |
| `ContainerListJson` / `ContainerJson` / `ContainerPortJson` | `kunj ct list --json` |
| `FileReadJson`, `FileWriteJson` | `kunj ct file read\|write --json` |
| `ContainerTokenStatusJson` (`github: { source: 'env'\|'gh'\|null, enabled }`) | `kunj ct token status --json` |
| `AgentStatusJson`, `AgentStopJson` | `kunj agent status\|stop --json` |
| `AgentState`, `AgentSessionJson` | The `agent` field of worktrees; one entry per tmux session |
| `ShellKillJson` (`{ killed }`) | `kunj worktree shell --kill`, `kunj ct shell --kill` |
| `EventJson` | Each NDJSON line of `kunj events --json` |
| `SecretListJson`, `SecretWriteJson`, `SecretImportJson`, `SecretApplyJson` | `kunj secret list\|set\|rm\|import\|apply --json` (never a value) |
| `ErrorJson` | Any failure in `--json` mode |

Shapes in detail live with their features: [Worktrees](/features/worktrees.md),
[Env and Status](/containers/env-and-status.md), [Events Stream](/features/events-stream.md),
[Worktree Agents](/features/worktree-agents.md), [Secrets Overview](/secrets/overview.md).

## EventJson

```ts
type EventJson = { at: string } & (
  | { type: 'hello'; version: string; repos: number }
  | { type: 'git' | 'sessions' | 'forwards' | 'repos'; repo?: { name: string; root: string } }
  | { type: 'container'; repo: {...} | null; branch: string | null; container: string; action: string }
  | { type: 'agent'; session: string; running: boolean; state?: 'running' | 'waiting' | null; repo?: {...} }
  | { type: 'backend'; status: 'available' | 'unavailable'; message?: string }
);
```

Each event says what to refresh, not what changed. A first line that is not `hello` is an `ErrorJson`.

# Error Shapes

```ts
interface ErrorJson { error: string | { code: string; message: string } }
```

| Command | Shape |
|---------|-------|
| `kunj ct ...` | Always `{ error: { code, message } }`: `StartError.code`, `hook` for a `HookError`, the error's `jsonCode`, else `error` |
| Others (via `BaseCommand`) | `{ error: { code, message } }` when the error has a string `jsonCode` (`AgentError`, `SecretError`, `EventsError` `not-a-repo`, `ContainerError`), else `{ error: "<message>" }` |

Errors go to stdout with exit code 1, so a consumer reads one JSON document either way
([Command System](/architecture/command-system.md)).

# Output Hygiene

* `--json` sets `chalk.level = 0` in `src/index.ts`, even when `FORCE_COLOR` is inherited.
* `BaseCommand.log()` is silent in JSON mode; `outputJSON()` pretty-prints.
* Hooks run in JSON mode have stdout redirected to stderr and stdin closed ([Hooks](/features/hooks.md)).

# Related Concepts

* [Command System](/architecture/command-system.md)
* [VS Code Extension](/apps/vscode-extension.md), [macOS App](/apps/macos-app.md), [Workspace App](/apps/workspace-app.md)
* [Fast Path](/architecture/fast-path.md)

# Citations

[1] [src/lib/json-types.ts](/src/lib/json-types.ts)
[2] [package.json](/package.json)
[3] [src/lib/command.ts](/src/lib/command.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [src/index.ts](/src/index.ts)
[6] [src/lib/__tests__/json-types.test.ts](/src/lib/__tests__/json-types.test.ts)
[7] [src/lib/__tests__/json-types.contract.test.ts](/src/lib/__tests__/json-types.contract.test.ts)
[8] [workspace-app/Sources/KunjWorkspaceCore/CLI/Version.swift](/workspace-app/Sources/KunjWorkspaceCore/CLI/Version.swift)
[9] [CLAUDE.md](/CLAUDE.md)
