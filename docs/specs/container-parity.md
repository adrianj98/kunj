# Worktree and container parity

*Gap analysis, 2026-11-07, from reading the CLI (`src/`) and the workspace app on `main`. Nothing here
has shipped yet; the status table says what each part is waiting on. The VS Code extension and the menu
bar app are out of scope: the workspace app is the consumer parity is measured in.*

## Goal

Starting a branch in a container should feel like starting it in a worktree: the same command shape,
the same row in the workspace app, the same status, the same tabs, the same way of ending it. The only thing
you should notice is the container mark. [containers-in-apps.md](containers-in-apps.md) states the
principle for rows and actions; this spec lists where the two still differ end to end, in the order
a person meets them, and what closes each gap.

Containers stay containers: origin is the only channel in and out, secrets only in the `docker run`
env file, nothing bind-mounted. Parity means the same experience, not the same mechanism, and nothing
below relaxes an invariant from [container-system.md](container-system.md#rules-every-part-follows).

## Status

| Part | State |
| --- | --- |
| 1. Rows and status: `changedFiles`, `behind`, `upstream`, `startedAt` in `ct list`; the app lists containers with PRs and pairs rows by branch | To do |
| 2. Agents: `kunj ct agent start\|status\|stop`, `--resume`, `--detach --prompt-file --open-in-app`, `--json`, `--no-tmux`; live `agent` events for containers | To do |
| 3. Creation: `ct start -c` with worktree semantics (existing origin branch, `-b`, `--no-origin`), create hooks reported in `--json` | To do |
| 4. Inside: the personal blueprint (`~/.kunj/blueprint.json`: `git`, `claude`, `shell`, `files`, `aliases`, `kunj`), `blueprint init --personal`, `personalChanged`; `kunj` in the image | In progress ([personal-blueprint.md](personal-blueprint.md)) |
| 5. Keep files and secrets: `keep apply` and `secret apply` for a container | To do |
| 6. Ending: one removal guard for both kinds; `worktree remove` ends its sessions | To do |
| 7. Workspace app: language servers, CPU/memory, resume, Antigravity, Create PR, forward port, open in new window, `repo: null` events | To do |

## 1. The row

What you see first is the sidebar, and a container row knows less than a worktree row.

**CLI.** `ContainerJson.workspace` is `{ head, ahead, dirty }` (src/lib/json-types.ts); `WorktreeInfo.status`
is `{ dirty, changedFiles, ahead, behind, upstream }`. `STATUS_SCRIPT` (src/lib/container/env.ts) already
runs `git status` in the container, so the same numbers are one `--porcelain=v2 --branch` parse away.
Add to `ct list --json`, additively:

- `workspace.changedFiles`, `workspace.behind`, `workspace.upstream` (the same meaning as the worktree
  fields; `upstream` is `origin/<branch>` once pushed, as the seed sets `push.autoSetupRemote`).
- `startedAt` from `containerRun()`'s StartedAt, so uptime counts from the last start, not from
  `createdAt` (workspace-ide.md open question).
- `agent.session`, the tmux session name, as `WorktreeInfo.agent.session` has it.
- `pullRequest` stays where it is: `kunj worktree list --json --containers` already joins it from the one
  `gh pr list` call ([containers-in-apps.md](containers-in-apps.md#cli-contract)).

**Workspace app.** It lists containers with `kunj ct list` per repository
(`EnvironmentList.swift`, `listContainers`), so a container never has `pullRequest`, `behind`, `upstream`,
`changedFiles` or `agentSession`, and `statusVerb` can never say `PR #n` or `Merged #n` for it, the
Changes pill shows no count, and the diff base falls back to origin/HEAD instead of the PR's base.
Switch the listing to `kunj worktree list --json --containers` (one call per repo, the same PRs for
both kinds) and decode the new fields. Then order rows by branch so a branch's worktree and container
sit together (today all worktrees come first, then all containers).

**Smaller row differences** (all in the workspace app): a container row has no tooltip (`path` is nil;
show the container name), the tab bar's tmux label is the hard-coded `agent` for a container (use
`agent.session`), and CPU/memory chips are worktree-only because the sidebar's `kunj sessions` poll runs
without `--containers` and keys usage by path. Rather than an exec per container per poll, report usage
from the status poll kunj already runs (`STATUS_SCRIPT` can read `/proc` for its tmux sessions, the way
`SESSIONS_SCRIPT` does) and key the chip by environment id.

## 2. The agent

`kunj agent` and `kunj ct agent` are the same action with two different command surfaces.

| | `kunj agent` (src/commands/agent.ts) | `kunj ct agent` (src/commands/container.ts) |
| --- | --- | --- |
| Verbs | `start`, `status`, `stop` | one verb; `attach`; `--kill` |
| Several sessions | `--session <id>`, `stop --all` | `--session <id>`, `--kill` without `--session` ends all |
| Resume | `--resume` from `~/.kunj/<repo>/agent-resume/<session>.json` (SessionStart hook) | none: the hook is a no-op because `KUNJ_AGENT_RESUME` is unset in the container |
| Hand-off | `start --detach --prompt-file <f> --open-in-app` (`/handoff`) | none: always needs a TTY |
| Which agent | `--agent claude\|antigravity`, `--command` | `container.agentCommand` only |
| Without tmux | `--no-tmux` and `agent.tmux` | `agent.tmux` only |
| JSON | `AgentStartJson`, `AgentStatusJson`, `AgentStopJson` | none; state only in `ct list` |
| Waiting state | state file watched by `kunj events`, `agent` events at once | `/tmp/kunj-agent-state`, read by the 10 s status poll only |

Close it by giving `ct agent` the same verbs and options, sharing the option list and the JSON shapes with
`kunj agent` (one `AgentOptions` type, one help text), and in the same order a person reaches for them:

1. **`--resume`.** Set `KUNJ_AGENT_RESUME=/tmp/kunj-agent-resume-<id>.json` in the container's agent
   session so the existing SessionStart hook writes the id; `ct agent --resume` reads it with one exec
   when the session is not running. `STATUS_SCRIPT` reports `resumable` per session so the app knows
   without an exec. The workspace app's `terminalSpec` then passes `--resume` for containers too (today
   the flag is dropped for `.container`, so a restored container agent starts fresh), and
   `TerminalSpecTests` gets the container case.
2. **`start|status|stop` and `--json`.** `ct agent stop [--session|--all]` is `--kill` under the host's
   name; `status --json` is `AgentStatusJson` from `STATUS_SCRIPT`. Keep `--kill` and `attach` as aliases.
3. **`--detach --prompt-file --open-in-app`.** The container's tmux session is created detached with the
   prompt as the first argument, as `agent-session.ts` does on the host, and tagged `@kunj_open=app`
   in the container's tmux so `kunj events` (through the status poll) emits `agent` with `open`. This
   gives `/handoff` a container target and the workspace app's `openAgent` a container case (today it
   resolves worktrees only, `EnvironmentStore.swift`).
