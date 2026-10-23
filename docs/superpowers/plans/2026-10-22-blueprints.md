# Blueprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `kunj ct blueprint init|snapshot|status|remove`: a repo's `.kunj/blueprint.json` (`tools`, `setup`, `maintain`) is run once in a sandbox and committed as `kunj-blueprint-<repo>:<hash>` with the tree at `/opt/kunj/seed`; new branch containers copy the seed and run `maintain` instead of installing.

**Architecture:** New modules under `src/lib/container/` (`blueprint.ts` file+hash, `presets.ts` tool installers, `infer.ts` for `init`, `snapshot.ts` orchestration) plug into the existing seams: `ContainerBackend` gains image commit/list/remove; `resolveImage` gains a `'blueprint'` kind; `seedScript` gains `seedFrom`; `startContainer` runs tools/setup (no snapshot) and `maintain`. The command gets a `blueprint` sub-dispatcher like `worktree keep`. Everything stays on the fast path and behind the firewall.

**Tech Stack:** TypeScript strict, Node 20, Jest + `FakeBackend`, Docker CLI (`docker commit`, `docker image ls/inspect/rm`), POSIX sh presets.

**Spec:** docs/superpowers/specs/2026-10-22-blueprints-design.md (binding). Container phase 1 spec: docs/superpowers/specs/2026-10-21-branch-containers-design.md. Branch: `feature/blueprints` (off `feature/branch-containers`).

## Global Constraints

