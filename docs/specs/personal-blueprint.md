# Personal blueprint

*Designed 2026-11-07 as part 4 of [container-parity.md](container-parity.md). What of the user goes
into a branch container, declared in `~/.kunj/blueprint.json` with the repository blueprint's file
format, and applied into the container's home volume on every start.*

## Goal

A container's shell and agent should have what the host's have: the user's Claude Code skills,
agents, commands and global `CLAUDE.md`, their git configuration, their shell aliases and rc, a few
dotfiles. Today a container gets only the git identity (copied once at seed), the image's zshrc and
whatever `container.files` names, and `kunj install skill` writes to the host alone.

Copying the host's files is not the answer. `~/.claude/settings.json` hooks call host binaries on every
tool use; a `.gitconfig` can carry `credential.helper osxkeychain` (shadowing the container's
`git-credential-kunj`), `url.<ssh>.insteadOf` (no key in the container), `core.hooksPath` and `include`
(host paths) and `commit.gpgsign` (no key); a `.zshrc` sources Homebrew and nvm by absolute path and can
hide the image's node. The first two break pushes silently, the rest fail loudly on every shell or tool
call. So nothing is copied unless it is named, and what can be named is bounded by allowlists.

**Non-goals.** Session history, credentials, `~/.claude.json` (MCP servers are host commands; kunj
writes the bridged one itself), hooks, `apiKeyHelper`, `statusLine`, environment variables (those are
secrets or `container.env`), and anything into a snapshot image.

## Status