4. **`--agent antigravity` / `--command`.** The command runs in the container, so `agy` must be in the
   image: an `antigravity` preset, and `ct agent --agent antigravity` refused with a hint when the
   blueprint does not list it. The workspace app's "worktrees only" on Antigravity and the
   `agentNotInContainer` error go once this exists.
5. **Live state.** `kunj events` emits `agent` events for container sessions when the status poll sees a
   session start, end or change state (with `repo`, as the host ones carry), and the workspace app's
   store refreshes the containers half on an `agent` event with a container session (today an `agent`
   event refreshes worktrees only). The 10 s poll is the floor; a faster path is a `docker events`
   exec filter, which the stream drops today on purpose.

## 3. Starting

`kunj worktree add -c <b>` and `kunj ct start -c <b>` should resolve the branch the same way.

- **Base.** Worktrees go through `resolveBaseRef()` (src/lib/base-branch.ts): `--base`, else
  `preferences.defaultBaseBranch`, else origin's default; fetched, with `--no-origin` and a commit, tag or
  `HEAD~2` accepted as given. `ct start` resolves `--base || defaultBaseBranch || detectDefaultBranch()`
  itself and the seed runs `git switch -c <b> --no-track origin/<base>`, so a tag or commit base fails
  in the container and `--no-origin` does not exist. Use `resolveBaseRef()` on the host and put the
  resolved commit into the bundle (`makeBranchBundle()` already fetches the branch on the host; a second
  ref `refs/kunj/base` carries the base), so any base a worktree accepts a container accepts.
