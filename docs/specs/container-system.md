# Kunj container system

*Umbrella for `kunj ct`. Checked against `main` on 2026-10-23. The design of each part is in its own
spec; this file says what exists, where the code is and what comes next.*

## What it is

`kunj container` (alias `kunj ct`) runs a branch in its own Docker container with its own clone of the
repo, the way `kunj worktree` gives a branch its own directory. The main use is a sandbox for an AI
agent running with permissions skipped: it cannot touch the host's files, the host's `.git`, or other
branches' containers. The same container serves a shell, an attached editor and the app's dev server.

*Drawing: CLI → `ContainerBackend` → Docker; per branch a container, its network helper, its sidecar
services and its own network; code moves only through origin (and, for snapshots, a git bundle made on
the host).*

## Status

| Feature | Status | Spec |
| --- | --- | --- |
| Sandbox containers: start, shell, exec, agent, attach, forward, list, stop, remove | Shipped | [branch-containers.md](branch-containers.md) |
| Network helper and firewall (default and allowlist modes, IPv6) | Shipped | [branch-containers.md](branch-containers.md) |
| Credentials by name, credential helper scoped to origin, hooks | Shipped | [branch-containers.md](branch-containers.md) |
| Default zsh config and `KUNJ_*` env | Shipped | [branch-containers.md](branch-containers.md) |
| Blueprints and snapshots, including private origins | Shipped | [blueprints.md](blueprints.md) |
| Sidecar services, `ct open`, `forward --auto`, `ct prune`, Docker-in-Docker | Shipped | [container-phase-2.md](container-phase-2.md) |
| `kunj ct file read\|write` (workspace files for the IDE) | Shipped | [workspace-ide.md](workspace-ide.md) |
| Host MCP bridge (a browser on the Mac for the agent) | Shipped | [container-phase-2.md](container-phase-2.md) |
| Workspace IDE (phase 3) | CLI contract shipped; app proposed | [workspace-ide.md](workspace-ide.md) |
| Containers in the VS Code extension and the macOS app | In progress | [containers-in-apps.md](containers-in-apps.md) |
| Remote Docker host (`kunj serve`) | Not started | — |
| Secret manager (`kunj secret`, `kunj run`, delivery to containers and worktrees) | Shipped | [Secrets](#secrets) below |

## Rules every part follows

These are stated in full in [branch-containers.md](branch-containers.md); they are the invariants a
change must not break.

- Only `docker.ts` spawns `docker`; everything else programs against `ContainerBackend`.
- No host bind mounts; files are tar-streamed through `docker exec`.
- Secrets only in the `docker run` env file; never `docker exec -e`, never labels, never a snapshot.
- Docker labels (`kunj.*`) are the only state; reuse requires an exact label match.
- Nothing runs in the branch container before the network helper reports `/tmp/kunj-ready`; the branch
  container never gets `NET_ADMIN` or `NET_RAW`; port forwards exec in the helper, not the container.
- `container`/`ct` is on the fast path: light top-level imports, inquirer lazy, no AWS or LangChain.
- `kunj ct --json` errors are always `{ "error": { "code", "message" } }`; `list --json` changes are additive.

## Code map

| File | Role |
| --- | --- |
| `src/commands/container.ts` | The command |
| `src/lib/container/backend.ts`, `docker.ts` | Backend interface; the Docker CLI implementation |
| `src/lib/container/lifecycle.ts` | Start, resume, rollback, stop, remove guard, status |
| `src/lib/container/names.ts`, `env.ts`, `defaults.ts`, `errors.ts`, `seed.ts`, `forward.ts` | Names and labels, env, defaults, errors, seed, forwarding |
| `src/lib/container/image.ts`, `devcontainer.ts` | Image choice and builds |
| `src/lib/container/blueprint.ts`, `presets.ts`, `infer.ts`, `provision.ts`, `snapshot.ts` | Blueprints |
| `src/lib/container/services.ts`, `editor.ts`, `autoforward.ts`, `prune.ts`, `dind.ts` | Phase 2 |
| `src/lib/container/files.ts` | `kunj ct file` |
| `src/container/sandbox/`, `sandbox-dind/`, `nethelper/`, `presets/` | Image build contexts, firewall, preset scripts (copied to `dist/container`) |
| `src/settings/container.ts` | Settings |
| `src/lib/json-types.ts` | Published JSON shapes (`ContainerListJson`, `FileReadJson`, …) |

**Tests.** `npm test` runs the unit tests against `FakeBackend`. `npm run test:docker`
(`*.docker.test.ts`) drives a real Docker daemon, builds the images and checks the firewall; it skips
itself when Docker is unavailable.

## Secrets

*Designed 2026-10-23; shipped 2026-10-24.* Plan: docs/superpowers/plans/2026-10-23-secret-manager.md
(its rulings are written into Storage and Delivery below). Built so far: the `.env` parser
(`src/lib/secrets/dotenv.ts`, c2a722f), the vault (`src/lib/secrets/vault.ts`, `errors.ts`, 1429ed9) and the key providers (`src/lib/secrets/keyprovider.ts`, `secrets.keyProvider`, 8901b6b) and resolution with host file rendering (`src/lib/secrets/resolve.ts`, `deliver.ts`, 009958c and its review fix) and `kunj secret` (`src/commands/secret.ts`, 6c08cd1 and its review fix) and host delivery (`kunj run`, `kunj agent` and `kunj worktree shell` under `kunj run`, file deliveries on `worktree add`; `src/commands/run.ts`, `src/lib/secrets/host.ts`, 4a15833 and its review fix) and container delivery (`StartOptions.secrets` in `src/lib/container/lifecycle.ts`, the `kunj.secrets` label, `secretsChanged` in `kunj ct list --json`, 8fd3733 and its review fix in 20c95f9) and the migration hint, the `kunj setup` offer and the user docs (`docs-site/src/content/docs/configuration/secrets.mdx`, Task 8, 3bbe9af and its review fix) and the workspace app's Settings › Containers (where the GitHub token comes from, the `container.useGhToken` toggle, the Claude Code token set up with `claude setup-token` then `kunj secret set CLAUDE_CODE_OAUTH_TOKEN --global --targets container` in an action tab, and removed with `kunj secret rm`). Before it, secrets reached a container only as host environment variables
named in `container.env` (or literal `NAME=value` entries in the config), and `.env` files travelled as
plaintext keep files in `~/.kunj/<repo>/keep/`. That meant exporting tokens by hand in every shell, a
desktop app launched from Finder that sees none of them, and app secrets in plaintext. The secret
manager stores secrets once, encrypted, and kunj delivers each one only where it was told to.

**Goals.** No more hand-exported tokens (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, API keys). Per-repo and
per-branch app secrets (`DATABASE_URL`, payment keys) replacing plaintext `.env` keep files. Import of
existing `.env` files. **Non-goals for v1:** sharing with a team, SOPS or committed secret files (some
repos cannot hold them), external vaults (1Password, AWS Secrets Manager), short-lived or per-container
tokens. Nothing is ever written into the repository.

Shipped before the vault: with no `GH_TOKEN`/`GITHUB_TOKEN`/`GITLAB_TOKEN` in the host env, a GitHub origin's container gets `gh auth token --hostname <host>` as `GH_TOKEN` (`container.useGhToken`, default true; `kunj ct token status`).

### Storage

- `~/.kunj/secrets.enc` holds global secrets; `~/.kunj/<repo>/secrets.enc` holds the repo's, including
  branch-scoped ones. Each is a JSON envelope `{ version: 1, kdf: "keychain" | "passphrase", salt, iv,
  ciphertext, tag }`, AES-256-GCM with Node's `crypto` (no new dependency), written atomically with mode
  0600. Names are inside the ciphertext, so the file reveals nothing. `version`, `kdf` and `salt` are
  bound as GCM additional data (`kunj-secrets:1:<kdf>:<salt>`), so editing them fails like a flipped
  byte. A write keeps an existing file's salt and kdf, refuses (`secrets-locked`) a key provider of
  another kdf, and never replaces a file that does not parse or does not decrypt with its key (`secrets-corrupt`,
  the file left byte-identical).
- A decrypted entry:

  ```json
  { "name": "DATABASE_URL", "value": "postgres://…", "scope": { "branch": "feature/x" },
    "targets": ["host", "container"], "delivery": { "env": true, "file": ".env" },
    "updatedAt": "2026-10-23T…" }
  ```

  `scope.branch` is optional; a branch entry overrides the repo entry of the same name for that branch.
  `targets` is required and explicit: `host`, `container` or both. Nothing reaches a container unless
  its secret says `container`. `delivery.env` injects it as an environment variable; `delivery.file`
  renders it as a `NAME=value` line into that file (relative to the worktree or container root; several
  secrets may share one file). Global secrets are environment variables only.
- Resolution for a branch: global, then repo, then branch; the most specific wins.
- **Key.** A random 32-byte key (64 hex chars) in the macOS Keychain (generic password, service
  `kunj-secrets`, account `kunj`, created on first use, read once per command with
  `security find-generic-password -s kunj-secrets -a kunj -w`), or libsecret `secret-tool` (attribute
  `service kunj-secrets`) on Linux. The key never goes in argv when it is stored: `security -i` reads the
  `add-generic-password` command from stdin, and `secret-tool store` reads the secret from stdin.
  Without either: the `passphrase` kdf, `scrypt(passphrase, salt, 32, N=2^15, r=8, p=1)` with a 16-byte
  random salt per file, prompted once per command (a new vault asks twice to confirm; a file that does not
  decrypt asks again, and after three tries it is `secrets-locked`, the file untouched; an empty passphrase,
  Ctrl-C or end of input at the hidden prompt is `secrets-locked`). `KUNJ_SECRETS_KEY` (64 hex chars) supplies the raw key
  for CI and scripts and overrides the keychain; it opens `keychain`-kdf files only. A new key is
  made only when no vault file exists yet: a keychain-kdf file whose item is missing stays `secrets-locked`, and a
  read that fails for any reason other than "not found" (access denied, locked keychain) never makes a new
  key; the item is added without `-U` and read back before use. The setting
  `secrets.keyProvider` (`auto|keychain|libsecret|passphrase`, default `auto`) picks the provider
  for a new vault (`auto`: Keychain on macOS, else libsecret, else the passphrase when `secret-tool` is not
  installed); an existing file's kdf decides how it is opened, and a new repo vault next to an existing global
  one takes that file's kdf and key (a global and a repo file of different kdfs are opened with one key each).
  The vault is only unlocked by commands that deliver or manage secrets, and only when a `secrets.enc`
  exists, never by listings (`worktree list`, `ct list`, `events`), so the fast path does not change.
- **Stamp.** A container records the label `kunj.secrets`: the first 12 hex chars of the sha256 of the
  global and repo `secrets.enc` bytes (ciphertext only, `''` when neither exists; each file's bytes are
  prefixed with its position and length, so the same bytes in the other file give another stamp). `ct list` recomputes it
  from the files without unlocking and compares. Any write to the vault marks every container of the
  repo, which is coarse but reveals nothing.

### Commands

| Command | What it does |
| --- | --- |
| `kunj secret set NAME [--branch b] [--global] [--targets host,container] [--file .env] [--no-env]` | Value from a hidden prompt, or stdin when piped; never argv (visible in `ps` and shell history) |
| `kunj secret import <file> [--branch b] [--global] [--targets …] [--file …] [--delete] [--yes]` | Import a `.env` file (see below) |
| `kunj secret list [--branch b] [--global] [--json]` | Names, scope, targets, delivery; never values. Every scope by default; `--global` only the global store, `--branch` only that branch's entries |
| `kunj secret get NAME [--branch b]` | One value on stdout for scripts; refused with `--json` |
| `kunj secret rm NAME [--branch b] [--global]` | Remove one |
| `kunj secret env [--branch b] [--target host]` | Resolved secrets as `export NAME='…'` lines for `eval`; refused with `--json` |
| `kunj secret apply [-a] [--force]` | Render file deliveries into this worktree (or all, each with its own branch), like `keep apply`; the vault is opened once |
| `kunj run [--branch b] [--hold] -- <cmd…>` | Run a host command with the host secrets in its environment, file deliveries rendered first |

`secret` and `run` are on the fast path (no AWS, LangChain or inquirer at top level). Writes (`set`,
`import`, `rm`) go to repo scope unless `--global` or `--branch` is given (`--branch` without a name is the
current branch); reads (`get`, `env`, `apply`) resolve with the current branch unless `--branch` names
another. `--json` output of `set`, `rm`, `import` and `apply` is `SecretWriteJson`, `SecretImportJson` and
`SecretApplyJson` (json-types.ts); none holds a value.

**`.env` import.** Standard dotenv syntax: `KEY=value`, single and double quotes, `export KEY=`,
comments, blank lines, multi-line values in quotes (double: `\n`, `\"`, `\\` escapes, any other
backslash kept as written; single: literal); no `${X}` expansion (stored literally). Spaces around `=`
are allowed, an unquoted value ends at ` #`, text after a closing quote other than a comment is an
error, and the last of duplicate names wins. A malformed line fails the whole import with `bad-dotenv`
naming the file and the line the entry starts on; the message never quotes the file's text, which may
be a value.
Defaults: repo scope, `targets: host,container`, env plus `file: .env` (so the worktree gets its `.env`
back). In a terminal it shows the names it will add or replace, never values, and asks once (`--yes`
skips; `--json` prints the names). `--delete` removes the source afterwards (a symlink is removed itself, never the file it points to); when the source is,
or links to, a keep file it is removed from the keep store too, as is the keep copy at the source's path in the worktree.

### Delivery

- **Containers** (`kunj ct start`, on create and resume): container-targeted `env` secrets join the
  existing `docker run` env file, so the container rules hold (never `docker exec -e`, never a label,
  never a snapshot; snapshot builds get no secrets). A stored secret overrides a `container.env` entry
  of the same name, and a stored `GH_TOKEN` (or `CLAUDE_CODE_OAUTH_TOKEN`) wins over the `gh auth token`
  fallback, which is then not asked. An env value with a newline is refused before anything is created
  (the env file is line based; deliver it as a file). `file` deliveries render into `/workspace/<file>`
  as the sandbox user, mode 0600, through the tar stream, after the seed and after `/<file>` (anchored,
  gitignore-escaped) is added to `.git/info/exclude` so the agent cannot commit them; a path outside
  `/workspace`, with a `.git` component or with a control character (which would split the exclude line) is refused (`bad-path`) before anything is created. `docker start` keeps the environment
  of `docker run`, and the env file is the only allowed channel, so a changed `env` secret reaches a
  container only when it is recreated (`ct start --rebuild`); `start` and resume re-render `file`
  deliveries (also on a running container), and the start output hints at `--rebuild` when the stamp
  differs and the branch has container env secrets. `ct list --json` shows `secretsChanged` for this
  repository's containers: `true` while the label (absent counts as `''`) differs from the stamp.
  `kunj ct start` loads and checks the secrets (`checkSecrets()`: a locked vault, a multi-line env value
  or a bad file path fails it) before the create hook, the snapshot and anything created; `kunj ct open` loads them only when it resumes; `kunj ct agent` never starts a
  container and loads none.
  `docker inspect` shows env-file variables in `Config.Env`, as it does for forwarded tokens today, so
  "not in `docker inspect`" means not in a label and not for host-only secrets; anyone who can run
  `docker inspect` already has root on the daemon.
- **Host:** `kunj agent`, `kunj run` and the workspace app's worktree terminals get host-targeted `env`
  secrets, never through argv. `kunj agent` runs the tmux command as
  `<node> <kunj> run --hold --branch <b> -- <shell> -lc <agent.command>` (an argv array, no shell
  quoting), so the vault is unlocked inside the
  session (not through `new-session -e`, which would put values in argv; `KUNJ_*` stay there); without
  tmux it does the same in-process. `kunj worktree shell` (how the workspace app opens worktree
  terminals, with `--session <id>` in tmux) does the same with `<shell> -l`: under `kunj run` in tmux,
  in-process without. `kunj run` resolves with `--branch` or the branch checked out where it runs,
  renders file deliveries into that worktree first, and exits with the command's code (a signal: 128 +
  its number; not found: 127). A vault that cannot be unlocked fails `run` (and so `agent` and
  `worktree shell`) before the command starts; with `--hold`, which the tmux sessions pass, `run`
  prints the error and waits for Enter first, because the pane (and the message) would otherwise close
  at once, leaving only tmux's `[exited]`. A file it cannot render is a warning and the command
  still runs. `file` deliveries render into the worktree when `kunj worktree add` creates it (after
  keep files; every failure there, a locked vault included, is a warning, as for keep files, and
  `worktree add --json` lists `secretFiles`) and on `kunj secret apply`. A rendered file that git does not ignore (`git check-ignore`; a tracked file counts as not ignored) is refused unless `--force`, before any file is written; paths outside the worktree, also through a symlinked directory (checked for every file before any file or directory is created), and paths inside a `.git` directory (which `check-ignore` can report as ignored) are refused even with `--force`, and a symlink at the file's path is replaced, not written through. Rendered lines are `NAME="value"` sorted by name, with `\\`, `"` and newlines escaped (a raw CR does not survive the round trip).
