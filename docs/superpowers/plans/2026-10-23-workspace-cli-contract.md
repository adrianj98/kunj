# Workspace CLI Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kunj CLI everything the workspace app needs so the app can drive kunj through `--json` alone: published JSON types, `kunj agent` for worktrees, `kunj ct file read|write`, and `kunj events --json`.

**Architecture:** Four additions to the existing command/registry structure. Types live in one new module that the commands build their output against (`satisfies`), so the published `.d.ts` cannot drift from what the commands print. `kunj agent` reuses the container naming helpers for host tmux session names and reports status through `worktree list --json`. `kunj ct file` is two guarded `exec`s through the `ContainerBackend`. `kunj events` watches `.git` directories, `~/.kunj` files, host tmux sessions and Docker events (through a new backend method) and prints NDJSON.

**Tech Stack:** TypeScript (strict, CommonJS), Commander, Jest + FakeBackend, `fs.watch`, tmux, `docker events` (docker.ts only).

**Spec:** `docs/superpowers/specs/2026-10-23-workspace-ide-design.md` (sections Decisions, Corrections, CLI additions). Discussion: `docs/specs/workspace-ide.md`.

## Global Constraints

- Work on `main`, one commit per task (user rule). Another session is executing `docs/superpowers/plans/2026-10-23-container-phase-2.md` on `main` at the same time and edits `src/commands/container.ts`, `src/lib/container/{backend,docker,forward,autoforward}.ts` and their tests. **Before every task, `git pull --rebase` and check `git status` is clean for the files the task touches**; if phase 2's auto-forward task (Task 3 there) is still uncommitted, do Tasks 1 and 2 here first and wait for it before Tasks 3 and 4.
- Fast path: `agent`, `events` and `ct` load without AWS, LangChain, Jira or inquirer at top level (`src/commands/fast.ts`). No per-worktree or per-container subprocess added to a listing beyond the single `tmux list-sessions` call this plan introduces.
- Every `--json` error is `{ "error": { "code", "message" } }` on stdout with exit code 1 (BaseCommand already does this for thrown errors; give thrown errors a `code`).
- Backend rule: only `src/lib/container/docker.ts` spawns `docker`.
- The CLI JSON output stays backwards compatible: fields are added, never renamed or removed.
- After changing a command's options or a setting, run `npm run gen` in `docs-site/` and commit the JSON.
- Append a line per change to `aj-log.md` (what and why) in each task's commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A branch name with `/`, `.`, `:` or unicode (`feature/v1.2:hotfix`) must yield a tmux session name tmux accepts and that differs from `feature-v1-2-hotfix` (Task 2 test `agentSessionName`).
2. `kunj ct file write` with a path like `../etc/passwd`, `/etc/passwd` or `src/../../x` must be refused before any exec (Task 3 test `validateWorkspacePath`).
3. `kunj events` with Docker stopped must still stream git and session events and say the backend is unavailable once, not crash (Task 4 test `backend unavailable`).
4. `worktree list --json` on a machine without tmux must report `agent: { running: null }`, not fail (Task 2 test in worktree.test.ts).
5. Two writes to `.git/HEAD` within the debounce window must produce one `git` event, and the stream must end when stdin closes so the app can stop it (Task 4 tests `debounce` and `stdin end`).

---

### Task 1: JSON contract types

**Files:**
- Create: `src/lib/json-types.ts`
- Modify: `src/commands/worktree.ts` (`list()`), `src/commands/container.ts` (`list()` JSON branch), `src/commands/repos.ts` (`list` JSON branch), `package.json`
- Test: `src/lib/__tests__/json-types.test.ts`

**Interfaces:**
- Produces (all exported from `src/lib/json-types.ts`):
  - `ErrorJson { error: { code: string; message: string } }`
  - `AgentState { running: boolean | null; session: string }`
  - `WorktreeJson = WorktreeInfo & { openCount: number; changedFiles: number | null; prLabel: string | null }` (`WorktreeInfo` imported as a type from `./worktree`; it gains `agent?: AgentState` in Task 2)
  - `WorktreeListJson { repoRoot: string; currentPath: string | null; pullRequestLookup: PullRequestLookup; pullRequestsFromCache: boolean; worktrees: WorktreeJson[] }`
  - `ReposJson { repos: KnownRepoInfo[] }` (type import from `./repos`)
  - `ContainerPortJson { container: number; host: number; kind: 'publish' | 'forward'; pid?: number }`
  - `ContainerJson`: the exact shape of the object literal built per container in `list()` of `src/commands/container.ts` (branch, name, state, image, imageInfo, blueprint?, createdAt, firewall, ports: `ContainerPortJson[]`, agent: `{ running: boolean | null }`, workspace, status, services). Copy the literal's field names and types; `satisfies` below is what keeps them equal.
  - `ContainerListJson { repo: string; backend: { kind: 'docker'; context: string }; containers: ContainerJson[] }`
