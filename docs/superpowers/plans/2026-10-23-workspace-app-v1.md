# Workspace App v1 Implementation Plan (native)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native macOS app, `workspace-app/`, that lists every worktree and branch container as an environment, keeps terminals and agent sessions per environment alive, shows the Changes column with Monaco, edits files, and runs every action through the installed `kunj` CLI, looking like `docs/workspace-app/design/mockups/warm.png`.

**Architecture:** One AppKit process (Swift, SwiftPM, no Xcode). `KunjWorkspaceCore` (Foundation only, `swift test`) holds the CLI runner, the JSON mirrors, the environment model and store, the event stream, terminal specs, diff and file services and the layout file. `KunjWorkspace` holds the views, SwiftTerm terminals and two Monaco WKWebViews. State comes from `kunj … --json`, refreshed by `kunj events --json`; agents live in tmux sessions kunj names. The spec's Architecture section is the design; this plan is its task list.

**Tech Stack:** Swift 6.4 toolchain (Command Line Tools, Swift 5 language mode), AppKit, WebKit, SwiftTerm 1.20.0 (vendored, patched), monaco-editor 0.57.0 (AMD `min/vs`), Inter + JetBrains Mono (bundled), Swift Testing (`import Testing`; the Command Line Tools do not reliably ship XCTest); TypeScript/Jest for the CLI task.

**Spec:** `docs/specs/workspace-ide.md` (Layout, Architecture, Decisions) and `docs/workspace-app/design/` (DESIGN.md, tokens.json, mockups).

## Global Constraints