- **The workspace app** never reads the vault; it runs kunj commands, which unlock through the keychain,
  so an app launched from Finder works without shell variables.

### Errors, migration, testing

- **Errors** (`jsonCode`, opt-in shape): `secrets-locked` (no key and no terminal to prompt),
  `secrets-corrupt` (authentication tag fails; the file is left untouched and named in the message),
  `secret-not-found`, `bad-name` (names must match `[A-Za-z_][A-Za-z0-9_]*`), `not-ignored`,
  `bad-dotenv` (a malformed line in an imported `.env`). A wrong
  passphrase is `secrets-locked` after three tries.
- **Migration:** nothing changes for existing users. `container.env` and keep files keep working. When a
  repo has a keep `.env` and no secrets of its own (none at repo or branch scope; global ones do not
  count), `kunj secret list` (text output, not narrowed by `--global`/`--branch`) prints
  `Found a kept .env: kunj secret import ~/.kunj/<repo>/keep/.env --delete` (a path the shell would
  split, such as a repo directory with a space, is single-quoted after `~/`, so the line pastes);
  `--json` stays a bare `SecretListJson`. `kunj setup` offers the same import when the repo has no `secrets.enc` (decided
  without unlocking); declining prints the command, and a failed import is a warning.
- **Tests:** crypto round trip and tamper detection; dotenv parser table (quotes, `export`, multi-line,
  comments, `${X}` literal); resolution order; target filtering (a host-only secret never reaches the
  container env file); rendering, mode 0600, `.git/info/exclude`; the not-ignored refusal; a fake key
  provider so tests never touch the real Keychain. Docker test: a container-targeted secret is visible
  in the container, a host-only one is not and appears nowhere in `docker inspect`, no label holds a
  value, and a snapshot image's `Config.Env` holds neither.