- Later tasks add `AgentStatusJson`, `FileReadJson`, `FileWriteJson`, `EventJson` to this file.

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/json-types.test.ts`:

```ts
import type { WorktreeListJson, ContainerListJson, ReposJson, ErrorJson } from '../json-types';

test('json contract types are exported and describe the documented shapes', () => {
  const err: ErrorJson = { error: { code: 'x', message: 'y' } };
  const repos: ReposJson = { repos: [] };
  const worktrees: WorktreeListJson = { repoRoot: '/r', currentPath: null, pullRequestLookup: 'skipped', pullRequestsFromCache: false, worktrees: [] };
  const containers: ContainerListJson = { repo: 'app', backend: { kind: 'docker', context: 'default' }, containers: [] };
  expect([err, repos, worktrees, containers]).toHaveLength(4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/__tests__/json-types.test.ts`
Expected: FAIL, "Cannot find module '../json-types'".

- [ ] **Step 3: Create `src/lib/json-types.ts`** with the interfaces listed under Interfaces, a header comment saying it is the published contract for the VS Code extension, the macOS app and the workspace app, and no runtime imports (type imports only).

- [ ] **Step 4: Make the three commands build their JSON against the types**

In `src/commands/worktree.ts` `list()`: `this.outputJSON({ … } satisfies WorktreeListJson)` (`import type { WorktreeListJson } from '../lib/json-types'`). Same for `src/commands/container.ts` `list()` (`satisfies ContainerListJson`, annotate the `containers` array as `ContainerJson[]`) and `src/commands/repos.ts` (`satisfies ReposJson`). Fix any field type the `satisfies` reports by adjusting the type in `json-types.ts`, never the output.

- [ ] **Step 5: Publish the types**

In `package.json` add `"types": "./dist/lib/json-types.d.ts"` after `"main"`.

- [ ] **Step 6: Run the test, the type check and the build**

Run: `npm test -- src/lib/__tests__/json-types.test.ts && npm run lint && npm run build && test -f dist/lib/json-types.d.ts && echo ok`
Expected: PASS, no type errors, `ok`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/json-types.ts src/lib/__tests__/json-types.test.ts src/commands/worktree.ts src/commands/container.ts src/commands/repos.ts package.json aj-log.md
git commit -m "JSON contract types for the CLI consumers"
```

---

### Task 2: `kunj agent` for worktrees

**Files:**
- Create: `src/lib/repo-identity.ts`, `src/lib/agent-session.ts`, `src/commands/agent.ts`, `src/settings/agent.ts`
- Modify: `src/lib/worktree.ts` (`WorktreeInfo`, `listWorktreesDetailed`), `src/lib/json-types.ts`, `src/lib/config.ts` (`KunjConfig.agent`), `src/settings/index.ts`, `src/commands/index.ts`, `src/commands/fast.ts`, `CLAUDE.md`, `docs-site/src/content/docs/` (new `commands/agent.mdx`, or the page the site uses per command), `docs-site/src/data/*.json`
- Test: `src/lib/__tests__/agent-session.test.ts`, `src/commands/__tests__/agent.test.ts`, `src/lib/__tests__/worktree.test.ts`

**Interfaces:**
- Consumes: `containerNames()`, `repoIdFromUrl()` from `src/lib/container/names.ts`; `getRepoCommonRoot()`, `getRepoName()`, `getOriginUrl()` from `src/lib/config.ts`; `stripUserinfo()` (where `src/commands/container.ts` gets it from); `listWorktreesDetailed()`, `findWorktreeIn()` from `src/lib/worktree.ts`.
- Produces:
  - `src/lib/repo-identity.ts`: `repoIdentity(): { root: string; name: string; id: string; originUrl: string }` — the four lines `context()` in `src/commands/container.ts` computes (root from `getRepoCommonRoot()`, throws `Error('Not in a git repository')` when null; `originUrl = stripUserinfo(getOriginUrl() || '')`; `id = repoIdFromUrl(originUrl || root)`; `name = getRepoName() || path.basename(root)`). container.ts keeps its copy for now (hot file in phase 2).
  - `src/lib/agent-session.ts`:
    - `agentSessionName(repoName: string, repoId: string, branch: string): string` = `containerNames(repoName, repoId, branch).container` with every `.` and `:` replaced by `-`.
    - `listTmuxSessions(): Promise<string[] | null>` — `tmux list-sessions -F '#{session_name}'`; `null` when tmux is not installed (spawn ENOENT), `[]` when tmux exits non-zero (no server).
    - `agentRunning(sessions: string[] | null, name: string): boolean | null`.
    - `agentArgv(name: string, cwd: string, command: string): string[]` = `['tmux', '-u', 'new-session', '-A', '-s', name, '-c', cwd, command, ';', 'set-option', '-t', name, 'window-size', 'latest']`.
    - `class AgentError extends Error { code: 'tmux-missing' | 'no-tty' | 'not-running' | 'no-worktree' }`.
  - `src/lib/json-types.ts`: `AgentStatusJson { branch: string; worktree: string; session: string; running: boolean | null }`, `AgentStopJson { success: true; branch: string; session: string }`.
  - `WorktreeInfo.agent?: AgentState` (`{ running, session }`), set by `listWorktreesDetailed()` for every existing, non-bare worktree with a branch when `includeStatus !== false`, from one `listTmuxSessions()` call per listing.
  - Setting `agent.command` (string, default `'claude'`, category `agent`, description "Command `kunj agent` runs in a host tmux session for a worktree"); `KunjConfig.agent?: { command?: string }`.
  - Command `kunj agent [action] [branch]` where action is `start` (default when the first positional is not `status`/`stop`; a bare `kunj agent my-branch` starts), `status`, `stop`; options `--json`, `--command <cmd>` (overrides `agent.command`). Hook names: none.

- [ ] **Step 1: Write the failing unit tests for the session helpers**

`src/lib/__tests__/agent-session.test.ts`:

```ts
import { agentSessionName, agentRunning, agentArgv } from '../agent-session';

test('session names are tmux-safe and distinguish feature/x from feature-x', () => {
  const a = agentSessionName('app', 'github.com/acme/app', 'feature/v1.2:hotfix');
  const b = agentSessionName('app', 'github.com/acme/app', 'feature-v1-2-hotfix');
  expect(a).toMatch(/^kunj-[A-Za-z0-9_-]+$/);
  expect(a).not.toContain('.');
  expect(a).not.toContain(':');
  expect(a).not.toEqual(b);
});

test('agentRunning is null without tmux', () => {
  expect(agentRunning(null, 'kunj-x')).toBeNull();
  expect(agentRunning(['kunj-x'], 'kunj-x')).toBe(true);
  expect(agentRunning([], 'kunj-x')).toBe(false);
});

test('agentArgv attaches or creates and sets window-size latest', () => {
  expect(agentArgv('kunj-x', '/wt', 'claude')).toEqual(['tmux', '-u', 'new-session', '-A', '-s', 'kunj-x', '-c', '/wt', 'claude', ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest']);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- src/lib/__tests__/agent-session.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/repo-identity.ts` and `src/lib/agent-session.ts`** per Interfaces. `listTmuxSessions` uses `execFile` from `child_process` (promisified), distinguishing `ENOENT` (null) from a non-zero exit (`[]`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/__tests__/agent-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing listing test**

Add to `src/lib/__tests__/worktree.test.ts` (follow the file's existing mocking of `execAsync`/git output):

```ts
jest.mock('../agent-session', () => ({ ...jest.requireActual('../agent-session'), listTmuxSessions: jest.fn() }));
// in a describe('agent status'):
test('worktree agent.running comes from one tmux listing', async () => {
  (listTmuxSessions as jest.Mock).mockResolvedValue([agentSessionName('app', 'github.com/acme/app', 'feature-a')]);
  const listing = await listWorktreesDetailed({ includeStatus: true, includePullRequests: false });
  const a = listing.worktrees.find(w => w.branch === 'feature-a')!;
  expect(a.agent).toEqual({ running: true, session: expect.stringMatching(/^kunj-/) });
  expect(listTmuxSessions).toHaveBeenCalledTimes(1);
});
test('agent.running is null when tmux is missing', async () => {
  (listTmuxSessions as jest.Mock).mockResolvedValue(null);
  const listing = await listWorktreesDetailed({ includeStatus: true, includePullRequests: false });
  expect(listing.worktrees.find(w => w.branch === 'feature-a')!.agent!.running).toBeNull();
});
```

Use the repo name and origin the existing worktree tests already mock (mock `repoIdentity` from `../repo-identity` if the test file does not mock config getters).

- [ ] **Step 6: Run it to verify it fails, then implement**

Run: `npm test -- src/lib/__tests__/worktree.test.ts -t "agent"`
Expected: FAIL (`agent` undefined).

Implement in `listWorktreesDetailed()`: when `options.includeStatus !== false`, `const sessions = await listTmuxSessions()` in the same `Promise.all` as the git calls, `const identity = repoIdentity()` (inside a try: outside a repo with an origin, fall back to `name = path.basename(repoRoot)`, `id = commonDir`), then per worktree with a branch and `exists && !bare`: `info.agent = { running: agentRunning(sessions, name), session: name }` where `name = agentSessionName(identity.name, identity.id, wt.branch)`.

Run: `npm test -- src/lib/__tests__/worktree.test.ts`
Expected: PASS (all, including the existing ones).

- [ ] **Step 7: Write the failing command tests**

`src/commands/__tests__/agent.test.ts`, mocking `../../lib/worktree` (`listWorktreesDetailed` returning one worktree `{ branch: 'feature-a', path: '/wt/feature-a', exists: true, bare: false, … }`), `../../lib/repo-identity`, `../../lib/agent-session` (`listTmuxSessions`, and a `spawnAgent` seam you add: `runTmux(argv: string[], cwd: string, env: Record<string,string>): Promise<number>`), `../../lib/config` (`loadResolvedConfig` → `{ agent: { command: 'claude' } }`), and `../../lib/git` (`getCurrentBranch`). Tests:

```ts
test('status --json reports the session', …)          // expect outputJSON({ branch: 'feature-a', worktree: '/wt/feature-a', session: expect.stringMatching(/^kunj-/), running: true })
test('start runs tmux in the worktree with agent.command', …) // runTmux called with agentArgv(session, '/wt/feature-a', 'claude'), cwd '/wt/feature-a', env containing KUNJ_BRANCH='feature-a'
test('start without tmux fails with tmux-missing', …)  // listTmuxSessions → null; rejects with AgentError code 'tmux-missing'
test('stop when not running fails with not-running', …)
test('unknown branch fails with no-worktree', …)
```

Capture `outputJSON` the way `src/commands/__tests__/container.test.ts` does.

- [ ] **Step 8: Run them to verify they fail, then implement `src/commands/agent.ts` and the setting**

`AgentCommand extends BaseCommand` (`name: 'agent'`, description "Run or reattach an agent in a worktree (tmux)", options `--json`, `--command <cmd>`, `helpText` listing `start|status|stop`). `execute(action?, branch?, options)`: resolve the worktree (`findWorktreeIn(listing.worktrees, branch ?? currentBranch)` → `AgentError('no-worktree')`), compute `session`, then:
- `start`: `listTmuxSessions() === null` → `AgentError('tmux-missing', 'tmux is not installed; brew install tmux')`; `!process.stdin.isTTY` → `AgentError('no-tty')`; `process.exitCode = await runTmux(agentArgv(session, wt.path, command), wt.path, { ...process.env, KUNJ_BRANCH, KUNJ_REPO, KUNJ_WORKTREE })` where `runTmux` is `spawn` with `stdio: 'inherit'` resolved on exit.
- `status`: `--json` → `AgentStatusJson`; otherwise one line.
- `stop`: `tmux kill-session -t <session>`; not in the listing → `AgentError('not-running')`; `--json` → `AgentStopJson`.
`AgentError` must print without a stack trace like `ContainerError` (check how BaseCommand recognises those and do the same).
Register: `src/settings/agent.ts` (export `registerAgentSettings()` in the style of `src/settings/container.ts`), call it from `src/settings/index.ts`, add `agent?: { command?: string }` to `KunjConfig`, export `AgentCommand` from `src/commands/index.ts` and add it to `getAllCommands()`, add `agent` to `FAST_COMMANDS` in `src/commands/fast.ts`.

Run: `npm test -- src/commands/__tests__/agent.test.ts`
Expected: PASS.

- [ ] **Step 9: Check the fast path stays light**

Run: `npm run build && time node dist/index.js agent --help >/dev/null`
Expected: help printed; real time well under 0.5 s (compare with `time node dist/index.js worktree --help`).

- [ ] **Step 10: Docs**

Run `cd docs-site && npm run gen`; add a docs page for `kunj agent` next to the other command pages (what it does, the session name rule, `agent.command`, the `worktree list --json` `agent` field); in `CLAUDE.md` add `kunj agent [start|status|stop] [branch]` to Key Commands and a short "Worktree agents" paragraph (session name = container name with `.`/`:` replaced, one `tmux list-sessions` per listing, null without tmux).

- [ ] **Step 11: Full test run and commit**

Run: `npm test && npm run lint`
Expected: all pass.

```bash
git add src/lib/repo-identity.ts src/lib/agent-session.ts src/commands/agent.ts src/settings/agent.ts src/settings/index.ts src/lib/config.ts src/lib/worktree.ts src/lib/json-types.ts src/commands/index.ts src/commands/fast.ts src/lib/__tests__/agent-session.test.ts src/commands/__tests__/agent.test.ts src/lib/__tests__/worktree.test.ts CLAUDE.md docs-site aj-log.md
git commit -m "kunj agent: host tmux sessions for worktrees, reported by worktree list"
```

---

### Task 3: `kunj ct file read|write`

**Files:**
- Create: `src/lib/container/files.ts`
- Modify: `src/commands/container.ts` (ACTIONS, dispatch, help text, a `file()` method), `src/lib/json-types.ts`, `CLAUDE.md`, the container docs page, `docs-site/src/data/*.json`
- Test: `src/lib/container/__tests__/files.test.ts`, `src/commands/__tests__/container.test.ts`

**Interfaces:**
- Consumes: `ContainerBackend.exec(id, cmd, io)` with `io.stdin` as a stream (docker.ts pipes it with `-i`), `WORKSPACE` constant, `userOf()`/`requireRunning()` in container.ts, `ContainerError`.
- Produces (`src/lib/container/files.ts`):
  - `validateWorkspacePath(p: string): string` — returns the POSIX-normalised relative path; throws `ContainerError` with `code = 'bad-path'` when empty, absolute, containing a `..` segment after normalisation, or containing a NUL byte.
  - `readWorkspaceFile(backend, id, relPath, user?: string): Promise<string>` — `exec(id, ['sh', '-c', 'cat -- "$1"', 'sh', relPath], { user, workdir: WORKSPACE })`; non-zero exit → `ContainerError` code `not-found`.
  - `writeWorkspaceFile(backend, id, relPath, stdin: NodeJS.ReadableStream, user?: string): Promise<void>` — `exec(id, ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', relPath], { stdin, user, workdir: WORKSPACE })`; non-zero → `ContainerError` code `write-failed`.
  - `json-types.ts`: `FileReadJson { path: string; content: string }`, `FileWriteJson { success: true; path: string }`.
- Command: `kunj ct file read [branch] <path>` prints the content raw (`--json`: `FileReadJson`); `kunj ct file write [branch] <path>` reads stdin to EOF (`--json`: `FileWriteJson`, else `✓ wrote <path>`). With two positionals after the verb the first is the branch; with one, the branch is the current one. Container must be running.

- [ ] **Step 1: Write the failing helper tests**

`src/lib/container/__tests__/files.test.ts` with `FakeBackend`:

```ts
test.each(['', '/etc/passwd', '../x', 'src/../../x', 'a\0b'])('refuses %j', p => {
  expect(() => validateWorkspacePath(p)).toThrow(expect.objectContaining({ code: 'bad-path' }));
});
test('normalises ./src//a.ts', () => expect(validateWorkspacePath('./src//a.ts')).toBe('src/a.ts'));
test('read runs cat as the sandbox user in /workspace', …)   // inspect backend.execCalls: cmd, user 'dev', workdir '/workspace'
test('read of a missing file is not-found', …)                 // fake exec exit 1 → code 'not-found'
test('write pipes stdin and creates the directory', …)         // cmd contains 'mkdir -p' and 'cat >', stdin passed through (FakeBackend records stdin)
```

- [ ] **Step 2: Run them to verify they fail, then implement `src/lib/container/files.ts`**

Run: `npm test -- src/lib/container/__tests__/files.test.ts`
Expected: FAIL then PASS after implementing per Interfaces. `ContainerError` needs a `code` property if it has none: add an optional `code?: string` constructor argument (check its definition in container.ts or lifecycle.ts; keep existing callers working).

- [ ] **Step 3: Write the failing command tests**

In `src/commands/__tests__/container.test.ts` (existing harness):

```ts
test('ct file read --json prints the content', …)   // backend exec resolves { exitCode: 0, stdout: 'hello' } → outputJSON({ path: 'src/a.ts', content: 'hello' })
test('ct file write --json reads stdin', …)         // mock process.stdin as a Readable of 'new' → outputJSON({ success: true, path: 'src/a.ts' }), exec called with a stdin stream
test('ct file read with one positional uses the current branch', …)
test('ct file read on a stopped container fails', …) // existing requireRunning error
```

- [ ] **Step 4: Run them to verify they fail, then wire the command**

Add `'file'` to `ACTIONS`, a `case 'file'` in the dispatcher (parse `read|write`, branch, path the way `blueprint <sub>` is parsed), `private async file(sub, branch, relPath, options)` using `requireRunning`, `userOf`, and the helpers; help text lines `file read [branch] <path>` / `file write [branch] <path>  (content on stdin)`. In `--json` mode the error path uses `ContainerError.code` as the JSON `code` (check `outputJSON`/error handling in BaseCommand prints `code` when present; if it prints a fixed code, extend it to use `error.code ?? 'error'`).

Run: `npm test -- src/commands/__tests__/container.test.ts`
Expected: PASS.

- [ ] **Step 5: Docker check (optional when Docker is available)**

Run: `npm run build && kunj ct start <some-branch> && echo hi | node dist/index.js ct file write <some-branch> tmp/x.txt && node dist/index.js ct file read <some-branch> tmp/x.txt`
Expected: `hi`; `node dist/index.js ct exec <some-branch> -- stat -c %U tmp/x.txt` prints the sandbox user.

- [ ] **Step 6: Docs, full tests, commit**

Add `file read|write` to the container docs page and to the `kunj container` line in `CLAUDE.md` Key Commands, plus one sentence under Branch Containers ("`ct file` validates paths against `/workspace` and runs as the sandbox user"). `cd docs-site && npm run gen`.

Run: `npm test && npm run lint`

```bash
git add src/lib/container/files.ts src/lib/container/__tests__/files.test.ts src/commands/container.ts src/commands/__tests__/container.test.ts src/lib/json-types.ts CLAUDE.md docs-site aj-log.md
git commit -m "kunj ct file read|write: workspace files through the CLI"
```

---

### Task 4: `kunj events --json`

**Files:**
- Create: `src/lib/events.ts`, `src/commands/events.ts`
- Modify: `src/lib/container/backend.ts` (`BackendEvent`, `events()`), `src/lib/container/docker.ts` (`events()`, `parseDockerEvent()`), `src/lib/container/__tests__/fake-backend.ts` (`emitEvent()`), `src/lib/json-types.ts`, `src/commands/index.ts`, `src/commands/fast.ts`, `CLAUDE.md`, docs page, `docs-site/src/data/*.json`
- Test: `src/lib/__tests__/events.test.ts`, `src/lib/container/__tests__/docker.test.ts`

**Interfaces:**
- Consumes: `listRepos()` / `KnownRepoInfo` (`src/lib/repos.ts`), `getGlobalKunjDir()`, `WORKTREE_SESSIONS_FILE`, `REPOS_FILE`, the forwards file name from `src/lib/container/autoforward.ts` (`forwardsFile()`), `listTmuxSessions()` (Task 2), `repoIdFromUrl()`, `LABEL` (names.ts), `LocalDockerBackend`.
- Produces:
  - `backend.ts`: `BackendEvent { action: string; name: string; labels: Labels; at: string }`; `ContainerBackend.events(filter: Labels, onEvent: (e: BackendEvent) => void, signal: AbortSignal): Promise<void>` — resolves when the signal aborts, rejects when the daemon is unreachable.
  - `docker.ts`: `events()` runs `docker events --format '{{json .}}' --filter type=container` plus `--filter label=<k>=<v>` per filter entry (or `--filter label=<k>` when the value is `''`); `parseDockerEvent(line: string): BackendEvent | null` maps `Action`, `Actor.Attributes.name`, the `kunj.*` attributes, `timeNano`.
  - `fake-backend.ts`: `emitEvent(e: BackendEvent)` delivers to every active `events()` subscriber.
  - `json-types.ts`: `EventJson = { at: string } & ({ type: 'hello'; version: string; repos: number } | { type: 'git' | 'sessions' | 'forwards' | 'repos'; repo?: { name: string; root: string } } | { type: 'container'; repo: { name: string; root: string } | null; branch: string | null; container: string; action: string } | { type: 'agent'; session: string; running: boolean } | { type: 'backend'; status: 'available' | 'unavailable'; message?: string })`.
  - `src/lib/events.ts`: `watchEvents(options: { repos: KnownRepoInfo[]; kunjDir: string; backend: ContainerBackend | null; onEvent: (e: EventJson) => void; signal: AbortSignal; debounceMs?: number /* 250 */; tmuxPollMs?: number /* 5000 */; backendRetryMs?: number /* 10000 */; now?: () => Date }): Promise<void>`. Also `gitPathMatters(relative: string): boolean` (true for `HEAD`, `ORIG_HEAD`, `index`, anything under `refs/`, `packed-refs`, anything under `worktrees/` except `*/logs/*`; false for `logs/`, `objects/`, `*.lock`).
- Command `kunj events [--json] [--repo <path>...]` (fast path): without `--repo` all known, non-hidden, existing repos; prints one `EventJson` per line in `--json` mode and `<time> <type> <repo> …` otherwise; first event `hello`; ends on SIGINT/SIGTERM or when stdin ends.

- [ ] **Step 1: Write the failing watcher tests**

`src/lib/__tests__/events.test.ts` using a temp `HOME`-like dir with a fake `.git` (files `HEAD`, `refs/heads/main`) and a fake kunj dir:

```ts
test('gitPathMatters', …)  // table: 'HEAD' true, 'refs/heads/x' true, 'logs/HEAD' false, 'objects/ab/cd' false, 'index.lock' false, 'worktrees/a/HEAD' true
test('two HEAD writes within the debounce yield one git event with the repo', …)
test('writing worktree-sessions.json yields a sessions event', …)
test('a backend event maps kunj.repo to the known repo and carries the branch', …)   // FakeBackend.emitEvent({ action: 'start', name: 'kunj-app-x-abc123', labels: { 'kunj.repo': 'github.com/acme/app', 'kunj.branch': 'x' } })
test('backend unavailable is reported once and the git watcher still works', …)    // backend.events rejects; expect one { type: 'backend', status: 'unavailable' } then a git event
test('a new kunj- tmux session yields an agent event', …)                            // mock listTmuxSessions: [] then ['kunj-app-x-abc123']; tmuxPollMs 10
test('aborting the signal resolves watchEvents', …)
```

Map repos to ids inside `watchEvents` by reading each repo's origin once at start (`git -C <gitCommonDir> config --get remote.origin.url`, `execFile`), `repoIdFromUrl(url || gitCommonDir)`; in the test mock `child_process.execFile` or pass a `repoId?: (repo) => Promise<string>` option (choose the option; default implementation does the git call).

- [ ] **Step 2: Run them to verify they fail, then implement `src/lib/events.ts`**

`fs.watch(gitCommonDir, { recursive: true })` (Node ≥ 20 on macOS and Linux) filtered by `gitPathMatters`, one debounce timer per repo; `fs.watch(kunjDir)` non-recursive, file name → event type (`WORKTREE_SESSIONS_FILE` → `sessions`, `path.basename(forwardsFile())` → `forwards`, `REPOS_FILE` → `repos`); tmux poll comparing the set of `kunj-` names; backend subscription with retry on rejection (`backend` unavailable once, `available` again when a retry succeeds); everything torn down on abort. A watcher that throws (missing directory) is skipped, not fatal.

Run: `npm test -- src/lib/__tests__/events.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing backend tests**

In `src/lib/container/__tests__/docker.test.ts`: `parseDockerEvent` on a real `docker events --format '{{json .}}'` line (`{"status":"start","Action":"start","Type":"container","Actor":{"ID":"…","Attributes":{"name":"kunj-app-x-abc123","kunj.repo":"github.com/acme/app","kunj.branch":"x","kunj.role":"main"}},"timeNano":1760000000000000000}`) → `{ action: 'start', name: 'kunj-app-x-abc123', labels: { 'kunj.repo': …, 'kunj.branch': 'x', 'kunj.role': 'main' }, at: '2025-10-09T…Z' }`; a non-JSON line → `null`. In the FakeBackend tests (or lifecycle tests): `emitEvent` reaches a subscriber and `events()` resolves on abort.

- [ ] **Step 4: Run them to verify they fail, then implement the backend method**

`backend.ts` interface + `BackendEvent`; `docker.ts` `events()` spawning the command through the same helper the other methods use (context flag included), line-splitting stdout, resolving on abort (kill the child), rejecting on a non-zero exit before any line; `fake-backend.ts` `events()` keeps subscribers in a Set and `emitEvent()` fans out.

Run: `npm test -- src/lib/container`
Expected: PASS.

- [ ] **Step 5: Write the failing command test, then implement `src/commands/events.ts`**

`src/commands/__tests__/events.test.ts`: mock `../../lib/events` (`watchEvents`) and `../../lib/repos` (`listRepos` → two repos, one hidden); `--json` prints the `hello` line with `repos: 1` and forwards each `onEvent` as one JSON line to stdout; `--repo /x` limits to that repo; closing a fake stdin aborts the signal. Implement `EventsCommand` (`name: 'events'`, options `--json`, `--repo <path...>`), on the fast path (`fast.ts`), exported from `index.ts`; backend = `new LocalDockerBackend({ context: config.container?.dockerContext })` from `loadResolvedConfig()`; stdout writes use `process.stdout.write(JSON.stringify(e) + '\n')`.

Run: `npm test -- src/commands/__tests__/events.test.ts`
Expected: PASS.

- [ ] **Step 6: Manual check**

Run in a kunj repo: `npm run build && node dist/index.js events --json & sleep 1; git commit --allow-empty -m tmp -q; sleep 1; kill %1; git reset --hard HEAD~1 -q`
Expected: a `hello` line, then one `git` line naming this repo.

- [ ] **Step 7: Docs, full tests, commit**

Docs page for `kunj events` (event types table, "stops when stdin closes"); `CLAUDE.md`: Key Commands line and a "Events" paragraph (what is watched, debounce, backend retry, fast path). `cd docs-site && npm run gen`.

Run: `npm test && npm run lint`

```bash
git add src/lib/events.ts src/commands/events.ts src/lib/__tests__/events.test.ts src/commands/__tests__/events.test.ts src/lib/container/backend.ts src/lib/container/docker.ts src/lib/container/__tests__/fake-backend.ts src/lib/container/__tests__/docker.test.ts src/lib/json-types.ts src/commands/index.ts src/commands/fast.ts CLAUDE.md docs-site aj-log.md
git commit -m "kunj events: NDJSON change stream for the workspace app"
```

---

### Task 5: Contract check and release note

**Files:**
- Modify: `CLAUDE.md` (a "Workspace app contract" paragraph under Worktrees & VS Code Extension), `docs/superpowers/specs/2026-10-23-workspace-ide-design.md` (CLI additions marked shipped), `aj-log.md`

- [ ] **Step 1: Verify the published types resolve from outside the package**

Run from a temp dir: `mkdir -p /tmp/kunj-types-check && cd /tmp/kunj-types-check && npm init -y >/dev/null && npm i --no-save /Users/adrian/projects/kunj >/dev/null && printf "import type { WorktreeListJson, ContainerListJson, EventJson, AgentStatusJson, FileReadJson } from 'kunj';\nconst x: EventJson = { type: 'hello', at: '', version: '1', repos: 0 }; console.log(typeof x);\n" > check.ts && npx -y typescript@5 tsc --noEmit --esModuleInterop --skipLibCheck --moduleResolution node check.ts && echo types-ok`
Expected: `types-ok`.

- [ ] **Step 2: Document the contract**

In `CLAUDE.md` add: the JSON types in `src/lib/json-types.ts` are the published contract (`types` in package.json), commands build their JSON with `satisfies`, fields are only ever added; consumers: VS Code extension, macOS app, workspace app. In the design spec mark the four CLI additions as shipped with the commit hashes.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-23-workspace-ide-design.md aj-log.md
git commit -m "Workspace CLI contract: document the published JSON types"
```
