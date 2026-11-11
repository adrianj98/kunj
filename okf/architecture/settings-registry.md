---
type: Architecture
title: Settings Registry
description: The central registry where every kunj setting is declared with its type, default, category and help text, and from which the default config is generated.
resource: src/lib/settings-registry.ts
tags: [architecture, settings, config, defaults]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Settings are declared once, as `SettingDefinition` objects, in one module per area under
`src/settings/`. `initializeSettings()` in `src/settings/index.ts` registers them all (once, guarded by an
`initialized` flag) into the singleton `settingsRegistry` from `src/lib/settings-registry.ts`.

The registry is the source of three things: the default config (`getDefaultConfig()`), the
`kunj config` listing and interactive editor (`src/commands/config.ts`), and the generated settings
reference of the docs site (`docs-site/scripts/gen-reference.cjs`). Loading values from disk is the job
of [Configuration](/architecture/configuration.md).

# SettingDefinition

| Field | Meaning |
|-------|---------|
| `key` | Dotted path into the config object, e.g. `ai.commitStyle`, `container.network.allow` |
| `description` | One-line help |
| `type` | `'boolean' \| 'number' \| 'string' \| 'enum' \| 'array' \| 'object'` (`object`: `lsp.servers`, `container.services`, `container.mcp`) |
| `defaultValue` | Default; becomes part of `defaultConfig` |
| `category` | Grouping for `kunj config` |
| `options` | Allowed values for enums (also used by `secrets.keyProvider`, typed `string`) |
| `validate` | Optional predicate |
| `detailedDescription`, `examples`, `relatedSettings` | Longer help shown by `kunj config` |
| `sensitive` | Mask the value when displayed and prompt as a password (Jira and Slack tokens) |

`register()` warns and ignores a duplicate key. `getAll()`, `get(key)`, `getByCategory(category)` and
`has(key)` read the registry.

# Default Config

`src/constants/index.ts` calls `initializeSettings()` at import time and builds:

```ts
export const defaultConfig: KunjConfig = {
  ...settingsRegistry.getDefaultConfig(),   // nested object built by splitting each key on '.'
  aliases: {},                              // not a registered setting
};
```

Because `src/lib/config.ts` imports `defaultConfig`, any command that loads config has the registry
populated. The shape is typed by `KunjConfig` in `src/types/index.ts`.

# Modules and Categories

| Module | Register function | `category` | Keys (prefix) |
|--------|-------------------|------------|---------------|
| `core.ts` | `registerCoreSettings` | `general` | `preferences.autoStash`, `branchSort`, `pageSize`, `graphUnicode`, `graphStyle`, `defaultBaseBranch`, `baseFromOrigin` |
| `branch-filtering.ts` | `registerBranchFilteringSettings` | `filtering` | `preferences.showOnlyWIP`, `showOnlyConfigured`, `personalWIPMode`, `recentDays`, `wipTags`, `doneTags` |
| `stash.ts` | `registerStashSettings` | `stash` | `preferences.showStashDetails`, `stashAgeDays` |
| `ai.ts` | `registerAISettings` | `ai` | `ai.*` (provider `bedrock`, model `anthropic.claude-3-5-sonnet-20240620-v1:0`, `commitStyle` `conventional`, ...) |
| `flow.ts` | `registerFlowSettings` | `flow` | `flow.*` (git flow branches, prefixes, `mode`, `prProvider`) |
| `jira.ts` | `registerJiraSettings` | `jira` | `jira.*` (`apiToken` sensitive) |
| `slack.ts` | `registerSlackSettings` | `slack` | `slack.*` (`token`, `signingSecret`, `appToken` sensitive) |
| `worktree.ts` | `registerWorktreeSettings` | `worktree` | `worktree.baseDir` (`${repoconfig}/kunj/worktrees`), `worktree.editorCommand` (`code`) |
| `hooks.ts` | `registerHookSettings` | `hooks` | `hooks.<name>` for every entry of `HOOKS` in `src/lib/hook-defs.ts`, default `''` |
| `container.ts` | `registerContainerSettings` | `container` | `container.*` (image, env, network, forward, dockerInDocker, services, mcp, ...) |
| `agent.ts` | `registerAgentSettings` | `agent` | `agent.command` (`claude`), `agent.tmux` (true), `agent.tmuxStatus` (false), `agent.hooks` (true) |
| `secrets.ts` | `registerSecretsSettings` | `secrets` | `secrets.keyProvider` (`auto`; `auto`, `keychain`, `libsecret`, `passphrase`) |