- Work on `main`, one commit per task, push after each (user rule). `workspace-app/` is its own package; nothing in `src/` changes except in Tasks 1 and 12.
- The CLI is the only contract: the app runs `kunj … --json` and never imports kunj's runtime, never runs `docker`, and runs `git` only read-only for diff content in worktrees, always with `GIT_OPTIONAL_LOCKS=0`.
- Every kunj invocation runs with `currentDirectoryURL` = the repository `root` from `kunj repos --json` and names the branch explicitly; `kunj repos --json` itself, which has no repository yet, runs in the user's home.
- `MIN_KUNJ_VERSION = "1.3.0"` (the first release after v1.2.0; `package.json` is `1.0.0` on main and the release workflow rewrites it). A kunj reporting `1.0.0` is a dev build: accepted, shown as `dev`.
- macOS 14+, arm64 and x86_64 (`bundle.sh` builds each with `swift build --triple <arch>-apple-macosx14.0` in its own scratch dir and joins them with `lipo`; `--arch arm64 --arch x86_64` switches to XCBuild, which cannot link SwiftTerm's plugin for x86_64 under the Command Line Tools), ad-hoc signed, not notarized.
- Terminal env for every PTY: `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG` from the user's environment or `en_US.UTF-8`, PATH from the login shell; `NO_COLOR`, `FORCE_COLOR`, `TERM_PROGRAM*`, `TERM_SESSION_ID` and every `CLAUDECODE*`/`CLAUDE_CODE*` variable removed.
- Every colour, size and radius comes from `DesignTokens` (generated from `tokens.json`); no literal colours in views. Sans = Inter, mono = JetBrains Mono (bundled), with the system fonts as fallback when registration fails.
- Append a line per change to `aj-log.md`; commit messages end with the session's `Co-Authored-By:` attribution line (currently `Claude Opus 5.5 <noreply@anthropic.com>`).
- Tests use Swift Testing: the snippets below are written as `func testX()`/`XCTAssert…` shorthand; write them as `@Test func x()` with `#expect`/`#require` (a throw check is `#expect(throws:)`, a skip is a `.enabled(if:)` trait). Shared helpers live in `Tests/KunjWorkspaceCoreTests/Support.swift` (`appRoot`, `repoRoot`, `fixturesDir`, `responsesDir`, `fakeKunjPath`, `fakeKunjResponseName`, `tempDirectory`, `runFakeKunj`).
- Run `scripts/test.sh` and `scripts/bundle.sh` with your own `SCRATCH=.build/<name>` when other agents build at the same time (`ARCHS=arm64` while iterating); `build/` is shared, so screenshot right after your own bundle.
- The app has no automated UI tests; every UI task ends with `scripts/bundle.sh`, a `--demo --screenshot` render compared against `warm.png`, and a run against the real kunj.

## Review Focus

1. kunj missing from the login-shell PATH, or older than `MIN_KUNJ_VERSION`: the window shows one message with `npm install -g kunj`, not an empty list (Task 3 tests `not-found` and `too-old`; Task 6 renders the error state).
2. Docker stopped: worktrees still list, that repo's containers show as unavailable, the event stream keeps running after its `backend` event (Task 4 test `container listing fails`, Task 5 test `backend event refreshes all`).
3. An environment whose worktree is gone (`exists == false`) or whose container is stopped: Shell and Agent are refused with a reason, never a PTY that exits at once (Task 7 `TerminalSpec` tests).
4. Quitting with ten PTYs and the events child open leaves no orphan `kunj events`, `kunj ct shell` or `claude` (Task 5 test `stop closes stdin and waits`; Task 7 terminates every tab on quit; `kunj events` ends when stdin closes).
5. A branch named `feature/x` round-trips through the environment id, the layout file key and the tmux attach (Task 4 test `slash id`, Task 8 test `slash key`).

---

### Task 1: CLI: agent waiting state through Claude Code hooks

**Files:**
- Modify: `src/lib/json-types.ts` (`AgentState.state`, `EventJson` agent `state`), `src/lib/agent-session.ts`, `src/commands/agent.ts`, `src/commands/container.ts` (the `agent` case), `src/lib/container/env.ts` (`STATUS_SCRIPT`, `parseStatus`, `ContainerStatus.agentState`), `src/lib/worktree.ts` (`agent.state`), `src/lib/events.ts`, `src/settings/agent.ts` (`agent.hooks`), `docs/specs/workspace-ide.md` (CLI contract paragraph), docs-site reference JSON (`npm run gen`)
- Test: `src/lib/__tests__/agent-session.test.ts`, `src/lib/container/__tests__/env.test.ts`, `src/lib/__tests__/events.test.ts`, `src/commands/__tests__/agent.test.ts` (extend the existing files)

**Interfaces:**
- Produces (`agent-session.ts`):
  - `export type AgentHookState = 'running' | 'waiting'`
  - `export function agentStateDir(kunjDir: string): string` → `<kunjDir>/agent-state`
  - `export function agentStateFile(kunjDir: string, session: string): string`
  - `export function claudeHookSettings(stateFile: string): string` → JSON text with `hooks.UserPromptSubmit`, `hooks.PreToolUse` (command `printf running > "$KUNJ_AGENT_STATE"`), `hooks.Stop`, `hooks.Notification` (matcher `permission_prompt|idle_prompt|elicitation_dialog`, command `printf waiting > "$KUNJ_AGENT_STATE"`), `hooks.SessionEnd` (`rm -f "$KUNJ_AGENT_STATE"`); every command is `sh -c '…'`-safe with no quotes inside
  - `export function withAgentHooks(command: string, stateFile: string, enabled: boolean): string` → `command` unchanged unless `enabled` and its first word's basename is `claude`; then `<command> --settings '<json>'` with the JSON single-quoted for the shell (`'` → `'\''`)
  - `export function readAgentState(stateFile: string): AgentHookState | null` (trimmed file content when it is one of the two states, else null)
  - `tmuxNewSessionArgs(...)` gains `-e KUNJ_AGENT_STATE=<file>`; the no-tmux path sets it in the env
- `kunj ct agent`: the command string becomes `KUNJ_AGENT_STATE=/tmp/kunj-agent-state <withAgentHooks(command)>`; `STATUS_SCRIPT` prints `state=$(cat /tmp/kunj-agent-state 2>/dev/null)`; `parseStatus` sets `agentState: 'running' | 'waiting' | null`; `ct list --json` `agent: { running, state }`.
- `worktree list --json`: `agent: { running, session, state }` with `state` from `readAgentState(agentStateFile(kunjDir, session))` when `running` is true, else null.
- `kunj events`: `fs.watch` on `agentStateDir` of every repo (created on demand, like `refs/`), emitting `{ type: 'agent', session, running: true, state }` on change; the container poll hash includes `agentState` and the `container` status event carries nothing new (the app refreshes).
- `json-types.ts`: `AgentState { running; session; state?: 'running' | 'waiting' | null }`; `EventJson` agent variant gains `state?: 'running' | 'waiting' | null`.
- Setting `agent.hooks` (boolean, default `true`, category `ai`? no: category `core` next to `agent.command`): "Install Claude Code hooks that report when the agent waits for input".

- [ ] **Step 1: Write the failing unit tests**

```ts
// agent-session.test.ts
test('withAgentHooks appends --settings for claude', () => expect(withAgentHooks('claude', '/s', true)).toMatch(/^claude --settings '\{"hooks":/));
test('withAgentHooks leaves other commands and disabled alone', …);          // 'aider' unchanged; enabled false unchanged
test('claudeHookSettings is valid JSON with the five hooks', …);             // JSON.parse, keys UserPromptSubmit, PreToolUse, Stop, Notification, SessionEnd; Notification matcher as above
test('readAgentState reads running, waiting, else null', …);                 // temp files: 'waiting\n' → 'waiting'; 'bogus' → null; missing → null
test('tmuxNewSessionArgs carries KUNJ_AGENT_STATE', …);
// env.test.ts
test('parseStatus reads state=waiting', …);                                  // 'tmux=0\nstate=waiting\n# branch.oid abc' → agentRunning true, agentState 'waiting'
test('parseStatus with no state line gives null', …);
// events.test.ts
test('a write to agent-state/<session> emits an agent event with state', …); // temp HOME, fake tmux list: write 'waiting' → { type: 'agent', session, running: true, state: 'waiting' }
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -- agent-session env events`
Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement the helpers, the setting, the three commands, `STATUS_SCRIPT`, `worktree list` and `events`**

In `src/commands/agent.ts` the state file is `agentStateFile(getKunjDir(), name)` and its directory is created before start. In `src/commands/container.ts` `agent` case, build the command with `withAgentHooks(cfg.agentCommand ?? CONTAINER_AGENT_COMMAND_DEFAULT, '/tmp/kunj-agent-state', config.agent.hooks)` and prefix the env assignment. Keep `src/commands/agent.ts` on the fast path (no new heavy imports).

- [ ] **Step 4: Run the tests, the type check and the docs generator**

Run: `npm test && npm run lint && (cd docs-site && npm run gen)`
Expected: PASS; `docs-site/src/data/*.json` updated with `agent.hooks`.

- [ ] **Step 5: Check it live**

Run: `npm run build && node dist/index.js agent start main` in a spare terminal, ask claude something, then `cat ~/.kunj/kunj/agent-state/kunj-main-*` while it answers (`running`) and after (`waiting`); `node dist/index.js worktree list --json | jq '.worktrees[] | select(.branch=="main").agent'` shows `state`.

- [ ] **Step 6: Update the spec and commit**

Add the agent-state paragraph to the spec's CLI contract (shipped) and the tracker line in `docs/specs/README.md`; remove the `ct agent window-size latest` open question (it is already set, container.ts line 575).

```bash
git add -A src docs aj-log.md && git commit -m "kunj agent: report waiting-for-input through Claude Code hooks" && git push
```

---

### Task 2: Scaffold the Swift package, tokens and build scripts

**Files:**
- Create: `workspace-app/Package.swift`, `workspace-app/.gitignore`, `workspace-app/README.md`, `workspace-app/Resources/Info.plist`, `workspace-app/Resources/web/index.html` (placeholder page, replaced in Task 9), `workspace-app/web/package.json`, `workspace-app/web/copy-monaco.js`, `workspace-app/scripts/prepare-swiftterm.sh`, `workspace-app/scripts/fetch-fonts.sh`, `workspace-app/scripts/gen-tokens.js`, `workspace-app/scripts/bundle.sh`, `workspace-app/scripts/test.sh`, `workspace-app/Sources/KunjWorkspaceCore/Design/DesignTokens.swift` (generated), `workspace-app/Sources/KunjWorkspaceCore/Design/HexColor.swift`, `workspace-app/Sources/KunjWorkspace/main.swift`, `workspace-app/Sources/KunjWorkspace/AppDelegate.swift`, `workspace-app/Sources/KunjWorkspace/Views/MainWindowController.swift`
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/DesignTokensTests.swift`

**Interfaces:**
- Produces (`DesignTokens.swift`, generated, `public enum DesignTokens`):
  - `public struct ThemeTokens: Equatable { public let name: String; public let bg, side, raised, raised2, border, borderStrong, text, text2, muted, faint, faintest, idle, amber, green, red, addBg, link, primaryBg, primaryFg, primaryHint, term, termText, termMuted, termAccent: String }` (hex strings as in the JSON)
  - `public static let warm, light, graphite: ThemeTokens`; `public static let themes: [ThemeTokens]`
  - `public enum Layout { public static let sidebarWidth = 272.0, headerHeight = 52.0, tabbarHeight = 40.0, statusbarHeight = 28.0, changesFileListWidth = 196.0, sidebarRowPaddingV = 9.0, sidebarRowPaddingH = 10.0; public static let paneSplit: (Double, Double) = (11, 9) }`
  - `public enum Radius { public static let control = 5.0, card = 6.0, window = 12.0 }`
  - `public enum TypeScale { public static let body = 13.0, small = 12.0, caption = 11.0, monoTerminal = 12.5, monoDiff = 11.5, title = 14.0, hint = 10.5 }`
  - `public enum Fonts { public static let sans = "Inter", mono = "JetBrainsMono" }`: PostScript name prefixes, not family names; use `NSFont(name: "\(Fonts.mono)-Regular", …)` (`-Medium`, and `-SemiBold` for Inter)
- `HexColor.swift`: `public struct RGBA: Equatable { r, g, b, a: Double }`, `public func parseHex(_ s: String) -> RGBA?` (`#rgb`, `#rrggbb`, `#rrggbbaa`).
- `Package.swift`: tools 5.10, platforms `.macOS(.v14)`, dependency `.package(path: "vendor/SwiftTerm")`, targets `KunjWorkspaceCore` (no deps), `KunjWorkspace` (Core, SwiftTerm), `KunjWorkspaceCoreTests`.
- `scripts/gen-tokens.js`: `node scripts/gen-tokens.js` reads `../docs/workspace-app/design/tokens.json` and writes `DesignTokens.swift` with a `// Generated by scripts/gen-tokens.js from docs/workspace-app/design/tokens.json; do not edit` header.
- `scripts/fetch-fonts.sh`: downloads Inter 4.1 (`https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip`) and JetBrains Mono 2.304 (`https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip`), checks a pinned sha256 of each zip, extracts `Inter-Regular/Medium/SemiBold.ttf` (the static `extras/ttf` files, or `InterVariable.ttf`) and `JetBrainsMono-Regular/Medium.ttf` into `Resources/fonts/`, skipping when present. `Info.plist` has `ATSApplicationFontsPath` = `fonts`.
- `scripts/bundle.sh`: like the spike's (SwiftTerm prepare, Monaco copy, fonts, a release build per arch (`--triple`, `<SCRATCH>/release-<arch>`) joined with `lipo`, with the SDK fallback; `SCRATCH`, `ARCHS`, `VERSION`, `CODESIGN_IDENTITY`, `SDKROOT` documented in the README; `build/Kunj Workspace.app`, Info.plist from `Resources/Info.plist` with `__VERSION__`, SwiftTerm resource bundle, `codesign --sign -`); `--install` copies to `/Applications/Kunj Workspace.app` and launches with `env -u NO_COLOR -u FORCE_COLOR open`.
- `scripts/test.sh`: `swift test` with the SDK fallback; `SCRATCH=<dir>` sets `--scratch-path`.
- Also shipped here (moved forward from Task 3): `Tests/Fixtures/fake-kunj`, `Tests/KunjWorkspaceCoreTests/Support.swift` and `FakeKunjTests.swift`, which pin the fixture naming rule.
- `.gitignore`: `.build/`, `build/`, `vendor/`, `web/node_modules/`, `Resources/web/vs/`, `Resources/fonts/`, `build.log`.
- `main.swift` + `AppDelegate`: a 1440×900 window titled "Kunj Workspace", `titlebarAppearsTransparent`, `.fullSizeContentView`, `titleVisibility = .hidden`; `MainWindowController` lays out three empty regions with the token colours: sidebar 272 wide in `side` over an `NSVisualEffectView(.sidebar)`, a 52 px header strip, a left column and a right column separated by 1 px `border` lines, a 28 px status bar. `--screenshot <path>` writes a PNG of the window after the first layout and quits (snapshot code from `spikes/native-ide/Sources/NativeIDESpike/Workspace.swift`).

- [ ] **Step 1: Write the failing tokens test**

```swift
func testTokensMatchDesignJSON() throws {
    // ../../docs/workspace-app/design/tokens.json relative to #filePath
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: tokensURL)) as! [String: Any]
    let themes = json["themes"] as! [String: [String: String]]
    for t in DesignTokens.themes { XCTAssertEqual(Mirror(reflecting: t).children.filter { $0.label != "name" }.map { ($0.label!, $0.value as! String) }.sorted { $0.0 < $1.0 }, themes[t.name]!.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }) }
    XCTAssertEqual(DesignTokens.Layout.sidebarWidth, 272); XCTAssertEqual(DesignTokens.Layout.changesFileListWidth, 196)
}
func testParseHex() { XCTAssertEqual(parseHex("#1a1816"), RGBA(r: 26/255, g: 24/255, b: 22/255, a: 1)); XCTAssertNil(parseHex("nope")) }
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd workspace-app && scripts/test.sh`
Expected: build failure (no `DesignTokens`).

- [ ] **Step 3: Write `gen-tokens.js`, run it, write `HexColor.swift`, the package, the scripts and the skeleton app**

Copy `prepare-swiftterm.sh` and `copy-monaco.js` from the spike; `web/package.json` pins `monaco-editor` `0.57.0`.

- [ ] **Step 4: Run the tests and build the app**

Run: `scripts/test.sh && scripts/bundle.sh && "build/Kunj Workspace.app/Contents/MacOS/KunjWorkspace" --screenshot /tmp/ws-skeleton.png`
Expected: PASS; the PNG shows the three regions in the warm colours; `fc-list | grep -i jetbrains` is not needed: `NSFont(name: "JetBrainsMono-Regular", size: 12)` is non-nil in the app (log it at startup).

- [ ] **Step 5: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: Swift package, design tokens and build scripts" && git push
```

---

### Task 3: `KunjCLI` with the login-shell PATH and the version check

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/CLI/Version.swift`, `workspace-app/Sources/KunjWorkspaceCore/CLI/ShellEnvironment.swift`, `workspace-app/Sources/KunjWorkspaceCore/CLI/KunjCLI.swift`, `workspace-app/Tests/Fixtures/responses/version.txt`
- Modify: `workspace-app/Tests/KunjWorkspaceCoreTests/Support.swift` (add a `KunjCLI` pointed at `fakeKunjPath`); `fake-kunj` already exists (Task 2)
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/VersionTests.swift`, `workspace-app/Tests/KunjWorkspaceCoreTests/KunjCLITests.swift`

**Interfaces:**
- `Version.swift`: `public struct SemVer: Comparable { major, minor, patch: Int; public init?(_ s: String) }` (accepts `v1.2.3`, `1.2.3`, ignores a `-pre` suffix); `public let MIN_KUNJ_VERSION = SemVer("1.3.0")!`; `public struct VersionCheck: Equatable { ok: Bool; dev: Bool }`; `public func checkVersion(_ s: String, min: SemVer = MIN_KUNJ_VERSION) -> VersionCheck` (`1.0.0` → `ok: true, dev: true`; unparsable → `ok: false`).
- `ShellEnvironment.swift`: `public enum ShellEnvironment { public static func loginPath(timeout: TimeInterval = 5) async -> String` (the `macos-app` marker trick, fallback `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` appended); `public static func terminalEnvironment(path: String) -> [String: String]` (Global Constraints) }`.
- `KunjCLI.swift`:
  - `public struct KunjCLIError: Error, Equatable { public enum Code: String { case notFound = "not-found", tooOld = "too-old", commandFailed = "command-failed", badJSON = "bad-json" }; public let code: Code; public let message: String; public let kunjCode: String? }`
  - `public struct KunjStatus: Equatable { public let binary: String; public let version: String; public let dev: Bool }`
  - `public final class KunjCLI: @unchecked Sendable { public init(command: String, path: String); public static func discover(command: String, path: String) async throws -> (KunjCLI, KunjStatus)` (`kunj -V` → version; `ENOENT`/exit 127 → `notFound`; below min → `tooOld`); `public func run<T: Decodable>(_ args: [String], cwd: String, stdin: Data? = nil, timeout: TimeInterval = 120) async throws -> T` (appends `--json`, decodes; a `{"error": …}` document → `commandFailed` with `kunjCode` from `error.code` when present; non-JSON stdout → `badJSON`; the first `{` onwards is tried, as `macos-app` does); `public func runRaw(_ args: [String], cwd: String, stdin: Data?, timeout: TimeInterval) async throws -> (stdout: Data, stderr: String, exit: Int32)`; `public func spawnSpec(_ args: [String], cwd: String) -> SpawnSpec` }`
  - `public struct SpawnSpec: Equatable { public let executable: String /* "/usr/bin/env" */; public let arguments: [String] /* [command parts…] + args */; public let cwd: String; public let environment: [String: String] }`
  - `command` may be `"node /path/dist/index.js"` (split on spaces, double quotes honoured, as `macos-app`'s `splitArguments`; a value cannot contain a `"`, so tests pass quote-free `FAKE_KUNJ_STDOUT` and use `FAKE_KUNJ_RESPONSES` files otherwise).
  - As built (e6feedc), beyond the above: `KunjCLI.command`/`.path`, `KunjStatus.label` (`kunj 1.0.0 dev`), `KunjCLIError.init(code:message:kunjCode:)`, `SemVer.init(major:minor:patch:)`, public `splitArguments(_:)`, `ShellEnvironment.fallbackPath`, `loginPath(timeout:shell:)`, `terminalEnvironment(path:base:)`; the runner is `CLI/ProcessRunner.swift`. Error mapping: env exit 127/126 is `notFound` when env names the command itself, else `commandFailed` with env's line (kunj found, its `node` not); `-V` output that is not a version is `tooOld`; any top-level `error` key is kunj's error document even with exit 0; a non-zero exit without JSON is `commandFailed` (last stderr line); exit 0 without JSON or of the wrong shape `badJSON`. kunj calls get `terminalEnvironment(path:)` too. `AppDelegate.kunj`/`.kunjStatus` hold the discovered CLI for Task 5.
- `fake-kunj` (shipped in Task 2; its header is the reference): `-V` prints `$FAKE_KUNJ_VERSION` or `responses/version.txt`; otherwise `cat`s `responses/<name>.json`, where `<name>` is the arguments with `--json` dropped, a leading `--` stripped from the others, `/` → `-`, joined with `_` (`worktree list --json` → `worktree_list.json`, `ct file read feature/x src/a.ts --json` → `ct_file_read_feature-x_src-a.ts.json`); exit 1 with `{"error":{"code":"fixture-missing","message":"<name>"}}` when absent. Switches: `FAKE_KUNJ_STDOUT` (bad-JSON test), `FAKE_KUNJ_EXIT`, `FAKE_KUNJ_RESPONSES`, `FAKE_KUNJ_LOG` (`<cwd>\t<args>` per call: assert the cwd is the repo root).

- [ ] **Step 1: Write the failing tests**

```swift
// VersionTests
func testParse() { XCTAssertEqual(SemVer("v1.2.3"), SemVer("1.2.3")); XCTAssertNil(SemVer("garbage")) }
func testDevBuildAccepted() { XCTAssertEqual(checkVersion("1.0.0"), VersionCheck(ok: true, dev: true)) }
func testTooOld() { XCTAssertEqual(checkVersion("1.2.9", min: SemVer("1.3.0")!), VersionCheck(ok: false, dev: false)) }
// KunjCLITests
func testDiscoverReadsVersion() async throws { … version "1.3.2", dev false }
func testDiscoverNotFound() async { … command "kunj", path: an empty temp dir → code .notFound }
func testDiscoverTooOld() async { … version.txt overridden by env FAKE_KUNJ_VERSION=1.2.0 → .tooOld }
func testRunDecodesAndAppendsJson() async throws { struct R: Decodable { let repos: [String] }; … ["repos"] → fixture repos.json }
func testRunTurnsErrorDocumentIntoCommandFailed() async { … ["nope"] → .commandFailed, kunjCode "fixture-missing" }
func testRunRejectsNonJson() async { … FAKE_KUNJ_STDOUT="not json" → .badJSON }
func testSpawnSpecCarriesPathAndCwd() { … environment["PATH"] == path, cwd set, arguments.first == "kunj" }
```

- [ ] **Step 2: Run, implement, run**

Run: `scripts/test.sh`
Expected: FAIL then PASS. `runRaw` reads stdout and stderr on background file handles, writes `stdin` then closes it, kills the process at `timeout`.

- [ ] **Step 3: Wire discovery into the app**

`AppDelegate` resolves `loginPath()` then `KunjCLI.discover(command: UserDefaults "kunjCommand" ?? "kunj", path:)` off the main thread; the sidebar's foot (bottom right, as in `warm.png`) shows `kunj 1.4.2` (`kunj 1.0.0 dev` for a dev build); an error (`kunj not found on your PATH: npm install -g kunj`) showed in `red` on the status bar's right until Task 6, which made it the window's error state (`MainWindowController.showDiscoveryError`). `-kunjCommand "node /path/dist/index.js"` on the command line sets the command for one run (NSArgumentDomain).

Run: `scripts/bundle.sh && open "build/Kunj Workspace.app"`
Expected: the sidebar's foot shows `kunj 1.0.0 dev` on this machine; `-kunjCommand /nonexistent/kunj` shows the red not-found message.

- [ ] **Step 4: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: KunjCLI with login-shell PATH and version check" && git push
```

---

### Task 4: JSON mirrors and the environment model

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/JSON/KunjJSON.swift`, `workspace-app/Sources/KunjWorkspaceCore/Model/Environment.swift`, `workspace-app/Sources/KunjWorkspaceCore/Model/EnvironmentList.swift`, fixtures `Tests/Fixtures/responses/repos.json`, `worktree_list.json`, `ct_list.json`, `ct_list_error.json` (realistic output copied from `node dist/index.js … --json` on this machine, with the mockup's branch names)
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/EnvironmentTests.swift`

**Interfaces:**
- `KunjJSON.swift` (all `public struct … : Decodable`, optional where the TypeScript type is optional or nullable, unknown keys ignored): `ReposJson { repos: [KnownRepo] }`, `KnownRepo { root, gitCommonDir, name: String; bare: Bool; hidden: Bool?; exists: Bool; lastSeen: String }`, `WorktreeListJson { repoRoot: String; worktrees: [WorktreeJson] }`, `WorktreeJson { path, name: String; head, branch: String?; detached, bare, isMain, exists, isCurrent: Bool; status: WorktreeStatus?; pullRequest: PullRequestInfo?; sessions: [WorktreeSession]; agent: AgentState?; openCount: Int; changedFiles: Int? }`, `WorktreeStatus { dirty: Bool; changedFiles: Int; ahead, behind: Int?; upstream: String? }`, `PullRequestInfo { provider: String; number: Int; title, state, url: String; draft: Bool; baseBranch: String?; headBranch: String; reviewDecision: String?; checks: String?; updatedAt: String? }`, `WorktreeSession { id, path: String; pid: Int; editor: String; label: String? }`, `AgentState { running: Bool?; session: String?; state: String? }`, `ContainerListJson { repo: String; backend: Backend; containers: [ContainerJson] }`, `ContainerJson { branch, name, id, state, image, createdAt, firewall, status: String; ports: [ContainerPortJson]; agent: AgentState; workspace: ContainerWorkspace; services: [ServiceState]; blueprint: Blueprint? }`, `ContainerPortJson { container, host: Int; kind: String; service: String? }`, `ContainerWorkspace { head: String?; ahead: Int?; dirty: Bool? }`, `ServiceState { name, state: String; port: Int? }`, `FileReadJson { path, content: String }`, `FileWriteJson { success: Bool; path: String }`, `SuccessJson { success: Bool }`, `ErrorJson` (decodes both `{ "error": "msg" }` and `{ "error": { code, message } }` into `code: String?, message: String`).
- `Environment.swift`:
  - `public enum EnvironmentKind: String, Codable { case worktree, container }`
  - `public enum AgentActivity: Equatable { case none, running, waiting, unknown }`; `public enum DotColor: Equatable { case green, amber, idle }`; `public enum EnvState: Equatable { case running, stopped, ok, missing }`
  - `public struct PortInfo: Equatable { container, host: Int; kind: String; service: String? }`
  - `public struct Environment: Equatable, Identifiable { public let id: String; kind; repo: RepoRef; branch: String; path: String? /* worktree path */; containerName: String?; state: EnvState /* .running, .stopped, .ok, .missing */; agent: AgentActivity; agentSession: String?; dirty: Bool?; changedFiles: Int?; ahead, behind: Int?; upstream: String?; pullRequest: PullRequestInfo?; ports: [PortInfo]; services: [ServiceState]; createdAt: Date?; exists: Bool; isMain: Bool }`; `public struct RepoRef: Equatable, Hashable { name, root: String; bare: Bool }`
  - `public static func environmentId(repo: String, kind: EnvironmentKind, branch: String) -> String` → `"\(repo)|\(kind.rawValue)|\(branch)"`
  - `public var statusVerb: String` (spec order: `Missing`, `Stopped`, `Waiting for input`, `Running`, `Merged #N`, `PR #N open` (`PR #N draft` when draft), `N changed files` (`1 changed file`), `↑N unpushed`, `Clean`); `public var dot: DotColor` (`.amber` waiting, `.green` running, `.idle` otherwise)
  - `public var metaLine: [String]` → `[repo.name + " / " + branch, kind.rawValue, "↑3 ↓1 from main"?, "#412 open ✓"?, ":3000"…]` (empty parts omitted; checks `✓` success, `✗` failure, `…` pending)
- `EnvironmentList.swift`: `public struct RepoEnvironments: Equatable { repo: RepoRef; backend: BackendState /* .docker, .unavailable(String) */; environments: [Environment] }`; `public func mergeEnvironments(repo: RepoRef, worktrees: WorktreeListJson?, containers: Result<ContainerListJson, KunjCLIError>) -> RepoEnvironments` (worktrees that are `bare` or detached skipped; order: worktrees by branch, then containers); `public func listEnvironments(cli: KunjCLI) async -> ([RepoEnvironments], KunjCLIError?)` (repos → per repo in a task group; hidden or non-existing repos skipped; a `worktree list` failure drops that repo with the error logged).
- `Environment.lastActivity` is not here (Task 8).
- As built (53fdf6b), beyond the above: mirrors are `public var` with public memberwise inits where tests and later tasks build values (`PullRequestInfo`, `AgentState`, `ContainerPortJson`, `ServiceState`, `PortInfo`, `RepoRef`, `Environment`, `RepoEnvironments`); `AgentState.session` is optional (a container's agent has none); `ContainerListJson.Backend { kind; context? }` and `ContainerJson.Blueprint { hash; stale? }`; fields the app does not use (`imageInfo`, `dind`, `bridges`, `orphans`, `locked`/`prunable`, `prLabel`, session `pid`… beyond the listed ones) are left out. `environmentId` is a free function and `Environment.environmentId`; `public func agentActivity(running:state:) -> AgentActivity` (nil → `.unknown`, false → `.none`, true → `.waiting`/`.running`). Ids use the repo's `name` from `kunj repos` (`alertd-core.git` for a bare repo here). A worktree without an `agent` key is `.unknown`; a stopped container's agent is `.none` whatever `ct list` says; worktree `changedFiles` is `status.changedFiles`, else the top-level `changedFiles`. `ct list` gives a container no count, upstream or PR: a dirty container's verb is `Changed files` and its meta line has `↑N` alone (the mockup's `↑3 from main` on a container cannot come from the contract, since ahead counts are against the upstream, not the base). `metaLine`'s ahead/behind part is `↑N ↓M from <upstream>` with the upstream as kunj reports it (`origin/fix/x`); the PR part starts with `#`, ports with `:` (Task 6 makes those two links). `createdAt` parses Docker's RFC 3339 with nanoseconds. `listEnvironments` runs `repos` in the home directory and returns `repos`' failure, else the first repo whose `worktree list` failed (also `NSLog`ged), so the error slot means partial as well as failed. Fixture repo roots are `/Users/demo/...` (not on disk): tests that call `listEnvironments` write their own `repos.json` with temp roots.

- [ ] **Step 1: Write the failing tests**

```swift
func testMergeWorktreesAndContainers() { … 3 worktrees + 1 container on one of the branches → 4 environments; container id "kunj|container|feat/llm-insights"; its state .running; ports [PortInfo(3000, 3000, "forward", nil)] }
func testStatusVerbOrder() { … waiting beats running beats PR beats dirty; merged PR → "Merged #398"; dirty 3 → "3 changed files"; ahead 2 clean → "↑2 unpushed"; nothing → "Clean" }
func testMissingWorktree() { … exists false → .missing, "Missing" }
func testContainerListingFails() { … .failure → backend .unavailable, worktree rows kept }
func testSlashId() { XCTAssertEqual(environmentId(repo: "app", kind: .worktree, branch: "feature/x"), "app|worktree|feature/x") }
func testDecodeFixtures() throws { … all four fixtures decode; ErrorJson decodes both shapes }
```

- [ ] **Step 2: Run, implement, run**

Run: `scripts/test.sh`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: JSON mirrors and environment model" && git push
```

---

### Task 5: Event stream and the environment store

**Status:** the core (`EventStream`, `EnvironmentStore`, `listWorktrees`/`listContainers`) shipped in 8f49f54, as built below; Step 3 (the `AppDelegate` wiring) moved to Task 7, which replaces `loadEnvironments` with the store.

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/CLI/EventStream.swift`, `workspace-app/Sources/KunjWorkspaceCore/Model/EnvironmentStore.swift`, fixture `Tests/Fixtures/responses/events.ndjson` (a `hello`, a `git`, a `container`, a `backend`), `fake-kunj` `events` case: prints the fixture line by line with 20 ms gaps and then waits for stdin EOF unless `FAKE_KUNJ_EVENTS_EXIT=1`
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/EventStreamTests.swift`, `workspace-app/Tests/KunjWorkspaceCoreTests/EnvironmentStoreTests.swift`

**Interfaces:**
- `EventStream.swift`: `public enum KunjEvent: Equatable { case hello(version: String, repos: Int); case git(repoRoot: String?); case registry(kind: String, repoRoot: String?); case container(repoRoot: String?, branch: String?, container: String, action: String); case agent(session: String, running: Bool, state: String?, repoRoot: String?); case backend(available: Bool, message: String?); case error(code: String?, message: String) }`; `public func parseEventLine(_ line: String) -> KunjEvent?` (nil for a malformed line); `public final class EventStream { public init(cli: KunjCLI, onEvent: @escaping @Sendable (KunjEvent) -> Void, backoff: ClosedRange<TimeInterval> = 1...30); public func start(); public func stop() async` (closes the child's stdin, waits up to 2 s, then SIGTERM); restarts after exit with doubling backoff while started; `public func restart()` (closes the running child's stdin so a new one starts after `backoff.lowerBound`, SIGTERM if it is still running 2 s later); `public private(set) var restarts: Int`; `public var pid: Int32?` }`.
- `EnvironmentStore.swift`: `@MainActor public final class EnvironmentStore { public init(cli: KunjCLI, coalesceMs: Int = 300, lister: @escaping (KunjCLI) async -> ([RepoEnvironments], KunjCLIError?) = listEnvironments); public private(set) var repos: [RepoEnvironments]; public private(set) var lastError: KunjCLIError?; public var onChange: (() -> Void)?; public func refreshAll() async; public func refreshRepo(root: String) async; public func handle(_ event: KunjEvent)` (git → that repo's worktree list only; container → that repo's ct list only; agent → its repo's worktree list when the event has a repo, else all; registry/backend → all; hello after a restart → a full refresh; coalesced per key with a timer; the store keeps each repo's last worktree and container results apart so a scoped refresh re-merges with the other half) ; `public func environment(id: String) -> Environment?`; `public func start(events: EventStream)` }`.
- As built (8f49f54), beyond the above: `KunjEvent` is `Sendable`; `.agent` carries `repoRoot` (kunj sends `repo` on hook-state changes, not on the tmux poll's start/end). `EventStream` runs `kunj events --json` in the home directory like `repos`, discards stderr, resets the backoff after a child lived longer than `backoff.upperBound`, and `stop()` sends SIGKILL 1 s after SIGTERM if needed. `EnvironmentStore.init` also takes `worktrees:` (default `listWorktrees`) and `containers:` (default `listContainers`), so scoped refreshes are tested without per-root fixtures; a scoped result replaces only its kind's half of `RepoEnvironments.environments`, so the store keeps no raw JSON. An event whose repo the store does not know (null or unlisted root) runs a full refresh; a pending full refresh swallows scoped ones; the first `hello` is ignored (it follows the initial `refreshAll`) and every later one refreshes all; refreshes run one at a time, in order; `onChange` fires only when `repos` or `lastError` changed; a failed scoped `worktree list` keeps the last result and sets `lastError` until that repo's next success. `kunj events` resolves its repositories once, at start, so a clean full listing whose roots differ from the ones the stream started with calls `restart()` (a repo added, un-hidden or hidden since launch). `makeEventStream(backoff:)` builds a stream whose events hop to the main actor into `handle`; Task 7 wires it: `let s = store.makeEventStream(); store.start(events: s)` after `refreshAll()`, and `await s.stop()` in `applicationShouldTerminate`. `RelativeTime` is Task 6's.
- A scoped refresh needs one repo's half on its own, which `listEnvironments` (Task 4) does not expose: factor its per-repo calls into `public func listWorktrees(cli:repo:) async throws -> WorktreeListJson` and `public func listContainers(cli:repo:) async -> Result<ContainerListJson, KunjCLIError>` (both `cwd: repo.root`), keep `listEnvironments` built on them, and re-merge with `mergeEnvironments(repo:worktrees:containers:)`.

- [ ] **Step 1: Write the failing tests**

```swift
func testParseEventLines() { … hello, git with repo, container with null repo, agent with state, backend, malformed → nil }
func testStreamDeliversAndRestarts() async { … FAKE_KUNJ_EVENTS_EXIT=1, backoff 0.05...0.1: ≥ 4 events, restarts ≥ 1 within 1 s }
func testStopClosesStdinAndWaits() async { … start, stop(): child pid gone (kill(pid, 0) == -1) }
func testStoreCoalescesGitEvents() async { … counting calls; three .git for one root within 10 ms, coalesceMs 250 → 1 scoped worktree list, no ct list, no full listing (50 ms was flaky on a busy MainActor) }
func testBackendEventRefreshesAll() async { … }
func testStoreKeepsWorktreesWhenContainersFail() async { … lister returns backend .unavailable → environments non-empty }
```

- [ ] **Step 2: Run, implement, run**

Run: `scripts/test.sh`
Expected: PASS.

- [ ] **Step 3: Wire into the app** (done by Task 7)

`AppDelegate` creates the store after discovery, `refreshAll()`, starts the stream, stops it in `applicationShouldTerminate` (returning `.terminateLater` until `stop()` resolves). The status bar's left side shows `N environments · M agents running` for now.

Run: `scripts/bundle.sh && open "build/Kunj Workspace.app"`; `git commit --allow-empty -m x && git reset HEAD~1` in this repo updates the count within a second; `pgrep -f "kunj events"` is empty after quitting.

- [ ] **Step 4: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: kunj events stream and environment store" && git push
```

---

### Task 6: Sidebar, header, status bar and window chrome to the design

**Status:** done in 95410df and d7b79fa, as built below.

- As built: the sidebar list is a flipped view of `SidebarRowView` subviews in an `NSScrollView` (group headers drawn by the list, 2 px between rows, 18 px between groups), not an `NSTableView`; rows are 54 px and rebuilt on each `repos` change. The sidebar keeps vibrancy with the `side` tint at 0.94 (`MainWindowController.sideTintAlpha`; the render samples `#2c2725` against the mockup's `#2b2724`). Buttons, rows and the search box use radius 6 (`Radius.card`), pills 5, as `warm.html` does; `⌘1–N switch session` is `muted`, `│` separators `borderStrong`; unselected titles `text2`, the selected row's second line `text2`. The traffic lights are moved into the sidebar's 52 px top (`placeTrafficLights`, on show, resize and leaving full screen); they are not in `--screenshot`, and clicks on the header buttons under the titlebar container need checking by hand.
- Extra Core helpers (with tests): `uptime(since:now:)` (`2h 14m`, `3d 1h`) in `RelativeTime.swift`; `Model/EnvironmentFilter.swift` with `filterEnvironments(_:query:)` (a matching repo name keeps all its rows, else branch or kind substring; the search field already filters with it), `agentsRunning(_:)` (running + waiting) and `environmentIds(_:)` (sidebar order). `relativeTime` truncates minutes (a rounded 59m30s read `0h`; fixed in review).
- `Theme`: `color(_:alpha:)`, `isDark`, `appearance`, `dotColor(_:)`; `ThemeManager.override` (this run only, not saved): `--demo` renders `warm` unless `-theme <name>` (argument domain) or Task 11's `--theme <name>` is passed. View > Theme (Auto/Warm/Light/Graphite) writes the `theme` default; Task 11's settings write the same default.
- `MainWindowController` API for later tasks: `render(repos:selected:)` (nil keeps the selection; an id whose row is gone stays selected and shows "Select an environment" until it returns; `render` never calls `onSelect`), `select(_:)`, `onSelect(Environment?)`, `onHeaderAction(HeaderAction, Environment)` (AppDelegate only logs it today), `onNewSession`, `lastActivity: (String) -> Date?` (Task 8; nil shows no time), `setKunjVersion`, `showDiscoveryError` (the error state, with `npm install -g kunj` under the message), `showListingError` (status bar left in `red`). `terminalColumn`/`changesColumn` are placeholders in `Views/TerminalColumn.swift` and `Views/ChangesColumn.swift` exposing only `show(_ env: Environment?)` and `theme`. `AppDelegate.loadEnvironments` does one `listEnvironments` after discovery; Task 7 replaces it with the `EnvironmentStore` (`render(repos: store.repos)` on each change). Menus are `appMenu`/`editMenu`/`viewMenu`/`windowMenu` in `buildMenu`; later tasks add theirs to that list. Header Shell/Agent are disabled with a tooltip for a missing worktree or a stopped container. `DemoData` gives the container an upstream and a PR so the header matches `warm.png`, though `ct list` reports neither.

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Design/RelativeTime.swift`, `workspace-app/Sources/KunjWorkspace/Theme/Theme.swift`, `workspace-app/Sources/KunjWorkspace/Views/Controls.swift`, `workspace-app/Sources/KunjWorkspace/Views/SidebarView.swift`, `workspace-app/Sources/KunjWorkspace/Views/SidebarRowView.swift`, `workspace-app/Sources/KunjWorkspace/Views/HeaderView.swift`, `workspace-app/Sources/KunjWorkspace/Views/StatusBarView.swift`, `workspace-app/Sources/KunjWorkspace/Demo/DemoData.swift` (the mockup's environments, built from `Environment` values)
- Modify: `workspace-app/Sources/KunjWorkspace/Views/MainWindowController.swift`, `AppDelegate.swift`
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/RelativeTimeTests.swift`

**Interfaces:**
- `RelativeTime.swift`: `public func relativeTime(_ date: Date, now: Date = Date()) -> String` → `now` (< 45 s), `2m`, `1h`, `3d`, `2w`, `3mo`.
- `Theme.swift`: `struct Theme { let tokens: ThemeTokens; func color(_ key: KeyPath<ThemeTokens, String>) -> NSColor; static func sans(_ size: CGFloat, weight: NSFont.Weight) -> NSFont; static func mono(_ size: CGFloat, weight: NSFont.Weight) -> NSFont }` (Inter / JetBrains Mono by PostScript name, else `.systemFont` / `.monospacedSystemFont`); `enum ThemeChoice: String { auto, warm, light, graphite }`; `final class ThemeManager { static let shared; var choice: ThemeChoice (UserDefaults "theme"); var current: Theme; var onChange: [(Theme) -> Void]; observes NSApp.effectiveAppearance for `auto` }`.
- `Controls.swift`: `final class OutlinedButton: NSButton` (30 px tall, `borderStrong` 1 px, radius 5, label sans 12.5 + hint mono 10.5 in `muted`), `final class FilledButton` (`primaryBg`/`primaryFg`, hint `primaryHint`), `final class PillView` (26 px, `raised` when active), `final class DotView` (7 px circle in `green`/`amber`/`idle`), `final class HairlineView` (1 px `border`), `final class SearchField` (30 px, `⌘K` badge).
- `SidebarView`: an `NSOutlineView`-free `NSTableView` with two row kinds: a group row (repo name in `muted` 11 px, count right) and `SidebarRowView` (`padding 9px 10px`, radius 6; dot · branch 13 px/500 in `text` · relative time mono 11 px `muted`; second line indented 15 px: `kind` mono 11 px `muted` · ` · ` `faintest` · status verb sans 11 px (`amber` for waiting, `muted` otherwise); selected: `raised` fill + `borderStrong` border; hover `raised` at 50 %). Top: 52 px traffic-light area, the search field (filters rows by branch/repo substring), bottom: `+ New session ⌘N` button (full width, outlined) and a line `N agents running · kunj 1.4.2`. API: `var repos: [RepoEnvironments]`, `var selectedId: String?`, `var onSelect: (String) -> Void`, `var lastActivity: (String) -> Date?`.
- `HeaderView`: title 14 px/600 (the branch), meta line mono 11 px `muted` with ` · ` in `faintest` from `Environment.metaLine` (the PR part is a link in `link` opening `pullRequest.url`, ports are links opening `http://localhost:<host>`), actions right: `Shell ⌘T`, `Agent ⌘⇧A`, `Open in VS Code ⌘O` (outlined), `Create PR ⌘⇧P` (filled), `…` (outlined, 30×30). Callbacks `onAction: (HeaderAction) -> Void` with `enum HeaderAction { shell, agent, open, createPR, more(NSView) }`.
- `StatusBarView`: left mono 11 px `muted`: dot + container name or worktree path · `up 2h 14m` (from `createdAt`; containers only, a worktree has none) · services · forwards (`3000 → 3000`); right: agent state (`● agent waiting for input` in `amber`, `● agent running` in `green`) · `⌘1–N switch session` in `faintest`; a kunj error replaces the left side in `red` (this replaces Task 3's temporary `statusRight` error label in `MainWindowController`). A discovery error (`notFound`, `tooOld`, `commandFailed`) is the window's error state: one message with its text in place of the sidebar list and the columns, not an empty list (Review Focus 1); the sidebar's version label (Task 3) moves into the `N agents running · kunj 1.4.2` line.
- `MainWindowController`: `func render(repos:, selected:)`; when nothing is selected the right side shows "Select an environment" in `muted`; the Changes column shows its header bar placeholder (`Changes`) until Task 9; the left column shows the tab bar placeholder until Task 7.
- `--demo`: the store is replaced by `DemoData.repos` (alertd-core with four rows and kunj with two, matching the mockup, the first selected); `--screenshot <png>` as in Task 2.

- [ ] **Step 1: Write the failing `relativeTime` test and make it pass**

```swift
func testRelativeTime() { let now = Date(); XCTAssertEqual(relativeTime(now, now: now), "now"); XCTAssertEqual(relativeTime(now - 120, now: now), "2m"); XCTAssertEqual(relativeTime(now - 3600, now: now), "1h"); XCTAssertEqual(relativeTime(now - 3*86400, now: now), "3d") }
```

Run: `scripts/test.sh` → PASS.

- [ ] **Step 2: Build the views, bound to the store (live) and to `DemoData` (`--demo`)**

Fonts, sizes and colours exactly per `DESIGN.md` Layout; the window background is `bg` and the sidebar sits on an `NSVisualEffectView` (`.sidebar`, `.behindWindow`) with a `side` overlay at 85 % alpha.

- [ ] **Step 3: Compare with the mockup**

Run: `scripts/bundle.sh && "build/Kunj Workspace.app/Contents/MacOS/KunjWorkspace" --demo --screenshot /tmp/ws-demo.png`
Expected: side by side with `docs/workspace-app/design/mockups/warm.png` the sidebar rows, header, actions and status bar match in position, size, colour and type; fix differences before moving on. Then `open "build/Kunj Workspace.app"`: the real repositories list, selecting a row fills the header, the PR link opens the browser.

- [ ] **Step 4: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: sidebar, header and status bar from the design" && git push
```

---

### Task 7: Terminals, agent tabs and the tab bar

**Status:** done in a4ec693 (core: `TerminalSpec`), 5158fe4 and 45756ae, as built below; Task 5's Step 3 wiring is in 5158fe4.

- As built: `TerminalTab`'s background flag is `inBackground` (NSView already has `hidden`/`isHidden`); it also has `envId`, `spec`, `startedAt` (settable; `--demo` backdates it), `programTitle` (OSC 0/2 title, the pill's tooltip; the pill keeps the spec title), `running`, `pid`, `show(text:)` (`--demo`), `apply(_ theme:)` and `close()` (SIGHUP to the process, then SwiftTerm's SIGTERM; nothing once the process has exited, since its pid may be reused). `exited` is the exit code from the wait status (Core `exitCode(waitStatus:)`: SwiftTerm reports waitpid's raw status, so `exit 1` arrived as 256; fixed in review), 128 + N for a signal. Line spacing 1.2, padding 16 × 20 px.
- `HiddenFeedScheduler` + `HiddenFeedQueue` are Core (`Terminal/HiddenFeedScheduler.swift`, tested): budget, clock and scheduling injectable, 16 KB slices, round robin, main thread only (not `@MainActor`); a dropped queue is forgotten.
- `TabRegistry` (`@MainActor`) also has `openDemo(env:kind:title:text:)`, `activate(_:)`, `cycle(envId:by:)`, `allTabs`, `theme`; `onChange(envId)` fires after a tab is started (so the dot sees it running). A shell that exits 0 closes itself as an action with `closeOnExitZero` does; agent tabs and failed processes stay with `[process exited with code N]` in bright black.
- `TerminalColumn` owns the registry (`terminalColumn.registry`) and has `onNewTab`, `showMessage(_:)` (the refused-spec text, with `⌘T shell · ⌘⇧A agent` under it; "No terminal open" when the environment has no tab), `focusActive()`, `activeTab`; the tab bar's uptime refreshes every 30 s. Pills close from their context menu or ⌘W. Core `tabDot(kind:running:agent:)` gives the dots (agent: amber while waiting, else green; action green; shells none); the right side is `tmux <env.agentSession> · <uptime>`, a container's session `agent`.
- `AppDelegate` is `@MainActor` with a `nonisolated init`; `loadEnvironments` builds the `EnvironmentStore`, renders on `onChange`, sets `store.onRepoChanged` for the Changes column, then starts `makeEventStream()`. `applicationShouldTerminate` calls `registry.closeAll()`, stops the stream in a detached task and replies through `CFRunLoopPerformBlock` (a main-actor reply deadlocked under `--screenshot`). Menus Environment (New Shell ⌘T, Agent ⌘⇧A) and Tabs (⌘⇧] ⌘⇧[ ⌘W) are in `buildMenu`, validated by state. `-openTabs "<envId>#<kind>,…"` opens tabs after the first listing, for checking PTYs without a person. `HeaderView` needed no change. `--demo` opens `agent` (warm.html's transcript), `zsh` and `bun dev` from `Demo/DemoTabs.swift`; `--screenshot` composites the visible terminal (scrollers hidden while rendering).
- Checked live: shell and agent tabs on kunj `main`, `kunj agent main` attached at the app's size, the PTY environment as required; quitting left no `kunj events`, shell, `kunj agent` or tmux client and the session stayed. Not checked: a commit updating its row within a second, `yes | head -c 50000000` in a hidden tab, ⌘W/⌘T by hand.

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Terminal/TerminalSpec.swift`, `workspace-app/Sources/KunjWorkspace/Terminal/TerminalTab.swift`, `workspace-app/Sources/KunjWorkspace/Views/TabBarView.swift`, `workspace-app/Sources/KunjWorkspace/Model/TabRegistry.swift`
- Modify: `Views/TerminalColumn.swift` (Task 6's placeholder: keep `show(_:)` and `theme`, replace the inside), `MainWindowController.swift`, `AppDelegate.swift` (`loadEnvironments` → the `EnvironmentStore` and its event stream, with Task 5's Step 3 checks: a commit updates the row within a second, no `kunj events` left after quitting; add `tabsMenu()`/`environmentMenu()` to `buildMenu`) (and `store.onRepoChanged = { [weak wc] root in wc?.changesColumn.repoChanged(root: root) }` beside `render(repos: store.repos)` on `onChange`, so the Changes column follows `git` events) (menu: Tabs ⌘⇧] ⌘⇧[ ⌘W, Environment ⌘T ⌘⇧A, Edit menu as in the spike), `HeaderView` wiring
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/TerminalSpecTests.swift`

**Interfaces:**
- `TerminalSpec.swift`: `public enum TabKind: String, Codable { case shell, agent, action, editor }`; `public struct TerminalSpec: Equatable { executable: String; arguments: [String]; cwd: String; environment: [String: String]; title: String; closeOnExitZero: Bool }`; `public enum TerminalSpecError: Error, Equatable { case worktreeMissing, containerStopped(String), noWorktree }`; `public func terminalSpec(cli: KunjCLI, env: Environment, kind: TabKind, action: [String] = [], shell: String, terminalEnv: [String: String]) throws -> TerminalSpec`: worktree shell → `shell -l` in `env.path` (`execName "-zsh"` handled by the app: `arguments` start with `-l`, the tab passes `execName`), worktree agent → `kunj agent <branch>` in the repo root, container shell → `kunj ct shell <branch>`, container agent → `kunj ct agent <branch>`, action → `kunj <action…>` with `closeOnExitZero` true (false for `pr`, whose output holds the PR URL) and title `action.prefix(2).joined(" ")`; `.missing` → `worktreeMissing`, container not running → `containerStopped(branch)`; kunj runs through `/usr/bin/env` with the CLI's command parts.
- `TerminalTab: LocalProcessTerminalView`: `let id: String /* "<envId>#<kind>#<n>" */`, `let kind`, `var title`, `var exited: Int32?`, `var onExit`, `var onTitle`, `var inBackground: Bool` (when true `dataReceived` appends to a queue that a shared `HiddenFeedScheduler` drains in slices under a 4 ms budget per run-loop turn across all hidden tabs; nothing is ever dropped; when set false the queue is fed at once and `setNeedsDisplay`); font JetBrains Mono 12.5, line spacing for 1.6, colours from the theme's `term*` (`nativeBackgroundColor`, `nativeForegroundColor`, `installColors` with ANSI 8 = `termMuted`, 4 and 12 = `termAccent`, 2 = `green`, 3 = `amber`, 1 = `red`), 16 px inset. Starts with `startProcess(executable:args:environment:execName:currentDirectory:)` from a `TerminalSpec`.
- `TabRegistry` (`@MainActor`): `tabs(for envId) -> [TerminalTab]`, `active(for envId)`, `open(spec, env, kind) -> TerminalTab`, `close(tab)`, `closeAll()` (terminate every process; called from `applicationShouldTerminate`), `onChange`.
- `TabBarView`: pills from the registry for the current environment (dot in `green` for a running agent tab, `amber` when the environment is waiting), right side `tmux <session> · <uptime>` when an agent tab exists (session from `env.agentSession`, uptime from the tab's start), a split button (disabled, v2) and `+` (opens a shell). `TerminalColumn` holds every tab view, shows the active one and sets `inBackground` on the others.
- Header `Shell`/`Agent` and ⌘T/⌘⇧A open tabs; `Agent` with an existing agent tab activates it. A `TerminalSpecError` shows as an `NSAlert`-free inline message in the column ("The worktree directory is missing" / "Start the container first").

- [ ] **Step 1: Write the failing spec tests**

```swift
func testWorktreeShell() { … executable == "/bin/zsh", arguments == ["-l"], cwd == "/w/feat", environment["TERM"] == "xterm-256color" }
func testWorktreeAgent() { … executable == "/usr/bin/env", arguments == ["kunj", "agent", "feature/x"], cwd == repo root }
func testContainerShellAndAgent() { … ["kunj","ct","shell","feature/x"], ["kunj","ct","agent","feature/x"] }
func testActionTab() { … ["kunj","ct","start","feature/x"], closeOnExitZero true, title "ct start" }
func testMissingWorktreeRefused() { XCTAssertThrowsError(…) { XCTAssertEqual($0 as? TerminalSpecError, .worktreeMissing) } }
func testStoppedContainerRefused() { … .containerStopped("feature/x") }
func testEnvironmentIsCleaned() { … terminalEnv with NO_COLOR and CLAUDECODE set → absent in the spec; LANG present }
```

- [ ] **Step 2: Run, implement, run**

Run: `scripts/test.sh` → PASS.

- [ ] **Step 3: Build the tab bar, the column and the tabs; wire the actions and menus**

- [ ] **Step 4: Check it live**

Run: `scripts/bundle.sh && open "build/Kunj Workspace.app"`. Open a shell in a worktree (`echo $TERM` prints `xterm-256color`, `claude` draws correctly); open Agent on `main`: `kunj agent` attaches to the tmux session started in Task 1 Step 5, both sides show the same pane; detach the CLI side (`Ctrl-b d`) and the app keeps it; quit the app: `pgrep -f "kunj agent"` is empty but `tmux ls` still lists the session. Switch environments and back: the shell's scrollback is intact. Run `yes | head -c 50000000` in a hidden tab while typing in a visible one: no visible lag.
Then `--demo --screenshot /tmp/ws-tabs.png` and compare the tab bar with `warm.png`.

- [ ] **Step 5: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: SwiftTerm terminals, agent tabs and the tab bar" && git push
```

---

### Task 8: Layout persistence and last activity

**Status:** done in 062d22d (core: layout file and `LayoutStore`) and 2d972db, as built below.

- As built (Core, `Layout/WorkspaceLayout.swift`): `lastActivity` is ISO 8601 without fractions; `loadLayout` skips entries and tabs that do not decode (an unknown kind from a newer app) instead of emptying the file; `LayoutStore(home:debounceMs: = 500)` is thread-safe (lock + its own queue), not `@MainActor`, and `flush()` writes synchronously. Also `tabsToSave(_:active:)` (drops action tabs, moves `active`, nil when an action tab is active), `restorePlan(_:env:kinds: = [.shell, .agent])` (nil while the worktree is missing or the container stopped; agent tabs only while the agent is running or waiting, and only one) and `ActivityTracker` (the first listing only primes; an environment that changed since it was last listed, or was never listed, counts; one missing from a listing is remembered, so a failed `ct list`/`worktree list` does not mark everything active when it comes back, and a pull request appearing or disappearing, which `gh` failing causes, is not activity; both fixed in review).
- As built (app): `Model/LayoutKeeper.swift` (`@MainActor`), made by `AppDelegate.makeLayoutKeeper(store:)`: `selected(env)` restores on the first selection in a session once `restorePlan` allows it (a store change retries for the selected environment), and the entry is not saved over until then, so a stopped container keeps its saved tabs; `tabsChanged(envId)` saves after that, chained onto `registry.onChange` beside the column's handler; `listed(repos)` and `input(envId)` bump `lastActivity` (input at most every 5 s per environment). `TabRegistry.onInput` comes from an `NSEvent` local `keyDown` monitor on the first-responder `TerminalTab`, not `send(source:data:)`, which also carries the terminal's own replies. Restored tabs open through `AppDelegate.startTab(env:kind:)` (refused specs open nothing); saved titles are not used, the spec's are. `applicationShouldTerminate` calls `layoutKeeper.flush()` after `registry.closeAll()` (which fires no `onChange`, so quitting does not save empty tabs). `MainWindowController.lastActivity` feeds the sidebar, whose times refresh every 30 s. `-openTabs` stays; an entry without `#kind` only selects (and so restores). In `--demo` nothing is read or written.
- Checked live: `-openTabs main#shell,main#agent` wrote `worktree:main` with both tabs and `active` 1; a relaunch with `-openTabs main` restored both, the agent attached to its tmux session; dirtying a worktree bumped only its `lastActivity`. Not checked: restore of a container's tabs, input bumps by hand.
- For Task 10: pass `kinds: [.shell, .agent, .editor]` to `restorePlan`, map editor tabs with their `path` in `LayoutKeeper.tabs` (`AppDelegate.makeLayoutKeeper`), and open `.editor` in `keeper.open` from `SavedTab.path`.

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Layout/WorkspaceLayout.swift`
- Modify: `TabRegistry.swift`, `MainWindowController.swift` (set `lastActivity`; the sidebar refreshes times every 30 s), `SidebarView.swift`
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/WorkspaceLayoutTests.swift`

**Interfaces:**
- `WorkspaceLayout.swift`: `public struct SavedTab: Codable, Equatable { kind: TabKind; title: String; path: String? }`; `public struct BranchLayout: Codable, Equatable { tabs: [SavedTab]; active: Int?; lastActivity: Date? }`; `public struct WorkspaceLayout: Codable, Equatable { public var branches: [String: BranchLayout] }` (encoded as the object of the spec, keyed by `public func layoutKey(kind: EnvironmentKind, branch: String) -> String` = `"<kind>:<branch>"`, because a worktree and a container on the same branch are two environments); `public func layoutPath(repoName: String, home: String = NSHomeDirectory()) -> String` → `<home>/.kunj/<repoName>/workspace.json`; `public func loadLayout(path:) -> WorkspaceLayout` (`{}` for missing or corrupt); `public func saveLayout(_:path:) throws` (temp file + rename; parent directories created); `public final class LayoutStore { init(home:); func layout(repo: String) -> WorkspaceLayout; func update(repo: String, key: String, _ f: (inout BranchLayout) -> Void)` (debounced 500 ms save) `; func flush()` }`.
- The registry saves `shell`, `agent` and `editor` tabs (never `action`) and the active index on every change; selecting an environment for the first time in a session restores its tabs (agent tabs reattach, editor tabs reopen in Task 10, shells restart). `lastActivity` is bumped on a state-hash change in the store (`Environment` without `lastActivity` hashed) and when a tab of the environment receives input; the sidebar shows `relativeTime(lastActivity)`.
- From Task 7: save on `TabRegistry.onChange(envId)`; restore builds each spec as `AppDelegate.openTab(_:)` does (`terminalSpec(cli:env:kind:shell:terminalEnv:)` + `registry.open`), refused specs skipped; `TerminalTab` has no input hook yet (override `send(source:data:)` to bump `lastActivity`); `-openTabs` can go once restore covers it.

- [ ] **Step 1: Write the failing tests**

```swift
func testLoadMissingIsEmpty() { … }
func testRoundTripSlashKey() throws { … branches[layoutKey(kind: .worktree, branch: "feature/x")] with two tabs and active 1 survives save + load and is distinct from the .container key }
func testCorruptIsEmpty() throws { … "{ nope" → empty }
func testSaveIsAtomic() throws { … no "*.tmp" left in the directory }
func testLayoutPath() { XCTAssertEqual(layoutPath(repoName: "kunj", home: "/h"), "/h/.kunj/kunj/workspace.json") }
```

- [ ] **Step 2: Run, implement, run; wire restore and `lastActivity`**

Run: `scripts/test.sh` → PASS; `scripts/bundle.sh && open …`: open two tabs, quit, relaunch, select the environment: both are back (the agent one attached to tmux); `cat ~/.kunj/kunj/workspace.json` shows them.

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: persist open tabs and last activity per repo" && git push
```

---

### Task 9: The Changes column with Monaco's diff editor

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Diff/DiffModel.swift`, `workspace-app/Sources/KunjWorkspaceCore/Diff/DiffService.swift`, `workspace-app/Sources/KunjWorkspaceCore/Diff/GitRunner.swift`, `workspace-app/Sources/KunjWorkspace/Editor/MonacoWebView.swift`, `workspace-app/Sources/KunjWorkspace/Views/ChangesColumn.swift` (Task 6's placeholder exists: keep `show(_:)` and `theme`, replace the inside), `workspace-app/Sources/KunjWorkspace/Views/ChangedFileRowView.swift`, `workspace-app/Resources/web/index.html` (replaces the placeholder), `workspace-app/Resources/web/app.js`
- Modify: `MainWindowController.swift`, `EnvironmentStore` (an `onRepoChanged(root)` hook so the column refreshes on `git` events of its repo)
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/DiffModelTests.swift`, `workspace-app/Tests/KunjWorkspaceCoreTests/DiffServiceTests.swift` (builds a temp git repository with `git init`, an `origin` remote pointing at a second temp repo, two commits, a modified, an added, a deleted, a renamed and an untracked file; the shared `diffTestEnvironment(kind:branch:path:state:exists:prBase:)` helper lives there)

**Status:** done. The core (`DiffModel`, `GitRunner`, `DiffService`, with Task 10's `FileAccess`) shipped in 831d215; the web page, `MonacoWebView`, `ChangesColumn`, `ChangedFileRowView`, `ChangesList.swift` and the store's `onRepoChanged` in f3c01a5, as built below. Not yet checked against the real kunj with a selected environment (Step 5's live part): the store is wired into `AppDelegate` by Task 7.

**Interfaces:**
- `DiffModel.swift`: `public enum DiffScope: String, CaseIterable { case base, uncommitted, last; public var label: String /* "vs base", "Uncommitted", "Last commit" */; public func label(base: String?) -> String /* "vs origin/main" for .base */ }`; `public enum FileStatus: String { case added = "A", modified = "M", deleted = "D", renamed = "R" }`; `public struct ChangedFile: Equatable { path: String; oldPath: String?; status: FileStatus; added, deleted: Int /* nil → 0 for binary */ }`; `public struct DiffSummary: Equatable { files: [ChangedFile]; var added: Int; var deleted: Int }`; `public func parseNumstat(_ s: String) -> [(path: String, oldPath: String?, added: Int, deleted: Int)]` (`-` counts as 0; `old => new` and `{a => b}/c` rename forms); `public func parseNameStatus(_ s: String) -> [String: FileStatus]` (`R100\told\tnew` keyed by new path); `public func diffArgs(scope:, mergeBase: String?) -> (list: [[String]], contentRefs: (old: String?, new: String?))`: base → `["diff","--numstat","-M", mb]` + `["diff","--name-status","-M", mb]`, old ref `mb`, new nil (working tree); uncommitted → `HEAD`; last → `["diff","--numstat","-M","HEAD~1","HEAD"]`, old `HEAD~1`, new `HEAD`; `public func chooseBase(prBase: String?, originHead: String?, branches: [String]) -> String` (`origin/<prBase>` when it is in `branches`, else `originHead`, else `origin/main` if in `branches`, else `origin/master`; never a local `main`/`master`). `parseNumstat`/`parseNameStatus` also undo git's C-quoting.
- `GitRunner.swift`: `public protocol CommandRunner { func run(_ argv: [String], cwd: String, env: [String: String], stdin: Data?) async throws -> (stdout: Data, exit: Int32) }`; `public struct ProcessRunner: CommandRunner`; `public struct GitContext { enum Target { case worktree(path: String), container(branch: String, repoRoot: String) } }`; `public func gitArgv(_ target: GitContext.Target, cli: KunjCLI, _ args: [String]) -> (argv: [String], cwd: String, env: [String: String])` (worktree: `["/usr/bin/git", "-C", path] + args`, env `GIT_OPTIONAL_LOCKS=0`; container: `cli.spawnSpec(["ct","exec",branch,"--","git"] + args, cwd: repoRoot)`); as built the worktree env is the terminal environment plus `GIT_OPTIONAL_LOCKS=0` (git needs `HOME`), and `execArgv(target, cli:, argv)` beside it runs a non-git command (`find`) the same way. `CommandRunner` returns stdout and exit only, so a failure names the command and exit code, not git's stderr.
- `DiffService.swift`: `public final class DiffService { public init(cli: KunjCLI, runner: CommandRunner = ProcessRunner()); public func summary(env: Environment, scope: DiffScope) async throws -> (DiffSummary, baseLabel: String)` (base: origin's branches and HEAD from ONE `for-each-ref --format=%(refname)\t%(symref) refs/remotes/origin/`, `chooseBase`, then `git merge-base <base> HEAD`, cached per environment id for `contents`; untracked via `ls-files --others --exclude-standard -z` added as `.added` (not in `last`), their line counts from ONE `find ./a ./b -maxdepth 0 -type f -exec wc -l {} +` (one exec in a container, never one per file; symlinks and devices skipped; at most `maxCountedUntracked` = 500 counted, the rest 0)); `public func contents(env:, scope:, file: ChangedFile) async throws -> (original: String, modified: String)` (`git show <ref>:<path>`, empty for a missing side; the working file through `FileAccess`, a worktree symlink as its target text, as git stores it) }`. Every git call adds `--no-optional-locks -c core.quotePath=false` (a container does not get the host's env). Errors are `DiffError.unavailable` (worktree gone, container not running; nothing runs), `.noBase` (the chosen base does not exist or shares no commit with HEAD) and `.commandFailed` (also `last` on a repository with one commit): the column shows each as its empty state's message.
- `index.html` + `app.js` (served over the `kunj://app/` scheme as in the spike; `fonts/…` from `Resources/fonts`, the rest from `Resources/web`, because the WebKit process does not see the app's registered fonts): `?mode=diff` creates a read-only `createDiffEditor` (`renderSideBySide: true`, which Monaco shows inline below 900 px, i.e. always at 1440 wide, as `warm.png`; JetBrains Mono 11.5 px, line height 19 px, `minimap` off, `renderOverviewRuler` false, `hideUnchangedRegions` with 3 context lines) plus a second, single-side editor for a file with one empty side (added or deleted: every line marked `+`/`−`, since Monaco diffs an empty side as one changed empty line), `?mode=editor` an editable `create` (Task 10). Every page function takes ONE argument object, because `MonacoWebView.call(fn, [String: Any])` has no argument order: `window.kunj.setTheme({tokens})` (`MonacoWebView.tokens(theme)`; `editor.background` = `bg`, `diffEditor.insertedLineBackground` = `addBg`, `diffEditor.removedLineBackground` = `red` at 18 %, `editorLineNumber.foreground` = `faintest`; code monochrome, `text2` with comments `muted`, `inherit: false`, bracket colours off, per DESIGN.md principle 4), `showDiff({original, modified, language, path})` (an empty `language` picks one from the path's extension map), `clear()`. The page posts `{type: "ready", mode}` and `{type: "error", message}` to the `kunj` message handler. Cmd+F stays Monaco's.
- Fonts: `scripts/fetch-fonts.sh` also copies each font's `OFL.txt` into `Resources/fonts/`.
- `MonacoWebView`: `final class MonacoWebView: NSView { init(mode: "diff" | "editor"); func whenReady(_:); func call(_ fn: String, _ args: [String: Any]) async -> Any?; var onMessage: (([String: Any]) -> Void)? }` with a shared `WKProcessPool` and the scheme handler from the spike.
- `MonacoWebView` as built: `ready`, `whenReady`, `call` (queued until `ready`; nil when the function threw), `onMessage` (sees `ready` again after a crashed content process reloads the page, so the owner re-sends its content), `static tokens(_ theme:)`, `snapshot(completion:)` (`--screenshot` composites it: `cacheDisplay` does not draw a WKWebView); navigation outside `kunj://` is cancelled.
- `ChangesColumn` as built: header bar 40 px: `Changes` sans 12.5/500, `14 files · +199 −12` mono 11 (`muted`, `green`, `red`), and a custom-drawn `ScopeButton` (24 px, `raised2`, `borderStrong`, radius 5, sans 11.5 `text2`, chevron; pops an NSMenu of the three scopes, the base one titled `vs origin/main`), not an `NSPopUpButton`, which cannot take the tokens nor be drawn by `cacheDisplay`; file list 196 px (`NSTableView`, rows 28 px, padding 8 px, `ChangedFileRowView`: letter mono 10 in `green`/`amber`/`red`, name sans 12, counts mono 10 `muted`, `green`/`red` on the selected row, which is `raised`, radius 5, inset 6 px), every file listed (no "8 more…"), a row named by its basename widened by parent directories until unique (`changedFileDisplayNames`, so `routes/index.ts` beside `src/index.ts`); the first file selected on load (`selectedIndexAfterRefresh`); the diff `MonacoWebView` fills the rest. API: `source: ChangesSource?` (`DiffService` conforms; `DemoChanges` for `--demo`; set by `AppDelegate` after discovery), `show(_:)` (the same environment reloads only when its state, `exists` or path changed), `theme`, `repoChanged(root:)` (reloads 500 ms later when the root is its environment's repository), `diffView`, `snapshotOverlay(in:completion:)`. The scope is kept per environment id; every reload refetches the selected file, but a diff identical to the one shown (`ShownDiff`, `diffNeedsShowing`) is not sent again, so an unrelated `git` event does not scroll it back to the top. Empty state: `No changes` in `muted`; a `DiffError` (or a `KunjCLIError`) shows its message there instead.
- `EnvironmentStore.onRepoChanged: ((String) -> Void)?`: called at once (not coalesced; the column debounces) with the root of a `git` event and of a container event whose action is `status` (a container's head or dirty state changed; there is no `git` event for a container). Task 7 wires it beside `render(repos:)`.

- [ ] **Step 1: Write the failing model tests**

```swift
func testParseNumstatWithRenameAndBinary() { … "3\t1\tsrc/a.ts\n-\t-\timg.png\n0\t0\t{old => new}/x.ts\n" }
func testParseNameStatus() { … "A\tnew.ts\nR100\told.ts\tnew2.ts\nD\tgone.ts" }
func testDiffArgsPerScope() { … }
func testChooseBase() { … pr "develop" → "origin/develop"; nil + "origin/main" → "origin/main"; nothing + ["origin/master"] → "origin/master" }
func testGitArgvWorktreeAndContainer() { … env["GIT_OPTIONAL_LOCKS"] == "0"; container argv starts with "/usr/bin/env", contains "ct", "exec", "--", "git" }
```

- [ ] **Step 2: Write the failing service test against a temp repository**

```swift
func testSummaryAndContentsInWorktree() async throws { … scope .base: files sorted by path contain the modified (M, +1 −1), added (A), deleted (D) and untracked (A) files; total counts; contents(modified) original == committed text, modified == working text; scope .last lists only the second commit's files }
```

- [ ] **Step 3: Run, implement, run**

Run: `scripts/test.sh` → PASS (git is on the machine; skip the service test with `.enabled(if: FileManager.default.isExecutableFile(atPath: "/usr/bin/git"))` when it is missing).

- [ ] **Step 4: Build the web page, the web view and the column**

- [ ] **Step 5: Compare and check live**

Run: `scripts/bundle.sh && "…/KunjWorkspace" --demo --screenshot /tmp/ws-changes.png` (the demo feeds the mockup's file list and a diff fixture) against `warm.png`; then `open …`: this repository's `main` with an uncommitted edit shows it under Uncommitted and vs origin/main; a container environment shows its diff through `kunj ct exec`; editing a file in the worktree updates the list within a few seconds (the `kunj events` status poll) and the app does not refresh in a loop (`kunj events --json` in a terminal stays quiet while the app is idle).

- [ ] **Step 6: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: Changes column with Monaco diff" && git push
```

---

### Task 10: Editor tabs

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Files/FileAccess.swift` (done, 831d215), `workspace-app/Sources/KunjWorkspace/Editor/EditorTab.swift`, `workspace-app/Sources/KunjWorkspaceCore/Files/EditorSave.swift`, `workspace-app/Sources/KunjWorkspace/Views/HeaderTextButton.swift` (as built)
- Modify: `Resources/web/app.js` (`?mode=editor`), `TabRegistry.swift` (editor tabs), `TabBarView.swift` (dirty dot, title = file name), `ChangesColumn.swift` (double-click and an `Edit` button in the diff header), `TerminalColumn.swift` (shows the editor web view for an editor tab), `AppDelegate.swift` (⌘S `File > Save`)
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/FileAccessTests.swift` (done), `EditorSaveTests.swift`

**Status:** done. `FileAccess` shipped with Task 9's core in 831d215; `EditorSave.swift`, `EditorTab`, the editor mode, `HeaderTextButton` and the wiring in 54a0685, as built below. Checked live: an editor tab restored from `workspace.json` opened and loaded, unreadable paths (missing, `../`) closed with `notFound`/`badPath`. Not checked by hand: typing → dirty dot, ⌘S, the conflict alert, the close prompt, double-click, container files. `--screenshot` cannot show the editor page (`snapshotPNG` composites only the diff page and the terminals) and in some sessions renders the diff page blank.

**Interfaces:**
- `FileAccess.swift`: `public struct FileAccess { public init(cli: KunjCLI); public func read(env: Environment, path: String) async throws -> String` (worktree: `path` must be relative, no `..` component → else `FileAccessError.badPath`; `String(contentsOf:)` UTF-8; container: `cli.run<FileReadJson>(["ct","file","read",branch,path], cwd: repoRoot).content`); `public func write(env:, path:, content: String) async throws` (worktree: atomic write; container: `cli.run<FileWriteJson>(["ct","file","write",branch,path], stdin:)`); `public func digest(_ s: String) -> String` (SHA-256 hex, `CryptoKit`; also a free `digest(_:)`) }`; `public enum FileAccessError: Error, Equatable { case badPath, notFound }`. As built: a `Sendable` struct; the path check turns `./a` into `a` and refuses empty, absolute, NUL and `..`; a worktree read takes only a regular file (a symlink to one is followed; a fifo, a device or a directory is `notFound`); a worktree write writes through a symlink, creates missing directories and keeps the file's mode; kunj's `not-found`/`bad-path` map to `FileAccessError`, any other kunj error is rethrown as `KunjCLIError`.
- `app.js` editor mode: `openFile({id, content, language, path})`, `showFile({id})`, `closeFile({id})`, `getContent({id}) -> string` (one argument object, as Task 9's functions), posts `{ type: "dirty", id, dirty }` on model change and `{ type: "save", id }` on Cmd+S inside Monaco.
- `EditorTab`: `final class EditorTab { let id; let env; let path; var dirty: Bool; var openedDigest: String; func save() async throws` (re-reads the file first: when its digest ≠ `openedDigest` and ≠ the digest of the content being saved, an `NSAlert` "The file changed on disk" with Overwrite / Cancel) `}`; the registry closes a dirty editor tab only after an `NSAlert` Save / Don't Save / Cancel.
- As built, Core: `EditorSave.swift`: `public enum SaveDecision { case write, alreadySaved, conflict(deleted: Bool) }`, `public func saveDecision(onDisk: String?, openedDigest: String, content: String) -> SaveDecision` (nil on disk → `.conflict(deleted: true)`, whose alert offers "Save" to recreate the file; a disk already holding the text → `.alreadySaved`, nothing written), `editorTabTitle(_ path:)` (the file name), `maxEditableBytes` (5 MB) and `editorRefusal(_ text:) -> String?` (too large; a NUL byte → binary; a U+FFFD → not UTF-8, since `FileAccess` and `kunj ct file read` decode lossily and saving would write replacement characters); tests `EditorSaveTests`.
- As built, page: `openFile` replaces an existing model of the id; `getContent({id})` returns `{content, version}` (Monaco's alternative version id) and `markSaved({id, version})` marks clean only that version, so text typed during a save stays dirty; `focus()`; `dirty` is posted only when it flips; ⌘S is a Monaco command (`addCommand`) posting `save` with the current id. Editor font 12.5 px (the terminal's size), line height 20.
- As built, app: tabs are `any WorkspaceTab` (`@MainActor protocol WorkspaceTab: AnyObject { id, envId, kind, title, running }`; `TerminalTab` and `EditorTab` conform); `TabRegistry.tabs(for:)`, `active(for:)`, `allTabs`, `activate(_:)`, `close(_:)` take or return `any WorkspaceTab`, `allTerminals`/`allEditors` filter (Task 11: use `allTerminals` where a terminal is needed). The registry adds `fileAccess` (set by `AppDelegate` after discovery; `openEditor` returns nil before), `openEditor(env:path:failed:)` (an open tab of the same path is activated; the file loads in the background and a refused or unreadable one closes the tab and calls `failed` with the reason), `save(_:) async -> Bool`, `onSaved` (the Changes column reloads: a worktree edit makes no `git` event), `editorView` (ONE `MonacoWebView(mode: "editor")` for every editor tab, created with the first, placed edge to edge in the column body), `hasEditorView`, `shownEditor` (the editor tab on screen, set by `TerminalColumn.sync`, so key presses in the page count as `lastActivity`). A page `ready` after a crash reloads every loaded file from disk (unsaved text is lost with the process). `EditorTab`: `id` `"<envId>#editor#<n>"`, `env`, `path`, `title`, `dirty`, `openedDigest`, `loaded`, `load() async throws`, `show()`, `discard()`, `save() async -> Bool` (alerts itself on conflict and on failure). `TerminalColumn.activeTab` is `any WorkspaceTab`, `activeEditor: EditorTab?`. `TabBarItem.dirty` draws a `text2` dot (status colours stay for agent states). `ChangesColumn` has a diff header row (warm.html's hunk header: 29 px, `raised2`, mono 11.5 `muted` path truncated at the head, `border` hairline) with an `Edit` `HeaderTextButton` (disabled for a deleted file), the table's `doubleAction`, and `onEdit: ((Environment, String) -> Void)?`. `AppDelegate`: `File > Save` ⌘S (`saveFile`, enabled while the active editor is loaded), `wireEditors()`, and `confirmQuitWithUnsavedEditors()` (Cancel / Quit Without Saving) in `applicationShouldTerminate`. `LayoutKeeper` restores with `kinds: [.shell, .agent, .editor]`; its `tabs` closure saves an editor tab's `path`, and `keeper.open` reopens it through `openEditor`.

- [ ] **Step 1: Write the failing tests**

```swift
func testReadWriteWorktree() async throws { … temp dir; write then read round-trips; "../x" → .badPath; "/etc/passwd" → .badPath }
func testContainerGoesThroughKunjCtFile() async throws { … fake-kunj fixture ct_file_read_feature-x_src-a.ts.json → content; write sends stdin (fixture echoes `{"success":true,"path":…}`) }
func testDigestIsStable() { XCTAssertEqual(digest("a"), digest("a")); XCTAssertNotEqual(digest("a"), digest("b")) }
```

- [ ] **Step 2: Run, implement, run; build the editor mode, the tab and the wiring**

Run: `scripts/test.sh` → PASS; `scripts/bundle.sh && open …`: double-click a changed file → an editor tab titled with the file name; type → dot on the tab; ⌘S → the Changes list's counts update; edit the same file in another editor and ⌘S in the app → the conflict alert; close a dirty tab → the save prompt. Same for a file in a running container.

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: editor tabs in Monaco with save and conflict check" && git push
```

---

### Task 11: Actions, New session, search, shortcuts, settings and themes

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift`, `workspace-app/Sources/KunjWorkspace/Actions/ActionRunner.swift`, `workspace-app/Sources/KunjWorkspace/Sheets/NewSessionSheet.swift`, `workspace-app/Sources/KunjWorkspace/Settings/SettingsWindow.swift`
- Modify: `HeaderView.swift` (overflow menu, enabled states), `SidebarView.swift` (search filtering, `+ New session`), `AppDelegate.swift` (menus: `Kunj Workspace > Settings… ⌘,`, `Environment > Shell ⌘T / Agent ⌘⇧A / Open in VS Code ⌘O / Create PR ⌘⇧P / New Session ⌘N / Switch 1–9 ⌘1–9`, `View > Theme`, `View > Show Changes ⌘⇧C`), `MainWindowController.swift` and `TabBarView.swift` and `ChangesColumn.swift` (the Changes toggle), `Theme.swift` (apply a theme change to every view and terminal live)
- Test: `workspace-app/Tests/KunjWorkspaceCoreTests/ActionSpecTests.swift`
- As built, also: `Controls.swift` (`PillView.count`, `SearchField.clear`/`onEscape`, a faded disabled `ActionButton.filled`), `TerminalColumn.swift` (`setChanges`, `onToggleChanges`); `Theme.swift` needed no change (`ThemeManager.onChange` already re-themes every view, the terminals and both Monaco pages)

**Status:** done in fb62af9, review fixes in the Task 11 review commit. Checked: `--demo --screenshot` with `--theme warm|light|graphite` and `--no-changes` against `warm.png`/`light.png`/`graphite.png` (the diff page snapshot is blank in this environment, as since Task 10), a live run against the dev kunj lists environments, `kunj config --get agent.tmux --global --json` answers `{key, value}`. Not checked by hand: each header and overflow action against real worktrees and containers, New session creating and selecting `tmp/ws-test`, Remove Worktree's confirmation, `ct start` streaming in an action tab, ⌘K/⌘2, Settings toggles writing the global config, a kunj command change in Settings.

- As built, Core (`ActionSpec.swift`): `ActionPlan.terminal(args:title:cwd:)` (title = the first two args), `.run` answers decode as `RunResultJson { success, exec?, editorCommand? }` and `runOutcome(args, result) -> RunOutcome` (`.done`, `.info(title:detail:)` for `ct open`'s `exec`, `.failed(title:detail:)` for `success: false`: `worktree open` exits 0 with `success: false` when the editor did not start or `worktree.editorCommand` is empty); `KunjSetting` (`CaseIterable`, `defaultValue`), `configGetArgs(_:)`, `configSetArgs(_:_:)`, `ConfigValueJson { key, bool? }` (`value` omitted when unset: the setting's default applies; kunj answers the merged value, which in `$HOME` is the global one); `isValidBranchName` (`git check-ref-format --branch` rules); disabled reasons are the tooltips (`Only for a container`, `Only for a worktree`, `The worktree directory is missing`, `The main worktree cannot be removed`, `Create PRs from a worktree of this branch`, `A container has no folder on this Mac`, running/stopped container).
- As built, app: `ActionRunner` (`Actions/ActionRunner.swift`, owned by `AppDelegate`, wired in `wireRunner()`): `plan(_:_:)`, `perform(_:env:)` (removals confirm in a sheet with a "Force" checkbox), `overflowMenu(env:)` (items of the other kind left out, Reveal in Finder not on a container, the rest greyed with the reason as tooltip, Prune Containers… in every menu), `newSession(_:fallback:)` (the action tab opens in the repo's main worktree, else its first worktree, else any of its environments, else the selected one; the new environment is selected, and its agent opened, once a listing shows it usable, waited for up to 30 min) and `listed(_:)` (called from the store's `onChange`); `MenuAction` (an `NSMenuItem` running a closure). `.run` actions get a 600 s timeout (`ct open` may resume the container); `ct open`'s credentials warning is not shown. `HeaderView.plan` enables Open in VS Code and Create PR (all enabled in `--demo`). `NewSessionSheet` (`Sheets/`) as specified; a base is any ref not starting with `-` and without whitespace. `SettingsWindow` (`Settings/`): `kunjCommandKey`, `onKunjCommandChanged` (applied when the field ends editing: `AppDelegate.reconnect()` stops the event stream, drops the store and rediscovers; the `LayoutKeeper` stays and reads the new store; open tabs keep their command; a discovery or first listing still running for the old command is dropped), `cli` (the agent toggles are disabled until discovery). `MainWindowController.setChangesVisible(_:animated:)`, `changesVisible`, `onToggleChanges`, `visibleEnvironmentIds` (`SidebarView.visibleIds`); `ChangesColumn.isActive`; `TabBarView.showChanges(count:open:)`: the pill stays on a clean environment and only its count is hidden at 0, because the base scope shows committed work. Menus: `Kunj Workspace > Settings…` ⌘,, `Environment > Open in VS Code` ⌘O, `Create PR` ⌘⇧P, `New Session…` ⌘N, `Search Sessions` ⌘K, a `Switch to Session` submenu ⌘1–9 (the nth row the search leaves), `View > Show/Hide Changes` ⌘⇧C. Esc in the search clears it; Esc on an empty field gives the terminal the keyboard. Launch flags: `--changes`/`--no-changes` force the column for one run, `--theme <name>` overrides the theme for one run (`ThemeManager.override`); `--demo` opens the column.


**Interfaces:**
- `ActionSpec.swift`: `public enum EnvAction: Equatable { case ctStart, ctStop, ctRemove(force: Bool), ctRebuild, ctOpen, worktreeOpen, worktreeRemove(force: Bool), createPR, prune, copyPath, revealInFinder, openPort(Int) }`; `public enum ActionPlan: Equatable { case terminal(args: [String], title: String); case run(args: [String]); case external(url: String); case local(String) /* copyPath, reveal */; case disabled(reason: String) }`; `public func actionPlan(_ action: EnvAction, env: Environment, worktreeOfSameBranch: Environment?) -> ActionPlan`: `ctStart` → `.terminal(["ct","start",branch], "ct start")`, `ctStop` → `.run(["ct","stop",branch])`, `ctRemove` → `.terminal(["ct","remove",branch] + (force ? ["--force"] : []))`, `ctRebuild` → `.terminal(["ct","start",branch,"--rebuild"])`, `ctOpen` → `.run(["ct","open",branch])`, `worktreeOpen` → `.run(["worktree","open",path])`, `worktreeRemove` → `.terminal(["worktree","remove",path] + force)`, `createPR` → `.terminal(["pr"], "pr")` run in the worktree's path (the plan carries `cwd` override: add `cwd: String?` to `.terminal`), for a container with `worktreeOfSameBranch` nil → `.disabled("Create PRs from a worktree of this branch")`, `prune` → `.terminal(["ct","prune"])`, `openPort(p)` → `.external("http://localhost:\(p)")`, `copyPath`/`revealInFinder` → `.local(path or containerName)`; `public struct NewSessionRequest: Equatable { repo: RepoRef; branch: String; base: String?; kind: EnvironmentKind; startAgent: Bool }`; `public func newSessionPlan(_ r: NewSessionRequest) -> ActionPlan` → worktree: `["worktree","add",branch,"-c"] + (base ? ["--base", base] : [])`, container: `["ct","start",branch,"-c"]` (base through `--base` when `ct start` has it, else omitted) as `.terminal`.
- `ActionRunner`: executes a plan: `.terminal` opens an action tab in the environment (for New session: a temporary "new" environment row is not created; the tab opens in the repo's main worktree environment and the sidebar selects the new environment when it appears; with `startAgent` an agent tab is opened then), `.run` runs `cli.run<SuccessJson>` and shows an `NSAlert` on error, `.external` `NSWorkspace.shared.open`, destructive actions (`ctRemove`, `worktreeRemove`) confirm first (`NSAlert`, with a "Force" checkbox mapping to `force`).
- `NewSessionSheet`: repo popup (from the store), branch text field, base text field (placeholder "repo default"), kind radio (Worktree / Container; Container disabled when the repo's backend is unavailable), "Start an agent" checkbox, Create / Cancel; Create validates the branch name (`git check-ref-format --branch` rules: non-empty, no spaces, `..`, `~`, `^`, `:`, `?`, `*`, `[`, leading `-`).
- Changes toggle (user, 2026-10-23: the column is hidden by default): `MainWindowController.setChangesVisible(_ visible: Bool, animated: Bool)` collapses `ChangesColumn` to zero width (the terminal column takes the window) or restores the `paneSplit` 11fr:9fr; UserDefaults `showChanges` (default `false`) holds it app-wide and is read at launch. Controls: a `Changes N` pill at the right of `TabBarView` (`PillView`, active = `raised` fill while open, N = the selected environment's changed-file count from the last `worktree list`/`ct list`; at 0 the pill shows only "Changes"), and `View > Show Changes` / `Hide Changes` ⌘⇧C. While hidden, `ChangesColumn` sets `isActive = false` and skips its refresh on selection and `git` events; opening it loads the selected environment at once. Double-clicking a file and the diff header's `Edit` (Task 10) need it open; editor tabs already open stay in the left column either way. `--demo` still shows the column (it renders the mockup), and `--changes`/`--no-changes` force it open or closed for one run. A Swift Testing test in Core is not needed (pure view state); verify by screenshots with the column closed and open.
- Search: typing in the sidebar field already filters rows (Task 6, `filterEnvironments`: repo name, branch or kind, case-insensitive); this task adds Esc to clear and ⌘K to focus (`SearchField.focus()`). ⌘1–9 select the nth visible row: `environmentIds(filterEnvironments(repos, query:))`, since `environmentIds(repos)` alone ignores the filter. View > Theme already exists (Task 6) and writes the `theme` default the settings popup must share.
- `SettingsWindow` (⌘,): "kunj command" text field (UserDefaults `kunjCommand`, the key Task 3's `AppDelegate` reads; default `kunj`; change re-runs discovery and rebuilds the store and the event stream on the new `KunjCLI`), a Theme popup (`auto`, `warm`, `light`, `graphite`), and an "Agents" group with two checkboxes backed by kunj settings, not UserDefaults (the CLI and the app share them): "Run agents in tmux" (`agent.tmux`, default on; when off a note says "Agents stop when their tab closes") and "Show tmux status line" (`agent.tmuxStatus`, default off; disabled while tmux is off). Read each with `KunjCLI.run(configGetArgs(setting), cwd: NSHomeDirectory())` (`run` appends `--json`: `{ key, value }`, `value` absent when unset) and write with `runRaw(configSetArgs(setting, value), cwd: NSHomeDirectory(), …)`; a failed write shows an inline error and reverts the checkbox; they apply to agents started afterwards. Add to `ActionSpec.swift` (it exists from the core lane) `public enum KunjSetting: String { case agentTmux = "agent.tmux", agentTmuxStatus = "agent.tmuxStatus" }` and `public func configSetArgs(_ setting: KunjSetting, _ value: Bool) -> [String]` with a test (`configSetArgs(.agentTmux, false) == ["config", "--set", "agent.tmux=false", "--global"]`); `ThemeManager.choice` applies at once: views re-read colours, terminals get `installColors` + background, Monaco `setTheme` (setting `TabRegistry.theme` already re-themes the terminals and the editor page; the diff page is `ChangesColumn.theme`). Code that walks the registry for terminals uses `allTerminals`: `allTabs` also holds editor tabs (Task 10).

- [ ] **Step 1: Write the failing table test**

```swift
func testActionPlans() { … one assertion per EnvAction case, plus ctRemove force → "--force", createPR for a container without a worktree → .disabled, createPR for a worktree → cwd == path }
func testNewSessionPlans() { … worktree with base; container without base }
```

- [ ] **Step 2: Run, implement, run; build the runner, the sheet, the menus, search, shortcuts, settings and live theming**

Run: `scripts/test.sh` → PASS; `scripts/bundle.sh && open …`: Shell/Agent/Open in VS Code/Create PR/… all act; New session creates a worktree `tmp/ws-test` and selects it; the overflow's Remove worktree confirms and removes it; `ct start` on a stopped container streams in an action tab that closes on success; ⌘K then typing filters; ⌘2 selects the second row; Settings → Light re-themes the window live and `--screenshot` with `--theme light`/`graphite` matches `light.png` and `graphite.png`.

- [ ] **Step 3: Commit**

```bash
git add workspace-app aj-log.md && git commit -m "workspace-app: actions, new session, search, shortcuts, settings and themes" && git push
```

---

### Task 12: Distribution, `kunj install workspace` and docs

**Files:**
- Modify: `.github/workflows/release.yml` (job `workspace-app` on `macos-15`: `brew install` nothing; `npm ci` in `web/`, `scripts/bundle.sh` with `VERSION`, `ditto -c -k --keepParent "build/Kunj Workspace.app" "Kunj-workspace-$VERSION.zip"`, attach; release notes paragraph), `src/lib/apps.ts` (`CompanionApp` gains `'workspace'`: `{ label: 'Kunj Workspace app', asset: /^Kunj-workspace-.*\.zip$/ }`; `installMacApp(zipPath, { app: 'Kunj.app' | 'Kunj Workspace.app' })` generalised, `installedMacApp(app)`), `src/commands/install.ts` (`workspace` target, in `all` on darwin, help text), `src/commands/setup.ts` if it offers apps, `README.md` (a Workspace app section), `docs-site/src/content/docs/` (a `workspace-app.mdx` page: what it is, install, the layout, shortcuts, themes, how agents persist), `docs/specs/workspace-ide.md` (status table → Shipped with commits), `docs/specs/README.md` (tracker), `CLAUDE.md` (a Workspace app paragraph next to the macOS app one), `workspace-app/README.md`
- Test: `src/lib/__tests__/apps.test.ts` (extend: `pickAsset` for `workspace`; `installMacApp` app name)

- [ ] **Step 1: Write the failing `apps` tests, run, implement, run**

```ts
test('pickAsset finds the workspace zip of the matching release', …);
test('installMacApp installs to the app name given', …);   // temp HOME/Applications, a zip with "Kunj Workspace.app/Contents/Info.plist"
```

Run: `npm test -- apps && npm run lint && npm run build`
Expected: PASS; `node dist/index.js install --help` lists `workspace`.

- [ ] **Step 2: Release job and docs**

`npm run gen` in `docs-site` after the `install` option change; `cd docs-site && npm run build` passes.

- [ ] **Step 3: Final checks**

Run: `cd workspace-app && scripts/test.sh && scripts/bundle.sh --install` then use the installed app for the whole loop once: select, shell, agent (attached to the CLI's tmux session), Changes, edit + save, Create PR disabled/enabled as expected, quit without orphans (`pgrep -f "kunj events|kunj ct shell"` empty).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "workspace-app: release job, kunj install workspace and docs" && git push
```
