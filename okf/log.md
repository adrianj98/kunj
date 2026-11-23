# Directory Update Log

## 2026-11-20 (suspend and resume sessions)
* `features/worktree-agents.md`: Suspend Session / Resume Session in the workspace app.

## 2026-11-19 (resume closed agents)
* `features/worktree-agents.md`: `kunj agent saved` / `forget` and the workspace app's Resume Agent… (⌘⇧R).

## 2026-11-16 (cloud machines phase 2)
* `containers/cloud-machines.md`: the proxy, `kunj ct` on a branch's machine and the idle loop, as shipped.

## 2026-11-16 (bootstrap and nonce pairing)
* `containers/cloud-machines.md`: the bootstrap script row and pairing by nonce.

## 2026-11-16 (phase 0 run)
* No page changed in substance: phase 0 of cloud machines ran on a real Google Cloud VM (remote ping, start,
  exec, firewall, suspend/resume); results are in docs/specs/cloud-machines.md and google-cloud-containers.md.

## 2026-11-16 (cloud machines phase 1 shipped)
* `containers/cloud-machines.md` describes the shipped modules (provider seam, GceProvider, Coordinator, machine
  routes, local auto-start, `kunj machine`) and what is not built yet; `containers/remotes.md` gains named client
  tokens and pairing on `kunj serve`.

## 2026-11-16 (coordinator)
* `containers/cloud-machines.md`, `containers/google-cloud.md`: the design now has a coordinator,
  `kunj serve --machines`, auto-started on the laptop or always-on on a tiny VM, which alone drives the
  provider and proxies to each machine's serve; several clients connect with a token each; the idle loop
  moves to the coordinator with machine self-suspend as the local fallback.

## 2026-11-16 (cloud machines follow-ups)
* `containers/cloud-machines.md`: the blueprint snapshot, golden image and registry copy share one hash; the
  machine suspends itself. CLAUDE.md and docs/specs/container-system.md (status table, roadmap, decisions) now
  point at the design.

## 2026-11-16 (cloud machines design)
* **New page**: `containers/cloud-machines.md` for docs/specs/cloud-machines.md: a VM per session from a
  pluggable `MachineProvider`, Google Cloud first. `containers/google-cloud.md` trimmed to the provider
  notes for that design (the option survey is gone).

## 2026-11-16 (Google Cloud research)
* **New page**: `containers/google-cloud.md` summarises docs/specs/google-cloud-containers.md: a
  Compute Engine VM running Docker and `kunj serve` behind IAP is the recommended way to run branch
  containers on Google Cloud; Cloud Workstations, a GKE backend and Cloud Run are weighed and why they
  lose. Research only; no code changed.

## 2026-11-12 (editor reload and save on focus loss)
* **Workspace app**: `apps/workspace-app.md`: editor tabs without unsaved edits reload a file that changed on disk; optional save when the editor loses focus.

## 2026-11-12 (file:line links in terminals)
* **Workspace app**: `apps/workspace-app.md`: ⌘-click on `token.ts:33` or `bob.ts:44-60` opens the file at the line; bare names are found among the environment's files.

## 2026-10-30 (sidebar folder, usage on hover)
* **Features**: `features/tmux-sessions.md`: sidebar rows name the worktree folder; usage is polled and shown only while hovering.

## 2026-10-29 (sessions follow a checkout)
* **Features**: `features/tmux-sessions.md`: sessions are matched to their worktree by tag, so a branch switch inside the worktree keeps them; the workspace app moves the worktree's tabs to the new branch.

## 2026-10-28 (sidebar session usage)
* **Features**: `features/tmux-sessions.md`: workspace app sidebar rows show their worktree's session CPU and memory.

## 2026-10-27 (tmux sessions)
* **New page**: `features/tmux-sessions.md` covers `kunj sessions`, the `@kunj_worktree` tag and the workspace app's Sessions window.

