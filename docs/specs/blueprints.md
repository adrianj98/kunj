# Blueprints

*Designed 2026-10-22, extended the same day (start builds the snapshot, private origins through a
host-made bundle); shipped. Checked against `main` on 2026-10-23. Builds on
[branch-containers.md](branch-containers.md).*

## Goal and status

A repository describes once how to install itself, in `.kunj/blueprint.json`. kunj runs that install
once in a sandbox and commits the result as an image (a snapshot); every later branch container starts
from it in seconds with dependencies installed. The model is Devin's setup steps plus a machine
snapshot. This phase is provisioning only: no lint, test or run commands and no agent prompting.

| Feature | Status |
| --- | --- |
| Blueprint file, resolution, hash, presets | Shipped |
| `kunj ct blueprint init`, `snapshot`, `status`, `remove` | Shipped |
| `kunj ct start` builds or rebuilds the snapshot itself | Shipped (2ee7853) |
| Private and SSH origins: snapshot from a host-made git bundle, no token in the container | Shipped (b18ee3d) |
| Blueprint `services` (sidecars) | Shipped with phase 2 ([container-phase-2.md](container-phase-2.md)) |
| `lint`, `test`, `run` commands and `kunj ct test`; telling the agent about the blueprint | Not started |
| Snapshot rebuilt on a schedule or when a lockfile changes on origin | Not started |
| Build-time secrets for private registries | Not started |

## Design

*Drawing: blueprint → presets and `setup` in a temporary sandbox → commit as
`kunj-blueprint-<repo>:<hash>` → each new branch container copies the seed and runs `maintain`.*

### The file

JSONC at `.kunj/blueprint.json`. The file can be edited by the agent on its branch, so it may only
describe what runs inside the sandbox: nothing in it can widen the firewall or forward secrets. It may
name the base image (`image`), as devcontainer.json already can; the firewall lives in the network
helper and the capabilities are dropped whatever the image, and an image it names is refused when it
runs as root, like a devcontainer's.

```jsonc
{
  "tools":     { "node": "22", "pnpm": "corepack", "playwright": "chromium", "apt": ["jq"] },
  "setup":     ["pnpm install --frozen-lockfile", "pnpm build"],
  "maintain":  ["pnpm install --frozen-lockfile"],
  "lockfiles": ["pnpm-lock.yaml"],
  "notes":     "free text shown by status",
  "image":     "sandbox",
  "services":  { "postgres": { "image": "postgres:16", "env": { "POSTGRES_PASSWORD": "dev" }, "port": 5432 } }
}
```