- The blueprint is agent-editable: `setup`/`maintain` run as the sandbox user, never root; only **presets** (files from `.kunj/presets/`, `~/.kunj/presets/`, or kunj's `src/container/presets/`) run as root, never inline commands from the blueprint.
- Snapshot containers forward **no** secrets (`env: []`, `keepFiles: false`, `publish: []`) and run behind the normal firewall helper.
- `/workspace` is never part of the image; the seed lives at `/opt/kunj/seed` (constant `SEED_DIR`). One snapshot per repo: `kunj-blueprint-<repo>:<hash>` (repo name lowercased/sanitised like `imageRepoName()` in image.ts).
- `blueprintHash` = first 12 hex of sha1 over: blueprint text, each lockfile's blob id at `origin/<default>` (skipped when absent), the base image tag, and the content hash of every preset used (in `tools` order).
- Image labels: `kunj.repo`, `kunj.blueprint.hash`, `kunj.blueprint.ref`, `kunj.blueprint.base`, `kunj.blueprint.user`, `kunj.blueprint.createdAt` (ISO).
- Only `docker.ts` spawns `docker`; no new dependencies; no heavy imports (fast path); inquirer lazy.
- Backwards compatible `kunj ct list --json`: only additive fields (`image: { tag, kind }`, `blueprint?: { hash, stale }`), `image` string field kept.
- Tests in `src/lib/container/__tests__/` (unit) and `integration.docker.test.ts` (Docker); `npm test` must exclude Docker tests; every task ends with `npm test` + `npm run lint` green. Commit per task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer; add an aj-log.md line per task.

## Review Focus

1. A blueprint with `"setup": ["sudo rm -rf /"]` or a preset name of `../evil` must not run anything as root (Task 3 tests `rejects preset names outside [a-z0-9-]`, Task 5 test `setup runs as the sandbox user`).
2. `snapshot` must never bake a forwarded secret: the temp start's `StartOptions.config.container.env` is `[]` and `keepFiles` false (Task 6 test `snapshot forwards no env and no keep files`).
3. Starting a branch from a snapshot whose origin URL differs (https vs ssh) must end with the user's origin (Task 5 test `seedFrom resets origin`).
4. A stale snapshot is still used, with exactly one hint, and `--no-snapshot` bypasses it (Task 5 tests).
5. A failed `snapshot` (preset or setup error) leaves no container/volume/network/image behind (Task 6 test `cleans up on setup failure`, Task 8 Docker test).

---

### Task 1: Backend image operations

**Files:**
- Modify: `src/lib/container/backend.ts`, `src/lib/container/docker.ts`, `src/lib/container/__tests__/fake-backend.ts`
- Test: `src/lib/container/__tests__/docker.test.ts`

**Interfaces (Produces):**
```ts
export interface ImageInfo { tag: string; id: string; createdAt: string; labels: Labels; size: number }
commitContainer(id: string, tag: string, labels: Labels): Promise<void>;   // docker commit --change 'LABEL k=v'… <id> <tag>
listImages(filter: Labels): Promise<ImageInfo[]>;                           // docker image ls --filter label=k=v --format '{{json .}}' + one docker image inspect for labels/size
removeImage(tag: string): Promise<void>;                                     // docker image rm <tag>; "No such image" tolerated
```
FakeBackend: `images: ImageInfo[]` served by `imageExists`/`listImages`; `commitContainer` appends with the given labels; `removeImage` deletes; calls recorded.

- [ ] Step 1: Tests — `commitContainer argv emits one --change per label (sorted) then id and tag`; `listImages parses ls json and inspect labels/size; empty ls → [] without inspect`; `removeImage tolerates No such image and rethrows other errors`.
- [ ] Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS; `npm run lint`. Step 5: Commit `Backend: commit, list and remove images`.

---

### Task 2: Blueprint file, resolution and hash

**Files:**
- Create: `src/lib/container/blueprint.ts`
- Test: `src/lib/container/__tests__/blueprint.test.ts` (real git in temp dirs for resolution)

**Interfaces (Produces):**
```ts
export const BLUEPRINT_PATH = '.kunj/blueprint.json';
export const SEED_DIR = '/opt/kunj/seed';
export const KNOWN_LOCKFILES = ['package-lock.json','yarn.lock','pnpm-lock.yaml','bun.lock','bun.lockb','poetry.lock','uv.lock','Pipfile.lock','go.sum','Cargo.lock','Gemfile.lock']; // plus requirements*.txt by glob
export interface Blueprint { tools: Record<string, string | string[] | true>; setup: string[]; maintain: string[]; lockfiles: string[]; notes?: string; ignoredKeys: string[] }
export function parseBlueprint(text: string, source: string): Blueprint;       // JSONC via parseJsonc; validates types; throws `${source}: setup must be an array of strings` etc.
export interface ResolvedBlueprint { blueprint: Blueprint; source: 'repo' | 'host' | 'file'; path: string; text: string; ref?: string }
export async function resolveBlueprint(opts: { cwd: string; repoKunjDir: string; defaultBranch?: string; override?: string }): Promise<ResolvedBlueprint | null>; // override → 'file'; else git show origin/<default>:.kunj/blueprint.json → 'repo'; else <repoKunjDir>/blueprint.json → 'host'; else null
export async function lockfileIds(lockfiles: string[], ref: string, cwd: string): Promise<Array<{ path: string; id: string }>>; // git rev-parse <ref>:<path>, absent skipped
export function blueprintHash(input: { text: string; lockfiles: Array<{ path: string; id: string }>; baseImage: string; presetHashes: string[] }): string;
export function snapshotTag(repoName: string, hash: string): string;            // kunj-blueprint-<imageRepoName>:<hash>
export const SNAPSHOT_REPO = (repoName: string) => `kunj-blueprint-${imageRepoName(repoName)}`;
export function blueprintLabels(input: { repoId: string; hash: string; ref: string; base: string; user: string; now?: Date }): Labels;
```
- `lockfiles` default: `KNOWN_LOCKFILES` entries that exist at the ref (`git cat-file -e <ref>:<path>`) plus `requirements*.txt` via `git ls-tree`.

- [ ] Step 1: Tests — `parses tools/setup/maintain and reports ignored keys`; `rejects non-array setup with the key named`; `rejects preset names outside [a-z0-9-]` (in tools); `resolves repo file from origin default, falls back to host, then null` (bare origin + clone fixture, like seed.test.ts); `lockfileIds skips absent files`; `hash changes with text, lockfile id, base image and preset hash`; `snapshotTag lowercases`.
- [ ] Steps 2–5 as Task 1. Commit `Blueprint file, resolution and hash`.

---

### Task 3: Presets

**Files:**
- Create: `src/container/presets/{apt,node,yarn,pnpm,bun,python,go,rust,java,playwright}.sh`, `src/lib/container/presets.ts`
- Modify: `scripts/copy-container-assets.js` (presets copied, 0755), `src/lib/container/image.ts` (`assetHash` unaffected: presets live outside `sandbox/`/`nethelper/`)
- Test: `src/lib/container/__tests__/presets.test.ts`

**Interfaces (Produces):**
```ts
export interface Preset { name: string; path: string; source: 'repo' | 'host' | 'builtin'; text: string; hash: string }
export const PRESET_ORDER = ['apt', 'node', 'python', 'go', 'rust', 'java', 'yarn', 'pnpm', 'bun', 'playwright']; // others after, in tools order
export function orderTools(tools: Blueprint['tools']): string[];
export async function resolvePresets(names: string[], opts: { repoRoot?: string /* host checkout, for .kunj/presets */; repoKunjDir: string; builtinDir?: string }): Promise<Preset[]>; // throws `Unknown preset "x" (looked in <3 dirs>)`
export function presetEnv(name: string, value: string | string[] | true, user: string): Record<string, string>; // KUNJ_TOOL_VERSION ('' for true; arrays joined by spaces), KUNJ_TOOL_USER, KUNJ_TOOL_NAME
export async function runPresets(backend: ContainerBackend, id: string, presets: Preset[], tools: Blueprint['tools'], user: string, io: ExecIO): Promise<Array<{ name: string; version: string }>>; // streams each script to /tmp/kunj-presets/<name>.sh via tarEntries (as root), runs `sh` as root with presetEnv in the script's env file (not -e: write env to /tmp/kunj-presets/<name>.env and `. it` inside the wrapper), parses the final `installed <name> <version>` line; non-zero → throws Error(`preset <name> failed (exit N)`)
```
Scripts (POSIX sh, `set -eu`, idempotent, end with `echo "installed <name> <version>"`): `apt` — `apt-get update` once (`/var/lib/apt/lists` marker), install `$KUNJ_TOOL_VERSION` words; `node` — resolve version (`nvmrc` reads `/opt/kunj/seed/.nvmrc` or `/workspace/.nvmrc`; `lts` and majors via `https://nodejs.org/dist/index.json` with the firewall allowing nodejs.org — add `nodejs.org` to `ALWAYS_ALLOWED` in firewall.sh), download the linux-<arch> tarball, extract into `/usr/local`, re-run `corepack` disable/enable as needed; `yarn`/`pnpm` — `corepack enable` + `corepack prepare <pm>@<v> --activate` (`corepack` reads `packageManager` from `/opt/kunj/seed/package.json` or `/workspace`); `bun` — official installer into `$KUNJ_TOOL_USER`'s home; `python` — install `uv` into `/usr/local/bin`, `uv python install <v>`, symlink `python3`; `go` — `go.dev/dl` tarball into `/usr/local/go` + profile.d PATH; `rust` — rustup for the user; `java` — Temurin tarball; `playwright` — `npx playwright install --with-deps <browsers>` as the user after node exists. Keep each under ~40 lines.

- [ ] Step 1: Tests — `orderTools puts apt first, runtimes, then package managers, then unknown in given order`; `resolvePresets prefers repo over host over builtin and hashes content`; `rejects names with / or ..`; `presetEnv joins arrays and maps true to ''`; `runPresets streams script and env, runs as root, parses installed line, throws on failure` (FakeBackend); `sh -n` passes for every builtin script (posixOnly).
- [ ] Step 2–4 as before; Step 5: Commit `Presets: root-run tool installers for blueprints`.

---

### Task 4: Inference for `init`

**Files:**
- Create: `src/lib/container/infer.ts`
- Test: `src/lib/container/__tests__/infer.test.ts` (fixture dirs written to temp)

**Interfaces (Produces):**
```ts
export interface Inferred { tools: Blueprint['tools']; setup: string[]; maintain: string[]; lockfiles: string[]; reasons: string[] } // reasons: one line per decision ("packageManager yarn@4.6.0 → yarn: corepack")
export function inferBlueprint(repoRoot: string, imageNodeMajor = 22): Inferred;
```
Rules from the spec (§init, §Presets inference): package manager from `packageManager`/lockfile; `build` script; `.nvmrc`/`.node-version` → `node: "nvmrc"`; `engines.node` → lowest satisfying major, omitted when the image's major satisfies it; `.python-version`/`requires-python`; `go.mod`; `rust-toolchain`; `.tool-versions`; `@playwright/test` dep; Makefile `setup`/`install` target as an alternative appended to `reasons` (not chosen); nothing inferred → empty arrays.

- [ ] Step 1: Tests — one per fixture: npm+build, yarn corepack + engines ≥24.2 (→ node "24", yarn corepack), pnpm, bun, nvmrc, poetry, uv, pip, go, cargo, bundler, tool-versions, playwright, empty repo, kunj-like repo (`node` omitted when image satisfies).
- [ ] Steps 2–5. Commit `Infer a blueprint from the repository`.

---

### Task 5: Snapshot-aware start, seed and maintain

**Files:**
- Modify: `src/lib/container/image.ts` (`ImageSource.kind` gains `'blueprint'`; `ResolveImageInput.snapshot?: { tag: string; user: string; stale: boolean }`), `src/lib/container/seed.ts` (`SeedInput.seedFrom?: string`), `src/lib/container/lifecycle.ts`, `src/lib/container/env.ts` (status unchanged)
- Test: `src/lib/container/__tests__/{image,seed,lifecycle}.test.ts`

**Interfaces (Produces):**
```ts
// StartOptions gains:
noSnapshot?: boolean;
blueprint?: ResolvedBlueprint | null;            // resolved by the command (null = none); lifecycle resolves when undefined via resolveBlueprint
// StartResult gains:
blueprint?: { hash: string; snapshot: string | null; stale: boolean; toolsRun: string[]; setupRan: boolean; maintainRan: boolean };
export async function findSnapshot(backend: ContainerBackend, repoName: string, repoId: string, hash: string): Promise<{ tag: string; user: string; stale: boolean } | null>; // listImages({kunj.repo}) filtered to SNAPSHOT_REPO; exact hash → stale false; else newest → stale true
```
Behaviour: `resolveSource` resolves the blueprint + hash (base image tag = what resolution would give without the snapshot; presets resolved for their hashes) and `findSnapshot`; with a snapshot and `!noSnapshot` → `kind: 'blueprint'`, `tag` = snapshot, `user` from its label; stale → one `warn('Blueprint snapshot is stale (lockfiles or blueprint changed); run kunj ct blueprint snapshot')`. `seedScript` with `seedFrom`: `[ -d /workspace/.git ] || cp -a <seedFrom>/. /workspace/` then `git remote set-url origin <url>`, fetch + switch as today. After seed and keep files, when the container is new and there is a blueprint but no snapshot: `runPresets` (root) then `setup` (user, `sh -lc`, stop at first failure → `StartError('setup')` — add the code); then on every start `maintain` (warn on failure); then post commands.

- [ ] Step 1: Tests — image: `blueprint kind wins over devcontainer when a snapshot exists`, `no snapshot → previous resolution`; seed: `seedFrom copies the seed, resets origin and still switches`; lifecycle: `uses the snapshot and copies the seed (no clone)`, `stale snapshot used with one hint`, `--no-snapshot ignores it`, `without snapshot runs presets as root then setup as the sandbox user, in order, after keep files`, `setup failure → StartError code setup and rollback`, `maintain runs on resume and warns on failure`, `setup runs as the sandbox user` (Review Focus 1), `seedFrom resets origin` (Review Focus 3).
- [ ] Steps 2–5. Commit `Start containers from a blueprint snapshot`.

---

### Task 6: Snapshot orchestration

**Files:**
- Create: `src/lib/container/snapshot.ts`
- Test: `src/lib/container/__tests__/snapshot.test.ts` (FakeBackend; `startContainer` mocked via `jest.mock('../lifecycle')` returning a fake StartResult)

**Interfaces (Produces):**
```ts
export interface SnapshotOptions { branch: string /* default branch or --base */; blueprint: ResolvedBlueprint; config: KunjConfig; repo: StartOptions['repo']; kunjVersion: string; cwd: string; jsonMode: boolean; rebuild: boolean; warn: (m: string) => void; log: (m: string) => void }
export interface SnapshotResult { tag: string; hash: string; ref: string; base: string; sizeBytes: number; tools: Array<{ name: string; version: string }>; reused: boolean }
export async function snapshotBlueprint(backend: ContainerBackend, opts: SnapshotOptions): Promise<SnapshotResult>;
export async function snapshotStatus(backend: ContainerBackend, repoName: string, repoId: string, hash: string): Promise<{ current: ImageInfo | null; others: ImageInfo[] }>;
export async function removeSnapshots(backend: ContainerBackend, repoName: string, repoId: string): Promise<string[]>;
```
Flow per spec §snapshot: hash → `imageExists` (reused unless `rebuild`) → `startContainer` with `branch`, names via `containerNames(repo, id, '<branch>@snapshot')` (pass a `nameSuffix`/`branchLabel` option — add `StartOptions.namesFor?: string` used only for naming/labels), `config` cloned with `container.env = []`, `keepFiles = false`, `publish = []`, `blueprint` passed, `noSnapshot: true` → presets ran + setup ran inside start (Task 5) → root exec `mkdir -p /opt/kunj && cp -a /workspace /opt/kunj/seed && chown -R <user> /opt/kunj/seed` → `commitContainer(id, tag, blueprintLabels(...))` → remove temp container/helper/volumes/network (always; `finally`) → `removeImage` for older snapshots of the repo → size via `listImages`.

- [ ] Step 1: Tests — `snapshot forwards no env and no keep files` (Review Focus 2), `copies the seed as root, commits with labels, removes temp objects and older snapshots`, `cleans up on setup failure` (start rejects → no commit, remove called), `reuses an existing tag unless rebuild`, `status reports current vs others`, `removeSnapshots removes all tags for the repo`.
- [ ] Steps 2–5. Commit `Blueprint snapshots: build once, commit, prune`.

---

### Task 7: Command: `kunj ct blueprint` and `--no-snapshot`

**Files:**
- Modify: `src/commands/container.ts` (sub-dispatcher `blueprint init|snapshot|status|remove`; `--no-snapshot`, `--global`, `--yes`, `--blueprint <path>` options; `list` JSON additions; start summary line for blueprint), `src/lib/container/lifecycle.ts` only if a signature is missing
- Test: `src/commands/__tests__/container.test.ts`

Behaviour: `init` → `inferBlueprint(repoRoot)`; print reasons; for each of tools/setup/maintain show the proposal and (TTY, not `--yes`) inquirer `input` to edit (comma-separated commands); write `.kunj/blueprint.json` (pretty JSON, with a top comment line `// kunj blueprint — see kunj ct blueprint --help`) or `~/.kunj/{repo}/blueprint.json` with `--global`; refuse to overwrite without `--yes`/confirm; print next step. `snapshot` → `resolveBlueprint` (`--blueprint` override) → `detectDefaultBranch()` or `--base` → `snapshotBlueprint`; text summary (tag, size in MB, tools) / JSON. `status` → source/path/hash/snapshot tag+date/stale/notes; JSON. `remove` → `removeSnapshots`. `start` passes `noSnapshot` and `blueprint`; summary adds `Blueprint: snapshot <hash> (stale)` or `Blueprint: no snapshot; ran setup`. `list` adds `image: { tag, kind }` (kind from `kunj.options`? — record `imageKind` in the options label at start) and `blueprint` when the container's image repo is `SNAPSHOT_REPO`.

- [ ] Step 1: Tests — `blueprint init writes the inferred file (--yes) and refuses to overwrite`, `blueprint snapshot calls snapshotBlueprint with the default branch and prints the tag`, `blueprint status json shape`, `start passes noSnapshot`, `list json includes image.kind and blueprint`.
- [ ] Steps 2–5 (also `npm run build` and `node dist/index.js ct blueprint --help`). Commit `kunj ct blueprint: init, snapshot, status, remove`.

---

### Task 8: Docker tests, docs, and kunj's own blueprint

**Files:**
- Modify: `src/lib/container/__tests__/integration.docker.test.ts`, `README.md` (blueprint section after the container section: file, presets, snapshot flow, security note that presets run as root at snapshot time and nothing else does), `CLAUDE.md` (Branch Containers: blueprint modules, presets dirs, snapshot rules), `aj-log.md`
- Create: `.kunj/blueprint.json` for this repo via `node dist/index.js ct blueprint init --yes` (expected: `setup: ["npm ci","npm run build"]`, `maintain: ["npm ci"]`, `lockfiles: ["package-lock.json"]`, no `tools`)

- [ ] Step 1: Docker tests — `blueprint snapshot builds an image with jq and the seed` (test repo gets `.kunj/blueprint.json` with `tools: {apt: ["jq"]}`, `setup: ["touch installed", "echo built > built.txt"]`, pushed to the bare origin; `snapshotBlueprint` → image labelled; `docker run --rm <tag> sh -c 'command -v jq && test -f /opt/kunj/seed/installed'`), `start from the snapshot copies the seed and runs maintain` (new branch: `installed` present, no `setup` exec recorded — assert via a `maintain: ["touch maintained"]`), `stale snapshot prints the hint` (change the lockfile on origin), `snapshot failure leaves nothing` (setup `exit 1` → no image, no labelled objects), cleanup removes snapshot images.
- [ ] Step 2: `npm run test:docker` → PASS; `npm test` → PASS; `npm run lint`; `npm run build`.
- [ ] Step 3: `node dist/index.js ct blueprint init --yes` in this repo; inspect the file; `node dist/index.js ct blueprint snapshot` (expect a few minutes: `npm ci` + build); `node dist/index.js ct start blueprint-smoke -c` → `node_modules` present, `< 20 s`; `kunj ct remove blueprint-smoke --force`; record timings in aj-log.
- [ ] Step 4: Docs. Step 5: Commit `Blueprints: docs, Docker tests and kunj's own blueprint`.

---

### Task 9: Snapshot private origins without a credential in the container

**Files:**
- Modify: `src/lib/container/seed.ts` (`SeedInput.bundlePath?: string`), `src/lib/container/lifecycle.ts` (stream the bundle before the seed when `StartOptions.bundle` is set), `src/lib/container/snapshot.ts` (make the bundle on the host, pass it), `src/commands/container.ts` (`snapshot --no-bundle` escape hatch, status text)
- Test: `src/lib/container/__tests__/{seed,lifecycle,snapshot}.test.ts`, `integration.docker.test.ts`

**Why:** snapshots forward no env (a token would reach the committed image via older engines' `container_config` or via repo-controlled `setup` writing it to disk), so a private origin cannot be cloned inside the temp container. The host already has credentials.

**Interfaces (Produces):**
```ts
// snapshot.ts
export async function makeBranchBundle(branch: string, cwd: string): Promise<{ path: string; cleanup: () => void }>; // git fetch origin <branch>; git bundle create <tmp>/origin.bundle refs/remotes/origin/<branch>:refs/heads/<branch> (one ref, so the bundle carries only that branch's history)
// StartOptions gains:
bundle?: { hostPath: string; containerPath: string };   // streamed into the container (tarEntries, as the sandbox user) before the seed script runs
// SeedInput gains:
bundlePath?: string;   // when set: `git clone --no-checkout <bundle> /workspace` then `git remote set-url origin <originUrl>`, then switch; no network needed for the clone
```
- The snapshot path always uses a bundle (public or private — one code path), unless `--no-bundle`. Normal `kunj ct start` keeps cloning from origin (the token is forwarded there by design).
- The bundle is deleted from the container (`rm -f`) before the seed copy, and from the host temp dir in `finally`.
- `lockfileIds`/`blueprintRef` are unchanged (they read the host's `origin/<default>`, which the fetch just updated).

- [ ] Step 1: Tests — `makeBranchBundle creates a bundle containing only the branch` (real git: `git bundle list-heads`); `seedScript with bundlePath clones from the bundle and resets origin`; lifecycle `streams the bundle before the seed and removes it after`; snapshot `passes a bundle and cleans it up on success and failure`; Docker test: snapshot against the git-daemon origin with a `bundle` — assert the temp container never ran `git clone git://…` (exec log) and the image's seed HEAD equals origin's.
- [ ] Steps 2–5. Commit `Snapshot from a host-made bundle so private origins need no token`.

---

### Task 10: `start` builds the snapshot itself

**Files:**
- Modify: `src/commands/container.ts` (`start`: ensure-snapshot step before `startContainer`), `src/lib/container/snapshot.ts` (`ensureSnapshot()`), `src/lib/container/blueprint.ts` (`resolveBlueprint` gains `repoRoot?` checked first)
- Test: `src/commands/__tests__/container.test.ts`, `src/lib/container/__tests__/{blueprint,snapshot}.test.ts`, `integration.docker.test.ts`

**Interfaces (Produces):**
```ts
// snapshot.ts
export async function ensureSnapshot(backend, opts: SnapshotOptions & { stale: 'rebuild' | 'keep' }): Promise<{ result: SnapshotResult | null; built: boolean; failed?: string }>;
// planSnapshot → if exists && !stale → {built:false}; if missing or (stale && opts.stale==='rebuild') → snapshotBlueprint (progress line); a thrown error is caught → {result:null, built:false, failed: message}
// blueprint.ts
resolveBlueprint({ cwd, repoRoot?, repoKunjDir, defaultBranch?, override? }) // order: override → <repoRoot>/.kunj/blueprint.json ('worktree') → origin/<default> ('repo') → host ('host')
```
- `start` (command): unless `--no-snapshot`, after resolving the blueprint: `ensureSnapshot(..., { stale: 'rebuild' })`; on `failed` → `warn('Blueprint snapshot could not be built (<reason>); running tools and setup in the container instead')` and continue; then `startContainer` as today (which now finds the fresh snapshot). The lifecycle's own stale hint is suppressed when the command already rebuilt. `ResolvedBlueprint.source` gains `'worktree'`; `status` prints it.
- `kunj ct blueprint snapshot` keeps working (`--rebuild` forces).

- [ ] Step 1: Tests — command: `start builds the snapshot when none exists then starts from it` (snapshot mock called before startContainer, with the same blueprint/base), `start rebuilds a stale snapshot`, `start falls back with a warning when the snapshot build fails`, `--no-snapshot skips the build`; blueprint: `worktree file wins over origin and host`; Docker: `start with a blueprint and no snapshot builds one and starts from it` (fresh repo id: assert the snapshot image exists after a plain `startContainer`-via-command flow — call the same `ensureSnapshot` + `startContainer` sequence the command uses).
- [ ] Steps 2–5; update README/CLAUDE.md wording (the flow is `init` → `start`; `snapshot` is optional). Commit `kunj ct start builds the blueprint snapshot itself`.

---

## Self-review notes

- Spec coverage: file/resolution/hash → T2; presets + inference → T3/T4; snapshot → T6; start/seed/maintain/stale/`--no-snapshot` → T5; commands/JSON → T7; backend → T1; tests/docs/worked example → T8. Open question (devcontainer `postCreateCommand` during snapshot) is answered by T5's ordering: `startContainer` already runs it on a new container, so the snapshot includes it.
- Type consistency: `ResolvedBlueprint`, `Preset`, `ImageInfo`, `SnapshotResult`, `StartOptions.noSnapshot/blueprint/namesFor`, `StartResult.blueprint`, `StartError` code `'setup'` are each defined once (T1/T2/T3/T5/T6) and used by name later.
- Review Focus 1–5 pinned in T3/T5, T6, T5, T5, T6/T8.