## 2026-10-27 (search follow-ups)
* **Apps**: `apps/workspace-app.md`: a search match opens with the match selected across emoji (UTF-16 columns), `-searchOpen` launch argument.

## 2026-10-27 (monaco-vscode-api spike)
* **Apps**: `apps/workspace-app.md` notes the monaco-vscode-api spike and its result.

## 2026-10-27
* **Search**: new `features/search.md` for `kunj search` (src/lib/search.ts, src/commands/search.ts, `ContainerCommand.searchJson`, `SearchJson`); `apps/workspace-app.md` describes the Files column's Search mode.

## 2026-10-27 (blueprint aliases)
* **Containers**: `containers/blueprints.md` documents the `aliases` key and `/etc/profile.d/kunj-aliases.sh`.

## 2026-10-26 (kunj_need_pkg)
* **Containers**: `containers/presets.md` lists `kunj_need_pkg`; the bun preset installs unzip.

## 2026-10-26 (blueprint tools "*", LFS)
* **Containers**: `containers/blueprints.md` notes `"*"` tool values and LFS handling in snapshot seeds.

## 2026-10-26 (blueprint image)
* **Containers**: `containers/blueprints.md` documents the blueprint `image` key, its precedence and `init` writing `sandbox`.

## 2026-10-26 (zsh wizard)
* **Containers**: `containers/images.md` notes the new-user wizard is turned off in `/etc/zsh/zshenv`.

## 2026-10-26 (icon)
* **New page**: `apps/icon.md` covers the icon sources, `scripts/gen-icons.sh` and where each output goes.

## 2026-10-26 (serve guard)
* **Containers**: `containers/remotes.md` gains "What the server refuses" (volumes, networks, capabilities) and tunnel closing.

## 2026-10-26 (terminal colours)
* **Workspace app**: `apps/workspace-app.md` notes which terminal colours follow the theme.

## 2026-10-25 (shell selection)
* **Workspace app**: `apps/workspace-app.md` notes ⌥-drag selection and plain-drag selection in shell tabs.

