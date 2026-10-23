# Workspace App v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron app, `workspace-app/`, that lists every worktree and branch container as an environment, keeps terminals and agent sessions per environment alive, shows a diff viewer, and runs every action through the installed `kunj` CLI.

**Architecture:** A sandboxed React renderer talks over typed IPC to the main process. Main owns four services: `KunjCli` (finds and runs `kunj … --json` with `cwd` = repository root), `EnvironmentStore` (repos → worktrees + containers, refreshed by `kunj events --json`), `PtyManager` (node-pty per tab; shells and agents are kunj commands), and `Layout` (which tabs are open, per repo). Diff content comes from `git` in a worktree and `kunj ct exec … git` in a container; files from `fs` or `kunj ct file`. The app never imports kunj's runtime, only its JSON types.

**Tech Stack:** Electron (current stable), electron-vite, React 18, TypeScript, `@xterm/xterm` + `@xterm/addon-webgl` + `@xterm/addon-fit`, `node-pty`, `monaco-editor` via `@monaco-editor/react`, `parse-diff`, electron-builder, vitest (+ `@testing-library/react`, jsdom for renderer smoke tests).

**Spec:** `docs/superpowers/specs/2026-10-23-workspace-ide-design.md`. Discussion: `docs/specs/workspace-ide.md`. Requires the CLI additions from `docs/superpowers/plans/2026-10-23-workspace-cli-contract.md` (`kunj agent`, `kunj ct file`, `kunj events`, published types).

## Global Constraints

- Work on `main`, one commit per task. `workspace-app/` is its own npm package (like `vscode-extension/`); nothing in the root `package.json` or `src/` changes except in Task 10.
- The CLI is the only contract: no `import` from `kunj` except `import type`; no `docker` or kunj library calls; `git` only for diff content in worktrees (Task 8), read-only.
- Every kunj invocation runs with `cwd` set to the repository root from `kunj repos --json` and names the branch explicitly.
- Electron security defaults on: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the renderer reaches main only through the `window.kunj` API exposed by the preload.
- `MIN_KUNJ_VERSION` = the first released version containing the CLI contract plan (set it when that release is tagged; `0.0.0` until then). A kunj reporting `1.0.0` is a dev build: accepted, flagged `dev: true`.
- macOS arm64 only in v1. Ad-hoc signed, not notarized (as `macos-app/`).
- Terminal env for every PTY: `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG` from the user's environment or `en_US.UTF-8`, `PATH` from the login shell.
- Append a line per change to `aj-log.md`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. kunj missing from the login-shell PATH, or older than `MIN_KUNJ_VERSION`: the window must show one clear message with the install command, not an empty list (Task 2 tests `not-found`, `too-old`; Task 5 renders the error state).
2. Docker stopped: worktrees still list, containers show as unavailable, the events stream keeps running after its backend retry (Task 3 test `container listing fails`).
3. An environment whose worktree directory is gone (`exists: false`) or whose container is stopped: opening a shell must be refused in the UI with a reason, never spawn a PTY that exits at once (Task 6 `terminalSpec` test).
4. Quitting the app with ten PTYs and the events child open must not leave orphan `kunj events` or `kunj ct shell` processes (Task 6 test `closeAll` and Task 4 `stop()` closes stdin and waits for exit).
5. A branch name with `/` must round-trip through the layout file and the environment id (Task 7 test `feature/x`).

---

### Task 1: Scaffold the Electron package

**Files:**
- Create: `workspace-app/package.json`, `workspace-app/electron.vite.config.ts`, `workspace-app/tsconfig.json`, `workspace-app/tsconfig.node.json`, `workspace-app/tsconfig.web.json`, `workspace-app/vitest.config.ts`, `workspace-app/src/main/index.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/shared/ipc.ts`, `workspace-app/src/renderer/index.html`, `workspace-app/src/renderer/main.tsx`, `workspace-app/src/renderer/App.tsx`, `workspace-app/README.md`, `workspace-app/.gitignore`
- Test: `workspace-app/src/shared/ipc.test.ts`

