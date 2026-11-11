# Workspace app: all settings

The workspace app's Settings window shows every kunj setting and the app's own, instead of the five
it has today. The CLI publishes its settings list; the app draws the window from it.

## Status

| Part | State |
| --- | --- |
| CLI: `config --schema`, `--set-json`, `--unset` | Spec written |
| App: Settings window drawn from the schema | Spec written |
| User docs | Spec written |

## Goal

- Every setting registered in `src/settings/` can be read and changed in the app, in the global
  config or in one repository's config.
- The app's own preferences sit in the same window.
- A setting added to the CLI later appears in the app with no app change.

Not in scope: editing hook scripts in `~/.kunj/hooks/`, the secret vault (`kunj secret`), blueprints,
`remotes.json`. The existing container token block stays as it is.

## What exists today

- About 95 settings in 14 categories (`general`, `worktree`, `agent`, `container`, `lsp`, `repos`,
  `secrets`, `ai`, `flow`, `jira`, `slack`, `hooks`, `filtering`, `stash`), each a `SettingDefinition`
  (key, type, default, description, enum options, `sensitive`, `validate`).
- `kunj config --list --json` prints `{ global, local, merged }`; `--get <key> --json` prints
  `{ key, value }`; `--set key=value [--global]` writes.
- `--set` guesses the type from the text: `true` and `12` can never be stored as strings, an empty
  string cannot be set, a list item cannot contain a comma, an object cannot be set, and nothing is
  checked against the registry. The app cannot rely on it for 95 settings.
- No way to remove a value, except `--reset` which empties the whole file.
- `SettingsWindow.swift` is one hand-built grid: kunj command, theme, `agent.tmux`,
  `agent.tmuxStatus`, `container.useGhToken`, the container tokens.
- App preferences in `UserDefaults`: kunj command, theme, show empty repositories,
  Files column, Changes column (the last three only as menu toggles).

## CLI changes

All additive. `kunj config` stays off the fast path (it needs the full registry).

### `kunj config --schema --json`

Prints `ConfigSchemaJson` (new, in `src/lib/json-types.ts`):

```ts
interface ConfigSchemaJson {
  categories: { id: string; title: string }[];   // in display order
  settings: ConfigSettingJson[];                  // in registration order
}
interface ConfigSettingJson {
  key: string;                 // 'agent.tmux'
  category: string;            // a categories[].id
  type: 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'object';
  default: unknown;
  description: string;
  detailedDescription?: string;
  options?: string[];          // enum
  examples?: string[];
  sensitive?: boolean;
}
```

- Category titles come from one table in the CLI (`general` → "General", `lsp` → "Language servers",
  `filtering` → "Branch filtering", …). A setting with no category goes to `general`.
- The `hooks.<name>` settings are in the list like any other (type `string`; an array value is shown
  as JSON by the app, see Controls).
- Without `--json` it prints the same as a plain table (key, type, default). Reading needs no
  repository.
- `object` is a new `SettingType` for values the registry could not describe before. `lsp.servers` is
  registered with it (default `{}`), so it appears in the schema, and `container.services` and
  `container.mcp` (registered as `string` with an object check) become `object`. An `array` whose
  items are objects (`container.files`) keeps its type; the app tells them apart by the value (see
  Controls).

### `kunj config --set-json <key>=<json> [--global]`

Sets one key to a JSON value, exactly: `--set-json 'agent.command="true"'` stores the string.

- The key must be registered, else `unknown-setting`.
- The value must match the type: boolean, finite number, string, one of `options`, array, object.
  A setting with `validate` must pass it. Else `bad-value`, with what was expected in the message.
- One argument, split at the first `=` (a key never contains one), so a value that starts with `-`
  is never read as an option.
- With `--json` it prints `{ key, value, scope: 'global' | 'local' }`; errors are
  `{ error: { code, message } }`.
- `--set` is unchanged.

### `kunj config --unset <key> [--global]`

Removes the key from that config file, and any parent object it leaves empty. Exits 0 when the key
was not there. With `--json`: `{ key, scope, removed: boolean }`. An unregistered key is allowed, so a
stale key can be cleaned up.

### Sensitive values

`--list --json` already prints stored tokens in full and that does not change. The app never shows
them (see Controls).

## App

### Window

```
┌ Settings ─────────────────────────────────────────────┐
│ [Search]                    Scope: [Global ▾]         │
├──────────────┬────────────────────────────────────────┤
│ App          │ Run agents in tmux            [x]      │
│ General      │   agent.tmux · Global          Reset   │
│ Worktrees    │ Agent command   [claude            ]   │
│ Agents       │   agent.command · default              │
│ Containers   │ …                                      │
│ …            │                                        │
└──────────────┴────────────────────────────────────────┘
```

- Left: "App", then the schema's categories in its order. Right: the rows of the chosen category in a
  scroll view. The window is resizable; it remembers its size and the last category.
