---
type: Feature
title: Shell Integration
description: Tab completion (kunj completion and the zsh scripts) and the PR number in the shell prompt (kunj prompt-info and the prompt scripts).
resource: src/commands/prompt-info.ts
tags: [feature, shell, completion, prompt]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Two small pieces connect kunj to the user's shell: tab completion and a prompt segment showing the
current branch's pull request number. The CLI side is `kunj completion` (`src/commands/completion.ts`)
and `kunj prompt-info` (`src/commands/prompt-info.ts`); the shell side is a set of standalone scripts
in `scripts/`. User documentation is `docs/SHELL_INTEGRATION.md`.

`prompt-info` runs on every prompt, so it is in `FAST_COMMANDS` ([Fast Path](/architecture/fast-path.md))
and never prints errors.

# kunj completion

| Invocation | Behaviour |
|------------|-----------|
| `kunj completion` | Prints a bash-style script: `_kunj_completion` with `compgen -W` over a fixed list of command names, registered with `complete -F` |
| `kunj completion --install` | Appends a block between `# Kunj completion` and `# End Kunj completion` to the rc file (`~/.zshrc`, `~/.config/fish/config.fish` or `~/.bashrc`, chosen from `$SHELL`) that runs `source <(kunj completion ...)`; no-op if the marker exists |
| `kunj completion --uninstall` | Removes that block |

The generated script completes only top-level command names, and its list is fixed:
`create switch list commit pr delete config setup log graph diff stash flow jira completion prompt-info`.
Newer commands (`worktree`, `container`, `agent`, `secret`, `hooks`, ...) are not in it.

# kunj prompt-info

Options: `--format <simple|detailed|json>` (default `simple`), `--show-branch`, `--show-status`.

```
git rev-parse --abbrev-ref HEAD   (detached HEAD ──> print nothing)
PR number: prUrl in branches.json (/pull/<n>)  else  gh pr list --head <branch> --json number
status (only with --show-status): gh pr view <n> --json state  ──> OPEN / MERGED / CLOSED
```

| Format | Output |
|--------|--------|
| `simple` | `#123` |
| `detailed` | `[<branch>] PR#123 [<STATE>]` (branch and state only when asked) |
| `json` | `{"branch":"...","prNumber":"123","prStatus":"OPEN"}` (`prStatus` only with `--show-status`) |

No PR, no repository or any error prints nothing and exits 0. The `prUrl` cache is written by `kunj pr`
([AI Pull Requests](/features/ai-pr.md), [Branch Metadata](/features/branch-metadata.md)); without it every
prompt costs a `gh` call.

# Scripts

| File | Purpose |
|------|---------|
| `scripts/kunj-completion.zsh` | zsh `_kunj` with `_arguments`/`compdef`: command descriptions plus options for `pr`, `prompt-info`, `config`, `list` |
| `scripts/kunj-prompt.zsh` | `kunj_prompt_pr` (prepended to `RPROMPT`, blue) and an optional `kunj_prompt_detailed` |
| `scripts/kunj-prompt.bash` | Same functions for bash, inserted into `PS1` before the final `$ ` |
| `scripts/kunj-setup.zsh` | Completion and prompt in one file, to source after oh-my-zsh |
| `scripts/install-shell-integration.sh` | Interactive menu: completion (via `kunj completion --install`), prompt (sources the matching prompt script from the rc file), both, or quit; zsh and bash only |

The zsh completion scripts are hand-written and out of date with the CLI in places: they offer
`-f` for `prompt-info --format` (the command has no short flag) and `--remote` for `list` (no such
option). Their `config` options (`--set`, `--get`, `--list`, `--reset`) do exist; `-i/--interactive`
and `--global` are missing.

# Worktree cd helper

`kunj worktree path <branch>` prints only a worktree's path, so a shell function can `cd` into it.
`docs/SHELL_INTEGRATION.md` gives a `kt` function that falls back to `kunj worktree add <branch> --json`
and reads `worktree.path` from the JSON ([Worktrees](/features/worktrees.md)).

# Related Concepts

* [Fast Path](/architecture/fast-path.md) - why `prompt-info` loads quickly
* [AI Pull Requests](/features/ai-pr.md) - writes the `prUrl` the prompt reads
* [Setup and Install](/features/setup-and-install.md) - `kunj setup` installs aliases, not completion
* [Worktrees](/features/worktrees.md)

# Citations

[1] [src/commands/completion.ts](/src/commands/completion.ts)
[2] [src/commands/prompt-info.ts](/src/commands/prompt-info.ts)
[3] [src/commands/fast.ts](/src/commands/fast.ts)
[4] [scripts/kunj-completion.zsh](/scripts/kunj-completion.zsh)
[5] [scripts/kunj-prompt.zsh](/scripts/kunj-prompt.zsh)
[6] [scripts/kunj-prompt.bash](/scripts/kunj-prompt.bash)
[7] [scripts/kunj-setup.zsh](/scripts/kunj-setup.zsh)
[8] [scripts/install-shell-integration.sh](/scripts/install-shell-integration.sh)
[9] [docs/SHELL_INTEGRATION.md](/docs/SHELL_INTEGRATION.md)
