# Blueprints — design

*2026-10-22. Kunj CLI (`kunj container blueprint`). Builds on docs/superpowers/specs/2026-10-21-branch-containers-design.md (phase 1 shipped on `feature/branch-containers`).*

## Goal

A repository describes, once, how to install itself; kunj runs that once in a sandbox, snapshots the
result as an image, and every new branch container starts from the snapshot in seconds with
dependencies already installed. Modelled on Devin's setup steps + machine snapshot. Phase 1 of this
feature is **provisioning only**: no lint/test/run commands and no agent prompting.

## Decisions

| Question | Decision |
|---|---|
| Where the blueprint lives | `.kunj/blueprint.json` in the repo (read from `origin/<default branch>`), else `~/.kunj/{repo}/blueprint.json`. The repo copy wins. |
| Trust | The file is agent-editable, so it may only describe commands that run inside the sandbox. Nothing in it can widen the firewall, forward secrets or change the image. |
| Snapshot | Yes: `kunj ct blueprint snapshot` runs `setup` in a temporary sandbox and commits the container as `kunj-blueprint-<repo>:<hash>`, with the tree copied to `/opt/kunj/seed`. |
| Secrets at snapshot time | None are forwarded (`env: []`, no keep files), so a snapshot never contains a token. Private registries are a documented limit. |
| Sharing between branches | None: each start copies the seed into its own workspace volume. |
| Init | `kunj ct blueprint init` infers commands from the repo and confirms each interactively. |
| Agent | Does not see the blueprint (provisioning only). |

## The file

```jsonc
{
  "tools":     { "node": "24", "yarn": "corepack", "apt": ["jq"] },   // system dependencies, installed by presets as root at snapshot time
  "setup":     ["yarn install --immutable", "yarn build"],            // run once in /workspace during snapshot (or after a clone when there is no snapshot)
  "maintain":  ["yarn install --immutable"],                          // run on every start after the seed, to absorb lockfile drift
  "lockfiles": ["yarn.lock"],                                         // optional; default = the known names found at the repo root
  "notes":     "Docker tests: npm run test:docker"                    // free text shown by `status`; unused otherwise
}
```

- `tools` maps a **preset name** to a version or option. Presets are the extension point (below). They
  run as root inside the temporary snapshot container, behind the firewall, before `setup`; they are
  the blueprint's answer to "install node 24" without a Dockerfile.