- Search filters rows across all categories by key, title and description; while it has text the
  left list shows only categories with a match.
- Scope popup: "Global", then each repository from `kunj repos --json`. It starts on Global each time the window
  opens. The App category ignores it and hides it.

### App category

Kept in `UserDefaults`, applied at once, as today:

| Row | Key |
| --- | --- |
| kunj command | `kunjCommandKey` |
| Theme | theme choice |
| Show repositories with no sessions | `showEmptyReposKey` |
| Show the Files column | `showFilesKey` |
| Show the Changes column | `showChangesKey` |

The menu items for the last three stay and both places stay in step (one notification per key).

### Rows

Each row: a title, the control, and under it the key, the description and where the value comes from.

- Title: the key's last part in words (`tmuxStatus` → "Tmux status"), unless the app has a nicer one
  in a small table (the three existing toggles keep their wording).
- Source, for the scope shown: `default`, `Global`, or the repository's name. In a repository scope a
  value that comes from Global is shown, marked "Global"; changing it writes the repository's config.
- Reset appears when the value is set in the scope shown; it runs `--unset` for that scope.

### Controls

| Type | Control |
| --- | --- |
| `boolean` | Checkbox; saved on click |
| `enum` | Popup of `options` |
| `number` | Text field accepting a number; saved on Return or when focus leaves |
| `string` | Text field, monospaced; an empty field saves the empty string |
| `string`, `sensitive` | Secure field showing "Set" or empty, never the value; typing replaces it |
| `array` of strings | Text box, one item per line |
| `object`, an `array` holding non-strings, or any value whose JSON type is not the setting's | Text box holding the JSON, checked as JSON before saving |

A text control saves on Return (⌘Return in a box) or when it loses focus, only when the text changed.

### Reading and writing

- Open: the App category shows at once. In the background the app runs `config --schema --json` once
  per app run and `config --list --json` for the scope (in the home directory for Global, in the
  repository root otherwise). The rest shows a spinner until both are back.
- Changing the scope reruns `--list`; so does the window becoming key again, in case the CLI changed
  the file.
- Write: `config --set-json <key>=<json>` plus `--global` in the Global scope, run with the
  repository root as `cwd` otherwise. On success the row takes the value from the reply. On failure
  the control goes back to the old value and the error's message shows in red under the row until
  the next change.
- Writes run one at a time, in order, so two quick changes cannot interleave on one file.
- `agent.tmux` keeps its note about tmux not being installed; the Containers category keeps the
  GitHub and Claude Code token block above its rows, unchanged, and `container.useGhToken` is drawn
  once, in that block.

### Older kunj

`--schema` fails as an unknown option on a kunj older than this change. The window then shows the App
category and one line in the left list's place for the rest: "Update kunj to edit its settings here."
`MIN_KUNJ_VERSION` does not move.

### Code

| Where | What |
| --- | --- |
| `KunjWorkspaceCore/JSON/ConfigSchema.swift` | `ConfigSchemaJson` and `ConfigListJson` mirrors; values as a small `JSONValue` enum |
| `KunjWorkspaceCore/Model/SettingsModel.swift` | For a schema, a list reply and a scope: the rows per category, each with value, source and control kind; search; titles from keys; text ↔ `JSONValue` for each control |
| `KunjWorkspaceCore/Actions/ActionSpec.swift` | `configSchemaArgs`, `configListArgs`, `configSetJsonArgs`, `configUnsetArgs`; the Bool-only `KunjSetting` helpers go once the window no longer uses them |
| `KunjWorkspace/Settings/SettingsWindow.swift` | The window, category list, scope popup, search |
| `KunjWorkspace/Settings/SettingRowView.swift` | One row and its control |
| `KunjWorkspace/Settings/AppSettingsPane.swift` | The App category |
| `KunjWorkspace/Settings/ContainerTokensView.swift` | The token block, moved out of `SettingsWindow` unchanged |

`SettingsWindow.swift` is 409 lines doing everything today; splitting it is part of this work.

## Tests

- Jest, `src/commands/__tests__/config-schema.test.ts`: the schema lists every registered key once
  with a known category; `--set-json` stores exact values, refuses an unknown key, a wrong type, a
  value outside `options` and one failing `validate`; `--unset` removes the key and empty parents,
  and reports `removed: false` for a missing key; `--set` behaves as before.
- Swift Testing, `KunjWorkspaceCore`: decoding the schema and list fixtures; source per scope
  (default, Global, repository); control kind per type and value; text ↔ JSON round trips (lists,
  empty string, a string that looks like a number); search; the argument builders. `fake-kunj` gains
  `config --schema`, `--list`, `--set-json` and `--unset`.
- `--demo --screenshot` renders the window with fixture data for a look at the layout.

## Docs

`docs-site`: the workspace app page's Settings section; `npm run gen` for the new `config` options.
`workspace-ide.md`'s Settings paragraph points here. CLAUDE.md: the `config` options and
`ConfigSchemaJson` in the contract list.