- **An existing branch with `-c`.** `worktree add -c` creates only when the branch exists nowhere and
  checks out origin's otherwise (src/lib/worktree.ts); the seed creates from base whenever the clone has
  no local `<b>`, so `ct start -c feature/x` with `feature/x` already on origin branches from base and
  ignores it. Match the worktree rule, and add `-b` (force a new branch) for the one case that needs it.
- **Hooks.** `post-worktree-create` runs inside the new worktree and its results are in `worktree add
  --json`; `post-container-create` runs on the host in the cwd and `ct start --json` reports nothing of
  it. Report `hooks` in `ct start --json` the same way, and document that the in-container step is the
  blueprint's `setup`/`maintain` (no hook runs inside; it would need `kunj` in the image, part 4).
- **The New session sheet** already offers both kinds; after this part the two choices behave alike.

## 4. Inside: the personal blueprint

*Full design in [personal-blueprint.md](personal-blueprint.md); this section is the summary.*

Once inside, a container shell and agent miss what the host has: no part of `~/.claude` (CLAUDE.md,
settings, skills, agents, commands), git config beyond identity, the image's zshrc instead of the
user's, and no `kunj`. Copying the host's files is not the answer: `settings.json` hooks call host
binaries on every tool use, a `.gitconfig` can carry `credential.helper osxkeychain` (shadowing kunj's
helper), `url.insteadOf` to SSH (no key), `core.hooksPath` and `include` (host paths) and
`commit.gpgsign` (no key), and a `.zshrc` sources Homebrew and nvm by absolute path and can hide the
image's node. The first two break pushes silently; the rest fail loudly on every shell or tool call.

So nothing is copied unless it is named. The blueprint is already the declarative description of a
container, and it gets a second, personal layer with the same file format.

**Two layers, one schema.**

| Layer | File | Holds | Applied |
| --- | --- | --- | --- |
| Repository (as today) | `.kunj/blueprint.json`, from the working tree, else `origin/<default>` | `tools`, `setup`, `maintain`, `lockfiles`, `notes`, `image`, `services`, `aliases` | hashed into the snapshot, presets as root, `setup`/`maintain` as the user |
| Personal | `~/.kunj/blueprint.json` (every repo), then `~/.kunj/<repo>/blueprint.json` (one repo) over it | `git`, `claude`, `shell`, `files`, `aliases`, `kunj` | on every `ct start` and resuming `open`, as the sandbox user, into the home volume; never hashed, never in a snapshot |

The personal keys are refused in a committed blueprint (`parseBlueprint` names the file and says they
belong in `~/.kunj/blueprint.json`); the repository keys are refused in `~/.kunj/blueprint.json`
(they are per repository and would change every snapshot's hash per person). `~/.kunj/<repo>/blueprint.json`
keeps its present role as the host copy of the repository blueprint (`blueprint init --global`): its
repository keys count only when the repo has no blueprint, its personal keys always apply. Objects merge
by key with the per-repo file winning, lists are replaced.

**The personal keys.**

- `git`: an object of config keys written with `git config --global` in the container. Allowlist:
  `user.name`, `user.email`, `pull.rebase`, `push.default`, `init.defaultBranch`, `fetch.prune`,
  `rerere.enabled`, `rerere.autoupdate`, `diff.algorithm`, `merge.conflictstyle`, and `alias.*` whose
  value does not start with `!`. Any other key is refused at parse with the reason (`credential.*`,
  `core.hooksPath`, `core.sshCommand`, `url.*`, `include*`, `gpg.*`, `commit.gpgsign` are named in the
  message). Values are one line. Without `git.user.*` the host identity is copied as today.
- `claude`: `{ "claudeMd": true, "skills": true | ["name", …], "agents": true | […], "commands": true |
  […], "settings": { "model": "…", "permissions": { "deny": […] } } }`. Copied from `~/.claude/` into
  the container's `~/.claude/` by name; `true` means every entry present. `settings` takes only `model`
  and `permissions.deny`; never `hooks`, `apiKeyHelper`, `statusLine`, `env`, `enabledMcpjsonServers`,
  and never `~/.claude.json` (`mcpServers` are host commands; the bridged one is written by kunj already).
  kunj's agent hooks still arrive through `--settings`, so the container's `settings.json` is merged key
  by key, not replaced, and a login made inside the container survives. A named skill missing on the
  host is a warning, not a failure.
- `shell`: `{ "rc": "<text>" }` or `{ "rcFile": "~/.kunj/container/zshrc" }`, written to `~/.kunj-rc`
  in the container and sourced last by the image's `/etc/zsh/zshrc` and bash profile (an image change,
  so the sandbox hash moves once). The user's text, run as the user; capped at 64 KB, UTF-8, otherwise
  unvalidated. This replaces copying `.zshrc`.
