# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kunj is a Git branch management CLI tool with AI-powered features for commit message and PR description generation. It uses AWS Bedrock Claude 3.5 Sonnet for AI capabilities and follows a pluggable command architecture.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Build the project (TypeScript → dist/)
npm run build

# Run in development mode
npm run dev <command> [options]

# Test locally after building
node dist/index.js <command> [options]

# Link for global CLI testing
npm link

# Run tests
npm test

# Run tests in watch mode
npm test:watch

# Run tests with coverage
npm test:coverage

# Type checking (no emit)
npm run lint
```

also commit and push changes

Track work in `docs/specs/README.md`: it lists what is done (with commits), in progress, to do and
waiting on the user. Move a line there in the same commit that ships or starts the work, and keep the
spec's own status table in step. Design specs live in `docs/specs/<topic>.md`, one per topic.

Work directly on `main`, in this checkout: no feature branches and no git worktrees (not even for
plan execution or subagents), even when another session is working here at the same time. Pull
before you start, commit small, and push.

## Testing

- Tests are located in `src/**/__tests__/` directories
- Test files follow the pattern `*.test.ts`
- Uses Jest with ts-jest preset
- Run single test file: `npm test -- path/to/test.test.ts`

## Architecture

### Pluggable Command System

Commands inherit from `BaseCommand` (src/lib/command.ts) and are registered via `CommandRegistry`:

1. Each command extends `BaseCommand` with a `CommandConfig` (name, description, options, and optional `helpText` shown after the options in `--help`)
2. Commands implement the `execute()` method
3. All commands are exported from `src/commands/index.ts` via `getAllCommands()`
4. The registry applies commands to the Commander.js program in `src/index.ts`

To add a new command:
1. Create a new file in `src/commands/` extending `BaseCommand`
2. Export it from `src/commands/index.ts`
3. Add it to the `getAllCommands()` array

### Settings Registry Pattern

Settings are registered via a centralized registry (src/lib/settings-registry.ts):

- Settings are defined with metadata (type, default value, description, validation)
- Organized by category (core, ai, branch-filtering, stash)
- All settings initialized in `src/settings/index.ts`
- Default config is dynamically generated from registered settings
- Settings support hierarchical keys (e.g., `ai.commitStyle`, `preferences.autoStash`)

### Configuration System

Two-tier config (global + local):
- Global: `~/.kunj/config.json` (user-wide settings)
- Local: `~/.kunj/{reponame}/config.json` (per-repository settings, shared by all worktrees of the repo)
- Local overrides global via deep merge
- Config loaded via `loadConfig()` in src/lib/config.ts

The per-repository directory is resolved by `getKunjDir()` in src/lib/config.ts. `{reponame}` comes from the
`origin` remote URL, falling back to the basename of the git common dir. Outside a git repository it falls back
to `./.kunj`. A legacy `./.kunj` directory is copied to the new location the first time it is seen.

Any string value may reference repository variables with `${name}` (src/lib/config-vars.ts):
`${repoconfig}` (the `.git` directory, or the repository itself when bare), `${repoRoot}`,
`${repoName}`, `${home}`, and `${branch}` where a branch is in scope. Names match
case-insensitively, and an unknown name is left verbatim so a literal `${...}` in a prompt or
commit template survives. `loadConfig()` returns the raw templates so `kunj config` can display
them; `loadResolvedConfig()` returns expanded values and only makes the git call when something
actually references a variable. Resolve variables from a git call you already made
(`repoVariables()`) rather than adding a subprocess.

### Branch Metadata

Per-branch metadata stored in `~/.kunj/{reponame}/branches.json`:
- Descriptions, tags, notes, related issues
- Stash history with timestamps
- Last switched timestamp
- Managed via src/lib/metadata.ts

### AI Integration

AI features use AWS Bedrock Claude 3.5 Sonnet:
- **Commit Messages** (src/lib/ai-commit.ts): Analyzes staged diffs and generates commit messages
- **PR Descriptions** (src/lib/ai-pr.ts): Analyzes branch diffs and commit history
- **Work Log Generation**: AI-powered daily standup bullets

Project context is read from `claude.md`, `.claude.md`, `CLAUDE.md`, `.claude/context.md`, or `README.md` (first 1000 chars cached).

AWS credentials and region resolved via standard AWS SDK chain (env vars, config files, IAM roles).

Commit styles (conventional, semantic, simple, gitmoji, custom) are defined in src/lib/commit-styles.ts.

### Work Log System

Daily activity tracking in `~/.kunj/{reponame}/work-logs/`:
- Markdown files named `YYYY-MM-DD.md`
- Automatically appends commit activity with timestamps
- AI-generated standup format with bullets
- Managed via src/lib/work-log.ts

## Key Commands

- `kunj create <branch>` - Create and switch to new branch (with auto-stash)
- `kunj switch [branch]` - Switch branches (interactive if no arg)
- `kunj list` - List branches with filtering options
- `kunj commit` - Interactive commit with AI-generated messages
- `kunj pr` - Create PR with AI-generated description
- `kunj log` - View/manage work logs
- `kunj config` - Manage global/local settings
- `kunj setup` - Interactive onboarding
- `kunj delete <branch>` - Delete branch
- `kunj completion` - Manage shell completion (--install/--uninstall)
- `kunj prompt-info` - Output PR# for shell prompts
- `kunj worktree [list|add|remove|prune|open|path|pr|session]` - Manage git worktrees (`add -c` creates the branch when it does not exist), their pull requests and editor sessions (used by the VS Code extension)
- `kunj worktree keep [add|apply|delete|list]` - Manage keep files copied into every worktree (interactive menu with no args)
- `kunj agent [start|status|stop] [branch]` - Run an agent in a host tmux session for a worktree (see Worktree agents below)
- `kunj container [start|shell|exec|agent|attach|open|forward|logs|list|stop|remove|prune|file]` (alias `ct`) - Run a branch in a sandboxed Docker container (see Branch Containers below)
- `kunj ct blueprint [init|snapshot|status|remove]` - The repository's container blueprint and its snapshot image (see Blueprints under Branch Containers)
- `kunj hooks [list|add|run|path]` - Inspect, scaffold and test hooks (see Hooks below)
- `kunj repos [list|add|remove|prune]` - Repositories kunj has been used in (used by the macOS app)
- `kunj events [--json] [--repo <path>...]` - Stream changes to worktrees, containers and agents as NDJSON (see Events below)
- `kunj install [vscode|macos|workspace|all]` - Download the VS Code extension / macOS app / Workspace app from the GitHub release and install them (also offered at the end of `kunj setup`)

## New Branches

`kunj create`, `kunj switch -c` and `kunj worktree add -b/-c` all start a new branch from the same
base, resolved by `resolveBaseRef()` in src/lib/base-branch.ts: `--base <ref>`, else
`preferences.defaultBaseBranch`, else the repo default (origin/HEAD, then main/master). With
`preferences.baseFromOrigin` (default true) the base is fetched and the branch is made from
`origin/<base>`; `--no-origin` uses the local branch for one command. A ref that is not a branch
(a commit, tag, `HEAD~2`) is used as given. New branches are created with `--no-track` so they do
not treat the base as their upstream. base-branch.ts only imports child_process because the
worktree fast path uses it.

## Worktrees & VS Code Extension

`kunj worktree` (src/commands/worktree.ts, src/lib/worktree.ts) wraps `git worktree` and tracks *editor sessions*: editors register the worktree they have open with `kunj worktree session start --pid <pid>`, and `kunj worktree list --json` reports those sessions per worktree. Sessions live in `~/.kunj/worktree-sessions.json` and are pruned when their PID is dead.
New worktrees default to `${repoconfig}/kunj/worktrees/<branch>` (`worktree.baseDir`, default in
src/lib/worktree-defaults.ts), which keeps them out of the working tree in a normal repo and inside
the repository directory in a bare one. Bare repositories are supported throughout: `--show-toplevel`
fatals there, so ask git for `--git-common-dir` first. Pull requests are fetched in one `gh pr list` (or `glab mr list`) call and cached for 60s in `~/.kunj/pr-cache.json`; pass `--no-pr` to skip or `--fresh` to bypass the cache.

**Performance:** `src/index.ts` has a fast path (`src/commands/fast.ts`) that loads only the requested command for `worktree`, `repos` and `prompt-info`, because importing the full registry pulls in AWS, LangChain and Jira and costs ~1s. A listing makes one `git rev-parse`, one `git worktree list` and one `git status --porcelain=v2 --branch` per worktree. Keep it that way: don't add per-worktree subprocesses or heavy top-level imports to these modules.

**Keep files:** files deliberately left out of git (e.g. `.env`) can be stored per repository in `~/.kunj/{reponame}/keep/` under their path relative to the worktree root (src/lib/keep.ts). `addWorktree()` applies them to every newly created worktree, and `kunj worktree keep apply [-a]` re-applies them to the current worktree (or all of them).

**Opening an editor:** `buildOpenCommand()`/`openWorktree()` in src/lib/worktree.ts launch `worktree.editorCommand` (default `code`) detached. VS Code-like editors (code, cursor, codium, windsurf) get `-r` to reuse the window, or `-n` with `--new-window`, unless the configured command already sets a window flag. An empty command disables opening.

The VS Code extension in `vscode-extension/` is a separate npm package (own `package.json`, esbuild bundle) that shells out to `kunj … --json` for everything. Build it with `cd vscode-extension && npm install && npm run build`; package with `npm run package`. Keep the CLI's JSON output backwards compatible, the extension depends on it.

**Workspace app contract:** the types in src/lib/json-types.ts (`WorktreeListJson`, `ContainerListJson`,
`ReposJson`, `ErrorJson`, `AgentStatusJson`, `AgentStopJson`, `FileReadJson`, `FileWriteJson`, `EventJson`) are the
published, type-only JSON contract (`types` in package.json; consumers import `from 'kunj'`). Commands build their
JSON against these types (`satisfies` or a type annotation) so the compiler checks it, and fields are only ever added, never renamed or
removed. Consumers: the VS Code extension, the macOS app and the workspace app. Errors in `--json` mode are
`{ error: { code, message } }` when the error has a string `jsonCode`, else `{ error: "<message>" }`; `kunj ct`
always prints the object shape. `kunj events --json` is the NDJSON change stream, `kunj ct file read|write` the
container file access.

**Worktree agents:** `kunj agent` (src/commands/agent.ts, src/lib/agent-session.ts) runs `agent.command`
(default `claude`) in a host tmux session for a worktree. The `KUNJ_*` variables go in argv
(`new-session -e`, tmux 3.2+), because tmux builds a new session's environment from its server, and
`TMUX` is dropped so it works from inside a pane. Without tmux (or with `--no-tmux`) `start` runs the
command directly (`$SHELL -lc`, a one-line hint on stderr when tmux is missing, exit code passed
through), like `kunj ct agent` in an image without tmux; `status` still reports `running: null` and
`stop` fails with `tmux-missing`. `readTmuxSessions()` tells `'missing'` (ENOENT) from `'failed'`;
only "no server running"/"error connecting to" count as no sessions. One tmux server serves the host, so the
session name is `agentSessionName()`: the container name from `containerNames()` with `.` and `:`
replaced by `-`. `listWorktreesDetailed()` makes one `tmux list-sessions` call per listing (in the
same `Promise.all` as the git calls, only with status) and sets `WorktreeInfo.agent`
(`{ running, session }`); `running` is null when tmux is not installed. Keep it one call, not one per
worktree. `AgentError` prints without a stack trace (listed in BaseCommand). Repo name and id come from
`repoIdentity()` (src/lib/repo-identity.ts).

## Branch Containers

`kunj container` (alias `ct`, src/commands/container.ts) runs a branch in a Docker container with its
own clone, mainly to run an agent with permissions skipped. Origin is the only channel in and out;
nothing from the host is bind-mounted. Specs: docs/specs/ (one file per topic; overview in
docs/specs/container-system.md, phase 1 in docs/specs/branch-containers.md). Phase 2
(docs/specs/container-phase-2.md) adds sidecar services, `open`,
`forward --auto`, `prune`, Docker-in-Docker (`container.dockerInDocker`) and the host MCP bridge. Phase 3 is the workspace IDE
(docs/specs/workspace-ide.md): its CLI contract has shipped, the app has not.

**Modules:** `src/lib/container/{backend,docker,names,devcontainer,image,seed,env,lifecycle,forward,autoforward,services,editor,prune,dind,errors,files,mcpbridge}.ts`.
`prune.ts` (`planPrune`/`applyPrune`) removes containers of branches gone from origin (missing from one
`git ls-remote --heads origin` and present as `refs/remotes/origin/<b>` in the clone; unreachable origin
removes none) only when the remove guard is clean, checked at plan and again at removal, or `--force`;
orphans found by labels (helpers, services, networks of a repo/branch with no main container and nothing
created in the last `ORPHAN_GRACE_MS` = 10 min, so a start waiting on services is not one; volumes
only with `--force`); only `--yes` or a confirmation applies (`--force` is not consent);
snapshots of another hash (all kept when the hash is unknown), other versions' `kunj-sandbox`/`kunj-nethelper`/`kunj-sandbox-dind`
tags and stopped containers older than `container.pruneAfterDays`; never an image a container uses.
`autoforward.ts` polls `/proc/net/tcp{,6}` (not `ss`, which most images lack) and forwards new listeners (127.0.0.1 only).
The poll and every branch-container tunnel (`forward <port>` too) exec in the network helper (shared network
namespace, `socat` in its image), never in the main container, which may not be READY yet after a quick
restart; services are tunnelled through their own container. A forwarder is bound to one run of the main
container (`containerRun()`'s `startedAt`) and exits on the first check that finds it stopped or restarted.
Running forwarders, manual `forward` ones included, are in `~/.kunj/container-forwards.json` keyed by
container id (dead pids pruned on read, atomic writes); a port-0 record marks an `--auto` forwarder, and
`agent` spawns a detached one unless `container.forward.auto` is `false` or one is registered for the container.
`dind.ts`: `sysbox` (`--runtime sysbox-runc`, refused unless `docker info` lists it) or `privileged`
(needs `container.allowPrivileged`, refused on Docker Desktop whatever the context): capabilities kept,
`/var/lib/docker` on `<container>-docker`, the `kunj-sandbox-dind` image (only on top of kunj's sandbox;
a devcontainer or custom image is refused). `dockerd` is started by `kunj-dind-start` as root only after
READY (start and resume), and never in a snapshot (`StartOptions.withoutDind`: same image, so the hash
agrees, but no dockerd and no docker volume).
The images' build contexts live in `src/container/{sandbox,nethelper,sandbox-dind}/` and are copied to
`dist/container` by `scripts/copy-container-assets.js` as part of the build. Their tags are
`kunj-sandbox:<version>-<hash>` / `kunj-nethelper:<version>-<hash>`, the hash covering the build
context's files (`assetHash()` in image.ts), so editing a Dockerfile or `firewall.sh` rebuilds;
`kunj-sandbox-dind:<version>-<hash>` also hashes the sandbox tag it is built FROM.

**Backend rule:** only `docker.ts` spawns `docker`. Everything else programs against the
`ContainerBackend` interface (backend.ts) so a remote backend can be added later; unit tests use
`FakeBackend`.

**Files:** `ct file read|write [branch] <path>` (src/lib/container/files.ts) validates paths against `/workspace` and runs as the sandbox user; its errors carry a `ContainerError` code (`bad-path`, `not-found`, `write-failed`) printed as the `--json` error code. It is for text: `read` decodes UTF-8, and symlinks inside /workspace are followed (the sandbox boundary is the container, not the path check).

**Naming and state:** containers, volumes and networks are `kunj-<repo>-<b>-<h>`, where `<h>` is a
short hash of the exact branch name, because `branchToDirName` collapses `feature/x` and
`feature-x` (names.ts). There is no state file: `kunj.*` labels on the Docker objects are the only
state, and a reused container must match its labels.

**Fast path:** `container` and `ct` are in `FAST_COMMANDS` (src/commands/fast.ts). Keep top-level
imports light, load inquirer lazily and do not import the AWS or LangChain modules.

**No code before READY:** the main container runs with `--entrypoint sleep`, and the network helper
(a sidecar sharing its network namespace, holding NET_ADMIN) applies the firewall and then touches
`/tmp/kunj-ready`. The main container runs with all capabilities dropped except CHOWN, DAC_OVERRIDE,
FOWNER, SETUID and SETGID (`MAIN_CAPABILITIES` in lifecycle.ts); never give it NET_ADMIN or NET_RAW
(Docker-in-Docker is the one opt-in exception). Nothing may be exec'd in the main container
before that file exists. `start` (not `open`, `keepStaleHelper`) replaces a running helper whose image is
not the current `kunj-nethelper` tag the same way, after ending that container's registered forwarders and
bridges; a running main whose helper replacement fails is stopped. firewall.sh builds its rules in
`KUNJ-OUT-NEW` and swaps the chain in, so reloading on a running container never opens a gap.

**Secrets:** they travel only in the `docker run` env-file. Never pass them with `docker exec -e`
(visible in `ps` and `inspect`) and never put them in labels. The git credential helper
(`src/container/sandbox/git-credential-kunj`) is streamed into `$HOME/.kunj/bin/` of every container
that gets a token, whatever the image, and answers only for origin's `host[:port]`.

**Tests:** `npm test` runs everything with the fake backend. `npm run test:docker`
(`*.docker.test.ts`) drives a real Docker daemon, builds the images and checks the firewall; it
skips itself when Docker is unavailable.

**Functional tests:** `npm run test:functional` (`test/functional/*.functional.test.ts`,
`jest.functional.config.js`) drives the built CLI (`node dist/index.js ct …`) as a user would, in a
throwaway repository whose origin is a `git daemon` on the host (helpers shared with the Docker suite in
`src/lib/container/__tests__/git-origin.ts`), with a throwaway `HOME` so `~/.kunj` is never touched, and
asserts on `--json` output, exit codes and `docker inspect`. They cover start/list/stop/resume/remove,
exec and shell, secrets, the firewall, the remove guard, blueprint snapshots, services, forward and
`--auto`, agent/attach, open, prune, Docker-in-Docker refusals, the MCP bridge and the container hooks.
Opt-in only: without `KUNJ_FUNCTIONAL=1` (which the script sets) every file is skipped, and `npm test` /
`npm run test:docker` never see them (their roots are `src/`). They take many minutes, need Docker
(the sandbox image has tmux for the agent test) and `script` on the host, build the CLI first, and remove
everything labelled with the test repository after each test. `KUNJ_FUNCTIONAL_SLOW=1` adds the
10-minute orphan-volume prune test; `KUNJ_FUNCTIONAL_PRUNE_IMAGES=1` lets `prune --yes` run even when it
would also remove kunj images of other versions on the daemon (otherwise only its dry run is checked).

**Hooks:** `${...}` values in `hooks.*` config commands are quoted for the context they sit in
(`expandVariablesQuoted()` in config-vars.ts): single-quoted when bare, escaped inside `"..."`,
`'\''`-spliced inside `'...'`, and quoted as bare inside `$(...)` and backticks (which open a fresh
unquoted context even within `"..."`; backtick spans get one more level of escaping), so every
form passes the value literally. The container
hooks are `pre/post-container-create` and `pre/post-container-delete` with `branch`, `container`,
`image`; the create hooks are skipped when `start` resumes an existing container.

**MCP bridge:** `mcpbridge.ts` bridges host stdio MCP servers (`container.mcp`, host config only;
v1 only `chrome`) into the container, for one container run (`containerRun()` StartedAt). Root runs
only `mkdir`/`chown`/`chmod 700` of `/run/kunj-mcp`; the listener (`socat UNIX-LISTEN:…sock,mode=600
STDIO`, no `fork`: one session at a time), its pid file and its stop run as the user, and the stop
checks the pid's cmdline. The host server (only `cfg.env` + PATH/HOME) starts on the first complete
message; the default one is pinned (`CHROME_DEVTOOLS_MCP`) and gets a per-session `--userDataDir` and
TMPDIR in a temp dir whose prefs refuse downloads, deleted afterwards. The agent drives a browser on
the Mac's network, so the filter is deny by default: `BROWSER_TOOL_ARGS` (tools and, per tool, their
arguments, checked against the pinned version), `isPathKey` at any depth (too deep is refused), ids
short strings or safe integers and unique in flight, batches refused with one error, container text
quoted at most 100 characters, every tool list in a reply filtered by shape, the server's `roots/list`
answered empty by the bridge (container roots stripped, its replies to those dropped), malformed lines
dropped, lines capped at 4 MB (16 MB from the server), reading paused while either side does not drain
(8 MB waiting for the container ends the session), a thrown error ends the session, never the process, navigation only to the forwarded host
ports unless `allowOrigins` (explicit navigation only, not a network boundary). Never add a tool or an
argument that takes a host path; bump the pin only after re-reading the new version's tools. `kunj ct agent` (and start) merge `mcpServers.<name>` into the user's
`~/.claude.json`; agent spawns a detached `kunj ct mcp`, registered in `~/.kunj/container-bridges.json`
(`pidRegistry`, shared with the forward registry).

**Services:** `services.ts` parses and validates services (blueprint `services`, `container.services`, the
devcontainer's compose file read through `backend.composeConfig()`, i.e. `docker compose config
--no-interpolate` on stdin in an empty project directory; first source wins by name), orders them by
`dependsOn` and builds their run spec: `<container>-svc-<name>` on the branch network with
`--network-alias <name>`, only the env and named volumes it declares, no added capabilities, no
published ports, no firewall helper, labels `kunj.role=service`, `kunj.service=<name>` and
`kunj.options` (`port`, `healthcheck`, volume names; never env). `startContainer` starts them after
the network and before the branch container (health check polled up to 120 s, then a warning), and
they are in its rollback list; `resume` starts stopped ones and creates newly declared ones (never
removes one; a failed resume stops the ones it started), `--rebuild` removes undeclared ones with their
volumes unless `--keep-volumes`, `stopContainer` stops them and
`removeContainer` deletes them and the volumes in their label. Never give a service host env, a
bind mount, a capability or `--privileged`: its image is chosen by the branch.

**Editor:** `kunj ct open` resumes through `startOrResume()` (never rebuilds) when `needsResume()` says the container,
its helper or a service is down (never for an out-of-date running helper), writes the
Dev Containers extension's per-image config (`imageConfigs/<image>.json`, `:`/`/`/`%` escaped as lowercase
`%xx`, with `remoteUser` and `workspaceFolder`) and launches `worktree.editorCommand` via `buildOpenCommand`
with `--folder-uri vscode-remote://attached-container+<hex of {"containerName":"/<name>"}>/workspace`. An
attached window forwards host git credentials and the SSH/GPG agents into the container, so `open` always
prints `EDITOR_CREDENTIALS_WARNING` (editor.ts); kunj does not change the extension's behaviour.

**Blueprints:** `.kunj/blueprint.json` (`tools`, `setup`, `maintain`, `lockfiles`, `notes`, `services`) says how a
new container is set up. Design: docs/specs/blueprints.md. Modules:
`blueprint.ts` (parse/validate, resolve, hash, tags, labels), `presets.ts` (lookup and order),
`infer.ts` (`blueprint init`), `provision.ts` (find a snapshot, run presets + `setup` on a new
container, `maintain` on every start except one that just ran `setup`), `snapshot.ts` (build,
`ensureSnapshot()` for start, status, remove). `start` resolves the
blueprint from the working tree's `.kunj/blueprint.json`, then `origin/<default>`, then
`~/.kunj/<repo>/blueprint.json`, builds the snapshot itself when there is none for the hash or it
is stale (falling back to the stale snapshot, else tools + `setup` in the container, when the build
fails; `StartOptions.snapshotHandled` then silences lifecycle's own hints), and starts from
it; `kunj ct blueprint snapshot` is only for building ahead of time or forcing a rebuild.
Presets are `<name>.sh` in `.kunj/presets/`, `~/.kunj/presets/`, then `src/container/presets/`
(first found wins; copied to dist by the build). They run as root with `sh`, source `_lib.sh`, get
`KUNJ_TOOL_NAME/VERSION/USER`, must install outside the home (it is a volume, not committed), persist
environment with `kunj_env KEY=VALUE` (→ `/etc/kunj/env`, turned into image `ENV` at commit and into
`/etc/profile.d/kunj-tools.sh`), and must end with `kunj_done <version>` (kunj reads the result file;
prints `installed <name> <version>`). Tool values are validated twice (`TOOL_WORD` in blueprint.ts and
`kunj_check_words` in the preset): never let a value become an option or a path. The hash is
`computeBlueprintHash()` only: blueprint text, the lockfiles' blob ids at `blueprintRef()` (origin's
default branch, never the current worktree), the base image tag and the presets' content hashes;
start, snapshot, status and list must all call it. The snapshot is an ordinary `startContainer`
(`namesFor: '<branch>:snapshot'`, no env, keep files, files, ports or agent, so no secrets in the
image) whose `/workspace` is copied to `/opt/kunj/seed` and committed as `kunj-blueprint-<repo>:<hash>`,
labelled `kunj.blueprint.{hash,ref,base,user,createdAt}`; older snapshots of the repo are deleted.
The temporary container clones a bundle, not origin: `makeBranchBundle()` fetches the branch on the
host (its credentials) and bundles it as the one ref `refs/heads/<branch>`; `StartOptions.bundle`
streams it in as the sandbox user, `seedScript({ bundlePath })` clones it, resets `origin` and skips
the fetch, and the file is removed before the commit (`/tmp` is in the image). With a bundle, start
skips the SSH `no-token` refusal and the unpushed gate. Never forward a token into a snapshot;
`--no-bundle` is the escape hatch (public origins only).
Seed sentinels in `/workspace`: `.kunj-seeded` (the seed finished; ignored file, never in a snapshot),
`.kunj-copying` (a copy from the snapshot is in progress: only then may `/workspace` be wiped and
recopied, never a real checkout), `.kunj-fresh` (a complete copy whose branch must still be moved to
origin's; removed once it is). All three are in `.git/info/exclude`. Never run presets or `setup` as
the wrong user: presets as root, `setup`/`maintain` as the sandbox user (`sh -lc` in /workspace).
`npm run test:docker` covers the snapshot (labels, jq from the apt preset, seed contents, no secret
ENV), a snapshot via the bundle (no `git clone git://` exec, seed HEAD is origin's; the host reaches
the git daemon through `core.gitProxy`), a start from it (no clone, `maintain` ran, origin URL), the stale hint, `--no-snapshot`, a failing
`setup` leaving nothing behind, and `removeSnapshots`.

## Repository Registry & macOS App

`~/.kunj/{reponame}/` does not record where a repository lives, so src/lib/repos.ts keeps
`~/.kunj/repos.json` (root, git common dir, name, bare, hidden, lastSeen). A repository is recorded
when `getKunjDir()` first resolves it, by `kunj worktree list` and by `kunj worktree session start`
(how editor windows reach the list). Recording only reads the file unless the entry is new or over an
hour old, because it sits on the fast path. `kunj repos remove` hides an entry rather than deleting it,
so running kunj there again does not bring it back; `kunj repos add` un-hides it.

The menu bar app in `macos-app/` (SwiftUI `MenuBarExtra`, macOS 14+, SwiftPM, no Xcode project) is the
second consumer of the CLI's JSON: it reads `kunj repos --json`, runs `kunj worktree list --json` per
repository, and uses `worktree open|add|remove|prune|pr`, `list --all` and `repos add|remove`. It
resolves `PATH` from a login shell because apps launched from Finder do not get one. Build it with
`macos-app/scripts/bundle.sh` (`--install` copies it to /Applications); the script retries with an
older SDK because the Command Line Tools' newest SDK lacks the SwiftUI macro plugin. It is ad-hoc
signed, not notarized. The release workflow's `macos-app` job attaches `Kunj-macos-<version>.zip`
next to the `.vsix`; `kunj install` (src/lib/apps.ts) finds those assets by name pattern, preferring
the release matching the CLI version, so keep the asset names in step with it.

## Workspace App

`workspace-app/` (AppKit + SwiftTerm, Monaco in two WKWebViews, macOS 14+, SwiftPM, no Xcode project) is
the third consumer of the CLI's JSON: one window listing every worktree and branch container of the repos
in `kunj repos --json` as environments, with terminals, agent tabs (`kunj agent`/`kunj ct agent`, so they
reattach to kunj's tmux sessions), a Changes column and editor tabs. It runs `kunj … --json` with `cwd`
= the repo root and the branch named, refreshes on `kunj events --json` (a child whose stdin it holds),
never imports kunj, never runs `docker`, and runs `git` only read-only with `GIT_OPTIONAL_LOCKS=0`. Its only
state is UI layout in `~/.kunj/<repo>/workspace.json`. `MIN_KUNJ_VERSION` is 1.3.0 (1.0.0 is accepted as a
dev build), so a JSON or command change it relies on must stay additive. `KunjWorkspaceCore` (Foundation
only) is unit tested with Swift Testing against `Tests/Fixtures/fake-kunj`; build with
`workspace-app/scripts/test.sh` and `scripts/bundle.sh` (`SCRATCH=.build/<name>` when building in
parallel; `--demo --screenshot <png>` renders the mockup data to compare with
`docs/workspace-app/design/mockups/warm.png`). Spec: docs/specs/workspace-ide.md; build details in
workspace-app/README.md. The release's `workspace-app` job attaches `Kunj-workspace-<version>.zip`, which
`kunj install workspace` installs as `Kunj Workspace.app`.

## Events

`kunj events [--json] [--repo <path>...]` (src/commands/events.ts, watcher in src/lib/events.ts,
`EventJson` in json-types.ts) is a long-lived NDJSON stream for the workspace app: `hello` first,
then `git` (`fs.watch` of each repo's git common dir top level, plus `refs/` and `worktrees/`
recursively, started when they appear; never the whole common dir recursively, because worktrees
live in `.git/kunj/worktrees` with their node_modules; filtered by `gitPathMatters()`),
`sessions`/`forwards`/`repos` (the registry files in `~/.kunj`), `agent` (a poll of `kunj-` tmux
sessions, 5 s; a failed listing is skipped, not read as every agent ending) and `container`
(`ContainerBackend.events()`, filtered on `kunj.repo`; exec/attach/copy actions are dropped because
`kunj ct list` execs and would trigger its own refresh). The watches cannot see a file edited in a
worktree or work inside a container, so a status poll (`statusPollMs`, 10 s) runs one
`git worktree list --porcelain` per repo and one `git status --porcelain=v2 --branch` per worktree
(both `GIT_OPTIONAL_LOCKS=0`), emitting a `git` event when a worktree's hash changes, and, while the
backend is available, one `backend.list` per repo and one exec of `STATUS_SCRIPT` (env.ts, shared with
`kunj ct list`) per running main container, emitting `container` with `action: 'status'` when
`{ agentRunning, head, ahead, dirty }` changes. The first poll only primes; ticks never overlap; a
failing worktree or container is skipped; Docker calls are raced against the abort signal. `hello` is
printed from `onReady`, after the watches, the repo ids and the first tmux and git polls. Changes are
debounced per key (250 ms, the first change starts the timer). An unreachable backend gives one
`backend unavailable`, then `info()` is retried every 10 s until `available`. Container events map to
a repo through an id computed once per repo at startup from `git remote get-url origin` (insteadOf,
includes; userinfo stripped), as the `kunj.repo` label has it (`repoId` is the test seam). It stops on SIGINT/SIGTERM
or when stdin ends, so a child dies with its parent; docker calls still hung then are killed
(`LocalDockerBackend.killChildren()`). On the fast path; a missing directory is skipped.
`index` is a trigger, so `getWorktreeStatus()` runs `git status` with `GIT_OPTIONAL_LOCKS=0`: otherwise
git rewrites a stale index on every listing, which is another `git` event and another refresh.

## Hooks

Git-style hooks (src/lib/hooks.ts) let users run their own scripts around kunj actions (not around
every git operation). The hook names, arguments and pre/post behaviour are declared in
src/lib/hook-defs.ts, which has no imports so the settings registry and the types can use it
without an import cycle through config.ts. Current hooks: `pre/post-worktree-create`,
`pre/post-worktree-delete`, `pre/post-branch-create` (create, switch -c), `pre/post-branch-switch`,
`pre/post-branch-delete`, `pre-commit`, `commit-msg` (may edit the message file), `post-commit`,
`pre/post-pr-create`, `pre/post-stash` (kunj stash and the auto-stash in src/lib/stash.ts).

For each hook, `runHook()` runs, in order: executables in `~/.kunj/hooks/` (global), executables
in `~/.kunj/{reponame}/hooks/` (repo) - either a file named after the hook or a `<hook>.d/`
directory of scripts in sorted order, skipping `*.sample`, dotfiles and non-executable files -
and then the commands in the `hooks.<name>` config setting (a string or an array, run via the
shell with `${...}` variables expanded). Each hook argument is passed positionally, as
`KUNJ_<ARG>` in the environment and as a camelCase `${var}` (`previous-branch` ->
`KUNJ_PREVIOUS_BRANCH`, `${previousBranch}`), alongside `KUNJ_HOOK`, `KUNJ_REPO_ROOT`,
`KUNJ_REPO_CONFIG` and `KUNJ_REPO_NAME`. A failing `pre-*` (or `commit-msg`) hook throws
`HookError` and aborts the command (BaseCommand prints it without a stack trace); `post-*`
failures come back in the `HookRunResult` and are printed as warnings. In `--json` mode hook
stdout is redirected to stderr and stdin is closed so the JSON output stays clean; `--no-hooks`
skips them.

To add a hook to another command: add its definition to `HOOKS` in src/lib/hook-defs.ts (the
`hooks.<name>` setting is registered automatically from that list), then call
`runActionHook(name, { <arg>: value }, { hooks: config.hooks, jsonMode, skip: options.hooks === false })`
at the right point and give the command a `--no-hooks` option. `runActionHook()` returns
immediately when nothing is installed, so it costs no git call. The worktree hooks instead build
a `HookContext` with `worktreeHookContext()` and call `runHook()`, passing in `repoVariables()`
from a git call they already made, because they sit on the fast path.

## Shell Integration

### Autocomplete

Enable tab completion for commands and options:

```bash
# Install completion
kunj completion --install

# Reload shell
source ~/.zshrc  # or ~/.bashrc
```

### PR# in Shell Prompt

Display current PR number in your shell prompt. Add to `~/.zshrc`:

```zsh
# Function to show PR# in prompt
kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " $pr"
}

# Add to right prompt
RPROMPT='$(kunj_prompt_pr)'
```

See `docs/SHELL_INTEGRATION.md` for detailed setup instructions and advanced configurations.

## Git Operations

Core git operations abstracted in src/lib/git.ts:
- All git commands use `child_process.exec` wrapped with `promisify`
- Functions return structured results or throw errors
- File status parsing handles standard git status codes (M, A, D, R, C, U)

## User Docs

`docs-site/` is the user documentation (Astro Starlight, MDX), published by `.github/workflows/pages.yml`
at `/kunj/docs/` next to the landing page in `site/`. Authoring rules and components are in
docs-site/README.md. The command, settings and hook reference is generated from the sources
(`docs-site/scripts/gen-reference.cjs` → `docs-site/src/data/*.json`, run by `npm run build` there):
after changing a command's options, a setting or a hook, run `npm run gen` in docs-site and commit the
JSON. When behaviour changes, update the matching page under `docs-site/src/content/docs/`.

## Release Process

Tag-based automatic releases via GitHub Actions:

1. Commit changes to main
2. Create version tag: `git tag v1.2.3`
3. Push tag: `git push origin v1.2.3`
4. Workflow automatically publishes to NPM and creates GitHub release

The workflow rewrites package.json *after* the build, so the CLI reads its version from
package.json at runtime (`getVersion()` in src/index.ts) - never inline a version at build time.
`-V` is answered before the command registry loads, for the same reason as the fast path.

See `.github/workflows/README.md` for details. Requires `NPM_TOKEN` secret.

## Code Conventions

- TypeScript strict mode enabled
- Target ES2022, CommonJS modules
- Source in `src/`, output in `dist/`
- Chalk for colored output (v4.1.2 for CommonJS compatibility)
- Inquirer for interactive prompts
- Commander.js for CLI parsing