## 2026-10-25 (token test)
* **Workspace app**: `apps/workspace-app.md` lists `kunj ct token check --json` (Settings' Test) and
  `kunj ct token setup` (Set Up…) in place of the `secret set` chain.

## 2026-10-25 (workspace links)
* **Workspace app**: `apps/workspace-app.md` gains ⌘-click file links in terminals and the close
  buttons on tabs and the Changes/Files columns.

## 2026-10-25 (remotes)
* **New page**: `containers/remotes.md` covers `~/.kunj/remotes.json` and `--allow-insecure-http`.

## 2026-10-25 (later)
* **Live refresh**: `apps/macos-app.md` and `apps/vscode-extension.md` describe the apps following
  `kunj events --json` (6e7e330), which the first pass left out as uncommitted work.

## 2026-10-25
* **Initialization**: Created the OKF v0.1 knowledge bundle for kunj, one file per technical
  feature or architectural piece, each checked against the source: `architecture/` (11: system
  overview, command system, fast path, settings registry, configuration, config variables, repo
  identity and registry, git layer, JSON contract, release process, testing), `features/` (17),
  `containers/` (21), `secrets/` (5) and `apps/` (4: VS Code extension, macOS app, workspace app,
  docs site), with an index per folder.
* **Found while writing** (code differs from CLAUDE.md or docs; documented as the code has it):
  container hook commands get `${repoRoot}`, `${repoconfig}`, `${repoName}` and `${home}` already
  expanded unquoted by `loadResolvedConfig()` before `expandVariablesQuoted()` runs (see
  [Config Variables](/architecture/config-variables.md)); setting categories are not the four
  CLAUDE.md names; `kunj config --set` does not run a setting's `validate`; `kunj completion` covers
  16 older top-level commands only; `ai.provider` is display-only (Bedrock is the only provider);
  `kunj pr` is GitHub-only and does not use `resolveBaseRef()`; the macOS app's `kunj events`
  subscription was uncommitted at the time of writing and is not described.
- Workspace app: resizable panes (`DividerHandle`, `PaneSizes`) and `sidebarPlace()` shows the kind when the folder matches the branch's letters and digits. Pages updated: apps/workspace-app.md, features/tmux-sessions.md.
- Workspace app sidebar: the kind is an icon (branch/box) and `sidebarPlace()` became `sidebarFolder()` (nil when the folder matches the branch). Page updated: features/tmux-sessions.md.
- Blueprints: `lockfiles` is optional and defaults to none (no auto-detected lockfiles in the hash); `blueprint init` no longer writes it. Pages updated: containers/blueprints.md.
- Clone from GitHub: `kunj repos github` (one `gh api --paginate user/repos`), `kunj repos clone` (`repos.cloneDir`, `repos.cloneBare`), the workspace app's Clone from GitHub sheet. Pages updated: architecture/repo-identity-and-registry.md, apps/workspace-app.md.
- Quit prompt (Leave Running / Close All Sessions, 20 s timeout), Close All Sessions…, and resuming Claude agents (`SessionStart` hook saves the session id, `kunj agent --resume`). Pages updated: features/worktree-agents.md, apps/workspace-app.md.
- Workspace app sidebar hides repositories with no open session; View > Show Repositories Without Sessions brings them back. Page updated: apps/workspace-app.md.
- Workspace app sidebar: repositories collapse to their header on a click (▸/▾), remembered in `collapsedRepos`. Page updated: apps/workspace-app.md.
- CLI errors: one format from `src/lib/errors.ts` (`UserError`, `describeError()`, `formatError()`): `✗ message` + hint, no stack trace unless `KUNJ_DEBUG=1`, raw git/Node/AWS errors translated, every command's messages rewritten. Page updated: architecture/command-system.md.
- `/handoff`: `kunj agent start --detach/--prompt-file/--open-in-app`, `@kunj_open`, events `id`/`worktree`/`open`, `kunj install skill`, the app opening the handed-off tab. Pages updated: features/worktree-agents.md.
- tmux sessions: `agentArgv` wraps the command with an explicit cd (`inDirectory()`), because a tmux server whose own directory was deleted ignores `-c`; `runTmux` starts tmux in the home directory (`spawnCwd`). Page updated: features/worktree-agents.md.
- Remote containers: exec frames carry at most 1 MB (`encodeFrames()`, `MAX_FRAME_DATA`), so a stream chunk over the 16 MB `maxPayload` (a large file in a tar stream) is split; `kunj serve` listens for `error` on every WebSocket, so a bad frame ends one stream, not the server. Page updated: containers/remotes.md.
- `kunj serve` prints `Waiting for Docker to answer…` when `docker info` takes over 5 s at startup (it listens only after). Page updated: containers/remotes.md.
- Remote terminals: first size set by `ConsoleSize`, a retried first resize and a late `resize` frame applied once the pty exists (was sometimes 80x24); a lost exec says the container stopped or Docker restarted. Page updated: containers/remotes.md.
- Services: `warnStoppedServices()` warns at the end of a start or resume about a service that is not running. Page updated: containers/services.md.
- Remote terminals: recorded the known gap that a closed remote terminal's process stays in the container. Page updated: containers/remotes.md.
- `kunj ct list` lists the fleet (this machine and every remote): `remote` per container, `backends`. Workspace app: "Run on" in New session, `Environment.remoteArguments` on every container command. Pages updated: containers/remotes.md, apps/workspace-app.md.
- Cloud machines: golden images (`kunj machine image build|list|delete`, `Coordinator.bake()`, newest image booted, bootstrap token reset), `ct blueprint snapshot --machine`, a start lock for the local coordinator. Page updated: containers/cloud-machines.md.
- `container.caches`: per-repository cache volumes in every new branch container and the snapshot build (`KUNJ_CACHE_DIR`). Page updated: containers/lifecycle.md.
- `kunj ct remove` on a cloud machine deletes the machine after the container (`BackendSelection.machine`). Page updated: containers/cloud-machines.md.
- Cache store for cloud machines: `machine.cache` (a bucket per coordinator), `MachineProvider.cacheSync()`, `syncCaches()`, `kunj ct cache status|pull|push`. Pages updated: containers/cloud-machines.md, containers/lifecycle.md.
- Seed: a fresh snapshot copy keeps only the container's own local branch (fixes a false `unpushed commits on main` from the remove guard). Cache sync: no push of an empty cache without `--force`. Pages updated: none (behaviour notes in the spec).
- Cloud machines in `kunj ct list` (`machine` per container, `machines` for the rest), machine hooks, fleet listing tunnel time limit. Page updated: containers/cloud-machines.md.
- `kunj ct stop` suspends the branch's cloud machine (`?wait=0`), `--keep-awake`, `--no-wake`. Page updated: none (spec).
- `kunj machine prune` (src/lib/machines/prune.ts): gone branches, machines without a container, stale builders; sleeping machines are never woken. Page updated: containers/cloud-machines.md.
- `kunj events`: `type: 'machine'`; golden image `kunj.blueprint` label and the `image-stale` warning. Page updated: containers/cloud-machines.md.
- Machine-side idle timer (`kunj serve --idle-suspend`, `selfSuspendScript()`, passive requests). Page updated: containers/cloud-machines.md.
- `Ec2Provider` (AWS) behind the `MachineProvider` seam, `machine.ec2`. Page updated: containers/cloud-machines.md.
- Coordinator idle loop skips machines being created or woken; bootstrap checks the installed kunj for `--idle-suspend`. Page updated: none.
- Workspace app lists cloud machines (`Environment.machine`, a sleeping machine as a stopped container row). Page updated: containers/cloud-machines.md.
- Review fixes: EC2 filters as one JSON array, per-machine listing time limit, in-flight requests count for the idle timer, `ct stop` on a sleeping machine is a no-op. Page updated: none.
- Listings no longer count as use of a cloud machine (`x-kunj-passive` through the proxy). Page updated: none.
- `kunj machine setup`: Google Cloud project preparation in one command. Page updated: containers/cloud-machines.md.
- Branch commands find the branch's cloud machine without `--remote` when it has no local container. Page updated: none (spec).
- `kunj resources` and the workspace app's Resources window. Pages updated: containers/cloud-machines.md.
- `container.claude` copies the user's Claude skills, agents, commands and CLAUDE.md into containers; remote exec stdin no longer ends on an empty chunk. Page updated: containers/lifecycle.md.
- `container.files` is applied on every start; the short-lived `container.claude` setting is removed. Page updated: containers/lifecycle.md.
- Agent overview designed (plan steps per agent from hooks, `kunj agent plan`, Overview window); nothing built. Page updated: none (spec docs/specs/agent-overview.md).
- Agent plan, CLI side: plan hooks and record, `reducePlan()`, `kunj agent plan`, `kunj ct agent --plan`, `agent.plan`. Page updated: features/worktree-agents.md.
- Workspace app Overview window written (not built yet); a container's plan change in `kunj events` (`container` action `plan`). Pages updated: apps/workspace-app.md.
- `kunj agent overview`: the Overview's grouping, text and layout moved from the workspace app into the CLI (`AgentOverviewJson`). Pages updated: apps/workspace-app.md, features/worktree-agents.md.
- Review fixes on the agent plan: `plan` is its own event type, plan variables stay out of the tmux client's environment, no machine wake for `--plan`, records cleaned with their worktree. Page updated: features/worktree-agents.md.
- Overview window built and run on a Mac; background subagents found to have no task tools. Page updated: apps/workspace-app.md.