- `files`: `["~/.vimrc", { "from": "~/.config/nvim", "to": ".config/nvim" }]`, home-relative on both
  sides, regular files and directories only, symlinks not followed outside the host home, 0600/0700,
  1 MB per file. Personal dotfiles go here; `container.files` (any host path to any container path, as
  root) stays for the rest.
- `aliases`: merged over the repository's; personal ones are written to `~/.kunj-rc` as the user, not
  to `/etc/profile.d` (that file is the snapshot's).
- `kunj`: `{ "config": true }` renders the host's `ai.*`, `preferences.*` and commit style into the
  container's `~/.kunj/config.json`; none of `container.*`, `secrets.*`, `hooks.*` or remotes. It needs
  `kunj` in the image (below), and Bedrock credentials as container-targeted secrets.

**Application.** After the seed and the secret files, through the tar stream as the sandbox user, on
create and on every resume; a snapshot build gets none of it, so nothing personal reaches a shared
image. kunj records what it wrote last time (`~/.claude/.kunj-personal.json` in the container) and
removes only those entries on the next run, so a skill made inside the container is not clobbered.
A stamp of the merged personal blueprint and the copied files' content is written into the container
(`$HOME/.kunj/personal.stamp`; labels cannot change after `docker run`), read by the status script, and
`ct list --json` reports `personalChanged` for running containers the way it reports `secretsChanged`;
the hint is `kunj ct start` (no rebuild: start re-applies). The start output has one line per part,
`personal  git 4 keys · claude 3 skills, 1 agent · shell rc · 2 files`, and one `dropped` line per
named thing not found on the host, so a missing alias has a visible reason.

**Writing it.** `kunj ct blueprint init --personal [--repo] [--yes]` drafts the file from the host:
the git identity and the allowlisted keys found in `git config --global --list` (`!` aliases and
refused keys are printed as skipped), which of `skills/`, `agents/` and `commands/` exist in `~/.claude`
(listed by name, not `true`, so a new host skill is a choice), `claudeMd` when the file exists, and
`model` from `settings.json`; nothing else. It shows the draft and asks before writing
`~/.kunj/blueprint.json` (`--repo` for `~/.kunj/<repo>/`). `kunj ct blueprint status` shows the
personal layer next to the repository one and whether a container is behind it. The three settings
this replaces (`container.claudeConfig`, `container.dotfiles`, a git allowlist setting) are not added.

**`kunj` in the image.** `kunj commit`, `kunj pr`, `kunj log`, `prompt-info` and the commit and PR hooks
do not exist in the container (the sandbox has git, gh, node and Claude Code). Install the same version
into the sandbox image (`npm install -g kunj@<version>`, or `npm pack` of the running copy streamed in
for a dev build); the `kunj.config` key above gives it a config. Roadmap item two.

**Extra repos** next to the workspace: roadmap item three, unchanged.

## 5. Keep files and secrets

- `kunj worktree keep apply [-a]` re-applies keep files to a worktree; a container gets them only when
  seeded. Add `kunj ct keep apply [branch]` (or `--container` on the existing command) that streams them
  in as the sandbox user, the way secret files are re-rendered on every `ct start`.
- `kunj secret apply [-a]` renders file deliveries into worktrees; for a container it means `ct start`.
  Give `secret apply` a `--container [branch]` target that renders file deliveries into a running
  container through the existing `renderSecretFiles()` path. Env secrets stay as they are: `docker start`
  keeps the `docker run` environment, so a changed env secret needs `--rebuild`, and the rules forbid
  any other channel. The hint already says so; `ct list` already reports `secretsChanged`.

## 6. Ending

The two removal guards check different things.

| | `worktree remove` | `ct remove` |
| --- | --- | --- |
| Unpushed commits, stashes, tracked changes | git's own dirty check only | all three, on every local branch, origin reachable |
| Open in an editor, attached terminal, running agent | refuses when an editor session is open | nothing; removing ends them |
| Sessions afterwards | tmux agent/shell sessions stay as `worktree-gone` orphans | gone with the container |
| Hooks | `pre/post-worktree-delete`, pre inside the worktree, results in `--json` | `pre/post-container-delete` on the host, no results in `--json` |

Make one guard: `worktree remove` adopts the unpushed-commits and stash checks (shared with
`lifecycle.ts`'s guard, `--force` skipping both) and ends the worktree's kunj tmux sessions after the
removal (`kunj sessions` then never sees `worktree-gone` from a kunj removal); `ct remove` refuses while
an agent runs or a terminal is attached unless `--force`, as the worktree does for an editor session; both
report `hooks` in `--json`. `worktree prune` stays git's prune; a "branches gone from origin" prune for
worktrees, mirroring `ct prune`, is a separate idea and not needed for parity.

## 7. Workspace app

Beyond parts 1 and 2, the app itself treats the kinds differently in these places:

- **Language servers are worktree-only** (`LspCoordinator.key(for:)` requires `.worktree`; URIs are
  built from the host path). [language-servers.md](language-servers.md) plans `kunj lsp run --branch <b>`
  through `ct exec`; the server then needs the language's toolchain in the image (a preset) and `cachePaths`
  excluded in the container. Until then a container editor tab gets hover, definition and references
  from the search fallback only.
- **Create PR** is disabled for a container without a host worktree of the branch. Create it from
  origin's branch instead (`kunj pr` with `--branch`, or `kunj ct exec -- kunj pr` once part 4 lands).
- **Resume** on relaunch: part 2 step 1.
- **Antigravity**: part 2 step 4.
- **Forward Port…** is in the containers-in-apps table and not in the app; `openPort` exists in `ActionSpec`
  unused. Add it to the overflow and row menus (an action tab running `kunj ct forward <b> <port>`).
- **Open in New VS Code Window** exists for worktrees only; `ct open -n/--new-window` already exists,
  so the action is one flag away.
- **`container` events with `repo: null`** trigger a full refresh; another repository's containers (a
  functional test run, say) would refresh the view every second. Ignore them, as containers-in-apps.md
  says for the other consumers.
- **⌘-click on a path** in a container terminal opens the first candidate unchecked; check with one
  `ct exec test -f` as the worktree case checks the disk.
- **Reveal in Finder** and **Copy Path** have no container meaning; keep them greyed with the reason.

## Order

Parts 1 and 2 are what a person notices in the first minute (the row, the agent tab coming back) and
touch only additive JSON and the app's listing; do them first. Part 3 next, because a wrong branch at
creation is the most expensive surprise. Part 4 is the roadmap and the largest; the `claude` key
of the personal blueprint is the part agents feel most, so build the layer with `git` and `claude`
first and add `shell`, `files` and `kunj` after. Parts 5 to 7 are independent of each other.

## Decisions

- **2026-11-07** Parity is measured from the person's side: the same command shape, row, status, tabs
  and ending. Mechanisms differ where the container rules require it (origin-only, env-file-only
  secrets, no bind mounts), and no gap here is closed by relaxing a rule.
- **2026-11-07** The workspace app lists containers through `worktree list --containers`, not `ct list`,
  so both kinds come from one call with the same PR data; `ct list` keeps its own fields and grows them
  additively.
- **2026-11-07** What of the user goes into a container is declared, not copied: a personal blueprint
  layer (`~/.kunj/blueprint.json`, per-repo overlay in `~/.kunj/<repo>/`) with the repository
  blueprint's format, applied into the home volume on every start and never into a snapshot. Host
  files are copied only when the blueprint names them, through allowlists for git config and Claude
  settings, because a copied `.gitconfig`, `settings.json` or `.zshrc` breaks the container (credential
  helper, `insteadOf`, hooks calling host binaries, host paths in rc files). No `container.dotfiles` or
  `container.claudeConfig` settings.
