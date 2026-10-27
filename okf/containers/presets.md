---
type: Container
title: Blueprint Presets
description: Root-run POSIX sh tool installers named by a blueprint's tools, found in the repo, the host or kunj's built-ins, sharing _lib.sh.
resource: src/lib/container/presets.ts
tags: [container, blueprint, presets, provisioning]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Each key of a [blueprint](/containers/blueprints.md)'s `tools` names a preset: a `<name>.sh` POSIX sh
script that installs one tool as root inside the container, behind the firewall. Presets run during a
[snapshot](/containers/snapshots.md) build, or in a new container that has no snapshot. They source the
shared `_lib.sh` and must end with `kunj_done <version>`, which is how kunj learns what was installed.

`src/lib/container/presets.ts` finds, orders, hashes and runs them; the built-ins live in
`src/container/presets/` and are copied to `dist/container/presets` by the build
(`builtinPresetsDir()`).

# Lookup and order

`resolvePresets()` validates each name (`^[a-z0-9-]+$`) before any path join, then takes the first
`<name>.sh` found in:

| Order | `source` | Directory |
| --- | --- | --- |
| 1 | `repo` | `<repoRoot>/.kunj/presets/` (the host checkout, not origin) |
| 2 | `host` | `~/.kunj/presets/` |
| 3 | `builtin` | `src/container/presets/` |

An unknown name throws. `orderTools()` runs them in `PRESET_ORDER` (`apt`, `node`, `python`, `go`,
`rust`, `java`, `yarn`, `pnpm`, `bun`, `playwright`, `supabase`), then any others in blueprint order.
`presetHash()` is 12 hex of sha1 over the built-in `_lib.sh` and the preset's text; these hashes feed
`computeBlueprintHash()`, so editing a preset or `_lib.sh` makes the snapshot stale.

# Built-in presets

| Preset | Installs | Example value |
| --- | --- | --- |
| `apt` | Debian/Ubuntu packages | `["jq", "postgresql-client"]` |
| `node` | official Node.js build into `/usr/local`; sets `COREPACK_HOME` | `"24"`, `"22.12.0"`, `"lts"`, `"nvmrc"` |
| `python` | a CPython via uv, plus uv | `"3.12"` |
| `go` | official tarball into `/usr/local/go` | `"1.22"` |
| `rust` | rustup toolchain, system-wide | `"stable"`, `"1.80"` |
| `java` | Eclipse Temurin JDK | `"21"` |
| `yarn`, `pnpm` | via corepack | `"corepack"` (reads `packageManager`), `"4.6.0"` |
| `bun` | official installer into `/usr/local` | `true`, `"1.2.5"` |
| `playwright` | browsers and OS deps, matching the project's `@playwright/test` | `"chromium"`, `true` |
| `supabase` | the Supabase CLI into `/usr/local/bin` | `"latest"` |

Each script's header names the domains it needs under `container.network.allow` in allowlist mode.

# Running

`runPresets()`:

1. Streams a tar of `_lib.sh`, each `<name>.sh` (0755) and `<name>.env` (0600) into `PRESET_DIR`
   (`/tmp/kunj-presets`, mode 700) as root.
2. For each preset runs `WRAPPER` as root: `cd`, remove a stale `<name>.result`, source `<name>.env`
   with `set -a`, `exec sh <name>.sh`. The env goes through a file, not `exec -e`, so it is not in `ps`.
3. A non-zero exit throws `preset <name> failed`. It then reads `<name>.result` (`<name> <version>`);
   a missing result is a warning with an empty version.
4. Always removes `PRESET_DIR`, so scripts never reach the committed snapshot.

`presetEnv()` gives each preset:

| Variable | Value |
| --- | --- |
| `KUNJ_TOOL_NAME` | preset name |
| `KUNJ_TOOL_VERSION` | the tool value; `""` for `true`, arrays joined by spaces |
| `KUNJ_TOOL_USER` | the sandbox user |

# `_lib.sh`

| Helper | Purpose |
| --- | --- |
| `kunj_env KEY=VALUE` | records in `/etc/kunj/env` (`KUNJ_ENV_FILE`) and regenerates `/etc/profile.d/kunj-tools.sh` with single-quoted exports; the snapshot turns `/etc/kunj/env` into image `ENV` |
| `kunj_arch`, `kunj_arch_node`, `kunj_arch_deb` | architecture names for download URLs; fail on unsupported machines |
| `kunj_tree` | `/opt/kunj/seed` during a snapshot, else `/workspace` |
| `kunj_check_words <BRE>` | second validation of every word of `KUNJ_TOOL_VERSION` (after `TOOL_WORD` in blueprint.ts) |
| `kunj_need <cmd>` | fail when the image lacks a command |
| `kunj_need_pkg <cmd> [pkg]` | apt-get install `pkg` (default `cmd`) when the command is missing, then `kunj_need`; bun uses it for `unzip` |
| `kunj_done <version>` | writes `<name>.result` and prints `installed <name> <version>` |

Presets must install outside the home (`$KUNJ_PREFIX`, default `/usr/local`, or `/opt`): the home is a
volume and is not part of `docker commit`. `KUNJ_PREFIX`, `KUNJ_ENV_FILE`, `KUNJ_PROFILE_DIR` and
`KUNJ_RESULT_DIR` are overridable for unprivileged tests only.

A repo's `.kunj/presets/*.sh` runs as root at snapshot time, but only from the user's own checkout;
review it like a Dockerfile.

# Related Concepts

* [Blueprints](/containers/blueprints.md) - `tools`, `TOOL_WORD`, the hash
* [Snapshots](/containers/snapshots.md) - where presets normally run, `envChanges()`
* [Network helper and firewall](/containers/network-helper-firewall.md) - allowlist mode
* [Images](/containers/images.md) - `copy-container-assets.js`

# Citations

[1] [src/lib/container/presets.ts](/src/lib/container/presets.ts)
[2] [src/container/presets/_lib.sh](/src/container/presets/_lib.sh)
[3] [src/container/presets/node.sh](/src/container/presets/node.sh)
[4] [src/lib/container/provision.ts](/src/lib/container/provision.ts)
[5] [src/lib/container/blueprint.ts](/src/lib/container/blueprint.ts)
[6] [docs/specs/blueprints.md](/docs/specs/blueprints.md)