**Code map:** built: `src/lib/secrets/{dotenv,vault,errors,keyprovider,resolve,deliver}.ts`, `secrets.*` settings in
`src/settings/secrets.ts`, `src/commands/secret.ts` with `SecretListJson` (and the write/import/apply
shapes) in `src/lib/json-types.ts`, `src/commands/run.ts` with `src/lib/secrets/host.ts` (`hostSecrets`,
`runAttached`), `kunjSelf`/`hostRunArgv`/`hostSecretEnv` in `src/lib/agent-session.ts` and `kunjEntry` in
`src/lib/self.ts`, container delivery in `src/lib/container/lifecycle.ts` (`StartOptions.secrets`,
`checkSecrets`, `secretFilePath`, `renderSecretFiles`, `secretsRebuildHint`), `LABEL.secrets` in `names.ts` and
`containerSecrets()`/`secretsChanged` in `src/commands/container.ts`, the migration hint
(`keptEnvImportCommand()`) in `src/commands/secret.ts` and `offerSecretImport()` in `src/commands/setup.ts`.
User docs: `docs-site/src/content/docs/configuration/secrets.mdx`. App: `ContainerTokens.swift` (Core: the JSON
mirrors, the summaries and `claudeTokenSetupSpec`) and the Containers section of `SettingsWindow`.