**Interfaces:**
- Produces: `src/shared/ipc.ts` exporting `Channels` (string constants, one per IPC call this plan adds; start with `'app:version'`) and `KunjApi` (the type of `window.kunj`, initially `{ appVersion(): Promise<string> }`); the preload exposes `window.kunj` with `contextBridge.exposeInMainWorld('kunj', …)` and a `src/renderer/global.d.ts` declares `window.kunj: KunjApi`.
- `package.json` scripts: `dev` (electron-vite dev), `build` (electron-vite build), `test` (vitest run), `lint` (tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json), `package` (electron-builder, Task 10), `postinstall: electron-builder install-app-deps`.
- `devDependencies` include `kunj: file:..` for the types.

- [ ] **Step 1: Create the package and the config files**

`npm init` in `workspace-app/` with `"private": true`, `"name": "kunj-workspace"`, `"main": "out/main/index.js"`; install `electron`, `electron-vite`, `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `typescript`, `vitest`, `jsdom`, `@testing-library/react`, `electron-builder`, `kunj@file:..`. electron-vite config with the three entry points. The renderer `App.tsx` renders a two-column layout: left column "Environments" (empty), right "Select an environment", and the app version from `window.kunj.appVersion()` in a status bar.

- [ ] **Step 2: Write the failing test**

`src/shared/ipc.test.ts`: `expect(Channels.appVersion).toBe('app:version')` and that every value in `Channels` is unique.

- [ ] **Step 3: Run, implement, run**

Run: `cd workspace-app && npm test`
Expected: FAIL then PASS after `src/shared/ipc.ts` exists.

- [ ] **Step 4: Build and open the window**

Run: `npm run build && npm run lint`
Expected: `out/` produced, no type errors. Run `npm run dev` manually: a window titled "Kunj Workspace" with the two columns and the version in the status bar.

- [ ] **Step 5: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: Electron scaffold"
```

---

### Task 2: `KunjCli` service

**Files:**
- Create: `workspace-app/src/main/kunj/loginPath.ts`, `workspace-app/src/main/kunj/cli.ts`, `workspace-app/src/main/kunj/version.ts`
- Test: `workspace-app/src/main/kunj/version.test.ts`, `workspace-app/src/main/kunj/cli.test.ts`, `workspace-app/test/fixtures/fake-kunj` (executable shell script) and `workspace-app/test/fixtures/responses/*.json`

**Interfaces:**
- Produces:
  - `loginPath(): Promise<string>` — runs `${SHELL || '/bin/zsh'} -l -i -c 'printf "<KUNJ-PATH>%s<KUNJ-PATH>" "$PATH"'` (the same trick as `macos-app/Sources/KunjBar/CLI/KunjCLI.swift`) and returns the PATH between the markers; falls back to `process.env.PATH` on error.
  - `version.ts`: `parseVersion(s: string): [number, number, number] | null`, `MIN_KUNJ_VERSION`, `checkVersion(v: string): { ok: boolean; dev: boolean }` (`dev` when `v === '1.0.0'`, then `ok` is true).
  - `cli.ts`: `class KunjCliError extends Error { code: 'not-found' | 'too-old' | 'command-failed' | 'bad-json'; args: string[]; kunjCode?: string }`; `class KunjCli { static discover(opts?: { path?: string; binary?: string }): Promise<KunjCli>; readonly binary: string; readonly version: string; readonly dev: boolean; readonly env: NodeJS.ProcessEnv /* PATH set to the login path */; run<T>(args: string[], opts: { cwd: string; stdin?: string }): Promise<T> /* appends --json, parses stdout; a parsed { error } → KunjCliError('command-failed', kunjCode = error.code) */; spawnSpec(args: string[], cwd: string): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } /* for PTYs and the events stream */ }`.
- `test/fixtures/fake-kunj`: a `sh` script that prints `1.2.3` for `-V`, and otherwise `cat`s `responses/<args joined by _ with / replaced by -_>.json`, exiting 1 with `{"error":{"code":"fixture-missing","message":…}}` when there is no fixture. Fixtures added by later tasks.

- [ ] **Step 1: Write the failing version tests**

```ts
test.each([['1.2.3', [1,2,3]], ['v1.2.3', [1,2,3]], ['garbage', null]])('parseVersion %s', …);
test('1.0.0 is a dev build and accepted', () => expect(checkVersion('1.0.0')).toEqual({ ok: true, dev: true }));
test('below the minimum is rejected', …);  // use a MIN_KUNJ_VERSION override argument: checkVersion(v, min)
```

