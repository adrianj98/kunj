---
type: Container
title: Blueprints
description: The .kunj/blueprint.json file that says how a new branch container is set up (tools, setup, maintain, lockfiles, services), its resolution, validation and hash.
resource: src/lib/container/blueprint.ts
tags: [container, blueprint, provisioning]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A repository describes once how to install itself in `.kunj/blueprint.json` (`BLUEPRINT_PATH`). kunj
runs that install once in a sandbox and commits the result as a [snapshot](/containers/snapshots.md)
image; later branch containers start from it with dependencies installed. Tools are installed by
[presets](/containers/presets.md). This is provisioning only: there are no lint, test or run commands.

`blueprint.ts` parses, validates, resolves and hashes the file; `infer.ts` writes a first version
(`kunj ct blueprint init`); `provision.ts` runs it in a container. The blueprint on a branch is treated
as hostile; the host checkout and `~/.kunj` are trusted.

# The file

```json
{ "tools": { "node": "nvmrc", "pnpm": "corepack", "apt": ["jq"] },
  "setup": ["pnpm install --frozen-lockfile", "pnpm build"],
  "maintain": ["pnpm install --frozen-lockfile"],
  "lockfiles": ["pnpm-lock.yaml"], "notes": "…", "services": { … } }
```

| Key | Rule (`parseBlueprint()`, JSONC via `parseJsonc()`) |
| --- | --- |
| `tools` | object; keys `^[a-z0-9-]+$` (preset names); value a string, string array or `true`; every word must match `TOOL_WORD` (no leading `-`, no `/`, no whitespace or shell metacharacters) |
| `setup` | non-empty strings; run once as the sandbox user with `sh -lc` in `/workspace` (snapshot, or a new container without one) |
| `maintain` | same; run on every start except one that just ran `setup`; a failure is a warning |
| `lockfiles` | paths for the hash; default `KNOWN_LOCKFILES` plus root `requirements*.txt` |
| `notes` | free text, shown by `blueprint status`, kept by `init` |
| `services` | [sidecar services](/containers/services.md), highest precedence |

Unknown keys are kept in `ignoredKeys` and printed by `status`.

# Resolution

`resolveBlueprint()` returns a `ResolvedBlueprint` with `source`:

| Order | `source` | Where |
| --- | --- | --- |
| 1 | `file` | `--blueprint <path>` |
| 2 | `worktree` | `<repoRoot>/.kunj/blueprint.json` of the working tree kunj runs in |
| 3 | `repo` | `git show origin/<default>:.kunj/blueprint.json` (sets `ref`) |
| 4 | `host` | `~/.kunj/<repo>/blueprint.json` |

# Hash

`computeBlueprintHash()` is the only hash: sha1 (12 hex) over the blueprint text, each lockfile's blob
id at `blueprintRef()` (the blueprint's `ref`, else `origin/<default>`, else `HEAD`; never the current
worktree), the base image tag and the presets' content hashes. Start, `snapshot`, `status`, `list` and
[prune](/containers/prune.md) all use it (via `planSnapshot()` in the commands), so they agree.
`snapshotTag()` = `kunj-blueprint-<repo>:<hash>` (`SNAPSHOT_REPO`); `blueprintLabels()` sets
`kunj.repo` and `kunj.blueprint.{hash,ref,base,user,createdAt}`.

# Commands

| Command | Behaviour |
| --- | --- |
| `kunj ct blueprint init [--global] [--yes]` | `inferBlueprint()` on the checkout, prints its reasons, prompts for tools/setup/maintain (TTY), validates, writes `.kunj/blueprint.json` (or `~/.kunj/<repo>/blueprint.json` with `--global`); refuses to overwrite without `--yes` or confirmation; keeps existing `notes` |
| `kunj ct blueprint status [--base] [--blueprint]` (default) | source, path, hash, current snapshot or stale/none, notes, ignored keys; `--json`: `{ source, path, hash, snapshot, stale, others, notes }` |
| `kunj ct blueprint snapshot` | build ahead of time; see [snapshots](/containers/snapshots.md) |
| `kunj ct blueprint remove` | `removeSnapshots()`; `--json`: `{ removed }` |

`kunj ct list --json` gives blueprint containers `blueprint: { hash, stale }`.

# Inference

`inferBlueprint(repoRoot, imageNodeMajor = 22)` reads the checkout:

| Signal | Result |
| --- | --- |
| `packageManager` or a lockfile | install command (`npm ci`, `yarn install --immutable` / `--frozen-lockfile` for classic, `pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`); yarn/pnpm via `corepack`, bun preset; `build` script added to setup |
| npm | maintain uses `npm install` (`npm ci` would reinstall every start) |
| `.nvmrc` / `.node-version` | `node: nvmrc`; else `engines.node` not satisfied by the image's node gives its lowest major |
| playwright in deps / `supabase/config.toml` | `playwright: true` / `supabase: latest` |
| `pyproject.toml` | `poetry install` or `uv sync`; else `pip install -r requirements.txt`; python version from `.python-version` or `requires-python` |
| `go.mod`, `Cargo.toml`, `rust-toolchain(.toml)`, `Gemfile` | `go mod download` + go version, `cargo fetch`, rust channel, `bundle install` |
| `.tool-versions` | asdf names mapped to presets when not already set |
| `Makefile` `setup`/`install` target | a hint only |

# Related Concepts

* [Presets](/containers/presets.md) - what `tools` runs
* [Snapshots](/containers/snapshots.md) - building and using the image
* [Services](/containers/services.md) - the `services` key
* [Lifecycle](/containers/lifecycle.md) - where provisioning sits in a start
* [Seed](/containers/seed.md) - cloning and the snapshot copy

# Citations

[1] [src/lib/container/blueprint.ts](/src/lib/container/blueprint.ts)
[2] [src/lib/container/infer.ts](/src/lib/container/infer.ts)
[3] [src/lib/container/provision.ts](/src/lib/container/provision.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [docs/specs/blueprints.md](/docs/specs/blueprints.md)
[6] [CLAUDE.md](/CLAUDE.md)