## Roadmap

**Phase 2:** done.

**Next:**

- [x] **Secret manager** ([Secrets](#secrets)): `kunj secret set|import|list|get|rm|env|apply`,
  `kunj run`, encrypted vault with a Keychain key, delivery to containers and worktrees by explicit
  target, `.env` import. Shipped; plan `docs/superpowers/plans/2026-10-23-secret-manager.md`.
- Copy the safe parts of `~/.claude` (CLAUDE.md, settings, skills, agents, commands) into containers;
  never session history or credentials.
- Run `kunj` itself inside the container, with the user's kunj config minus sensitive settings.
- Extra repos cloned next to the workspace (driveday's `../ideazone`).
- Containers in the VS Code extension and the macOS app, reading `kunj ct list --json`.
- Phase 3, the workspace IDE: [workspace-ide.md](workspace-ide.md).

**Later (remote):** `container.dockerContext` over SSH validated end to end; then `kunj serve`, an
authenticated HTTP and WebSocket API exposing `ContainerBackend`, and a `RemoteKunjBackend`. Because
every Docker interaction is a stream through the backend and origin is the only git channel, it needs no
new git or file transfer design: `forward` tunnels over the service's WebSocket instead of
`docker exec`, and editor attach goes through Remote-SSH (`features.editorAttach` false until then).
Auth, TLS and multi-user get their own spec.

## Decisions

- **2026-10-21** Containers are independent of worktrees: a branch may have either, both or neither.
- **2026-10-21** The remote backend is a later addition, not a redesign: no shared filesystem assumed.
- **2026-10-23** Phase order: phase 2 (services, editor, auto forward, prune, Docker-in-Docker, MCP
  bridge) before the workspace IDE; `forward --auto` moved from the UI phase into phase 2.
- **2026-10-23** Secrets: a local encrypted vault in `~/.kunj` (AES-256-GCM, key in the OS keychain),
  explicit targets per secret, delivery by env or rendered file, `.env` import. No SOPS or committed
  secret files (some repos cannot hold them); no team sharing or external vaults in v1.