- [ ] **Step 2: Run, implement `version.ts`, run**

Run: `npm test -- version`
Expected: FAIL then PASS.

- [ ] **Step 3: Write the failing cli tests**

`cli.test.ts` with `PATH` pointing at `test/fixtures` (the script is named `kunj` there, or pass `binary`):

```ts
test('discover finds kunj and reads its version', …)                 // version '1.2.3', dev false
test('discover fails with not-found when kunj is absent', …)         // PATH = empty dir → KunjCliError code 'not-found'
test('run parses JSON and appends --json', …)                        // fixture repos.json → { repos: [...] }
test('run turns a kunj error document into command-failed', …)       // fixture-missing → code 'command-failed', kunjCode 'fixture-missing'
test('run rejects non-JSON stdout with bad-json', …)                 // fixture prints "not json"
test('spawnSpec carries the login PATH and cwd', …)
```

- [ ] **Step 4: Run, implement `loginPath.ts` and `cli.ts`, run**

`run` uses `execFile` with `maxBuffer: 16 MiB`, `stdin` written then ended when given, otherwise `'ignore'`.

Run: `npm test -- cli`
Expected: PASS.

- [ ] **Step 5: Wire discovery into main**

In `src/main/index.ts` discover the CLI at startup; expose `kunj:status` → `{ binary, version, dev } | { error: { code, message } }` over IPC; `App.tsx` status bar shows `kunj 1.2.3` or the error with `npm install -g kunj` as the hint.

Run: `npm run lint && npm run build`

