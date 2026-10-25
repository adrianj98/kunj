---
type: Secrets
title: Secret Key Providers
description: Where the vault key comes from - KUNJ_SECRETS_KEY, the macOS Keychain, libsecret or an scrypt passphrase - chosen by secrets.keyProvider and the existing file's kdf.
resource: src/lib/secrets/keyprovider.ts
tags: [secrets, keychain, libsecret, passphrase, crypto]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`getUnlock(opts)` in `src/lib/secrets/keyprovider.ts` returns the `Unlock` object
(`{ kdf, attempts?, keyFor(salt, attempt) }`) that [Vault](/secrets/vault.md) uses to open and write
`secrets.enc`. A key or value is never placed in argv: the Keychain item is written by piping the command into
`security -i`, and `secret-tool store` reads the key from stdin.

All external calls go through a `Runner` (`defaultRunner` spawns with stderr ignored and maps ENOENT to exit
127). Tests inject `run` and `prompt`, or set `KUNJ_SECRETS_KEY`, so they never touch a real keychain or terminal.

# Setting

| Key | Default | Values |
|-----|---------|--------|
| `secrets.keyProvider` | `auto` | `auto`, `keychain`, `libsecret`, `passphrase` |

Registered in `src/settings/secrets.ts` (category `secrets`; see [Settings Registry](/architecture/settings-registry.md)).
It picks the provider for a new vault only. `configuredMode()` in `resolve.ts` reads it from the resolved
config and treats unknown values as `auto`.

# Decision order

```
existingKdf == passphrase            -> passphrase unlock (whatever the setting)
wantsKeychainKdf = existingKdf == keychain || mode != passphrase
KUNJ_SECRETS_KEY set && wantsKeychainKdf
                                     -> raw key (must be 64 hex chars, else secrets-locked)
!wantsKeychainKdf                    -> passphrase unlock (new vault when create)
store = keychain if mode==keychain, or mode!=libsecret on darwin; else libsecret
store.read:
  not-installed -> auto + no existing file: passphrase; else secrets-locked
  found         -> key
  failed        -> secrets-locked (never makes a key over an access error)
  missing       -> create && no existing file: new random 32-byte key, write, read back; else secrets-locked
```

`KUNJ_SECRETS_KEY` opens keychain-kdf files only; a passphrase file always asks for its passphrase.

# Stores

| Store | Read | Write | Missing |
|-------|------|-------|---------|
| macOS Keychain (`security`) | `find-generic-password -s kunj-secrets -a kunj -w` | stdin to `security -i`: `add-generic-password -s kunj-secrets -a kunj -w <hex>` (no `-U`, never replaces) | exit 44 |
| libsecret (`secret-tool`) | `lookup service kunj-secrets` | `store --label=kunj secrets service kunj-secrets`, key on stdin | exit 0 or 1 with no output |

The stored value must be 64 hex characters, else `secrets-locked` (the message never repeats it). Because
`security` can exit 0 without storing, a new key is used only after it reads back equal.

# Passphrase kdf

- `scrypt(passphrase, salt, 32, { N: 2^15, r: 8, p: 1, maxmem: 64 MB })`, salt per file.
- `attempts: PASSPHRASE_TRIES` (3). Prompted once per command and kept for later files; a wrong passphrase
  re-prompts (`Wrong passphrase. Secrets passphrase: `); after three tries the vault reports `secrets-locked`.
- A new vault prompts `New secrets passphrase: ` then `Repeat the passphrase: `; a mismatch or an empty answer is
  `secrets-locked`.
- Without an injected `prompt`, a prompt is shown only when stdin and stderr are TTYs (or `opts.tty`); otherwise
  `secrets-locked` telling the user to set `KUNJ_SECRETS_KEY` or use a keychain.

`hiddenPrompt(msg, io?)` writes the prompt to stderr and reads through readline with a muted output stream, so
typing is not echoed. Ctrl-C or end of input before a line rejects with `secrets-locked` ("No passphrase
given"), so kunj never exits 0 having done nothing. `kunj secret set` also uses it for values.

# One unlock per kdf

`openVaults()` (`resolve.ts`) reads both files' kdf first (a corrupt file is reported before anything is
unlocked), returns empty without unlocking when neither exists, and memoises one `getUnlock` per kdf with
`create: false`, so a passphrase or keychain is asked once even when global and repo files share it.
`kunj secret` writes call `getUnlock` with `create: true` and `existingKdf` = the target file's kdf, else
the other file's. When the target file is new and the other exists, `modify()` decrypts the other file first,
so a mistyped passphrase or a different `KUNJ_SECRETS_KEY` fails before a new file is written under a stray key.

# Related Concepts

* [Vault](/secrets/vault.md)
* [Secret Manager](/secrets/overview.md)
* [Resolution and Delivery](/secrets/resolution-and-delivery.md) - `openVaults`, `loadSecrets`
* [Configuration](/architecture/configuration.md)

# Citations

[1] [src/lib/secrets/keyprovider.ts](/src/lib/secrets/keyprovider.ts)
[2] [src/settings/secrets.ts](/src/settings/secrets.ts)
[3] [src/lib/secrets/resolve.ts](/src/lib/secrets/resolve.ts)
[4] [src/lib/secrets/vault.ts](/src/lib/secrets/vault.ts)
[5] [src/commands/secret.ts](/src/commands/secret.ts)
[6] [docs/specs/container-system.md](/docs/specs/container-system.md)
