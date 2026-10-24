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
| Secret manager (`kunj secret`, `kunj run`, delivery to containers and worktrees) | Designed, not started | [Secrets](#secrets) below |

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

*Designed 2026-10-23; in progress.* Plan: docs/superpowers/plans/2026-10-23-secret-manager.md
(its rulings are written into Storage and Delivery below). Built so far: the `.env` parser
(`src/lib/secrets/dotenv.ts`, c2a722f); the vault, key providers, commands and delivery are not. Today secrets reach a container only as host environment variables
named in `container.env` (or literal `NAME=value` entries in the config), and `.env` files travel as
plaintext keep files in `~/.kunj/<repo>/keep/`. That means exporting tokens by hand in every shell, a
desktop app launched from Finder that sees none of them, and app secrets in plaintext. The secret
manager stores secrets once, encrypted, and kunj delivers each one only where it was told to.

**Goals.** No more hand-exported tokens (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, API keys). Per-repo and
per-branch app secrets (`DATABASE_URL`, payment keys) replacing plaintext `.env` keep files. Import of
existing `.env` files. **Non-goals for v1:** sharing with a team, SOPS or committed secret files (some
repos cannot hold them), external vaults (1Password, AWS Secrets Manager), short-lived or per-container
tokens. Nothing is ever written into the repository.

### Storage

- `~/.kunj/secrets.enc` holds global secrets; `~/.kunj/<repo>/secrets.enc` holds the repo's, including
  branch-scoped ones. Each is a JSON envelope `{ version: 1, kdf: "keychain" | "passphrase", salt, iv,
  ciphertext, tag }`, AES-256-GCM with Node's `crypto` (no new dependency), written atomically with mode
  0600. Names are inside the ciphertext, so the file reveals nothing.
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
  random salt per file, prompted once per command. `KUNJ_SECRETS_KEY` (64 hex chars) supplies the raw key
  for CI and scripts and overrides the keychain; it opens `keychain`-kdf files only. The setting
  `secrets.keyProvider` (`auto|keychain|libsecret|passphrase`, default `auto`) picks the provider.
  The vault is only unlocked by commands that deliver or manage secrets, and only when a `secrets.enc`
  exists, never by listings (`worktree list`, `ct list`, `events`), so the fast path does not change.
- **Stamp.** A container records the label `kunj.secrets`: the first 12 hex chars of the sha256 of the
  global and repo `secrets.enc` bytes (ciphertext only, `''` when neither exists). `ct list` recomputes it
  from the files without unlocking and compares. Any write to the vault marks every container of the
  repo, which is coarse but reveals nothing.

### Commands

| Command | What it does |
| --- | --- |
| `kunj secret set NAME [--branch b] [--global] [--targets host,container] [--file .env] [--no-env]` | Value from a hidden prompt, or stdin when piped; never argv (visible in `ps` and shell history) |
| `kunj secret import <file> [--branch b] [--global] [--targets …] [--file …] [--delete] [--yes]` | Import a `.env` file (see below) |
| `kunj secret list [--branch b] [--global] [--json]` | Names, scope, targets, delivery; never values |
| `kunj secret get NAME [--branch b]` | One value on stdout for scripts; refused with `--json` |
| `kunj secret rm NAME [--branch b] [--global]` | Remove one |
| `kunj secret env [--branch b] [--target host]` | Resolved secrets as `export NAME='…'` lines for `eval` |
| `kunj secret apply [-a]` | Render file deliveries into this worktree (or all), like `keep apply` |
| `kunj run [--branch b] -- <cmd…>` | Run a host command with the host secrets in its environment, file deliveries rendered first |

`secret` and `run` are on the fast path (no AWS, LangChain or inquirer at top level). The branch
defaults to the current one.

**`.env` import.** Standard dotenv syntax: `KEY=value`, single and double quotes, `export KEY=`,
comments, blank lines, multi-line values in quotes (double: `\n`, `\"`, `\\` escapes, any other
backslash kept as written; single: literal); no `${X}` expansion (stored literally). Spaces around `=`
are allowed, an unquoted value ends at ` #`, text after a closing quote other than a comment is an
error, and the last of duplicate names wins. A malformed line fails the whole import with `bad-dotenv`
naming the file and the line the entry starts on; the message never quotes the file's text, which may
be a value.
Defaults: repo scope, `targets: host,container`, env plus `file: .env` (so the worktree gets its `.env`
back). In a terminal it shows the names it will add or replace, never values, and asks once (`--yes`
skips; `--json` prints the names). `--delete` removes the source afterwards; when the source is a keep
file it is removed from the keep store too.

### Delivery

- **Containers** (`kunj ct start`, on create and resume): container-targeted `env` secrets join the
  existing `docker run` env file, so the container rules hold (never `docker exec -e`, never a label,
  never a snapshot; snapshot builds get no secrets). A stored secret overrides a `container.env` entry
  of the same name. `file` deliveries render into `/workspace/<file>` as the sandbox user, mode 0600,
  added to `.git/info/exclude` so the agent cannot commit them. `docker start` keeps the environment
  of `docker run`, and the env file is the only allowed channel, so a changed `env` secret reaches a
  container only when it is recreated (`ct start --rebuild`); `start` and resume re-render `file`
  deliveries, and the start output hints at `--rebuild` when the stamp differs and the container has
  env secrets. `ct list --json` shows `secretsChanged: true` while the label differs from the stamp.
  `docker inspect` shows env-file variables in `Config.Env`, as it does for forwarded tokens today, so
  "not in `docker inspect`" means not in a label and not for host-only secrets; anyone who can run
  `docker inspect` already has root on the daemon.
- **Host:** `kunj agent`, `kunj run` and the workspace app's worktree terminals get host-targeted `env`
  secrets, never through argv. `kunj agent` runs the tmux command as
  `<node> <kunj> run --branch <b> -- <shell> -lc <agent.command>`, so the vault is unlocked inside the
  session (not through `new-session -e`, which would put values in argv; `KUNJ_*` stay there); without
  tmux it does the same in-process. The workspace app opens worktree terminals with
  `kunj run -- $SHELL -l`. `file` deliveries render into the
  worktree when `kunj worktree add` creates it (where keep files apply today) and on
  `kunj secret apply`. A rendered file that git does not ignore is refused unless `--force`.
- **The workspace app** never reads the vault; it runs kunj commands, which unlock through the keychain,
  so an app launched from Finder works without shell variables.

### Errors, migration, testing

- **Errors** (`jsonCode`, opt-in shape): `secrets-locked` (no key and no terminal to prompt),
  `secrets-corrupt` (authentication tag fails; the file is left untouched and named in the message),
  `secret-not-found`, `bad-name` (names must match `[A-Za-z_][A-Za-z0-9_]*`), `not-ignored`,
  `bad-dotenv` (a malformed line in an imported `.env`). A wrong
  passphrase is `secrets-locked` after three tries.
- **Migration:** nothing changes for existing users. `container.env` and keep files keep working; when a
  repo has a keep `.env` and no secrets, `kunj secret import` suggests it, and `kunj setup` offers it.
- **Tests:** crypto round trip and tamper detection; dotenv parser table (quotes, `export`, multi-line,
  comments, `${X}` literal); resolution order; target filtering (a host-only secret never reaches the
  container env file); rendering, mode 0600, `.git/info/exclude`; the not-ignored refusal; a fake key
  provider so tests never touch the real Keychain. Docker test: a container-targeted secret is visible
  in the container, a host-only one is not and appears nowhere in `docker inspect`, no label holds a
  value, and a snapshot image's `Config.Env` holds neither.

**Code map:** built: `src/lib/secrets/dotenv.ts`. Planned: `src/lib/secrets/{vault,keyprovider,resolve,deliver,errors}.ts`,
`src/commands/secret.ts`, `src/commands/run.ts`, `secrets.*` settings in `src/settings/secrets.ts`,
`SecretListJson` in `src/lib/json-types.ts`; container delivery hooks into `src/lib/container/env.ts`
and `lifecycle.ts`.

## Roadmap

**Phase 2:** done.

**Next:**

- [ ] **Secret manager** ([Secrets](#secrets)): `kunj secret set|import|list|get|rm|env|apply`,
  `kunj run`, encrypted vault with a Keychain key, delivery to containers and worktrees by explicit
  target, `.env` import. Needs an implementation plan.
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
