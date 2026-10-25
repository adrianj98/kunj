---
type: Secrets
title: Secrets Vault
description: The encrypted secrets.enc files - an AES-256-GCM JSON envelope holding secret entries - and the .env parser used to import them.
resource: src/lib/secrets/vault.ts
tags: [secrets, vault, crypto, dotenv]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A vault file is a JSON envelope around AES-256-GCM ciphertext, written with Node's `crypto` (no extra
dependency). There are two: `~/.kunj/secrets.enc` (global) and `~/.kunj/<repo>/secrets.enc` (repo and branch
entries), located by `vaultFiles(kunjDir, globalDir)`. Secret names are inside the ciphertext, so the file
reveals nothing but its size.

`vault.ts` never decides where a key comes from: callers pass an `Unlock` built by
[Key Providers](/secrets/key-providers.md). `dotenv.ts` parses `.env` files for `kunj secret import`
([Secret Manager](/secrets/overview.md)).

# Envelope

```json
{ "version": 1, "kdf": "keychain", "salt": "<b64 16 bytes>", "iv": "<b64 12 bytes>",
  "ciphertext": "<b64>", "tag": "<b64 16 bytes>" }
```

- `kdf` is `keychain` (raw 32-byte key, salt unused) or `passphrase` (scrypt over the salt).
- AAD is `kunj-secrets:1:<kdf>:<salt>`, so editing `version`, `kdf` or `salt` fails like a flipped byte.
- `isEnvelope()` checks the version, kdf and base64 field lengths; anything else is `secrets-corrupt`.

# Entry

```ts
interface SecretEntry {
  name: string;                         // [A-Za-z_][A-Za-z0-9_]*
  value: string;
  scope?: { branch?: string };          // absent: repo (or global) scope
  targets: Array<'host' | 'container'>;
  delivery: { env: boolean; file?: string };
  updatedAt: string;                    // ISO time
}
```

The decrypted plaintext is a JSON array of entries; `isEntry()` validates each, and anything else is
`secrets-corrupt`. `kunj secret` writes them sorted by name, the repo entry before branch ones.

# Functions

| Function | Behaviour |
|----------|-----------|
| `readVault(file, unlock)` | `[]` when the file is missing; checks the kdf matches `unlock.kdf` (else `secrets-locked`); decrypts |
| `writeVault(file, entries, unlock)` | Validates names (`bad-name`); keeps an existing file's salt and kdf; decrypts the existing file first and refuses to replace one that does not open; new salt (16 random bytes) for a new file; fresh 12-byte IV every write |
| `vaultKdf(file)` | The kdf read without a key; `undefined` when missing |
| `vaultStamp(files)` | First 12 hex chars of sha256 over each file's bytes, prefixed with `<index>:<length>:`; `''` when none exists |
| `vaultFiles(kunjDir, globalDir)` | `{ global, repo }` paths |

Writes are atomic: `mkdir -p` (mode 0700), write `<file>.tmp-<pid>` with mode 0600 and flag `wx`, rename.
The temp file is removed on failure.

# Decryption and retries

`openEnvelope()` calls `unlock.keyFor(salt, attempt)` up to `unlock.attempts` times (default 1; the
passphrase provider uses 3). A GCM failure with one attempt is `secrets-corrupt` ("wrong key, or the file was
modified"); after several attempts it is `secrets-locked`. A key that is not a 32-byte Buffer is
`secrets-locked`. In every failure the file is left as it was.

# The stamp

`vaultStamp` is what a branch container records as the `kunj.secrets` label at creation, and what
`kunj ct list --json` recomputes to set `secretsChanged`, all without unlocking. Any write to either vault
marks every container of the repo: coarse, but it reveals nothing. See
[Resolution and Delivery](/secrets/resolution-and-delivery.md) and [Naming and Labels](/containers/naming-and-labels.md).

# .env parser

`parseDotenv(text)` returns `[{ name, value }]` in first-seen order; the last duplicate value wins.

| Syntax | Handling |
|--------|----------|
| `KEY=value`, `export KEY=value` | Spaces around `=` allowed; unquoted value trimmed, ends at whitespace + `#` |
| `'...'` | Literal, may span lines |
| `"..."` | `\n`, `\"`, `\\` escapes; any other backslash kept; may span lines |
| After a closing quote | Only whitespace or a comment, else an error |
| `#` lines, blank lines | Skipped; CRLF normalised to LF |
| `${X}` | Never expanded |

Errors are `line <n>: <reason>` naming the line the entry starts on and never quoting the text; `kunj secret
import` wraps them as `bad-dotenv`. `isSecretName()` / `NAME_PATTERN` is the shared name check.

# Related Concepts

* [Secret Manager](/secrets/overview.md)
* [Key Providers](/secrets/key-providers.md) - where `Unlock` comes from
* [Resolution and Delivery](/secrets/resolution-and-delivery.md) - `renderFiles` writes `NAME="value"` lines `parseDotenv` reads back

# Citations

[1] [src/lib/secrets/vault.ts](/src/lib/secrets/vault.ts)
[2] [src/lib/secrets/dotenv.ts](/src/lib/secrets/dotenv.ts)
[3] [src/lib/secrets/errors.ts](/src/lib/secrets/errors.ts)
[4] [src/commands/secret.ts](/src/commands/secret.ts)
[5] [docs/specs/container-system.md](/docs/specs/container-system.md)