| Key | Meaning |
| --- | --- |
| `tools` | Preset name → `true`, a string, or a list (for `apt`). Installed as root before `setup`. Every word must match `TOOL_WORD`, `[A-Za-z0-9][A-Za-z0-9._+:=~@-]*`, so a value can never become an option or a path. |
| `setup` | Shell commands run once with `sh -lc` in `/workspace` as the sandbox user, in order; the first failure stops. |
| `maintain` | Run the same way on every start after the seed, to absorb lockfile drift; skipped right after `setup` in the same run. A failure is a warning. |
| `lockfiles` | Paths whose blob ids are part of the hash. Default: whichever known names exist at the repo root (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `go.sum`, `Cargo.lock`, `Gemfile.lock`, `requirements*.txt`). |
| `notes` | Free text, shown by `status`. |
| `image` | The base image: `sandbox` (kunj's own, ignoring any devcontainer.json) or an image reference (refused at start when it runs as root). Precedence: `--image`, then `image`, then `container.image`, then the devcontainer, then the sandbox. Naming it skips the devcontainer entirely, its compose services too. `blueprint init` writes `sandbox`, since the presets install onto it, and keeps the image of a file it overwrites. |
| `services` | Sidecar services; see [container-phase-2.md](container-phase-2.md). |

Unknown keys warn once and are ignored.

**Resolution**, first match wins: `--blueprint <path>` (on `snapshot` and `status`); the working tree
kunj runs from (user-controlled, so a blueprint works before it is pushed);
`origin/<default branch>:.kunj/blueprint.json`; `~/.kunj/<repo>/blueprint.json` (a private host copy).

**Hash.** `computeBlueprintHash()`, the one helper `start`, `snapshot`, `status` and `list` all call:
the first 12 hex chars of a sha1 over the blueprint text, each lockfile's blob id at `blueprintRef()`
(the blueprint's own ref, else `origin/<default>`, never the current worktree), the base image tag and
the content hash of every preset used (each includes `_lib.sh`). It is the snapshot's identity and its
staleness test.

### Presets

A preset is one POSIX `sh` script that installs one tool. Presets are the only part of a blueprint that
runs as root, and they always come from a file on disk, never from text in the blueprint. Lookup, first
found wins: `.kunj/presets/<name>.sh` in the host checkout, `~/.kunj/presets/<name>.sh`, then the
built-ins in `src/container/presets/` (copied to `dist`). Preset names are `[a-z0-9-]+`; an unknown name
fails naming the directories searched.

| Preset | Value | Installs |
| --- | --- | --- |
| `apt` | `["jq", "postgresql-client"]` | Debian packages |
| `node` | `"22"`, `"22.12"`, `"lts"`, `"nvmrc"` | Official build into `/usr/local`; `nvmrc` reads `.nvmrc`/`.node-version` |
| `python` | `"3.12"` | CPython through `uv` (installed too) |
| `go`, `rust`, `java` | version, `"stable"` for rust | Official tarball, rustup system-wide, Eclipse Temurin |
| `yarn`, `pnpm` | `"corepack"` or a version | Through corepack, version from `packageManager` |
| `bun` | `true` or a version | Official installer into `/usr/local` |
| `playwright` | `"chromium"` or `true` | Browsers and OS deps, matched to the project's Playwright |
| `supabase` | `"latest"` or a version | Supabase CLI |

**Contract.** A preset runs as root with `sh`, sources `_lib.sh`, gets `KUNJ_TOOL_NAME`,
`KUNJ_TOOL_VERSION` (`""` for `true`, lists joined by spaces) and `KUNJ_TOOL_USER`, re-checks its
words with `kunj_check_words`, must be idempotent, installs outside the home (a volume, not committed),
persists environment with `kunj_env KEY=VALUE` (into `/etc/kunj/env`, which becomes image `ENV` at
commit and `/etc/profile.d/kunj-tools.sh` for login shells) and ends with `kunj_done <version>`, which
writes the result kunj reads and prints `installed <name> <version>`.

**Order** (`PRESET_ORDER`): `apt`, `node`, `python`, `go`, `rust`, `java`, `yarn`, `pnpm`, `bun`,
`playwright`, `supabase`, then custom presets in the order written.

### Commands

```text
kunj ct blueprint init [--global] [--yes]       # infer, confirm, write .kunj/blueprint.json (or the host copy)
kunj ct start <branch> [-c] [--no-snapshot]     # builds the snapshot when needed, then starts from it
kunj ct blueprint status [--blueprint <path>]   # which file, hash, snapshot, stale or not
kunj ct blueprint snapshot [--rebuild] [--base <ref>] [--blueprint <path>] [--no-bundle]   # optional
kunj ct blueprint remove                        # delete this repo's snapshot images
```

All take `--json`. The normal flow is `init` once, then `start` as usual.

**`init`** inspects the host checkout (no fetch): the package manager and install command from
`packageManager` or the lockfile (`npm ci`, `yarn install --immutable`, `pnpm install
--frozen-lockfile`, `bun install --frozen-lockfile`), a build step when a `build` script exists;
`node` from `.nvmrc`/`.node-version` (`nvmrc`) or `engines.node` (the lowest satisfying major, omitted
when the sandbox's Node 22 satisfies it); Python (`poetry install`, `uv sync` or `pip install -r`), Go
(`go mod download`), Rust (`cargo fetch`), Ruby (`bundle install`, no preset), `.tool-versions`, the
Playwright dependency and `supabase/config.toml`; a Makefile `setup`/`install` target is mentioned as
an alternative. `maintain` is the install commands without the build, with `npm install` instead of
`npm ci` (which reinstalls from scratch on every start). Each proposal is shown with its reason and can
be edited; `--yes` accepts and overwrites. Nothing recognised writes a template. It never commits.

**`start` with a blueprint**, for a new container (not `--image`, not `--no-snapshot`):

1. Resolve the blueprint and its hash.
2. A snapshot with that hash exists: use it.
3. None, or the blueprint, a lockfile, a preset or the base image changed: build one first
   ("Building blueprint snapshot (first use)…" / "Blueprint changed; rebuilding…").
4. The build fails: warn and fall back to the stale snapshot when there is one, else to tools and
   `setup` inside the new container. A start never fails only because a snapshot could not be made.
5. Copy the seed into the workspace, move the branch to origin's, run `maintain`.

Resuming never builds; it runs `maintain`. Per new start the order is seed → keep files → presets and
`setup` (only without a snapshot, also on a kept workspace volume) → `maintain` (not right after
`setup`) → `postCreateCommand` once → `postStartCommand`.

### Snapshots

`kunj-blueprint-<repo>:<hash>`, one per repo: older ones are deleted after a successful build.

**Building one** (src/lib/container/snapshot.ts):

1. The host fetches the default branch (or `--base`) with its own credentials and bundles it as the one
   ref `refs/heads/<branch>` (`makeBranchBundle()`). This is why private and SSH origins work.
2. A temporary container is an ordinary `startContainer` with `namesFor: '<branch>:snapshot'` and no
   forwarded env, keep files, copied files, published ports, `forwardPorts`, hooks or agent; it runs
   behind the normal firewall (setup has the internet, not the host or LAN), and the blueprint's
   services start next to it. With Docker-in-Docker on, the DinD image is used but `dockerd` never runs
   and there is no docker volume.
3. The bundle is streamed in as the sandbox user to `/tmp/kunj-origin.bundle`, cloned
   (`seedScript({ bundlePath })`: `origin` reset to the real URL, no fetch, submodules from their own
   URLs) and removed before the commit. `--no-bundle` clones origin instead (public origins only).
4. Presets as root, then `setup` as the sandbox user, then the devcontainer's post commands.
5. `/workspace` is copied to `/opt/kunj/seed` as root (without the seed markers) and the container is
   committed with the presets' environment as `ENV` and labels `kunj.repo`,
   `kunj.blueprint.{hash,ref,base,user,createdAt}` (`ref` is the commit snapshotted).
6. The temporary container, helper, services, volumes and network are always removed; leftovers of an
   interrupted run are removed before the next build.

**In the image:** the tools, the seed tree, the environment. **Not in it:** any token or forwarded
variable, the workspace and home volumes, the bundle, `/var/lib/docker`.

**Starting from a snapshot** copies the seed into the new workspace volume, resets `origin`, fetches
and moves the branch to origin's. Three sentinel files in `/workspace`, all in `.git/info/exclude`,
make the copy safe to interrupt:

| File | Meaning |
| --- | --- |
| `.kunj-copying` | A copy is in progress. Only then may `/workspace` be wiped and recopied. |
| `.kunj-fresh` | A complete copy whose branch must still be moved to origin's; removed once it is. |
| `.kunj-seeded` | The seed finished (never in a snapshot). |

A workspace with a `.git` and no `.kunj-copying` is never wiped, so `git clean -fdx` or a lost marker
cannot delete work. The snapshot image layer is read-only, so the agent cannot change another branch's
seed.

**Image choice.** A snapshot of the repo is used when its hash matches; otherwise the newest one is used
and marked stale (still faster than a clone and `setup`). `list --json` reports
`imageInfo.kind: "blueprint"` and `blueprint: { hash, stale }`. A devcontainer base is part of the hash,
so changing its Dockerfile invalidates the snapshot.

### Security model

The blueprint on a branch is assumed hostile. The host checkout and files under `~/.kunj` are trusted,
because only the user writes them.

| The agent (or a hostile branch) can | It cannot |
| --- | --- |
| Change `setup`, `maintain`, `tools` values and `services` on its branch | Run anything as root except a preset file from disk |
| Make its own container's build fail | Inject options or commands through tool values (validated twice) |
| Write anything into its own workspace | Put a token into a snapshot (snapshots forward no environment) |
| Affect the snapshot only once its blueprint reaches the default branch or the user's checkout | Reach the host or LAN during setup (the firewall applies) |

Remaining trust points, by design: a repo's `.kunj/presets/*.sh` runs as root at snapshot time (only
from the user's own checkout; review it like a Dockerfile); devcontainer Dockerfile builds have full
network access; `setup` has internet access, so a malicious `setup` on the default branch can put
anything into the snapshot.

### Worked examples

**kunj** (committed): `{ "setup": ["npm ci", "npm run build"], "maintain": ["npm install"],
"lockfiles": ["package-lock.json"] }`. Node 22 comes from the sandbox image. Snapshot built in 62 s;
`maintain` was changed from `npm ci` to `npm install` because `npm ci` took ~16 s on every start.

**driveday_planner** (in the working tree, not committed): `node 22`, `pnpm` through corepack,
`playwright: chromium`, `supabase: latest`; `setup` builds with `--filter '!@dday/edge'` because that
package's vite config points at `../../../ideazone`, a sibling repo outside driveday.

**alertd-core** (no blueprint yet): `init` would propose Node 24, Yarn through corepack and Playwright;
its Postgres and Pulsar now fit blueprint `services` or its compose file.

## Decisions

- **Where it lives** (2026-10-22): `.kunj/blueprint.json` in the repo, else the host copy; later the
  working tree was put first so a blueprint works before it is pushed.
- **Trust**: the file may only describe commands inside the sandbox; root only through presets on disk.
- **Snapshot as an image** with the tree copied to `/opt/kunj/seed`; no sharing between branches, each
  start copies the seed into its own volume.
- **No secrets at snapshot time**: private registries are a documented limit.
- **`start` builds the snapshot itself** (2026-10-22): the user never has to run `snapshot`; a failed
  build falls back rather than failing the start.
- **Snapshots clone a host-made bundle** (2026-10-22): no token ever enters a snapshot container;
  `--no-bundle` is the escape hatch, and with a bundle `start` skips the SSH `no-token` refusal and the
  unpushed gate.
- **One hash helper** for every command, lockfiles at origin's default branch, never the worktree.
- **The agent does not see the blueprint** in this phase.
- **devcontainer `postCreateCommand` in the snapshot** (settled by the code): it runs in the snapshot
  container after `setup`, and once more in each new container, because its marker lives in the home
  volume.

## Open questions and known gaps

- A stale snapshot is used without a hint when a branch's devcontainer base image differs from the
  default branch's.
- `supabase: latest` hashes the word, not the resolved version, so a new CLI release never makes the
  snapshot stale.
- Snapshot images keep the temporary container's own labels (not secret, overridden at start).
- The bundle is read fully into memory when streamed in; very large repos could hit limits.
- Private git submodules cannot be fetched during a snapshot.
- Two worktrees with different blueprint files rebuild each other's snapshot on alternate starts
  (one snapshot per repo).
- Tool values cannot contain `_` (blocks some Rust toolchain names).
- Next phase: `lint`/`test`/`run` and `kunj ct test`; telling the agent about the blueprint; devcontainer
  `customizations.kunj`; build-time secrets; rebuilding on a schedule or on lockfile change.

## Code map

| File | Role |
| --- | --- |
| `src/lib/container/blueprint.ts` | Parse and validate, resolve, hash, tags, labels |
| `src/lib/container/presets.ts`, `src/container/presets/` | Preset lookup, order, running; the built-in scripts and `_lib.sh` |
| `src/lib/container/infer.ts` | `blueprint init` |
| `src/lib/container/provision.ts` | Find a snapshot; presets and `setup` on a new container; `maintain` |
| `src/lib/container/snapshot.ts` | Build, `ensureSnapshot()` for start, status, remove, the bundle |
| `src/lib/container/seed.ts` | `seedScript({ seedFrom, bundlePath })` and the sentinels |
| `src/commands/container.ts` | The `blueprint` sub-actions and the snapshot step of `start` |
| `.kunj/blueprint.json` | kunj's own blueprint |

`npm run test:docker` covers the snapshot (labels, `jq` from the apt preset, seed contents, no secret
ENV), a snapshot via the bundle (no `git clone git://` exec, seed HEAD is origin's), a start from it (no
clone, `maintain` ran, origin URL), the stale hint, `--no-snapshot`, a failing `setup` leaving nothing
behind, and `removeSnapshots`.