The hook settings are generated: each `hooks.<name>` gets a `detailedDescription` listing the
`${...}` variables and `KUNJ_*` environment the hook receives, and `relatedSettings` pointing at the
hooks on the same subject ([Hooks](/features/hooks.md)).

# Validation

`validate` is advisory today: the interactive editor (`kunj config -i`) applies it to number prompts,
and enums are offered as a list of `options`. `kunj config --set key=value` parses the value with
`parseKeyValue()` in `src/lib/utils.ts` (split on the first `=`; `true`/`false`, numbers and `[a,b]`
lists are converted) and writes it without consulting the registry. `container.services` and
`container.mcp` are declared with `type: 'string'` but an object default (`{}`) and an object
`validate`; they are edited by hand in the config file.

# Adding a Setting

1. Add a `SettingDefinition` to the matching `src/settings/<area>.ts` (or a new module registered
   from `initializeSettings()`).
2. Add the field to `KunjConfig` in `src/types/index.ts`.
3. Read it from `loadConfig()` / `loadResolvedConfig()`.
4. Run `npm run gen` in `docs-site/` so the settings reference is regenerated.

# Related Concepts

* [Configuration](/architecture/configuration.md) - where values come from and how they merge
* [Config Variables](/architecture/config-variables.md) - `${...}` in string values
* [Hooks](/features/hooks.md)
* [Docs Site](/apps/docs-site.md) - generated settings reference

# Citations

## The registry as JSON, and exact edits

`src/lib/config-edit.ts` (pure functions; `kunj config` loads and saves the files) [13]:

| Option | Function | Result |
| --- | --- | --- |
| `kunj config --schema [--json]` | `buildConfigSchema(settings)` | `ConfigSchemaJson`: categories in display order (`CATEGORY_TITLES`) and every setting with key, category, type, default, description, options, `sensitive` |
| `kunj config --set-json <key>=<json> [--global]` | `parseSetJson()` → `checkSettingValue()` → `setConfigPath()` | The value stored exactly as given; `unknown-setting` for an unregistered key, `bad-value` for a wrong type, an option not listed or a failed `validate` |
| `kunj config --unset <key> [--global]` | `unsetConfigPath()` | The key removed, with the parents it leaves empty; `removed: false` when it was not there |

Both edits refuse a config file that is not JSON (`config-corrupt`), because the loaders read such a
file as empty and a write would replace it. `--set` is unchanged and still guesses the type from
the text. The workspace app's Settings window is built on these three
([workspace app](/apps/workspace-app.md)).

[1] [src/lib/settings-registry.ts](/src/lib/settings-registry.ts)
[2] [src/settings/index.ts](/src/settings/index.ts)
[3] [src/settings/core.ts](/src/settings/core.ts)
[4] [src/settings/ai.ts](/src/settings/ai.ts)
[5] [src/settings/container.ts](/src/settings/container.ts)
[6] [src/settings/hooks.ts](/src/settings/hooks.ts)
[7] [src/settings/agent.ts](/src/settings/agent.ts)
[8] [src/settings/secrets.ts](/src/settings/secrets.ts)
[9] [src/constants/index.ts](/src/constants/index.ts)
[10] [src/commands/config.ts](/src/commands/config.ts)
[11] [src/lib/utils.ts](/src/lib/utils.ts)
[12] [src/types/index.ts](/src/types/index.ts)
[13] [src/lib/config-edit.ts](/src/lib/config-edit.ts)
