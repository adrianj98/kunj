---
type: Secrets
title: Secret Manager
description: kunj's encrypted secret store - global, repo and branch scoped secrets delivered by explicit target to host commands, worktree files and branch containers.
resource: src/commands/secret.ts
tags: [secrets, vault, cli, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The secret manager stores secrets once, encrypted, and delivers each one only where its entry says.
It replaces hand-exported tokens (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) and plaintext `.env` keep files
(see [Keep Files](/features/keep-files.md)). Nothing is ever written into the repository.

The user surface is `kunj secret` (`src/commands/secret.ts`) and `kunj run` (`src/commands/run.ts`), both on the
[fast path](/architecture/fast-path.md) (`secret` and `run` entries in `src/commands/fast.ts`). The library is
`src/lib/secrets/`. Values come from a hidden prompt or stdin, never argv, and are printed only by `get` and
`env`, both of which refuse `--json`.

# Scopes and targets

| Scope | Stored in | Notes |
|-------|-----------|-------|
| global | `~/.kunj/secrets.enc` | Environment variables only (`--file` is refused; resolution strips `delivery.file`) |
| repo | `~/.kunj/<repo>/secrets.enc` | Default scope for writes |
| branch | same file as repo, `scope: { branch }` | `--branch [name]`; without a name, the current branch |

Each entry has explicit `targets` (`host`, `container`, or both; default both) and a `delivery`
(`env: boolean`, optional `file` relative to the worktree or `/workspace`). Nothing reaches a container
unless its targets include `container`. Resolution is global, then repo, then branch, most specific wins
by name ([Resolution and Delivery](/secrets/resolution-and-delivery.md)). The file format is in
[Vault](/secrets/vault.md); the key in [Key Providers](/secrets/key-providers.md).

# Commands

| Action | What it does |
|--------|--------------|
| `set NAME` | Store a value (hidden prompt in a TTY, else stdin with one trailing newline stripped) |
| `import <file>` | Parse a `.env` (`parseDotenv`); defaults: repo scope, both targets, env plus `file: .env`. Shows add/replace per name and asks once in a TTY (`--yes` skips); `--delete` removes the source and its keep copy |
| `list` | Names, scope, targets, delivery, `updatedAt`; never values. Default action |
| `get NAME` | One value on stdout: branch entry, then repo, then global; refused with `--json` |
| `rm NAME` | Remove from the scope given by `--global` / `--branch` |
| `env` | Resolved secrets as `export NAME='...'` lines for `eval` (`--target host` default, or `container`); refused with `--json` |
| `apply [-a] [--force]` | Render file deliveries into this worktree, or every non-bare worktree with its own branch; vaults opened once |

Options: `--branch [branch]`, `--global` (cannot combine with `--branch`), `--targets <list>`, `--file <path>`,
`--no-env` (needs `--file`), `--target`, `--yes`, `--delete`, `-a/--all`, `--force`.
`kunj run [--branch b] [--hold] -- <cmd...>` is covered in [kunj run](/secrets/kunj-run.md).

Writes go through `modify()`: a read-modify-write of one scope's file. Only when neither vault file exists
may a new key be made; a new file next to an existing one takes that file's kdf.

# JSON output

Types in `src/lib/json-types.ts` (see [JSON Contract](/architecture/json-contract.md)); none ever holds a value.

| Command | Type | Shape |
|---------|------|-------|
| `list --json` | `SecretListJson` | `{ secrets: [{ name, scope: 'global'\|'repo'\|'branch', branch?, targets, delivery, updatedAt }] }` |
| `set`/`rm --json` | `SecretWriteJson` | `{ success: true, name, scope, branch? }` |
| `import --json` | `SecretImportJson` | `{ imported: string[] }` |
| `apply --json` | `SecretApplyJson` | `{ applied: { <worktree path>: string[] } }` |

# Error codes

`SecretError` (`src/lib/secrets/errors.ts`) carries a string `jsonCode`, so `--json` prints
`{ error: { code, message } }`; `BaseCommand` prints it without a stack trace. Messages never contain a value.

| Code | When |
|------|------|
| `secrets-locked` | No key available, no terminal to prompt, wrong kdf for the provider, empty/cancelled passphrase, three wrong passphrases |
| `secrets-corrupt` | A file that is not a v1 envelope or does not decrypt; left untouched |
| `secret-not-found` | `get`/`rm` of a missing name |
| `bad-name` | Name not matching `[A-Za-z_][A-Za-z0-9_]*` |
| `not-ignored` | A rendered host file git does not ignore (without `--force`) |
| `bad-dotenv` | A malformed line in an imported `.env` (line number only, never text) |

Container delivery adds `ContainerError` `bad-path` for secret file paths (see [Resolution and Delivery](/secrets/resolution-and-delivery.md)).

# Unlocking rule

Only commands that deliver or manage secrets unlock, and only when a `secrets.enc` exists. Listings
(`worktree list`, `ct list`, `events`) never unlock; `ct list` compares a ciphertext stamp instead.

# Migration

`keptEnvImportCommand()` (in `secret.ts`) returns `kunj secret import ~/.kunj/<repo>/keep/.env --delete`
(path shell-quoted when needed) when the repo has a kept `.env`. `kunj secret list` (text, no `--global` or
`--branch`) prints it as `Found a kept .env: ...` when the repo has no repo or branch secrets.
`SetupCommand.offerSecretImport()` (`src/commands/setup.ts`) offers the import during
[kunj setup](/features/setup-and-install.md) when the repo has no `secrets.enc` (decided without unlocking);
declining prints the command, a failure is a warning.

# Module map

| File | Role |
|------|------|
| `src/lib/secrets/dotenv.ts` | `.env` parser, `isSecretName`, `NAME_PATTERN` |
| `src/lib/secrets/vault.ts` | Envelope encrypt/decrypt, `readVault`, `writeVault`, `vaultFiles`, `vaultKdf`, `vaultStamp` |
| `src/lib/secrets/errors.ts` | `SecretError`, `SecretErrorCode` |
| `src/lib/secrets/keyprovider.ts` | `getUnlock`, Keychain/libsecret/passphrase, `hiddenPrompt` |
| `src/lib/secrets/resolve.ts` | `resolveSecrets`, `envOf`, `loadSecrets`, `openVaults`, `configuredMode` |
| `src/lib/secrets/deliver.ts` | `renderFiles`, `writeHostFiles` |
| `src/lib/secrets/host.ts` | `hostSecrets`, `runAttached` |
| `src/settings/secrets.ts` | `secrets.keyProvider` setting |

# Tests

Unit tests use a fixed `KUNJ_SECRETS_KEY` or a fake `Runner`/prompt, never the real Keychain.
`src/lib/container/__tests__/integration.docker.test.ts` checks container delivery against Docker.
`test/functional/secrets.functional.test.ts` drives the built CLI with a throwaway HOME: the vault on disk
(0600, no plaintext), a wrong key, the outside-a-repository refusal, `kunj run`, `kunj agent --no-tmux` (under
`script` with stdin `/dev/null`: macOS `script` fails on a socket stdin), `worktree add` file delivery and
`not-ignored`, and `ct start` (env file, rendered file, no value in argv, labels or JSON, `secretsChanged`).
tmux sessions are left out there: a session's command gets the tmux server's environment, not the fixture's.

# Related Concepts

* [Vault](/secrets/vault.md)
* [Key Providers](/secrets/key-providers.md)
* [Resolution and Delivery](/secrets/resolution-and-delivery.md)
* [kunj run](/secrets/kunj-run.md)
* [Container Tokens](/containers/tokens.md) - the `gh auth token` fallback a stored `GH_TOKEN` overrides
* [Container Overview](/containers/overview.md)

# Citations

[1] [src/commands/secret.ts](/src/commands/secret.ts)
[2] [src/lib/secrets/errors.ts](/src/lib/secrets/errors.ts)
[3] [src/lib/json-types.ts](/src/lib/json-types.ts)
[4] [src/commands/setup.ts](/src/commands/setup.ts)
[5] [src/commands/fast.ts](/src/commands/fast.ts)
[6] [src/lib/command.ts](/src/lib/command.ts)
[7] [docs/specs/container-system.md](/docs/specs/container-system.md)
[8] [CLAUDE.md](/CLAUDE.md)