- `setup` and `maintain` are arrays of shell commands run with `sh -lc` in `/workspace` as the sandbox user, in order; the first failure stops the step.
- `lockfiles` are paths relative to the repo root. Known names: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements*.txt`, `go.sum`, `Cargo.lock`, `Gemfile.lock`.
- Unknown keys warn once and are ignored (forward compatibility).
- Parsed as JSONC with the existing `parseJsonc`.

**Resolution** (`resolveBlueprint(repo, ref)`): `git show origin/<default>:.kunj/blueprint.json` (default branch via `detectDefaultBranch()`); if absent, `~/.kunj/{repo}/blueprint.json`; if neither, no blueprint (start behaves as today). `--blueprint <path>` on `snapshot` overrides for one run.

**Hash** (`blueprintHash`): sha1 of the blueprint text + each lockfile's blob id at `origin/<default>` (`git rev-parse origin/<default>:<path>`, skipped when absent) + the base image tag + the content hash of every preset the blueprint uses; first 12 hex chars. It is the snapshot's identity and its staleness test.

## Presets (the extension point)

A preset is a POSIX `sh` script that installs one tool for a requested version. Kunj ships presets in
`src/container/presets/<name>.sh` (copied to `dist/container/presets`); users add their own in
`~/.kunj/presets/<name>.sh` (host) or `.kunj/presets/<name>.sh` (repo). Resolution: repo → host → built-in,
so a repo can override `node` if it must. Each script receives `KUNJ_TOOL_VERSION` (the value from
`tools`, `""` for `true`) and `KUNJ_TOOL_USER` (the sandbox user), runs as root with `set -eu`, must be
idempotent, and must print one line `installed <name> <resolved version>` at the end so `status` and the
summary can show it.

Built-in presets for phase 1 — the ones `init` can infer:

| Preset | Value | What it does |
|---|---|---|
| `node` | `"24"`, `"22.12"`, `"lts"`, `"nvmrc"` | Official tarball for the exact or latest-matching version into `/usr/local`; replaces the image's node. `"nvmrc"` reads `.nvmrc` / `.node-version` from the seed. |
| `yarn` / `pnpm` | `"corepack"` or a version | `corepack enable` + `corepack prepare <pm>@<version> --activate` (reads `packageManager` from package.json when `corepack`). |
| `bun` | version or `true` | Official installer into the user's home. |
| `python` | `"3.12"` | `uv python install <v>` plus `uv` itself; `pip` via `uv pip`. |
| `go`, `rust`, `java` | version | Official tarballs / rustup / Temurin. |
| `apt` | `["jq", "postgresql-client"]` | `apt-get install` of the listed packages. |
| `playwright` | `"chromium"` or `true` | `npx playwright install --with-deps <browsers>` (needs node). |

Order: `apt` first, then language runtimes in the order written, then package managers, then anything else. Unknown preset names are an error at `snapshot` (not at `start`), naming the three directories searched.

**Inference** (`init`): `.nvmrc` / `.node-version` → `node: "nvmrc"`; `engines.node` → the lowest satisfying major (`>=24.2` → `"24"`); `packageManager: yarn@4.6.0` → `yarn: "corepack"`; `.python-version` / `requires-python` → `python`; `go.mod`'s `go 1.22` → `go: "1.22"`; `rust-toolchain(.toml)` → `rust`; `.tool-versions` (asdf) → each line; `@playwright/test` in dependencies → `playwright: true`.

Without a snapshot (fresh clone), `start` runs the presets too (as root, before `setup`) so the blueprint works even before anyone snapshots; it is just slow. Presets are the only thing in the blueprint that runs as root, which is why they are kunj-shipped scripts or files the user put on disk, never inline commands from the blueprint itself.

## Commands

```text
kunj ct blueprint init [--global] [--yes]     # infer, confirm, write .kunj/blueprint.json (or ~/.kunj/{repo}/blueprint.json)
kunj ct blueprint snapshot [--base <ref>] [--blueprint <path>] [--json]
kunj ct blueprint status [--json]             # which file, hash, snapshot tag/date, stale or not
kunj ct blueprint remove                      # delete the snapshot image(s) for this repo
kunj ct start … [--no-snapshot]               # ignore the snapshot for one start
```

Kept under `kunj ct` so it shares the command's context, backend and `--json` conventions; implemented as a sub-dispatcher like `kunj worktree keep`.

### init

1. Inspect the host checkout (cwd's repo root, current HEAD — no fetch): detect package manager from `packageManager` in package.json or the lockfile present → `npm ci` / `yarn install --immutable` / `pnpm install --frozen-lockfile` / `bun install --frozen-lockfile`; add `npm run build` (or the manager's equivalent) when a `build` script exists; `pyproject.toml` with `[tool.poetry]` → `poetry install`, with `uv.lock` → `uv sync`, else `requirements.txt` → `pip install -r requirements.txt`; `go.mod` → `go mod download`; `Cargo.toml` → `cargo fetch`; `Gemfile` → `bundle install`; a `Makefile` with a `setup` or `install` target → `make <target>` offered as an alternative.
2. `maintain` defaults to the install command(s) without the build.
3. Show each proposed command; inquirer lets the user edit/confirm (`--yes` accepts). When nothing is inferred, write a commented template.
4. Write the file (repo: `.kunj/blueprint.json`, creating `.kunj/`; `--global`: the host copy) and print how to snapshot. Does not commit.

### snapshot

1. Resolve the blueprint and its hash; `backend.imageExists(tag)` → "up to date" unless `--rebuild`.
2. Start a temporary container with the existing `startContainer`, branch = default branch (or `--base`), names suffixed `-snapshot` (`containerNames(repo, id, '<default>@snapshot')`), `config.container.env = []`, `keepFiles: false`, `publish: []`. The helper and firewall run as for any start (setup has internet, not the host/LAN).
3. Run the `tools` presets as root (each one's script streamed in with `tarEntries`, executed with `sh`), then `setup` in `/workspace` as the sandbox user, streaming output to the terminal (stderr in `--json`). Failure → remove the temporary objects, exit 1 with the failing preset or command.
4. `exec` as root: `mkdir -p /opt/kunj && cp -a /workspace /opt/kunj/seed && chown -R <uid> /opt/kunj/seed` (the main container keeps CHOWN/DAC_OVERRIDE/FOWNER). `/workspace` stays a volume and is **not** in the image.
5. `backend.commitContainer(id, tag, labels)` → `docker commit --change 'LABEL …' <id> kunj-blueprint-<repo>:<hash>` with labels `kunj.repo`, `kunj.blueprint.hash`, `kunj.blueprint.ref` (the commit sha snapshotted), `kunj.blueprint.base` (base image tag), `kunj.blueprint.createdAt`.
6. Remove the temporary container, helper, volumes and network (always, also on failure).
7. Print tag, size (`docker image inspect`), and the seed's commit.

Previous snapshots of the repo with another hash are deleted after a successful commit (one snapshot per repo).

### start builds the snapshot itself

The user never has to run `kunj ct blueprint snapshot`. `kunj ct start` resolves the blueprint and,
when no snapshot exists for the current hash (none yet, or stale), builds it first — the same
temporary-sandbox snapshot as the command — and then starts the branch from it. The first start of a
repo therefore takes as long as its `setup`; every later branch starts in seconds. Progress lines say
what is happening (`Building blueprint snapshot (first use)…` / `Blueprint changed; rebuilding the
snapshot…`). `--no-snapshot` skips both the build and the lookup (tools + setup run inside the
container instead). When the snapshot build fails — most commonly an origin that cannot be cloned
without credentials until Task 9 lands — `start` warns and falls back to running tools + setup in
the container, so a start never fails only because a snapshot could not be made. `kunj ct blueprint
snapshot` remains for forcing a rebuild (`--rebuild`) or building ahead of time.

**Resolution** also looks at the host checkout first: `<repoRoot>/.kunj/blueprint.json` in the
working tree kunj runs from (user-controlled, so safe), then `origin/<default>`, then the host copy
in `~/.kunj/{repo}/`. A blueprint that has only just been written therefore works before it is pushed.

### start with a snapshot

In `resolveImage`, after `setting` and before `devcontainer`: when a blueprint resolves and `kunj-blueprint-<repo>:<hash>` exists, `kind: 'blueprint'`, `tag` = that image, `user` = the base image's user (recorded in the label `kunj.blueprint.user`). When the hash differs from every existing snapshot of the repo (`backend.listImages({ 'kunj.repo': id })`, prefix match on the repository name), the newest snapshot is still used and `start` prints one hint: `Blueprint snapshot is stale (lockfiles or blueprint changed); run kunj ct blueprint snapshot`. `--no-snapshot` or no blueprint → today's resolution; when a blueprint exists but no snapshot, `setup` runs after the clone and `start` prints a hint to snapshot.

`seedScript` gains `seedFrom?: string`: when set and `/workspace/.git` is absent, `cp -a <seedFrom>/. /workspace/` replaces `git clone`, then `git remote set-url origin <url>` (the snapshot's origin may differ from the user's, e.g. ssh vs https), `git fetch` + `switch` as today. The seed marker logic is unchanged.

After the seed (fresh or resumed container alike), lifecycle runs `maintain` with the same `sh -lc` runner as `postCreateCommand`; a failure warns and continues (deps may be partly updated, the agent can retry). Order per start: seed → keep files → `setup` (only when no snapshot and the container is new) → `maintain` → `postCreateCommand` once → `postStartCommand`.

`kunj ct list --json` gains `image.kind` (`sandbox | devcontainer | setting | blueprint`) and `blueprint: { hash, stale }` when applicable (additive; backwards compatible).

## Backend additions

```ts
commitContainer(id: string, tag: string, labels: Labels): Promise<void>;   // docker commit --change LABEL…
listImages(filter: Labels): Promise<Array<{ tag: string; id: string; createdAt: string; labels: Labels; size: number }>>;
removeImage(tag: string): Promise<void>;                                     // tolerant of "No such image"
```

All three are added to `ContainerBackend`, `LocalDockerBackend` and `FakeBackend`.

## Errors and edge cases

- No origin default branch: `init` works (host checkout), `snapshot` refuses with "cannot detect the default branch; pass --base".
- Blueprint invalid (not an object, `setup` not an array of strings): refuse with the path and the key.
- `setup` fails: the temporary objects are removed; exit 1; nothing committed.
- `docker commit` of a large tree takes time; print "Committing snapshot…" before it. Snapshot size is reported so users notice a bloated tree (e.g. a `build/` with artefacts).
- A devcontainer Dockerfile and a blueprint together: the snapshot is taken on top of the devcontainer image (its tag is part of the hash), so changing the Dockerfile invalidates the snapshot.
- The seed is copied, not mounted: the agent cannot modify `/opt/kunj/seed` for other branches (the image layer is read-only; writes go to the container's own layer).
- `maintain` runs behind the firewall like everything else.

## Worked examples

**kunj** (this repo): `init` infers `node: "22"` is already satisfied by the image (no entry), `setup: ["npm ci", "npm run build"]`, `maintain: ["npm ci"]`, `lockfiles: ["package-lock.json"]`.

**alertd-core** (yarn 4 via corepack, node ≥ 24.2, Playwright, postgres + pulsar via compose):

```jsonc
{
  "tools":    { "node": "24", "yarn": "corepack", "playwright": "chromium", "apt": ["postgresql-client"] },
  "setup":    ["yarn install --immutable", "npm run build"],
  "maintain": ["yarn install --immutable"],
  "notes":    "postgres and pulsar come from .devcontainer/docker-compose.yml — sidecar services are phase 2"
}
```

`init` gets `node`, `yarn` and `playwright` from `engines`, `packageManager` and the Playwright dependency; the compose services need phase 2's `container.services`.

## Testing

- Unit: blueprint parsing/validation (incl. `tools`), preset resolution order and the version-matching for `node`, inference table (fixtures for npm/yarn/pnpm/bun/poetry/uv/pip/go/cargo/bundler/Makefile), hash composition, `resolveImage` with/without snapshot + stale detection, `seedScript` with `seedFrom`, lifecycle `setup`/`maintain` ordering and failure handling against `FakeBackend`, `runArgs`/argv for `commitContainer`, `listImages` parsing, the `blueprint` sub-dispatcher and `--json` shapes.
- Docker (`npm run test:docker`): blueprint for the test repo (`tools: { "apt": ["jq"] }`, `setup: ["touch installed", …]`), `snapshot` produces a labelled image in which `jq` exists; `start` of a new branch from it has `installed` present without running `setup`, `maintain` ran, and the clone's origin is correct; a stale blueprint prints the hint; cleanup removes the snapshot image.
- Manual: `kunj ct blueprint init` in this repo → `.kunj/blueprint.json` with `npm ci` + `npm run build`; `snapshot`; `start` of a new branch is < 15 s and `node_modules` is present.

## Phases

1. This spec: file + resolution + hash, `init`, `snapshot`, `status`, `remove`, snapshot-aware start/seed/maintain, docs, tests.
2. Later: lint/test/run commands and `kunj ct test`; agent prompting; devcontainer `customizations.kunj`; snapshot secrets (build-time only) for private registries; auto-snapshot on a schedule or on lockfile change.

## Open questions

- Should `snapshot` run `postCreateCommand` from a devcontainer too (so the snapshot includes its effects)? Proposed: yes, before `setup`, since the devcontainer author intended it to run once per container.
