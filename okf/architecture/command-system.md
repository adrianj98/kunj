---
type: Architecture
title: Command System
description: How kunj commands are declared (BaseCommand + CommandConfig), collected (getAllCommands, CommandRegistry) and wired into Commander, including --json and error printing.
resource: src/lib/command.ts
tags: [architecture, cli, commander, commands, errors]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Every kunj command is a class extending the abstract `BaseCommand` in `src/lib/command.ts`. The class
passes a declarative `CommandConfig` to the base constructor and implements `execute()`. A
`CommandRegistry` collects command instances and applies them to a Commander.js `program` in
`src/index.ts`.

The full list of commands is `getAllCommands()` in `src/commands/index.ts`. Because that module imports
every command (and with them AWS, LangChain, Jira and inquirer), `src/index.ts` imports it lazily and
first asks the [fast path](/architecture/fast-path.md) for a single lightweight command.

# Startup Sequence

```
main()  (src/index.ts)
  |- argv has --json            -> chalk.level = 0 (JSON output is never coloured)
  |- COMP_LINE / COMP_POINT set -> tabtab completion from getAllCommands() names, return
  |- argv is exactly [-V|--version] -> print getVersion(), return
  |- program = new Command().name('kunj').version(getVersion())
  |- loadFastCommand(argv[2])   -> one command, or null
  |- registry.registerAll(fast ? [fast] : await getAllCommands())
  |- registry.applyTo(program); program.parse(argv)
```

An uncaught rejection from `main()` prints `Fatal error:` and exits 1.

# CommandConfig

| Field | Meaning |
|-------|---------|
| `name` | Command name (`program.command(name)`) |
| `description` | One-line description |
| `arguments` | Positional spec, e.g. `'[action] [path]'` |
| `options` | `{ flags, description, defaultValue? }[]`, passed to `cmd.option()` |
| `helpText` | String or function, appended after the options in `--help` (function only called when help is shown) |
| `aliases` | Other names, e.g. `ct` for `container` |
| `ui` | `UIWidgetConfig` for the `kunj ui` web dashboard (`category`, `widget`, `label`, `icon`, `order`, ...) |

`register()` always adds a global `--json` option to every command.

# BaseCommand Members

| Member | Purpose |
|--------|---------|
| `config`, `getConfig()` | The `CommandConfig` (also used by shell completion and `src/ui/server.ts`) |
| `jsonMode` | Set when the options object (second-to-last action argument) has `json === true` |
| `register(program)` | Builds the Commander command and wraps `execute()` in the error handler |
| `log(message)` | `console.log` unless in JSON mode |
| `outputJSON(data)` | Pretty-printed JSON plus newline on stdout |
| `execute(...args)` | Abstract; receives Commander's positional args, options and command |

Commands with several positionals (`repos`, `container`, ...) re-locate the options object themselves,
because Commander shifts it left when fewer positionals are given.

# Error Printing

The action wrapper catches anything `execute()` throws:

| Situation | Output | Exit |
|-----------|--------|------|
| JSON mode, error has a string `jsonCode` | `{"error":{"code","message"}}` on stdout | 1 |
| JSON mode, otherwise | `{"error":"<message>"}` on stdout | 1 |
| Error `name` is one of `HookError`, `BaseBranchError`, `StartError`, `ContainerError`, `AgentError`, `EventsError`, `SecretError` | `✗ <message>` on stderr, no stack | 1 |
| Anything else | `Command failed:` plus the error | 1 |

Errors with a `jsonCode` today: `AgentError` (`src/lib/agent-session.ts`), `SecretError`
(`src/lib/secrets/errors.ts`), `ContainerError` (`src/lib/container/errors.ts`) and `EventsError`
(`not-a-repo`, `src/commands/events.ts`). `kunj ct` has its own handler that always prints the object
shape (code from `StartError.code`, `hook` for a `HookError`, the `jsonCode`, else `error`); see
[JSON Contract](/architecture/json-contract.md).

# Registered Commands

`getAllCommands()` returns, in order: `create`, `switch`, `list`, `commit`, `pr`, `delete`, `config`,
`setup`, `log`, `graph`, `diff`, `stash`, `flow`, `jira`, `branch-note`, `branch-tag`, `branch-desc`,
`completion`, `prompt-info`, `issue`, `team`, `worktree`, `container` (alias `ct`), `agent`, `hooks`,
`repos`, `events`, `secret`, `run`, `install`, `ui`.

# Adding a Command

1. Create `src/commands/<name>.ts` with a class extending `BaseCommand`.
2. Export it from `src/commands/index.ts` and add an instance to `getAllCommands()`.
3. If editors or prompts call it often, add it to `FAST_COMMANDS` and keep its imports light
   ([Fast Path](/architecture/fast-path.md)).
4. If it prints JSON for an app, type the output in `src/lib/json-types.ts`.
5. Regenerate the docs reference (`npm run gen` in `docs-site/`).

# Related Concepts

* [Fast Path](/architecture/fast-path.md) - which commands bypass `getAllCommands()`
* [JSON Contract](/architecture/json-contract.md) - `--json` output and error shapes
* [Hooks](/features/hooks.md) - `HookError` from failing `pre-*` hooks
* [System Overview](/architecture/system-overview.md)

# Citations

[1] [src/lib/command.ts](/src/lib/command.ts)
[2] [src/index.ts](/src/index.ts)
[3] [src/commands/index.ts](/src/commands/index.ts)
[4] [src/commands/fast.ts](/src/commands/fast.ts)
[5] [src/commands/repos.ts](/src/commands/repos.ts)
[6] [src/commands/container.ts](/src/commands/container.ts)
[7] [src/ui/server.ts](/src/ui/server.ts)
[8] [ARCHITECTURE.md](/ARCHITECTURE.md)