- [ ] **Step 6: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: KunjCli service with login-shell PATH and version check"
```

---

### Task 3: Environment model

**Files:**
- Create: `workspace-app/src/shared/environment.ts`, `workspace-app/src/main/environments.ts`
- Modify: `workspace-app/src/shared/ipc.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/main/index.ts`
- Test: `workspace-app/src/main/environments.test.ts`, fixtures `repos.json`, `worktree_list.json`, `ct_list.json`, `ct_list_error.json`

**Interfaces:**
- Consumes: `KunjCli.run` (Task 2); types `ReposJson`, `WorktreeListJson`, `ContainerListJson`, `WorktreeJson`, `ContainerJson` from `kunj`.
- Produces (`src/shared/environment.ts`):
  - `Environment { id: string /* `${repo.name}|${kind}|${branch}` */; kind: 'worktree' | 'container'; repo: { name: string; root: string }; branch: string; path: string | null; state: 'running' | 'stopped' | 'ok' | 'missing'; isMain: boolean; agent: boolean | null; dirty: boolean | null; ahead: number | null; behind: number | null; pullRequest: { number: number; url: string; state: string } | null; ports: Array<{ container: number; host: number; kind: 'publish' | 'forward' }>; containerName: string | null }`
  - `RepoEnvironments { repo: { name: string; root: string; bare: boolean }; backend: 'docker' | 'unavailable'; environments: Environment[] }`
  - `main/environments.ts`: `listEnvironments(cli: KunjCli, opts?: { repoRoot?: string }): Promise<RepoEnvironments[]>` — `repos --json` filtered to `!hidden && exists`; per repo, in parallel, `worktree list --json` and `ct list --json` with `cwd: repo.root`; a failing `ct list` → `backend: 'unavailable'`, no container environments; a failing `worktree list` → that repo reported with `environments: []` and the error logged; `toEnvironments(repo, worktrees: WorktreeListJson, containers: ContainerListJson | null): Environment[]` (pure; a detached or branchless worktree gets `branch = wt.name` and `kind 'worktree'`, state `missing` when `!exists`).
- IPC: `environments:list` → `RepoEnvironments[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test('toEnvironments merges worktrees and containers of one repo', …)   // 2 worktrees + 1 container (same branch as one worktree) → 3 environments, ids distinct, container one has state 'running', ports from the fixture, agent from agent.running
test('a worktree agent comes from worktree agent.running', …)
test('container listing failure marks the backend unavailable', …)     // fake-kunj fixture ct_list_error.json → backend 'unavailable', worktree environments still present
test('hidden and missing repos are skipped', …)
test('branch with a slash makes a stable id', …)                        // 'feature/x' → id 'app|worktree|feature/x'
```

- [ ] **Step 2: Run, implement, run**

Run: `npm test -- environments`
Expected: FAIL then PASS.

- [ ] **Step 3: Wire IPC and show a raw list**

Preload gains `listEnvironments()`; `App.tsx` calls it on mount and renders repo names with environment branches as plain text (styling is Task 5).

Run: `npm run lint && npm run build`; `npm run dev` shows your repos.

- [ ] **Step 4: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: environment model from repos, worktree list and ct list"
```

---

### Task 4: Event-driven refresh

**Files:**
- Create: `workspace-app/src/main/events.ts`, `workspace-app/src/main/store.ts`
- Modify: `workspace-app/src/shared/ipc.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/main/index.ts`
- Test: `workspace-app/src/main/events.test.ts`, `workspace-app/src/main/store.test.ts`

**Interfaces:**
- Consumes: `EventJson` from `kunj`; `KunjCli.spawnSpec` (Task 2); `listEnvironments` (Task 3).
- Produces:
  - `events.ts`: `class EventStream { constructor(cli: KunjCli, onEvent: (e: EventJson) => void, opts?: { backoffMs?: [number, number] /* [1000, 30000] */ }); start(): void; stop(): Promise<void> /* closes the child's stdin, waits up to 2 s, then SIGTERM */ }` — spawns `kunj events --json` with `cwd: os.homedir()`, splits stdout on newlines, ignores unparsable lines, restarts with exponential backoff when the child exits while started; `parseEventLines(buffer: string): { events: EventJson[]; rest: string }`.
  - `store.ts`: `class EnvironmentStore { constructor(cli: KunjCli, opts?: { coalesceMs?: number /* 300 */ }); get(): RepoEnvironments[]; refreshAll(): Promise<void>; refreshRepo(root: string): Promise<void>; onChange(fn: (all: RepoEnvironments[]) => void): () => void; handleEvent(e: EventJson): void }` — `git`/`sessions`/`container` events with a `repo` refresh that repo (coalesced per repo); `repos` refreshes all; `agent` and `forwards` refresh all; `backend` events refresh all once.
- IPC: main pushes `environments:changed` with the full `RepoEnvironments[]`; `environments:refresh` → `refreshAll()`.

- [ ] **Step 1: Write the failing tests**

```ts
test('parseEventLines splits complete lines and keeps the remainder', …)
test('EventStream restarts the child after exit with backoff', …)       // fake-kunj 'events' fixture prints two lines and exits; expect 2 events, then a second spawn
test('stop closes stdin and resolves', …)
test('store coalesces three git events for one repo into one refresh', …)   // stub listEnvironments; advance fake timers
test('store refreshes everything on a repos event', …)
```

- [ ] **Step 2: Run, implement, run**

Run: `npm test -- events store`
Expected: PASS.

- [ ] **Step 3: Wire into main**

`index.ts` creates the store, starts the stream after discovery, broadcasts `environments:changed` to all windows on change, stops the stream on `before-quit`. Renderer subscribes via `window.kunj.onEnvironmentsChanged(cb)` (preload `ipcRenderer.on`, returns an unsubscribe).

Run: `npm run lint && npm run build`; in `npm run dev`, `git commit --allow-empty` in a repo updates ahead counts without a manual refresh.

- [ ] **Step 4: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: refresh environments from kunj events"
```

---

### Task 5: Environment list and header

**Files:**
- Create: `workspace-app/src/renderer/state/AppState.tsx` (React context: environments, selected id, kunj status), `workspace-app/src/renderer/components/EnvironmentList.tsx`, `workspace-app/src/renderer/components/EnvironmentHeader.tsx`, `workspace-app/src/renderer/components/StatusBar.tsx`, `workspace-app/src/renderer/styles.css`
- Modify: `workspace-app/src/renderer/App.tsx`
- Test: `workspace-app/src/renderer/components/EnvironmentList.test.tsx`

**Interfaces:**
- Consumes: `RepoEnvironments`, `Environment` (Task 3).
- Produces: `EnvironmentList({ repos, selectedId, onSelect })` grouped by repo with per row: kind glyph (`⌂` worktree, `▣` container), branch, running dot (green when `state === 'running'`, grey when stopped), agent dot (blue when `agent === true`), `dirty` marker, `+ahead/-behind`, `#PR`, first port, a repo header with a "Docker unavailable" badge when `backend === 'unavailable'`; `EnvironmentHeader({ env, actions })` with branch, kind, state, PR link and the action buttons wired in Task 9 (disabled until then); `StatusBar` with the kunj version or error. Empty state: "No repositories yet. Run kunj in one." Error state: the kunj status error with its hint.

- [ ] **Step 1: Write the failing render test** (vitest + jsdom + testing-library)

```ts
test('groups environments by repo and marks running agents', …)   // two repos; one row has the agent dot (query by aria-label "agent running"); the unavailable repo shows the badge
test('clicking a row selects it', …)
test('renders the kunj error state', …)
```

- [ ] **Step 2: Run, implement, run**

Run: `npm test -- EnvironmentList`
Expected: PASS. Use plain CSS (dark theme, system font, 13px), no UI library.

- [ ] **Step 3: Build and look**

Run: `npm run lint && npm run build`; `npm run dev`: list on the left, selecting a row fills the header.

- [ ] **Step 4: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: environment list and header"
```

---

### Task 6: Terminals and agent tabs

**Files:**
- Create: `workspace-app/src/main/pty.ts`, `workspace-app/src/main/terminalSpec.ts`, `workspace-app/src/renderer/components/TerminalPane.tsx`, `workspace-app/src/renderer/components/TabStrip.tsx`, `workspace-app/src/renderer/components/PaneArea.tsx`, `workspace-app/src/renderer/state/tabs.ts`
- Modify: `workspace-app/src/shared/ipc.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/main/index.ts`, `workspace-app/src/renderer/App.tsx`, `workspace-app/package.json` (`node-pty`, `@xterm/*`)
- Test: `workspace-app/src/main/pty.test.ts`, `workspace-app/src/main/terminalSpec.test.ts`

**Interfaces:**
- Consumes: `KunjCli.spawnSpec` (Task 2), `Environment` (Task 3).
- Produces:
  - `terminalSpec.ts`: `TabKind = 'shell' | 'agent' | 'action'`; `terminalSpec(cli: KunjCli, env: Environment, kind: TabKind, action?: string[]): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; title: string } | { refused: string }` — worktree shell: `${SHELL || '/bin/zsh'} -l` in `env.path`; worktree agent: `kunj agent <branch>` in `env.path`; container shell/agent: `kunj ct shell|agent <branch>` with `cwd: env.repo.root`; action: `kunj <action…>` with `cwd: env.repo.root`; refused when a worktree is `missing` ("worktree directory is gone") or a container is not `running` for shell/agent ("container is stopped; start it first").
  - `pty.ts`: `class PtyManager { open(spec: { id: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }, handlers: { onData(d: string): void; onExit(code: number): void }): void; write(id, data): void; resize(id, cols, rows): void; close(id): void; closeAll(): void; has(id): boolean }` over `node-pty`.
  - Tab ids: `${env.id}#${kind}#${n}`; the renderer keeps `tabs: Record<envId, { tabs: Tab[]; active: string | null }>` in `state/tabs.ts`.
- IPC: `pty:open`, `pty:write`, `pty:resize`, `pty:close` (renderer → main); `pty:data`, `pty:exit` (main → renderer, payload `{ id, data | code }`).
- Renderer: `TerminalPane` mounts one `Terminal` (xterm) with the WebGL addon (fall back to the default renderer when `loadAddon` throws), the fit addon and a `ResizeObserver`; `PaneArea` keeps a `TerminalPane` mounted for every open tab of every environment and shows only the active tab of the selected environment (`display: none` for the rest), so background environments keep their scrollback; `TabStrip` shows the selected environment's tabs with `+ Shell` and `+ Agent` buttons and a close button per tab.

- [ ] **Step 1: Write the failing spec tests**

```ts
test.each([...])('terminalSpec for %s', …)   // worktree shell → $SHELL -l in path; worktree agent → kunj agent <branch>; container shell → kunj ct shell <branch> cwd repo root; container agent → kunj ct agent; missing worktree → refused; stopped container shell → refused; action ['ct','start','x'] → kunj ct start x
test('terminal env has TERM, COLORTERM and the login PATH', …)
```

- [ ] **Step 2: Run, implement `terminalSpec.ts`, run**

Run: `npm test -- terminalSpec`
Expected: PASS.

- [ ] **Step 3: Write the failing PtyManager test**

```ts
test('open streams data and reports the exit code', …)   // command 'sh', args ['-c', 'echo hi; exit 3'] → onData contains 'hi', onExit(3)
test('closeAll kills every pty', …)                       // open 'sleep 30' twice, closeAll(), has() false for both, processes gone (check `ps -p <pid>` via the pty's pid)
```

- [ ] **Step 4: Run, implement `pty.ts`, run**

Run: `npm test -- pty`
Expected: PASS (node-pty rebuilt for Node by `install-app-deps` is fine for vitest; if the native module mismatches Electron vs Node, run vitest with `npx electron-rebuild -f -w node-pty` guidance in the README).

- [ ] **Step 5: Wire IPC and the renderer**

Main: a `PtyManager` instance; handlers forward to `webContents.send`; `closeAll()` on `before-quit`. Renderer: `TabStrip`, `PaneArea`, `TerminalPane`; opening a tab asks main for `terminalSpec` via IPC `terminal:spec` (or main opens directly from `{ envId, kind }`: choose main-side `pty:openFor({ envId, kind, cols, rows })` so the renderer never sees commands); a refused spec shows the reason inline in the tab strip; on `pty:exit` the tab shows "exited (code)" and a close button.

Run: `npm run lint && npm run build`; `npm run dev`: open a shell in a worktree and a `kunj ct agent` in a running container; detach the CLI side (`Ctrl-b d` in a separate terminal) and see the app's tab keep the session; switch environments and back: scrollback intact.

- [ ] **Step 6: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: terminals and agent tabs over node-pty"
```

---

### Task 7: Layout state

**Files:**
- Create: `workspace-app/src/main/layout.ts`
- Modify: `workspace-app/src/shared/ipc.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/main/index.ts`, `workspace-app/src/renderer/state/tabs.ts`
- Test: `workspace-app/src/main/layout.test.ts`

**Interfaces:**
- Produces: `Layout = Record<string /* branch */, { tabs: Array<{ id: string; kind: 'shell' | 'agent' | 'diff'; title: string }>; active: string | null }>`; `layoutPath(repoName: string, home = os.homedir()): string` = `~/.kunj/<repoName>/workspace.json`; `loadLayout(repoName): Promise<Layout>` (missing or corrupt file → `{}`); `saveLayout(repoName, layout): Promise<void>` (write to `workspace.json.tmp` then rename; create the directory); `action` tabs are never saved.
- IPC: `layout:load(repoName)`, `layout:save(repoName, layout)`. Renderer saves (debounced 500 ms) whenever tabs change; on selecting an environment for the first time in a session it restores the saved tabs lazily (a saved shell/agent tab is re-opened only when it becomes the active tab, so launch stays cheap).

- [ ] **Step 1: Write the failing tests**

```ts
test('load returns {} for a missing file', …)
test('save then load round-trips a branch with a slash', …)   // key 'feature/x'
test('save skips action tabs and is atomic', …)                 // no .tmp left behind
test('corrupt json loads as {}', …)
```

- [ ] **Step 2: Run, implement, run; wire IPC and the renderer**

Run: `npm test -- layout` → PASS; `npm run lint && npm run build`; `npm run dev`: open two tabs, quit, relaunch, select the environment: both tabs are back (agent tab reattaches to tmux).

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: persist open tabs per repo"
```

---

### Task 8: Diff viewer

**Files:**
- Create: `workspace-app/src/main/diff.ts`, `workspace-app/src/main/files.ts`, `workspace-app/src/renderer/components/DiffPane.tsx`
- Modify: `workspace-app/src/shared/ipc.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/main/index.ts`, `workspace-app/src/renderer/components/TabStrip.tsx` (`+ Diff`), `workspace-app/package.json` (`monaco-editor`, `@monaco-editor/react`, `parse-diff`)
- Test: `workspace-app/src/main/diff.test.ts`, `workspace-app/src/main/files.test.ts`, fixture `test/fixtures/sample.diff`

**Interfaces:**
- Consumes: `KunjCli.run`/`spawnSpec`, `Environment`, `FileReadJson` from `kunj`.
- Produces:
  - `files.ts`: `readFile(cli, env, relPath): Promise<string>` — worktree: `fs.readFile(path.join(env.path, relPath))` after rejecting `..`/absolute paths; container: `cli.run<FileReadJson>(['ct', 'file', 'read', env.branch, relPath], { cwd: env.repo.root })`.
  - `diff.ts`: `DiffMode = 'base' | 'uncommitted' | 'last'`; `gitArgs(mode: DiffMode, baseSha: string | null): string[]` (`base` → `['diff', baseSha]`, `uncommitted` → `['diff', 'HEAD']`, `last` → `['diff', 'HEAD~1', 'HEAD']`); `gitInvocation(cli, env, args): { command; args; cwd }` — worktree: `git -C <path> <args>`; container: `kunj ct exec <branch> -- git <args>` with `cwd: env.repo.root`; `baseRef(env): string` = `origin/<pullRequest.baseBranch>` when known else `origin/HEAD`; `mergeBase(cli, env): Promise<string | null>` runs `git merge-base <baseRef> HEAD` through `gitInvocation` (null on failure); `getDiff(cli, env, mode): Promise<{ files: DiffFile[]; raw: string }>` where `DiffFile { path: string; oldPath: string | null; additions: number; deletions: number; status: 'added' | 'deleted' | 'modified' | 'renamed' }` from `parse-diff`; `fileContents(cli, env, mode, file): Promise<{ original: string; modified: string }>` — original from `git show <sha>:<oldPath>` (sha = merge base / `HEAD` / `HEAD~1`; empty for added), modified from `readFile` (or `git show HEAD:<path>` for `last`; empty for deleted).
- IPC: `diff:list({ envId, mode })`, `diff:file({ envId, mode, path })`.
- Renderer: `DiffPane` = mode dropdown (default `base`), file list with `+n −m`, Monaco `DiffEditor` (read-only, `renderSideBySide` true, language from the extension) for the selected file; a "Refresh" button and automatic refresh on `environments:changed` for this environment.

- [ ] **Step 1: Write the failing tests**

```ts
test.each([...])('gitArgs %s', …)
test('gitInvocation uses git -C for worktrees and kunj ct exec for containers', …)
test('baseRef prefers the PR base', …)
test('getDiff parses the fixture into files with counts and status', …)   // fixture has an added, a modified and a renamed file
test('readFile refuses paths outside the worktree', …)
test('readFile in a container goes through kunj ct file read', …)         // fake-kunj fixture
```

- [ ] **Step 2: Run, implement, run; wire IPC and the pane**

Run: `npm test -- diff files` → PASS; `npm run lint && npm run build`; `npm run dev`: a `+ Diff` tab on a branch with changes shows the files and a side-by-side diff; switching to "uncommitted" changes the list.

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: diff viewer against the base branch"
```

---

### Task 9: Actions

**Files:**
- Create: `workspace-app/src/main/actions.ts`
- Modify: `workspace-app/src/shared/ipc.ts`, `workspace-app/src/preload/index.ts`, `workspace-app/src/main/index.ts`, `workspace-app/src/renderer/components/EnvironmentHeader.tsx`, `workspace-app/src/renderer/components/EnvironmentList.tsx` (repo header "+ Worktree" / "+ Container")
- Test: `workspace-app/src/main/actions.test.ts`

**Interfaces:**
- Consumes: `KunjCli.run`, `PtyManager` + `terminalSpec` action tabs (Task 6), `EnvironmentStore.refreshRepo` (Task 4), Electron `shell.openExternal`, `dialog.showMessageBox`.
- Produces: `actionSpec(env, action: Action): { kind: 'pty'; args: string[]; title: string } | { kind: 'run'; args: string[] } | { kind: 'external'; url: string }` where `Action = 'ct-start' | 'ct-stop' | 'ct-remove' | 'ct-open' | 'wt-open' | 'wt-remove' | 'open-pr' | 'open-port'` and the table is: `ct-start` → pty `kunj ct start <branch>`; `ct-stop` → run `kunj ct stop <branch>`; `ct-remove` → pty `kunj ct remove <branch>` (after a confirm dialog; the pty shows kunj's unpushed-work refusal, a second button offers `--force`); `ct-open` → run `kunj ct open <branch>`; `wt-open` → run `kunj worktree open <branch>`; `wt-remove` → run `kunj worktree remove <branch>` after confirm; `open-pr` → external `pullRequest.url`; `open-port` → external `http://localhost:<host>`. Repo-level: `wt-add(branch)` → run `kunj worktree add -c <branch>`; `ct-create(branch)` → pty `kunj ct start -c <branch>`. After a `run` completes or a pty action exits, `refreshRepo(env.repo.root)`.
- IPC: `action:run({ envId, action, args? })` → `{ ok: true } | { error: { code, message } }`.

- [ ] **Step 1: Write the failing table test** for `actionSpec` (one row per action, plus "ct-remove with force adds --force").

- [ ] **Step 2: Run, implement, run; wire the header buttons and repo-level inputs**

Run: `npm test -- actions` → PASS; `npm run lint && npm run build`; `npm run dev`: start a stopped container from the header (progress in an action tab, list updates on exit), open it in VS Code, open its PR.

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md
git commit -m "workspace-app: container and worktree actions through kunj"
```

---

### Task 10: Packaging, release job and `kunj install workspace`

**Files:**
- Create: `workspace-app/electron-builder.yml`, `workspace-app/build/icon.icns` (reuse the macOS app's icon source if there is one, else a plain generated icon)
- Modify: `workspace-app/package.json` (`package` script, `build` field), `.github/workflows/release.yml` (new `workspace-app` job), `src/lib/apps.ts`, `src/commands/install.ts`, `src/lib/__tests__/apps.test.ts`, `CLAUDE.md`, `docs-site` (install page), `README.md` of `workspace-app/`
- Test: `src/lib/__tests__/apps.test.ts`

**Interfaces:**
- Produces: DMG `Kunj-workspace-<version>.dmg` (arm64, `identity: null` for ad-hoc signing, `asarUnpack: ['**/node_modules/node-pty/**']`, `appId: ai.kunj.workspace`, product name `Kunj Workspace`); release job `workspace-app` (`runs-on: macos-15`, `needs: release`, same `if` as `macos-app`, `npm ci && npm run build && npm run package` in `workspace-app/` with `VERSION` from the release, attaches the DMG with `softprops/action-gh-release@v1`).
- CLI: `CompanionApp` gains `'workspace'` (`label: 'Workspace app (Kunj Workspace.app)'`, `asset: /^Kunj-workspace-.*\.dmg$/`); `installWorkspaceApp(dmgPath: string, options: { launch?: boolean }): Promise<string>` — `hdiutil attach -nobrowse -readonly -mountpoint <tmp>`, `ditto` the `.app` to `macAppDestination()`'s directory as `Kunj Workspace.app`, `hdiutil detach`, `xattr -dr com.apple.quarantine`, optional `open`; `kunj install workspace`, and `all` includes it on darwin; help text updated.

- [ ] **Step 1: Write the failing CLI tests**

In `src/lib/__tests__/apps.test.ts`: `pickAsset(releases, 'workspace', '1.2.3')` finds `Kunj-workspace-1.2.3.dmg` and prefers the matching release; `COMPANION_APPS.workspace.asset` rejects `Kunj-macos-1.2.3.zip`.

- [ ] **Step 2: Run, implement `apps.ts`/`install.ts`, run**

Run: `npm test -- src/lib/__tests__/apps.test.ts` → PASS; `npm run lint`.

- [ ] **Step 3: Package locally**

Run: `cd workspace-app && VERSION=0.0.0-local npm run package`
Expected: `dist/Kunj-workspace-0.0.0-local.dmg`; mount it, drag the app to `/Applications`, launch: the window opens, kunj is found through the login PATH, a container shell works (node-pty loaded from the unpacked asar).

- [ ] **Step 4: Release job and docs**

Add the job to `.github/workflows/release.yml` mirroring `macos-app`; document `kunj install workspace` on the docs-site install page and in `CLAUDE.md` (Key Commands line for `install`, a "Workspace app" paragraph: package layout, CLI-only rule, IPC services, where layout state lives, how to build and package). `cd docs-site && npm run gen`.

- [ ] **Step 5: Full tests and commit**

Run: `npm test && npm run lint && (cd workspace-app && npm test && npm run lint)`

```bash
git add workspace-app .github/workflows/release.yml src/lib/apps.ts src/commands/install.ts src/lib/__tests__/apps.test.ts CLAUDE.md docs-site aj-log.md
git commit -m "workspace-app: DMG packaging, release job and kunj install workspace"
```
