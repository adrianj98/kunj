# Workspace App: All Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workspace app's Settings window shows and edits every registered kunj setting (global or per repository) and the app's own preferences.

**Architecture:** The CLI gains three additive `kunj config` options: `--schema` (the settings list as JSON), `--set-json` (an exact, checked setter) and `--unset`. Their logic is pure functions in a new `src/lib/config-edit.ts`; `config.ts` only wires them. The app decodes the schema and `--list` reply in `KunjWorkspaceCore`, turns them into rows with a value, a source and a control kind (`SettingsModel`, unit tested), and the AppKit window draws those rows.

**Tech Stack:** TypeScript + Jest (CLI); Swift 5.9, AppKit, Swift Testing (app).

**Spec:** `docs/specs/workspace-settings.md`

## Global Constraints

- Work on `main` in this checkout; no branches, no worktrees. Pull first, commit after each task, push.
- CLI JSON is additive only: no existing option, field or output of `kunj config` changes. `--set` keeps its behaviour exactly.
- `MIN_KUNJ_VERSION` stays 1.3.0. A kunj without `--schema` must leave the App category usable.
- The app never runs anything but `kunj … --json` for settings, with `cwd` = home (Global) or the repository root.
- A sensitive value is never put in a control, a log line or an error message by the app.
- `kunj config` stays off the fast path; add no import to `src/commands/fast.ts` modules.
- After each task: update `docs/specs/workspace-settings.md`'s status table and `aj-log.md` (what changed and why) in the same commit. Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Functional tests (`npm run test:functional`) are not run.
- App build and tests: `workspace-app/scripts/test.sh`; CLI: `npm run lint && npm test`.

## Review Focus

1. A config file edited by hand holds a value of the wrong type (a string where the setting is boolean, an object where it is a string): the row shows it in the JSON box and can be fixed or Reset; nothing crashes. (Task 4)
2. A secure field that gained and lost focus without typing must not write the empty string over a stored token. (Task 4, Task 6)
3. Values with `=`, quotes, newlines, a leading `-` (`-1`), or the strings `"true"` and `"12"` round-trip exactly through `--set-json`. (Task 1, Task 2, Task 3)
4. `--unset` when a parent holds other keys (parent kept), when it leaves parents empty (removed), and when a path segment is not an object (reports `removed: false`, file untouched). Keys in the file that are not in the schema survive every write. (Task 1)
5. A repository in the scope popup whose folder is gone or is no longer a git repository: the list call fails, the error shows in the pane, Global and App keep working. (Task 6)

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/config-edit.ts` (new) | `buildConfigSchema`, `checkSettingValue`, `parseSetJson`, `setConfigPath`, `unsetConfigPath`, `ConfigEditError` |
| `src/lib/settings-registry.ts` | `SettingType` gains `'object'` |
| `src/settings/container.ts`, `src/settings/lsp.ts` | `container.services`, `container.mcp` retyped `object`; `lsp.servers` registered |
| `src/lib/json-types.ts` | `ConfigSchemaJson`, `ConfigSettingJson`, `ConfigSetJson`, `ConfigUnsetJson` |
| `src/commands/config.ts` | The three options, wired to `config-edit.ts` |
| `workspace-app/Sources/KunjWorkspaceCore/JSON/JSONValue.swift` (new) | `JSONValue` |
| `workspace-app/Sources/KunjWorkspaceCore/JSON/ConfigSchema.swift` (new) | Decodable mirrors of the four CLI replies |
| `workspace-app/Sources/KunjWorkspaceCore/Model/SettingsModel.swift` (new) | Rows, sources, control kinds, text ↔ value, search, titles |
| `workspace-app/Sources/KunjWorkspaceCore/Actions/ActionSpec.swift` | Argument builders; `KunjSetting`, `configGetArgs`, `configSetArgs`, `ConfigValueJson` removed in Task 6 |
| `workspace-app/Sources/KunjWorkspace/Settings/ContainerTokensView.swift` (new) | The token block, moved |
| `workspace-app/Sources/KunjWorkspace/Settings/AppSettingsPane.swift` (new) | The App category |
| `workspace-app/Sources/KunjWorkspace/Settings/SettingRowView.swift` (new) | One row and its control |
| `workspace-app/Sources/KunjWorkspace/Settings/SettingsWindow.swift` | Window shell: category list, scope popup, search, loading, write queue |

---

### Task 1: CLI — settings schema and value checks (`config-edit.ts`)

**Files:**
- Create: `src/lib/config-edit.ts`, `src/lib/__tests__/config-edit.test.ts`
- Modify: `src/lib/settings-registry.ts` (`SettingType`), `src/settings/container.ts` (`container.services`, `container.mcp`: `type: 'object'`), `src/settings/lsp.ts` (register `lsp.servers`, `type: 'object'`, `defaultValue: {}`, category `lsp`), `src/lib/json-types.ts`
- Check: every `switch`/`if` on `setting.type` in `src/commands/config.ts` and `docs-site/scripts/gen-reference.cjs` still handles the retyped settings (they were shown as JSON before; keep that)

**Interfaces — Produces:**

```ts
// src/lib/json-types.ts
export interface ConfigSettingJson {
  key: string; category: string;
  type: 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'object';
  default: unknown; description: string;
  detailedDescription?: string; options?: string[]; examples?: string[]; sensitive?: boolean;
}
export interface ConfigSchemaJson { categories: { id: string; title: string }[]; settings: ConfigSettingJson[] }
export interface ConfigSetJson { key: string; value: unknown; scope: 'global' | 'local' }
export interface ConfigUnsetJson { key: string; scope: 'global' | 'local'; removed: boolean }