| Part | State |
| --- | --- |
| `personal.ts`: parse, resolve and merge the two files, stamp, plan, apply | Shipped (f087adb) |
| `git` and `claude` keys applied on every `ct start` and resuming `open` | Shipped (f087adb) |
| `shell`, `files` and `aliases` keys; `$HOME/.kunj/rc` sourced by the sandbox zshrc | Shipped (f087adb) |
| `personal` in `ct start` output and `--json`; `personalChanged` in `ct list --json` | Shipped (f087adb) |
| Personal keys refused in a committed blueprint | Shipped (f087adb) |
| `kunj ct blueprint init --personal [--repo]` | Shipped (the commit after f087adb) |
| `kunj ct blueprint status` shows the personal layer | Shipped (the commit after f087adb) |
| `kunj` key (kunj's own config, for a `kunj` installed in the image) | Later; needs `kunj` in the image (container-parity.md part 4) |
| User docs (containers/blueprints page) | Shipped (the commit after f087adb) |
| Docker test: a skill and a git alias in a real container, the rc sourced, a removed skill gone and a container-made one kept | To do (no Docker where this was built) |

## Two layers, one file format

| Layer | File | Keys | Applied |
| --- | --- | --- | --- |
| Repository (as today) | `.kunj/blueprint.json` in the working tree, else `origin/<default>:.kunj/blueprint.json` | `tools`, `setup`, `maintain`, `lockfiles`, `notes`, `image`, `services`, `aliases` | hashed into the snapshot; presets as root, `setup`/`maintain` as the user |
| Personal | `~/.kunj/blueprint.json` (every repository), then `~/.kunj/<repo>/blueprint.json` (one repository) over it | `git`, `claude`, `shell`, `files`, `aliases`, later `kunj` | on every `ct start` and every `open` that resumes, as the sandbox user, into the home volume; never hashed, never in a snapshot |

- A **committed** blueprint (working tree or origin) that has a personal key is refused:
  `.kunj/blueprint.json: "git" is personal and belongs in ~/.kunj/blueprint.json, not in the repository`.
  The repository's own Claude config needs no key: Claude Code reads the clone's `.claude/` and `CLAUDE.md`.
- `~/.kunj/blueprint.json` holds personal keys and `aliases`; a repository key there is refused (`tools`
  are per repository and would move every snapshot's hash per person).
- `~/.kunj/<repo>/blueprint.json` keeps its present role as the host copy of the repository blueprint
  (`blueprint init --global`, used when the repository has none) and may hold personal keys too: its
  repository keys count only as that fallback, its personal keys always apply.
- **Merge:** the per-repo file wins per key. `git` and `aliases` merge by name; `claude` merges by
  sub-key (`skills` from one file and `agents` from the other both apply; the same sub-key is replaced);
  `shell` and `files` are replaced whole.
- The file is JSON with comments (as the repository blueprint). Unknown keys are reported as `ignored` by
  `blueprint status`, never an error.

### Example

```jsonc
// ~/.kunj/blueprint.json
{
  "git": {
    "pull.rebase": "true",
    "rerere.enabled": "true",
    "alias.lg": "log --oneline --graph -20"
  },
  "claude": {
    "claudeMd": true,
    "skills": ["handoff", "review"],
    "agents": true,
    "commands": ["standup"],
    "settings": { "model": "opus", "permissions": { "deny": ["Bash(rm -rf *)"] } }
  },
  "shell": { "rcFile": "~/.kunj/container/zshrc" },
  "files": ["~/.vimrc", { "from": "~/.config/nvim", "to": ".config/nvim" }],
  "aliases": { "t": "npm test" }
}
```

## The keys

### `git`

An object of git config keys to values, written with `git config --global` in the container. Keys are
an allowlist; anything else is refused at parse with the reason:

| Allowed | Refused, and why |
| --- | --- |
| `user.name`, `user.email`, `pull.rebase`, `pull.ff`, `push.default`, `push.autoSetupRemote`, `init.defaultBranch`, `fetch.prune`, `rerere.enabled`, `rerere.autoupdate`, `diff.algorithm`, `diff.colorMoved`, `merge.conflictstyle`, `log.date`, `color.ui`, `core.pager`, `core.autocrlf` | `credential.*` (would shadow `git-credential-kunj`), `core.hooksPath`, `core.sshCommand`, `core.editor`, `include.*`/`includeIf.*`, `url.*` (`insteadOf` to SSH), `gpg.*`, `commit.gpgsign`, `tag.gpgsign`, `user.signingkey`, `http.*`, `remote.*`, `safe.*`, and every other key |
| `alias.<name>` whose value does not start with `!` | an alias starting with `!` (runs a host script) |

Values are strings on one line, at most 1000 characters; alias names match the repository blueprint's
`ALIAS_NAME`. Without `git.user.name`/`user.email` the host identity is still copied by the seed as
today, once; with them, they are set on every start, so a changed identity reaches an existing container.
A key set by an earlier run and absent now is unset (`--unset`), from the record below.

### `claude`

```ts
claude?: {
  claudeMd?: boolean;                 // ~/.claude/CLAUDE.md
  skills?: true | string[];           // ~/.claude/skills/<name>/ (directories)
  agents?: true | string[];           // ~/.claude/agents/<name>.md (or a directory <name>/)
  commands?: true | string[];         // ~/.claude/commands/<name>.md (or <name>/, nested commands)
  settings?: { model?: string; permissions?: { deny?: string[] } };
}
```

The host directory is `~/.claude` (`CLAUDE_CONFIG_DIR` on the host when set), the container's is
`$HOME/.claude`. `true` means every entry present; names match `[A-Za-z0-9_.-]+` (no path separators)
and are looked up as a directory, else `<name>.md`. A named entry missing on the host is a warning and
a `dropped` line, never a failure. Files are copied with their mode (`& 0o777`), directories recursively
with their symlinks skipped (a warning each), at most 1 MB per file and 500 files in all (over the cap:
the entry is dropped with a warning).

`settings` is merged key by key into the container's `$HOME/.claude/settings.json`: only `model` and
`permissions.deny` are read from the blueprint (anything else under `settings` is refused at parse,
naming the key), and only those two keys are written, so the login Claude Code made inside the
container and kunj's own agent hooks (which arrive through `--settings`, not this file) survive.
`permissions.deny` replaces the container's `deny` list whole. A key set by an earlier run and absent
now is removed.

### `shell`

`{ "rc": "<text>" }` or `{ "rcFile": "~/.kunj/container/zshrc" }` (one of the two; the file must be
inside the host home and readable). The text is written to `$HOME/.kunj/rc` in the container (mode 0600)
and sourced last by the sandbox image's `/etc/zsh/zshrc`, so it can override everything the image and
the repository blueprint set. It is the user's text, run as the user; capped at 64 KB and UTF-8,
otherwise unvalidated. The image change moves the sandbox hash once. A custom image sources
`$HOME/.kunj/rc` itself (documented), or does not; `ct start` does not check.

### `files`

A list of `"~/.vimrc"` or `{ "from": "~/.config/nvim", "to": ".config/nvim" }`. `from` is a host path
under the host home (`~` expanded; a path outside it, also through a symlink, is refused); `to` is
relative to the container home, defaulting to `from` relative to the host home, with no `..`, no leading
`/`, and not under `.kunj/` or `.claude/` (those are kunj's and the `claude` key's). Regular files
and directories only, mode kept, symlinks inside a directory skipped with a warning, 1 MB per file and
500 files in all with the `claude` entries; `.git` directories inside are skipped. Written as the user
into `$HOME` through the tar stream, the same path as `container.files`, which stays for copies to any
container path as root.

### `aliases`

As the repository blueprint's `aliases` (same names and one-line values), merged over them. Personal
aliases are written as `alias` lines at the top of `$HOME/.kunj/rc`, before the `shell` text, not to
`/etc/profile.d/kunj-aliases.sh` (that file is the snapshot's, written as root).

### `kunj` (later)

`{ "config": true }` renders the host's `ai.*`, `preferences.*` and commit style into the container's
`~/.kunj/config.json`, none of `container.*`, `secrets.*`, `hooks.*` or remotes. Accepted by the parser
only once `kunj` is installed in the sandbox image; until then a blueprint naming it is refused with that
reason, so nobody writes a key that does nothing.

## Application

**When.** In `startContainer` on create, after the seed, keep files, `container.files` and the secret
files and before the MCP config; on every resume (a running container whose helper is kept included),
next to the secret files, so `kunj ct start <b>` is how a change is applied, also to a running
container. Never for a snapshot build (`namesFor` is set): nothing personal reaches a shared image.
`kunj ct open` applies it when it resumes, as it renders secret files then.

**How.** `planPersonal()` reads the host side into memory (every file's content, the git commands, the
settings patch) before anything is exec'd, so a host error (a missing file, an oversized directory)
is known up front; `applyPersonal()` then runs, as the sandbox user:

1. one exec that reads the record `$HOME/.kunj/personal.json` and the container's
   `$HOME/.claude/settings.json` (both optional);
2. in Node: the set of paths written last time minus the paths written now (to delete), the git keys set
   last time minus the keys set now (to unset), the settings keys set last time minus now (to delete),
   and the merged `settings.json`;
3. one exec with the tar stream of every file (`$HOME/.claude/…`, `$HOME/.kunj/rc`, the `files` entries,
   the new `settings.json` at 0600, the new record and the stamp) extracted into `$HOME`, preceded by the
   deletions (`rm -rf` of recorded paths only, each checked to be relative without `..`, under
   `.claude/`, `.kunj/rc` or a recorded `files` target, never the record, the stamp or anything else
   under `.kunj/`; emptied `.claude` directories are removed), and one more exec for the git
   `--unset-all` and `config --global` calls, keys and values passed as arguments, never through the
   shell.

The record holds `{ version: 1, stamp, paths: [...], gitKeys: [...], settingsKeys: [...] }`; a missing
or unreadable record means nothing is deleted or unset (a first run, or a container made before this
feature). kunj removes only what it recorded, so a skill made inside the container by the agent is never
clobbered. The stamp is also written on one line to `$HOME/.kunj/personal.stamp` for the status script.

**Errors.** A personal blueprint that does not parse fails `ct start` before anything is created, as a
bad repository blueprint does (`ContainerError`, named file and key). A host-side problem with one
entry (missing, too large) is a warning and a `dropped` line; the rest applies. A failed exec is a
warning (`Personal blueprint not applied: …`) and the start succeeds: the container is usable without
it, and the stamp stays behind so `ct list` keeps reporting it.

**Output.** `ct start` prints one line, `personal  git 4 keys · claude 3 skills, 1 agent, settings ·
shell rc · 2 files`, and one `dropped   <what> (<reason>)` line per dropped entry. `--json` has
`personal: { git: string[]; claude: { claudeMd, skills, agents, commands, settings: string[] }; shell:
boolean; files: string[]; dropped: Array<{ entry, reason }> }` (`StartResult.personal`, present when a
personal blueprint exists).

## Drift

Labels cannot change after `docker run`, and a start re-applies the layer anyway, so the stamp lives in
the container, not in a label. The host computes `personalStamp()`: sha256 over the merged personal
blueprint (canonical JSON) and, for every host file it names, its container path, mode and content;
`''` when no personal blueprint exists; first 12 hex characters. `STATUS_SCRIPT` prints
`personal=<stamp>` from `$HOME/.kunj/personal.stamp` (empty when absent), and `ct list --json` reports
`personalChanged: boolean` for this repository's **running** containers whose status exec succeeded:
`true` while the two differ (a container made before the feature has no stamp, so it reads `true` as
soon as the user writes a personal blueprint). A stopped container has no field: the next start applies
the layer regardless. The hint is `kunj ct start <branch>`, not `--rebuild`. The workspace app can show
it like `secretsChanged` (not in this spec).

The stamp reads every named host file on each `ct list`; the entries are user config and bounded by the
500-file cap, so this stays well under the status exec it sits beside.

## Commands

- **`kunj ct blueprint init --personal [--repo] [--yes]`** drafts the personal file from the host and
  asks before writing (`--yes` skips; `--json` prints the draft and writes it):
  - `git`: `user.name`, `user.email` and every allowlisted key present in `git config --global --list`;
    refused keys and `!` aliases are printed as `skipped <key> (<reason>)`, never written;
  - `claude`: `claudeMd` when `~/.claude/CLAUDE.md` exists; `skills`, `agents`, `commands` listed by
    name (not `true`, so a new host skill is a choice), only when the directory has entries; `model`
    from `settings.json` when set; nothing else;
  - `shell`, `files`, `aliases`: never inferred; an existing file's values are kept on overwrite, as
    `init` keeps `notes` and `aliases` today.
  - Writes `~/.kunj/blueprint.json`, or with `--repo` the personal keys into `~/.kunj/<repo>/blueprint.json`
    (its repository keys kept). The existing `--global` (the host copy of the repository blueprint) is
    unchanged.
- **`kunj ct blueprint status`** adds a `personal` block: which of the two files exist, the merged key
  summary (`git 4 keys · claude …`), the stamp, and `ignored` keys; `--json` adds `personal: { files,
  summary, stamp, ignored }`.
- `kunj ct start` and `kunj ct open`: application and the `personal` line as above.

## Validation summary

| What | Rule | Error |
| --- | --- | --- |
| Personal key in a committed blueprint | refused | `<file>: "<key>" is personal and belongs in ~/.kunj/blueprint.json` |
| Repository key in `~/.kunj/blueprint.json` | refused (except `aliases`) | `~/.kunj/blueprint.json: "<key>" belongs in the repository's .kunj/blueprint.json` |
| `git` key not on the allowlist | refused with the reason | `…: git."credential.helper" is not allowed in a container (it would shadow kunj's credential helper)` |
| `git` alias starting with `!` | refused | `…: git."alias.x" runs a shell command, which is not allowed` |
| `git` value with a newline or over 1000 chars | refused | `…: git."<key>" must be one line` |
| `claude` name with `/`, `\`, `..` or empty | refused | `…: claude.skills[1] "<v>" is not a name` |
| `settings` key other than `model`, `permissions.deny` | refused | `…: claude.settings.<key> is not copied into containers (only model and permissions.deny are)` |
| `shell` with both `rc` and `rcFile`, or neither | refused | `…: shell needs rc or rcFile, not both` |
| `shell.rcFile` outside the home, or over 64 KB | refused at plan | `…: shell.rcFile must be a file under your home directory` |
| `files[].from` outside the home (also via symlink) | refused at plan | `…: files[0] "<p>" is outside your home directory` |
| `files[].to` absolute, with `..`, or under `.kunj/`/`.claude/` | refused at parse | `…: files[0].to must be a path inside the container home (no .., not under .kunj or .claude)` |
| Entry missing on the host | dropped with a warning | `dropped   claude.skills review (not in ~/.claude/skills)` |
| Over 1 MB per file or 500 files in all | dropped with a warning | `dropped   files ~/.config/nvim (more than 500 files)` |

## Tests

- `personal.test.ts`: parse (every rule above, the two file kinds), merge order (per-repo over global;
  `git`/`aliases` by name, `claude` by sub-key, `shell`/`files` whole), `planPersonal` against a fixture
  home (`CLAUDE_CONFIG_DIR` and `HOME` pointed at a temp directory: never the developer's), the stamp
  (same input, same stamp; a changed skill file changes it; `''` without a file), the tar contents and
  modes, the settings merge keeping unknown keys, the deletion set from a record, no path outside
  `.claude/`, `.kunj/rc` and recorded targets in the `rm` list.
- `lifecycle.test.ts`: applied on create and on resume (also the running-container resume), not on a
  snapshot (`namesFor`), after the secret files; a failed exec warns and the start succeeds; a parse
  error fails before `run`; `StartResult.personal`.
- `env.test.ts`: `personal=` in `parseStatus`. `container.ts` tests: `personalChanged` on a running
  container only, the hint.
- `blueprint.test.ts`: the committed-blueprint refusal.
- Docker test (`integration.docker.test.ts`): a skill and a git alias arrive in a real container as the
  sandbox user, `$HOME/.kunj/rc` is sourced by an interactive zsh, a second start with the skill removed
  from the blueprint removes it from the container and leaves a skill the container made.

## Code map

| File | Role |
| --- | --- |
| `src/lib/container/personal.ts` | Types, `parsePersonal`, `resolvePersonal`, `mergePersonal`, `planPersonal`, `personalStamp`, `applyPersonal`, the record |
| `src/lib/container/blueprint.ts` | `PERSONAL_KEYS`; `parseBlueprint` refuses them for a committed source |
| `src/lib/container/lifecycle.ts` | `StartOptions.personal`, application on create and resume, `StartResult.personal` |
| `src/lib/container/env.ts` | `personal=` in `STATUS_SCRIPT`, `ContainerStatus.personalStamp` |
| `src/commands/container.ts` | `start` output, `list` (`personalChanged`), `blueprint init --personal`, `blueprint status` |
| `src/container/sandbox/zshrc` | sources `$HOME/.kunj/rc` |
| `src/lib/json-types.ts` | `ContainerJson.personalChanged` |
| `docs-site/src/content/docs/containers/blueprints.mdx` | User docs: "Your personal blueprint" |

## Decisions

- **2026-11-07** Declared, not copied: a personal blueprint names what goes in; allowlists for git
  config and Claude settings; no `container.dotfiles` or `container.claudeConfig` settings.
- **2026-11-07** Same file format as the repository blueprint, two files (`~/.kunj/blueprint.json`,
  `~/.kunj/<repo>/blueprint.json`), personal keys refused in a committed blueprint.
- **2026-11-07** Applied into the home volume on every start and resume, never into a snapshot; the
  stamp lives in the container (`$HOME/.kunj/personal.stamp`), because labels cannot change and a
  start re-applies the layer, so `personalChanged` is known for running containers only and the fix is
  `ct start`, not `--rebuild`.
- **2026-11-07** kunj removes only what its record says it wrote, so the agent's own additions to
  `~/.claude` in the container survive a re-apply.
