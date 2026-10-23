<!-- On-disk copy of the Claude Doc "Blueprints Spec" (https://claude.ai/artifact/FE8AfuYceDbFTguCDfWD86), rebuilt on 2026-10-23 from the edits made in Claude Code. Drawings are noted in italics. -->

# Blueprints Spec

2026-10-23 · Adrian Jones

## Goal and status

A repository describes once how to install itself, in `.kunj/blueprint.json`. kunj runs that install once in a sandbox and saves the result as an image (a snapshot). Every later branch container starts from that snapshot in seconds, with dependencies already installed. The model is Devin's setup steps plus a machine snapshot.

This document describes what is on `main` today (commit b998941). The design file in the repo (`docs/superpowers/specs/2026-10-22-blueprints-design.md`) predates Tasks 9 and 10 and will be brought up to date from this document.

| Area | State |
| --- | --- |
| Blueprint file, tools, presets, `init`, snapshots, `status`, `remove` | Shipped on main |
| `kunj ct start` builds or rebuilds the snapshot itself | Shipped on main |
| Private and SSH origins (host-made git bundle, no token in the container) | Shipped on main |
| Default zsh config and `KUNJ_*` env in containers | In progress (Task 11) |
| Lint, test and run commands; agent prompting; sidecar services | Not started (next phase) |

## How it works

<?claude block dia?>

The first start of a repo pays for `setup` once while the snapshot is built; every later branch starts from the snapshot in seconds. A resumed container skips all of this and only runs `maintain`.

## The blueprint file

The file is JSONC at `.kunj/blueprint.json`. It may only describe what runs inside the sandbox; nothing in it can widen the firewall, forward secrets or change the base image.

```jsonc
{
  "tools":     { "node": "22", "pnpm": "corepack", "playwright": "chromium" },
  "setup":     ["pnpm install --frozen-lockfile", "pnpm build"],
  "maintain":  ["pnpm install --frozen-lockfile"],
  "lockfiles": ["pnpm-lock.yaml"],
  "notes":     "free text shown by status"
}
```

| Key | Meaning |
| --- | --- |
| `tools` | Preset name → version or option (`true`, a string, or a list for `apt`). Installed as root before `setup`. Every word must match `[A-Za-z0-9][A-Za-z0-9._+:=~@-]*`. |
| `setup` | Shell commands run once, as the sandbox user in `/workspace`. First failure stops. |
| `maintain` | Run on every start after the seed, to absorb lockfile drift. Skipped right after `setup` in the same run. |
| `lockfiles` | Paths whose content is part of the hash. Default: the known lockfile names found at the repo root. |
| `notes` | Free text, shown by `status`. |

Unknown keys warn once and are ignored.

**Resolution order** (first match wins):

1. `--blueprint <path>` on `snapshot`/`status`.
2. `.kunj/blueprint.json` in the working tree kunj runs from (the host checkout, so the user controls it).
3. `.kunj/blueprint.json` on `origin/<default branch>`.
4. `~/.kunj/<repo>/blueprint.json` (a private, host-only copy).

**Hash.** The snapshot's identity is the first 12 hex characters of a sha1 over: the blueprint text, each lockfile's blob id at `origin/<default>`, the base image tag, and the content hash of every preset used (including `_lib.sh`). One helper, `computeBlueprintHash`, is used by both `start` and `snapshot`, so they always agree.

## Presets

A preset is one POSIX `sh` script that installs one tool. Presets are the only part of a blueprint that runs as root, and they always come from a file on disk, never from text in the blueprint.

| Preset | Value | Installs |
| --- | --- | --- |
| `apt` | `["jq", "postgresql-client"]` | Debian packages |
| `node` | `"22"`, `"22.12"`, `"lts"`, `"nvmrc"` | Official build into `/usr/local` |
| `yarn`, `pnpm` | `"corepack"` or a version | Via corepack, version from `packageManager` |
| `bun` | `true` or a version | Into `/usr/local` |
| `python` | `"3.12"` | CPython via `uv` |
| `go` | `"1.22"` | Official tarball |
| `rust` | `"stable"` | rustup, system-wide |
| `java` | `"21"` | Eclipse Temurin |
| `playwright` | `"chromium"` or `true` | Browsers + OS deps, matched to the project's Playwright version |
| `supabase` | `"latest"` or a version | Supabase CLI |

**Where presets come from** (first match wins): `.kunj/presets/<name>.sh` in the host checkout, then `~/.kunj/presets/<name>.sh`, then kunj's built-ins. A repo preset overrides a built-in and runs as root, so review it like a Dockerfile.

**Contract.** Each script sources the built-in `_lib.sh`, receives `KUNJ_TOOL_VERSION` and `KUNJ_TOOL_USER`, runs with `set -eu`, must be idempotent, installs outside the home directory (the home is a volume and is not in the snapshot), records environment variables with `kunj_env KEY=VALUE`, and ends with `kunj_done <version>`.

**Order.** `apt`, then language runtimes, then package managers, then `playwright` and `supabase`, then any custom preset in the order written.

## Commands and start behaviour

The normal flow is two commands: `kunj ct blueprint init` once, then `kunj ct start <branch>` as usual. Nothing else needs to be run.

```text
kunj ct blueprint init [--global] [--yes]    # infer a blueprint, confirm, write .kunj/blueprint.json
kunj ct start <branch> [-c] [--no-snapshot]  # builds the snapshot when needed, then starts from it
kunj ct blueprint status [--json]            # which file, hash, snapshot, stale or not
kunj ct blueprint snapshot [--rebuild] [--base <ref>] [--no-bundle]   # optional: build ahead of time or force
kunj ct blueprint remove                     # delete this repo's snapshot images
```

**What `start` does with a blueprint**, for a new container:

1. Resolves the blueprint and its hash.
2. If a snapshot with that hash exists, uses it.
3. If none exists, or the blueprint or a lockfile changed, builds one first ("Building blueprint snapshot (first use)…" or "Blueprint changed; rebuilding…").
4. If the build fails, warns and continues: with no snapshot, tools and `setup` run inside the container; with only a stale one, it starts from the stale one.
5. Starts the branch: copies the seed into the workspace, switches to the branch, runs `maintain`.

Resuming an existing container never builds; it only runs `maintain`. `--no-snapshot` skips the snapshot entirely.

**What `init` infers**: the package manager and install command from `packageManager` or the lockfile, a build step when a `build` script exists, `node` from `.nvmrc` or `engines` (omitted when the sandbox's Node 22 already satisfies it), Python, Go, Rust and Ruby from their usual files, `.tool-versions`, Playwright from dependencies, and the Supabase CLI from `supabase/config.toml`. For npm, `maintain` is `npm install` (cheap when nothing changed) rather than `npm ci`.

## Snapshots

A snapshot is an image named `kunj-blueprint-<repo>:<hash>`. kunj keeps one per repo and deletes older ones after a successful build.

**How one is built:**

1. The host fetches the default branch and makes a git bundle of it, using the host's own credentials. This is why private and SSH origins work.
2. A temporary sandbox starts behind the normal firewall, with no forwarded environment, no keep files and no published ports.
3. The bundle is streamed in and cloned; it is deleted again before the commit.
4. Presets run as root, then `setup` runs as the sandbox user.
5. The tree is copied to `/opt/kunj/seed`; the presets' environment becomes image `ENV`; the container is committed with labels for the repo, hash, commit, base image and user.
6. The temporary container, its helper, volumes and network are always removed.

**What is in the image:** the tools from presets, the seed tree at `/opt/kunj/seed`, and the image environment. **What is not:** any token or forwarded variable, the workspace and home volumes, the bundle.

**Starting from a snapshot** copies the seed into the new workspace volume, resets `origin` to the real URL, fetches and switches to the branch. Three small files guard this copy:

| File | Meaning |
| --- | --- |
| `.kunj-copying` | A copy is in progress; if found, the copy is redone. |
| `.kunj-fresh` | A complete copy that has not been switched to the branch yet. |
| `.kunj-seeded` | Seeding finished. |

A workspace that has a `.git` and no `.kunj-copying` is never wiped, so `git clean -fdx` or a missing marker cannot delete work.

## Security model

The blueprint on a branch can be edited by the agent, so the design assumes it is hostile. The host checkout and files under `~/.kunj` are trusted, because only the user writes them.

| The agent (or a hostile branch) can | It cannot |
| --- | --- |
| Change `setup`, `maintain` and `tools` values on its branch | Run anything as root except a preset file from disk |
| Make its own container's build fail | Inject options or commands through tool values (validated twice) |
| Write anything into its own workspace | Put a token into a snapshot (snapshots forward no environment) |
| Affect the snapshot only once its blueprint reaches the default branch or the user's checkout | Reach the host or LAN during setup (the firewall applies) |

Remaining trust points, by design:

- A repo's `.kunj/presets/*.sh` runs as root at snapshot time. It only comes from the user's own checkout.
- Image builds from a devcontainer Dockerfile run with full network access (warned about).
- `setup` commands run with internet access, so a malicious `setup` on the default branch can download anything into the snapshot.

## Worked examples

**kunj.** Committed on main. Snapshot built in 62 s; a branch start from it took 22 s before `maintain` changed to `npm install`.

```jsonc
{ "setup": ["npm ci", "npm run build"], "maintain": ["npm install"], "lockfiles": ["package-lock.json"] }
```

**driveday_planner.** In the working tree, not committed. The `@dday/edge` package is left out of the build because its vite config points at `../../../ideazone`, a sibling repo outside driveday.

```jsonc
{
  "tools": { "node": "22", "pnpm": "corepack", "playwright": "chromium", "supabase": "latest" },
  "setup": ["pnpm install --frozen-lockfile", "pnpm build --filter '!@dday/edge'"],
  "maintain": ["pnpm install --frozen-lockfile"],
  "lockfiles": ["pnpm-lock.yaml"]
}
```

**alertd-core.** No blueprint yet. `init` would propose Node 24, Yarn through corepack and Playwright. Its Postgres and Pulsar services need sidecar containers, which are not built.

## Known gaps and next phase

These are the open items. Comment on any you want to change or prioritise.

**Gaps in what shipped:**

- [ ] A stale snapshot is used without a hint when a branch's devcontainer base image differs from the default branch's.
- [ ] `supabase: latest` is not part of the hash, so a new CLI release never makes the snapshot stale.
- [ ] Snapshot images keep the temporary container's labels (not secret, overridden at start).
- [ ] The bundle is read fully into memory when streamed in; very large repos could hit memory limits.
- [ ] Private git submodules cannot be fetched during a snapshot.
- [ ] Two worktrees with different blueprint files rebuild each other's snapshot on alternate starts.
- [ ] Tool values cannot contain `_` (blocks some Rust toolchain names).

**Next phase, not started:**

- [ ] `lint`, `test` and `run` commands in the blueprint, with `kunj ct test`.
- [ ] Telling the agent about the blueprint (commands, notes) at the start of a session.
- [ ] Sidecar services (Postgres, Pulsar, Redis) per branch, needed by alertd-core and driveday's Supabase.
- [ ] Copying the safe parts of `~/.claude` into containers.
- [ ] Extra repos cloned next to the workspace (for setups like driveday's `../ideazone`).
- [ ] Rebuilding snapshots on a schedule or when a lockfile changes on origin.