// src/lib/config-edit.ts
export class ConfigEditError extends UserError {}            // jsonCode: 'unknown-setting' | 'bad-value'
export const CATEGORY_TITLES: Record<string, string>;        // order = display order
export function buildConfigSchema(settings: SettingDefinition[]): ConfigSchemaJson;
export function checkSettingValue(setting: SettingDefinition, value: unknown): void;   // throws bad-value
export function parseSetJson(input: string, settings: SettingDefinition[]): { key: string; value: unknown }; // "key=<json>"
export function setConfigPath(config: Record<string, any>, key: string, value: unknown): void;
export function unsetConfigPath(config: Record<string, any>, key: string): boolean;    // true when removed
```

`CATEGORY_TITLES`, in this order: `general` General, `worktree` Worktrees, `agent` Agents, `container` Containers, `lsp` Language servers, `repos` Repositories, `secrets` Secrets, `ai` AI, `flow` Git flow, `jira` Jira, `slack` Slack, `hooks` Hooks, `filtering` Branch filtering, `stash` Stash. A category not in the table is appended with its id capitalised. Only categories that have a setting are listed.

`parseSetJson` splits at the first `=` (keys never contain one), so a value starting with `-` is never read as an option. `checkSettingValue`: `boolean` → `typeof boolean`; `number` → finite number; `string` → string; `enum` → string in `options`; `array` → `Array.isArray`; `object` → plain object; then `validate`, when present, must return true (a throwing `validate` counts as false). The message names the key and what was expected (`agent.tmux must be true or false.`). `hooks.*` settings (type `string`) also accept an array of strings.

- [ ] **Step 1: Write the failing tests** in `config-edit.test.ts` (import `../../settings` so the registry is filled):

```ts
const all = settingsRegistry.getAll();
test('schema lists every registered key once, in a known category', () => {
  const s = buildConfigSchema(all);
  expect(s.settings.map(x => x.key).sort()).toEqual(all.map(x => x.key).sort());
  expect(new Set(s.settings.map(x => x.key)).size).toBe(s.settings.length);
  const ids = s.categories.map(c => c.id);
  for (const x of s.settings) expect(ids).toContain(x.category);
  expect(ids.indexOf('general')).toBeLessThan(ids.indexOf('container'));
  expect(s.categories.find(c => c.id === 'lsp')!.title).toBe('Language servers');
});
test('schema carries type, default, options and sensitive', () => {
  const by = Object.fromEntries(buildConfigSchema(all).settings.map(x => [x.key, x]));
  expect(by['agent.tmux']).toMatchObject({ type: 'boolean', default: true, category: 'agent' });
  expect(by['preferences.branchSort'].options!.length).toBeGreaterThan(1);
  expect(by['jira.apiToken'].sensitive).toBe(true);
  expect(by['lsp.servers']).toMatchObject({ type: 'object', default: {} });
  expect(by['container.mcp'].type).toBe('object');
});
test.each([
  ['agent.command="true"', 'true'], ['agent.command="12"', '12'], ['agent.command=""', ''],
  ['agent.command="a=b \\"q\\"\\nline"', 'a=b "q"\nline'], ['agent.tmux=false', false],
  ['container.pruneAfterDays=0', 0], ['container.env=["A,B","C"]', ['A,B', 'C']],
  ['lsp.servers={"go":{"command":"gopls"}}', { go: { command: 'gopls' } }],
])('parseSetJson %s', (input, value) => {
  expect(parseSetJson(input, all).value).toEqual(value);
});
test.each([
  ['nope.key=1', 'unknown-setting'], ['agent.tmux="yes"', 'bad-value'], ['agent.tmux', 'bad-value'],
  ['agent.command=12', 'bad-value'], ['preferences.branchSort="sideways"', 'bad-value'],
  ['preferences.pageSize=-1', 'bad-value'], ['preferences.pageSize=1e999', 'bad-value'],
  ['container.env={"a":1}', 'bad-value'], ['agent.command={not json', 'bad-value'],
])('parseSetJson refuses %s with %s', (input, code) => {
  expect(() => parseSetJson(input, all)).toThrow(expect.objectContaining({ jsonCode: code }));
});
test('setConfigPath creates parents and keeps neighbours', () => {
  const c: any = { agent: { command: 'x' }, stale: { key: 1 } };
  setConfigPath(c, 'agent.tmux', false); setConfigPath(c, 'lsp.idleStopMinutes.cold', 3);
  expect(c).toEqual({ agent: { command: 'x', tmux: false }, stale: { key: 1 }, lsp: { idleStopMinutes: { cold: 3 } } });
});
test('unsetConfigPath removes the key and the parents it empties', () => {
  const c: any = { lsp: { idleStopMinutes: { cold: 3 } }, agent: { tmux: false, command: 'x' } };
  expect(unsetConfigPath(c, 'lsp.idleStopMinutes.cold')).toBe(true);
  expect(unsetConfigPath(c, 'agent.tmux')).toBe(true);
  expect(c).toEqual({ agent: { command: 'x' } });
  expect(unsetConfigPath(c, 'agent.tmux')).toBe(false);
  expect(unsetConfigPath(c, 'agent.command.deeper')).toBe(false);   // a segment that is not an object
  expect(c).toEqual({ agent: { command: 'x' } });
});
```

Use the real enum key and a number setting with `validate` from `src/settings/core.ts` if `preferences.branchSort` / `preferences.pageSize` differ from the above.

- [ ] **Step 2:** Run `npm test -- src/lib/__tests__/config-edit.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Add `'object'` to `SettingType`; retype the two container settings; register `lsp.servers`; add the four interfaces to `json-types.ts`; implement `config-edit.ts` to the signatures above. `setConfigPath`/`unsetConfigPath` refuse the segments `__proto__`, `constructor`, `prototype` (`bad-value`).
- [ ] **Step 4:** Run `npm run lint && npm test`. Expected: all pass, including `json-types.contract.test.ts` and `lsp.test.ts` (the `lsp.servers` default `{}` must not change `kunj lsp list`).
- [ ] **Step 5:** Commit: `Config: settings schema and exact value checks (config-edit.ts)`.

