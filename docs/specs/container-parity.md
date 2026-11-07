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
| 4. Inside the container: safe parts of `~/.claude`, git config beyond identity, shell dotfiles, `kunj` itself | To do (roadmap items, see container-system.md) |
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

## 4. Inside

Once inside, a container shell and agent miss what the host has.

- **`~/.claude`.** Nothing is copied in: no `CLAUDE.md`, settings, skills, agents or commands, and
  `kunj install skill` writes to the host only. Copy the safe parts at seed (and on `ct start`, as file
  deliveries are): `~/.claude/CLAUDE.md`, `settings.json` minus credentials and `env`, `skills/`,
  `agents/`, `commands/`; never `projects/`, session history or `.credentials.json`. A setting
  `container.claudeConfig` (default `safe`, `none` to skip) and a `claudeConfig` stamp label so
  `ct list` can say it is out of date, like `secretsChanged`. This is the roadmap's first item.
- **Git config.** Only `user.name` and `user.email` are copied, once, at seed. Also carry the host's
  `alias.*`, `pull.rebase` and `init.defaultBranch`; leave `core.editor` (the host's editor is not in the
  image) and keep `commit.gpgsign` off (no keys); re-copy on `ct start` so a later change reaches an
  existing container.
- **Shell.** The host shell runs `$SHELL -l` with the user's dotfiles; the container runs the image's zsh
  with `/etc/zsh/zshrc`. `container.files` can already copy any host file in; add `container.dotfiles`
  (a list, default empty) so `.zshrc`/`.gitconfig`-style files are copied in with one setting and
  re-copied on `ct start`, documented with the warning that a dotfile sourcing host paths will not work.
- **`kunj` itself.** `kunj commit`, `kunj pr`, `kunj log`, `prompt-info` and the commit/PR hooks do not
  exist in the container (the image has git, gh, node and Claude Code). Install the same version into the
  image (`npm install -g kunj@<version>` in the sandbox Dockerfile, or `npm pack` of the running copy
  streamed in for a dev build) with a sanitised config: `ai.*` and `preferences.*`, none of `container.*`,
  `secrets.*`, `hooks.*` or remotes. AWS credentials for Bedrock then travel as container-targeted
  secrets like any other. Roadmap item two.
- **Extra repos** next to the workspace: roadmap item three, unchanged.

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
creation is the most expensive surprise. Part 4 is the roadmap and the largest; the `~/.claude` copy
is the part agents feel most. Parts 5 to 7 are independent of each other.

## Decisions

- **2026-11-07** Parity is measured from the person's side: the same command shape, row, status, tabs
  and ending. Mechanisms differ where the container rules require it (origin-only, env-file-only
  secrets, no bind mounts), and no gap here is closed by relaxing a rule.
- **2026-11-07** The workspace app lists containers through `worktree list --containers`, not `ct list`,
  so both kinds come from one call with the same PR data; `ct list` keeps its own fields and grows them
  additively.