---

### Task 2: CLI — `kunj config --schema`, `--set-json`, `--unset`

**Files:**
- Modify: `src/commands/config.ts` (options list, `ConfigOptions`, `execute`)
- Create: `src/commands/__tests__/config-edit-command.test.ts`
- Modify: `docs-site/src/data/*.json` (via `cd docs-site && npm run gen`), `CLAUDE.md` (Key Commands line for `kunj config`; `ConfigSchemaJson` in the contract list)

**Interfaces — Consumes:** everything Task 1 produces. **Produces** (the app relies on these):

```
kunj config --schema --json                     → ConfigSchemaJson            (needs no repository)
kunj config --set-json <key>=<json> [--global]  → --json: ConfigSetJson
kunj config --unset <key> [--global]            → --json: ConfigUnsetJson, exit 0 when the key was absent
errors with --json                              → { error: { code: 'unknown-setting'|'bad-value', message } }
```

Option flags: `--schema`, `--set-json <key=json>`, `--unset <key>`. Order in `execute`: `--schema` is answered first, before any config file is loaded. `--set-json` and `--unset` load only the one file they write (`loadGlobalConfig`/`loadLocalConfig`), change it with `setConfigPath`/`unsetConfigPath` and save it with the matching save function; `--unset` saves only when something was removed. Text output: `✓ Set global agent.tmux` (never the value: it may be a token) and `✓ Removed global agent.tmux` / `agent.tmux was not set in the global config`. `--schema` without `--json` prints one line per setting: key, type, default (masked when sensitive).

- [ ] **Step 1: Write the failing test.** It drives `new ConfigCommand()` with `HOME` set to a `fs.mkdtempSync` directory (check how `getGlobalConfigPath()` resolves home in `src/lib/config.ts` and use the same seam the existing `config-migrate.test.ts` uses), capturing `console.log`:

```ts
test('--schema --json prints the schema', …  expect(out.settings.length).toBe(settingsRegistry.getAll().length));
test('--set-json --global writes the exact value and reports it', … 
  // run { setJson: 'agent.command="true"', global: true, json: true }
  expect(out).toEqual({ key: 'agent.command', value: 'true', scope: 'global' });
  expect(JSON.parse(fs.readFileSync(globalPath, 'utf8')).agent.command).toBe('true'));
test('--set-json keeps keys it does not know', …  // file starts as { stale: { x: 1 } }; still there after
test('--set-json refuses a bad value and leaves the file alone', … // agent.tmux="yes" → rejects, jsonCode 'bad-value', file bytes unchanged
test('--unset removes, then reports removed:false', … 
test('--set still guesses types', … // set: 'agent.command=true' stores boolean true, as before
test('text output of --set-json never prints the value', … // jira.apiToken="s3cret" → no "s3cret" in output
```

- [ ] **Step 2:** Run `npm test -- src/commands/__tests__/config-edit-command.test.ts`. Expected: FAIL (unknown options do nothing).
- [ ] **Step 3:** Implement in `config.ts` as described.
- [ ] **Step 4:** Run `npm run lint && npm test && npm run build`, then by hand in a scratch home:

```bash
export HOME=$(mktemp -d) && cd "$HOME"
node /Users/adrian/projects/kunj/dist/index.js config --schema --json | head -c 300
node /Users/adrian/projects/kunj/dist/index.js config --set-json 'preferences.pageSize=-1' --global --json; echo "exit $?"
node /Users/adrian/projects/kunj/dist/index.js config --set-json 'lsp.maxServers=2' --global --json
node /Users/adrian/projects/kunj/dist/index.js config --unset lsp.maxServers --global --json
```

Expected: the schema; `{"error":{"code":"bad-value",…}}` and `exit 1`; the set reply; `{"key":"lsp.maxServers","scope":"global","removed":true}`.
- [ ] **Step 5:** `cd docs-site && npm run gen`; update `CLAUDE.md`. Commit: `kunj config --schema, --set-json and --unset`.

---

### Task 3: App core — JSON mirrors, argument builders, fake-kunj

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/JSON/JSONValue.swift`, `…/JSON/ConfigSchema.swift`, `workspace-app/Tests/KunjWorkspaceCoreTests/ConfigSchemaTests.swift`
- Create fixtures: `workspace-app/Tests/Fixtures/responses/config_schema.json` (the real output of Task 2's `--schema --json`, trimmed to about 15 settings covering every type, one sensitive, one enum, `hooks.pre-commit`), `config_list.json`
- Modify: `…/Actions/ActionSpec.swift` (add builders; remove nothing yet)

**Interfaces — Produces:**

```swift
public enum JSONValue: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public func compact() -> String        // one line, sorted keys; 3 not 3.0 for whole numbers
    public func pretty() -> String         // 2-space indent, sorted keys
    public func at(_ dottedKey: String) -> JSONValue?   // "agent.tmux" through nested objects
    public init?(json: String)             // nil when the text is not JSON (fragments allowed: 3, "x", true)
}
public struct ConfigCategoryJson: Decodable, Equatable, Sendable { public var id, title: String }
public struct ConfigSettingJson: Decodable, Equatable, Sendable {
    public var key, category, type, description: String
    public var `default`: JSONValue?
    public var detailedDescription: String?; public var options: [String]?; public var sensitive: Bool?
}
public struct ConfigSchemaJson: Decodable, Equatable, Sendable { public var categories: [ConfigCategoryJson]; public var settings: [ConfigSettingJson] }
public struct ConfigListJson: Decodable, Equatable, Sendable { public var global, local, merged: JSONValue }
public struct ConfigSetJson: Decodable, Equatable, Sendable { public var key: String; public var value: JSONValue; public var scope: String }
public struct ConfigUnsetJson: Decodable, Equatable, Sendable { public var key, scope: String; public var removed: Bool }

public enum SettingsScope: Equatable, Sendable { case global, repo(root: String, name: String) }
public let configSchemaArgs = ["config", "--schema"]
public let configListArgs = ["config", "--list"]
public func configSetJsonArgs(_ key: String, _ value: JSONValue, _ scope: SettingsScope) -> [String]  // ["config","--set-json","<key>=<compact>"] + ["--global"] for .global
public func configUnsetArgs(_ key: String, _ scope: SettingsScope) -> [String]
public func settingsCwd(_ scope: SettingsScope, home: String) -> String   // home, or the repo root
```

A setting of an unknown `type` string decodes fine (the model treats it as JSON); unknown fields are ignored.

- [ ] **Step 1: Write the failing tests** (`ConfigSchemaTests.swift`, Swift Testing):

```swift
@Test func decodesTheSchemaFixture() throws   // categories non-empty; agent.tmux: type "boolean", default .bool(true)
@Test func decodesTheListFixture() throws     // list.global.at("agent.tmuxStatus") == .bool(false); list.merged.at("no.such") == nil
@Test func compactWritesWholeNumbersWithoutAFraction() { #expect(JSONValue.number(3).compact() == "3"); #expect(JSONValue.number(0.5).compact() == "0.5") }
@Test func compactRoundTripsAwkwardStrings()   // "true", "12", "", "a=b \"q\"\nline", "-x": JSONValue(json: v.compact()) == v
@Test func setJsonArgs() {
    #expect(configSetJsonArgs("agent.command", .string("true"), .global) == ["config", "--set-json", "agent.command=\"true\"", "--global"])
    #expect(configSetJsonArgs("preferences.pageSize", .number(-1), .repo(root: "/r", name: "r")) == ["config", "--set-json", "preferences.pageSize=-1"])
}
@Test func unsetArgsAndCwd()                   // ["config","--unset","agent.tmux","--global"]; settingsCwd(.repo(root:"/r",name:"r"), home:"/h") == "/r"
@Test func fakeKunjAnswersSchemaAndList() async throws  // KunjCLI pointed at fake-kunj decodes both
```

- [ ] **Step 2:** Run `workspace-app/scripts/test.sh`. Expected: FAIL to compile (types missing).
- [ ] **Step 3:** Implement. `compact()`/`pretty()` use `JSONSerialization` with `.sortedKeys` and `.fragmentsAllowed`; whole numbers are bridged as `Int64` so they print without `.0`.
- [ ] **Step 4:** Run `workspace-app/scripts/test.sh`. Expected: PASS.
- [ ] **Step 5:** Commit: `Workspace app: config schema mirrors and argument builders`.

---

### Task 4: App core — `SettingsModel`

**Files:**
- Create: `workspace-app/Sources/KunjWorkspaceCore/Model/SettingsModel.swift`, `workspace-app/Tests/KunjWorkspaceCoreTests/SettingsModelTests.swift`

**Interfaces — Consumes:** Task 3's types. **Produces:**

```swift
public enum SettingSource: Equatable, Sendable { case `default`, global, repo }
public enum SettingControl: Equatable, Sendable { case checkbox, popup([String]), number, text, secret, lines, json }
public struct SettingRow: Equatable, Sendable, Identifiable {
    public var id: String { key }
    public var key, title, description, category: String
    public var control: SettingControl
    public var value: JSONValue?          // the effective value in this scope; nil only when there is no default either
    public var source: SettingSource
    public var isSetInScope: Bool         // Reset is offered
}
public struct SettingsModel: Equatable, Sendable {
    public init(schema: ConfigSchemaJson, list: ConfigListJson, scope: SettingsScope)
    public var categories: [ConfigCategoryJson]
    public func rows(in category: String) -> [SettingRow]
    public func search(_ text: String) -> [SettingRow]          // key, title, description; case-insensitive; "" → []
    public func replacing(_ key: String, with value: JSONValue?) -> SettingsModel   // after a set (value) or unset (nil), in this scope
}
public func settingTitle(_ key: String) -> String
public func settingText(_ row: SettingRow) -> String            // what a text-like control shows
public enum SettingInputError: Error, Equatable { case notANumber, notJSON }
public func settingValue(from text: String, for control: SettingControl) -> Result<JSONValue, SettingInputError>
public func secretChange(typed: String, edited: Bool) -> JSONValue?   // nil = write nothing
```

Rules:
- Value and source. Global scope: `list.global` at the key, else the default (`.default`). Repository scope: `list.local` (`.repo`), else `list.global` (`.global`), else the default. `list.merged` is not used. `isSetInScope` is true only for the file of the scope shown.
- Control, decided from the type **and the value**: `boolean` + bool → `.checkbox`; `enum` + string in options → `.popup(options)` (a stored string not in options is added as the last item); `number` + number → `.number`; `string` + string → `.secret` when `sensitive`, else `.text`; `array` + every item a string → `.lines`; everything else, including `object`, an unknown type and any type/value mismatch → `.json`. A nil value takes the control of the type.
- `settingTitle`: `TITLES[key]` when present (`agent.tmux` "Run agents in tmux", `agent.tmuxStatus` "Show tmux status line", `container.useGhToken` "Use gh's GitHub token"), else the last key segment split at capitals and `-`, first word capitalised, the rest lower case, with `Pr`, `Ai`, `Aws`, `Gh`, `Url`, `Wip`, `Lsp`, `Cpus`→ their usual upper-case forms (`agent.antigravityCommand` → "Antigravity command", `ai.awsRegion` → "AWS region", `hooks.pre-commit` → "Pre commit").
- `settingText`: `.lines` → items joined by `\n`; `.json` → `pretty()`; `.number` → `compact()`; `.text` → the string; `.secret` → `""` always.
- `settingValue`: `.text` → `.string(text)` untrimmed (empty allowed); `.number` → a finite `Double` after trimming, else `.notANumber`; `.lines` → non-empty trimmed lines; `.json` → `JSONValue(json:)`, else `.notJSON`.
- `secretChange`: `edited == false` → nil; otherwise `.string(typed)`.

- [ ] **Step 1: Write the failing tests** against small inline schemas (a helper `schema(_ settings: ConfigSettingJson...)`):

```swift
@Test func globalScopeReadsGlobalThenDefault()      // set in global → .global, isSetInScope; absent → .default, value == default
@Test func repoScopeReadsLocalThenGlobalThenDefault() // local wins (.repo, isSetInScope true); global only → .global, isSetInScope false
@Test func repoScopeIgnoresMerged()                 // merged says X, global/local empty → default
@Test func controlPerType()                         // one expectation per rule line above
@Test func mismatchedValueBecomesJSON()             // boolean setting holding .string("yes") → .json; string setting holding .object → .json
@Test func enumKeepsAnUnknownStoredValue()          // options ["a","b"], value "c" → .popup(["a","b","c"])
@Test func hooksArrayValueIsJSON()                  // type string, value .array([...]) → .json
@Test func titles()                                 // the examples in the rules
@Test func textRoundTrips()                         // lines ["A,B","C"] ↔ "A,B\nC"; ".text" "" → .string(""); "12" as .text → .string("12")
@Test func numberInput()                            // " 3 " → 3; "abc" → .notANumber; "1e999" → .notANumber
@Test func jsonInput()                              // "{bad" → .notJSON; "{\"a\":1}" → object
@Test func secretNeverShowsAndUntouchedWritesNothing() // settingText == ""; secretChange(typed:"", edited:false) == nil; (typed:"", edited:true) == .string("")
@Test func searchMatchesKeyTitleAndDescription()    // "tmux" finds both agent rows; "TMUX" too; "" → []
@Test func replacingUpdatesValueAndSource()         // replacing(key, with: .bool(false)) → .global/true; with: nil → back to default
@Test func rowsKeepSchemaOrderWithinACategory()
```

- [ ] **Step 2:** Run `workspace-app/scripts/test.sh`. Expected: FAIL to compile.
- [ ] **Step 3:** Implement `SettingsModel.swift`.
- [ ] **Step 4:** Run `workspace-app/scripts/test.sh`. Expected: PASS.
- [ ] **Step 5:** Commit: `Workspace app: SettingsModel (rows, sources, controls)`.

---

### Task 5: App — split `SettingsWindow`, App pane with the view toggles

No behaviour change to tokens, kunj command or theme; the window still looks as it does today plus three checkboxes.

**Files:**
- Create: `workspace-app/Sources/KunjWorkspace/Settings/ContainerTokensView.swift`, `…/Settings/AppSettingsPane.swift`
- Modify: `…/Settings/SettingsWindow.swift`, `workspace-app/Sources/KunjWorkspace/AppDelegate.swift` (lines ~495-530, the three toggle actions, and ~1145 menu validation)

**Interfaces — Produces:**

```swift
@MainActor final class ContainerTokensView: NSView {
    var cli: KunjCLI?                                   // didSet reloads
    var selectedEnvironment: () -> Environment?
    var openAction: (Environment, TerminalSpec, @escaping (Int32) -> Void) -> Void
    func reload()                                       // token status + global secrets
    func apply(_ theme: Theme)
}
@MainActor final class AppSettingsPane: NSView {
    var onKunjCommandChanged: () -> Void
    func refresh()                                      // re-reads UserDefaults and the theme into the controls
    func apply(_ theme: Theme)
}
extension Notification.Name { static let viewPreferenceChanged }   // object: the UserDefaults key (String)
```

- `ContainerTokensView` takes everything from `// MARK: container tokens` down, plus the GitHub line, Set Up…/Test/Remove and their labels. The `container.useGhToken` checkbox stays in `SettingsWindow` for now (Task 6 moves it into this view as a schema row).
- `AppSettingsPane` rows: kunj command (+ its note), Theme, "Show repositories with no sessions" (`AppDelegate.showEmptyReposKey`), "Show the Files column" (`showFilesKey`), "Show the Changes column" (`showChangesKey`).
- One path for the three toggles: `AppDelegate` gets `func setViewPreference(_ key: String, _ on: Bool)` that does what the three menu actions do today (write the default, change the window) and posts `.viewPreferenceChanged`; the menu actions and the pane's checkboxes both call it; the pane observes the notification and calls `refresh()`.

- [ ] **Step 1:** Move the token code to `ContainerTokensView` and embed it where the Containers cell was. Build: `workspace-app/scripts/test.sh` passes (it builds the app target).
- [ ] **Step 2:** Create `AppSettingsPane`, add `setViewPreference`, route the menu actions through it, replace the command and theme rows of the grid with the pane.
- [ ] **Step 3: Verify by running the app** (`workspace-app/scripts/bundle.sh`, open it, ⌘,): toggling each checkbox changes the window and the menu item's check mark; toggling from the menu changes the checkbox while Settings is open; kunj command, Theme, token Set Up…/Test/Remove behave as before.
- [ ] **Step 4:** Commit: `Workspace app: Settings split into panes; view toggles in Settings`.

---

### Task 6: App — the schema-driven window

**Files:**
- Create: `workspace-app/Sources/KunjWorkspace/Settings/SettingRowView.swift`
- Modify: `…/Settings/SettingsWindow.swift`, `…/Settings/ContainerTokensView.swift`, `…/Actions/ActionSpec.swift` and `ActionSpecTests.swift` (remove `KunjSetting`, `configGetArgs`, `configSetArgs`, `ConfigValueJson` and their tests), the demo data (`Sources/KunjWorkspace/Demo/`) for `--demo` Settings
- Modify: wherever `SettingsWindow` is created in `AppDelegate.swift` (pass the repositories)

**Interfaces — Consumes:** Tasks 3-5. **Produces:**

```swift
@MainActor final class SettingRowView: NSView {
    init(row: SettingRow, enabled: Bool)
    var onChange: (JSONValue) -> Void        // a valid new value
    var onReset: () -> Void
    func show(error: String?)                // red line under the row
    func update(_ row: SettingRow)           // after a write or a reload; never while its field is being edited
    func apply(_ theme: Theme)
}
// SettingsWindow gains:
var repositories: () -> [(root: String, name: String)]   // from the store's kunj repos listing, hidden ones left out
```

Behaviour (spec sections Window, Rows, Controls, Reading and writing, Older kunj):
- Window: resizable, minimum 640×420, `setFrameAutosaveName("Settings")`; an `NSSplitView`-free layout: a fixed 170 pt `NSTableView` source list on the left, an `NSScrollView` with a vertical stack of `SettingRowView`s on the right; toolbar-less top bar with `NSSearchField` (left) and the scope `NSPopUpButton` (right). The last category is kept in `UserDefaults` key `settingsCategory`.
- Categories: "App" (shows `AppSettingsPane`, hides the scope popup), then `model.categories`. In "Containers", `ContainerTokensView` sits above the rows and the `container.useGhToken` row is drawn inside it (after the GitHub line), not in the list below; after that row changes, call `ContainerTokensView.reload()`.
- `agent.tmux` row: the caption "Agents stop when their tab closes" shows when its value is false; `agent.tmuxStatus` is disabled while `agent.tmux` is false.
- Row layout: title (left), control (right, 280 pt for fields), under them one caption line `key · source` (source: "default", "Global", or the repository name) then the description; `Reset` button at the caption's right when `isSetInScope`.
- Controls: checkbox and popup call `onChange` on click. Fields call it on Return or end of editing when the text differs from `settingText(row)` and `settingValue` succeeds; on failure they show "Not a number" / "Not valid JSON" and keep the text. `.lines` and `.json` use a 4-line `NSTextView` (⌘Return commits). `.secret` is an `NSSecureTextField` with placeholder "Set" when a value is stored, "Not set" otherwise; it tracks `edited` (a `controlTextDidChange` happened since focus) and commits `secretChange(typed:edited:)`.
- Loading: on first show and on scope change run `configListArgs` with `settingsCwd(scope, home:)`; the schema (`configSchemaArgs`, cwd home) is fetched once and kept for the app run. A generation counter drops a reply for a scope no longer shown. `windowDidBecomeKey` reloads the list unless a field is being edited or a write is pending. While loading: a spinner in the right pane; the App category is usable throughout.
- Writes: a serial queue (an array of pending operations drained by one `Task`). Set: `let reply: ConfigSetJson = try await cli.run(configSetJsonArgs(key, value, scope), cwd:…, timeout: 30)` then `model = model.replacing(key, with: reply.value)`. Reset: `configUnsetArgs`, then `replacing(key, with: nil)`. On error: `row.update(oldRow)` and `row.show(error: (error as? KunjCLIError)?.message ?? "\(error)")`. Log `kunj config: set <key>` without the value.
- Errors: a failed list for a repository scope shows the message in the right pane with a "Global" button that switches scope. A failed schema whose message contains `unknown option` shows, in place of the kunj categories, the single line "Update kunj to edit its settings here."; any other schema failure shows its message and a Retry button.
- Search: non-empty text replaces the right pane with `model.search(text)` grouped under category headings and the left list with the categories that have a hit (App rows match on their labels); clearing it restores the last category.
- `--demo`: Settings uses the Task 3 fixtures (no CLI), so `--demo --screenshot` with a new `--settings` argument (handled next to the other argument-domain flags at `AppDelegate.swift:315-332`) renders the window on the Agents category.

- [ ] **Step 1:** Add to `SettingsModelTests.swift` any pure helper this task needs that is not yet covered (for example the source caption `func sourceCaption(_ row: SettingRow, scope: SettingsScope) -> String` in `SettingsModel.swift`: "default" / "Global" / repository name) with its test first; run `workspace-app/scripts/test.sh`, see it fail, implement, pass.
- [ ] **Step 2:** Build `SettingRowView`, then the window shell, loading and the write queue.
- [ ] **Step 3:** Remove the old `KunjSetting` code and tests; `workspace-app/scripts/test.sh` passes.
- [ ] **Step 4: Screenshot check:** `workspace-app/scripts/bundle.sh`, then run the app with `--demo --settings --screenshot <scratchpad>/settings.png` and look at the image: categories on the left, rows with title, control, `key · source` and description, nothing clipped at 640×420, light and warm themes.
- [ ] **Step 5: Live check** with the real CLI (kunj command set to `node /Users/adrian/projects/kunj/dist/index.js`), in a scratch `HOME` copy if you prefer not to touch the real config:
  - toggle `agent.tmuxStatus` in Global → `kunj config --get agent.tmuxStatus --global --json` agrees; Reset → key gone from `~/.kunj/config.json`;
  - switch scope to a repository, change `preferences.pageSize` → written to `~/.kunj/<repo>/config.json` only; source reads the repository's name;
  - type `abc` in a number field → "Not a number", nothing written; enter 0 for `preferences.pageSize` → the CLI's `bad-value` message under the row, value reverts;
  - click into `jira.apiToken` and out again → file unchanged;
  - edit `~/.kunj/config.json` by hand to `"agent": {"tmux": "yes"}`, reactivate the window → the row is a JSON box, Reset fixes it;
  - set the kunj command to an older installed kunj, if one is at hand → App category works, the update line shows;
  - point the scope at a repository whose folder was renamed away → error in the pane, Global button works.
- [ ] **Step 6:** Commit: `Workspace app: Settings shows every kunj setting, global or per repository`.

---

### Task 7: Docs and tracker

**Files:**
- Modify: `docs-site/src/content/docs/**/workspace-app.mdx` (Settings section: categories, scope, Reset, tokens never shown; one screenshot from Task 6 if the page has images), the `kunj config` page for the three options
- Modify: `docs/specs/workspace-ide.md` (the Settings paragraph near line 429 points to `workspace-settings.md`; code map row for the new files), `docs/specs/workspace-settings.md` (status table → Shipped, with commits), `docs/specs/README.md` (move the line from In progress to Done with commits; Specs table state → Shipped)
- Modify: `okf/apps/` workspace app page and `okf/features/` (a settings/config page or the existing one that covers `kunj config`), `okf/index.md` if a page is added
- Modify: `CLAUDE.md` Workspace App section (Settings is schema-driven; files), `workspace-app/README.md` if it lists Settings, `aj-log.md`

- [ ] **Step 1:** Make the edits above. `cd docs-site && npm run build` passes.
- [ ] **Step 2:** `npm run lint && npm test` and `workspace-app/scripts/test.sh` pass one last time.
- [ ] **Step 3:** Commit: `Docs: workspace app settings`, push.
