# Secret Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store secrets once, encrypted in `~/.kunj`, and deliver each one only to the targets it names: host commands (`kunj run`, `kunj agent`), new worktrees and branch containers.

**Architecture:** `src/lib/secrets/` holds five small modules: dotenv parsing, the encrypted vault, key providers, resolution (scope and target filtering) and delivery (rendering files). `kunj secret` and `kunj run` are fast-path commands on top of them. Containers get secrets through the existing `docker run` env file and through the same tar stream that copies keep files; host tmux sessions get them by running the agent under `kunj run`, so no value is ever in argv.

**Tech Stack:** TypeScript (strict, CommonJS), Node `crypto` (AES-256-GCM, scrypt), Jest, Commander via `BaseCommand`. No new dependencies.

**Spec:** `docs/specs/container-system.md`, section "Secrets" (approved 2026-10-23; the rulings below are written back into it in Task 1).

## Global Constraints

- Secrets reach containers only through the `docker run` env file (`--env-file`) or files streamed in with `extractInto` as the sandbox user. Never `docker exec -e`, never a label, never a snapshot (snapshot builds get no secrets).
- A secret value is never in any process's argv. That covers `tmux new-session -e`, `security add-generic-password -w <value>` and `docker` args.
- `kunj secret get` with `--json` is refused.
- Nothing is written into the repository. A rendered file that git does not ignore is refused (`not-ignored`) unless `--force`. Container renders are added to `/workspace/.git/info/exclude`.
- A secret reaches a container only if its `targets` include `container`. Global secrets are `env` only.
- Names match `[A-Za-z_][A-Za-z0-9_]*`, otherwise `bad-name`.
- Files: `~/.kunj/secrets.enc` (global) and `~/.kunj/<repo>/secrets.enc` (repo and branch), JSON envelope `{ version: 1, kdf: "keychain" | "passphrase", salt, iv, ciphertext, tag }` (base64 fields), AES-256-GCM, written atomically (temp file + rename) with mode 0600.
- Keychain item: generic password, service `kunj-secrets`, account `kunj`, value 64 hex chars (32 bytes). libsecret: `secret-tool` with attribute `service kunj-secrets`. `KUNJ_SECRETS_KEY` (64 hex chars) overrides both.
- Passphrase kdf: `crypto.scrypt(passphrase, salt, 32, { N: 2**15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })`, 16-byte random salt per file, 12-byte random IV per write. A wrong passphrase three times gives `secrets-locked`.
- Error codes (`jsonCode` on a `SecretError`, printed without a stack trace like `AgentError`): `secrets-locked`, `secrets-corrupt`, `secret-not-found`, `bad-name`, `not-ignored`, `bad-dotenv` (added in Review 1: a malformed line in an imported `.env`).
- The vault is unlocked only by commands that deliver or manage secrets, and only when a `secrets.enc` file exists. Listings (`worktree list`, `ct list`, `events`) never unlock it.
- `secret` and `run` are fast-path commands (`src/commands/fast.ts`): no AWS, LangChain or top-level inquirer imports. Load inquirer lazily if it is used at all.
- Tests never touch the real Keychain. Every test injects a fake `Runner` and `prompt` into `getUnlock` (Task 3), or passes a fixed-key `Unlock` straight to the vault.

## Rulings (corrections to the spec, written back in Task 1)

1. **Env secrets reach a running container only when it is recreated.** `docker start` keeps the environment from `docker run`, and the env file is the only allowed channel. So `ct start` on an existing container re-renders file deliveries, and env changes need `ct start --rebuild`. `ct list --json` reports `secretsChanged: true`, and the start output hints at `--rebuild`.
2. **`secretsChanged` without unlocking.** The container gets the label `kunj.secrets`: the first 12 hex chars of the sha256 of the global and repo `secrets.enc` bytes (ciphertext only, `''` when neither exists). `ct list` recomputes it from the files and compares. Any vault write therefore marks every container of that repo, which is coarse but reveals nothing.
3. **Host tmux sessions use `kunj run`, not `-e`.** `kunj agent` starts the tmux command as `<node> <kunj> run --branch <b> -- <shell> -lc <agent.command>`. The vault is unlocked inside the session and the values never appear in argv. The tmux-less path does the same in-process. The workspace app opens worktree terminals with `kunj run -- $SHELL -l`.
4. **Keychain writes go through stdin.** `security -i` reads the `add-generic-password` command from stdin, and `secret-tool store` reads the secret from stdin.
5. **Key without a keychain:** the `passphrase` kdf. `KUNJ_SECRETS_KEY` is a raw key and opens `keychain`-kdf files only.
6. **`docker inspect` shows env-file variables** in `Config.Env`, as it does for forwarded tokens today, so the spec's "neither is in `docker inspect`" applies to labels and to host-only secrets. Anyone who can run `docker inspect` already has root on the daemon.

## Review Focus

1. **The value in argv.** Spawned argv for `security`, `secret-tool`, `tmux` and `docker` must never contain a secret value. Tests in Tasks 3, 6 and 7 assert that.
2. **A tampered or truncated `secrets.enc`.** It must give `secrets-corrupt`, name the file, and leave it byte-identical, never overwrite it with an empty vault (Task 2).
3. **A rendered `.env` in a repo whose `.gitignore` does not cover it.** It is refused with `not-ignored` and the file is not written (Task 4).
4. **A branch secret overriding a repo secret of the same name,** but only for that branch. Another branch still gets the repo value (Task 4).
5. **A dotenv value with `#`, `=` or quotes inside quotes,** and an unterminated multi-line value. These must parse as the shell would, and the last one must be an error naming the line (Task 1).

---

### Task 1: dotenv parser and spec rulings

**Status: done** in c2a722f; review fix (error messages never quote file text) in the Review 1 commit.

**Files:**
- Create: `src/lib/secrets/dotenv.ts`
- Test: `src/lib/secrets/__tests__/dotenv.test.ts`
- Modify: `docs/specs/container-system.md` (Secrets section: write Rulings 1–6 into Storage/Delivery; status line "Plan: docs/superpowers/plans/2026-10-23-secret-manager.md")

**Interfaces:**
- Produces: `parseDotenv(text: string): Array<{ name: string; value: string }>`, which throws a plain `Error('line N: …')` on a malformed line (N is the line the entry starts on; the message never contains text from the file). Entries come in first-seen order, last value wins. CRLF and lone CR are normalised to LF everywhere, including inside quoted values. Single-quoted values may span lines; spaces around `=` are allowed; text after a closing quote other than a `# comment` is an error; double-quote escapes other than `\n \" \\` are kept with their backslash. `isSecretName(name: string): boolean`, and `NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`.

- [x] **Step 1: Write the failing table test** `parseDotenv` covering each case:
  - `A=1` gives `1`.
  - `export B=2` gives `2`.
  - `C='x # y'` gives `x # y`.
  - `D="a\nb"` (escape) gives a newline.
  - `E="line1` / `line2"` (multi-line) gives `line1\nline2`.
  - `F=val # comment` gives `val`.
  - `G=${HOME}` gives the literal `${HOME}`.
  - `H=` gives `''`.
  - Blank lines and `# comment` lines are skipped.
  - `I="unterminated` throws `/line 1/`.
  - `1X=y` throws `/line 1/`.
  - Duplicate names: the last one wins.

  Also `isSecretName('A_1')` is true, and `isSecretName('A-1')` is false.
- [x] **Step 2:** `npx jest src/lib/secrets/__tests__/dotenv.test.ts`. Expected: FAIL, the module is not found.
- [x] **Step 3: Implement** a line scanner. Single quotes are literal. Double quotes handle `\n \" \\` and may span lines. Unquoted values stop at ` #`.
- [x] **Step 4:** Run the test. Expected: PASS.
- [x] **Step 5:** Edit the spec section with the rulings, then commit both files and add an `aj-log.md` line: `git commit -m "Secrets: dotenv parser; spec rulings for container env, tmux and keychain writes"`.

### Task 2: Vault (envelope crypto and store)

**Status: done** in 1429ed9; review fix (`writeVault` never replaces a file that does not decrypt with its key) in the Review 2 commit. Rulings in the ledger.

**Files:**
- Create: `src/lib/secrets/vault.ts`, `src/lib/secrets/errors.ts`
- Test: `src/lib/secrets/__tests__/vault.test.ts`

**Interfaces:**
- Consumes: `isSecretName` (Task 1).
- Produces:
  - `class SecretError extends Error { constructor(message: string, readonly jsonCode: 'secrets-locked'|'secrets-corrupt'|'secret-not-found'|'bad-name'|'not-ignored'|'bad-dotenv') }`. Add `SecretError` to BaseCommand's no-stack list.
  - `interface SecretEntry { name: string; value: string; scope?: { branch?: string }; targets: Array<'host'|'container'>; delivery: { env: boolean; file?: string }; updatedAt: string }`
  - `interface Unlock { kdf: 'keychain'|'passphrase'; attempts?: number; keyFor(salt: Buffer, attempt?: number): Promise<Buffer> }` (the keychain kdf ignores the salt; `attempts` and `attempt` added in Task 3).
  - `readVault(file: string, unlock: Unlock): Promise<SecretEntry[]>` returns `[]` when the file is missing.
  - `writeVault(file: string, entries: SecretEntry[], unlock: Unlock): Promise<void>` keeps the existing salt and kdf when the file exists.
  - `vaultFiles(kunjDir: string, globalDir: string): { global: string; repo: string }`
  - `vaultStamp(files: string[]): string` (Ruling 2). Each existing file's bytes are hashed after a `<index>:<length>:` prefix.
  - Also exported: `type Kdf = 'keychain'|'passphrase'`, `SecretErrorCode` (errors.ts).
  - As built: `version`, `kdf` and `salt` are GCM additional data (`kunj-secrets:1:<kdf>:<salt>`). `readVault` and `writeVault` give `secrets-locked` when `unlock.kdf` differs from the file's kdf or `keyFor` returns other than 32 bytes. `writeVault` gives `bad-name` before touching anything, and `secrets-corrupt` (file left byte-identical) when the existing file is not a v1 envelope or does not decrypt with the key (tampered, or written under another key): it decrypts the existing file before replacing it. `readVault` gives `secrets-corrupt` when the decrypted content is not a list of well-formed entries. Task 3 note: its passphrase retry must catch `secrets-corrupt` from the decrypt step only (the message "it does not decrypt"; add a distinguishing field or a separate check rather than matching text), not from a malformed envelope, and it applies to `writeVault` as well as `readVault`, since both decrypt the existing file.

- [x] **Step 1: Write the failing tests.** Use a fixed-key `Unlock` and a passphrase `Unlock` built on scrypt.
  - A round trip returns equal entries.
  - The file mode is `0o600`, and the raw file contains neither the name nor the value.
  - Two writes of the same entries give different `iv`.
  - Flipping one ciphertext byte makes `readVault` reject with `SecretError` code `secrets-corrupt`. The message contains the path, and the file bytes are unchanged afterwards.
  - Truncated JSON gives `secrets-corrupt`.
  - A wrong key gives `secrets-corrupt`.
  - `vaultStamp([])` is `''`, it changes after a write, and it has 12 chars.
- [x] **Step 2:** Run the test. Expected: FAIL.
- [x] **Step 3: Implement** with `crypto.createCipheriv('aes-256-gcm', key, iv)`. Write the envelope to `file + '.tmp-<pid>'` with mode 0600, then `fs.renameSync`, creating the parent directory with mode 0700.
- [x] **Step 4:** Run the test. Expected: PASS.
- [x] **Step 5:** Commit: `git commit -m "Secrets: encrypted vault"`.

### Task 3: Key providers

**Status: done** in 8901b6b; review fix (the hidden prompt refuses on Ctrl-C or end of input instead of never settling) in the Review 3 commit. Rulings in the ledger.

**Files:**
- Create: `src/lib/secrets/keyprovider.ts`, `src/settings/secrets.ts` (register in `src/settings/index.ts`)
- Test: `src/lib/secrets/__tests__/keyprovider.test.ts`

**Interfaces:**
- Consumes: `Unlock`, `SecretError` (Task 2).
- Produces:
  - `type Runner = (cmd: string, args: string[], input?: string) => Promise<{ code: number; stdout: string }>`, which defaults to `child_process.spawn`.
  - `getUnlock(opts: { mode: 'auto'|'keychain'|'libsecret'|'passphrase'; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; run?: Runner; prompt?: (msg: string) => Promise<string>; existingKdf?: 'keychain'|'passphrase'; create: boolean }): Promise<Unlock>`
  - As built: `getUnlock` also takes `tty?: boolean` (whether a hidden prompt may be shown without `prompt`; default stdin and stderr are TTYs). `Unlock` gained `attempts?: number` and `keyFor(salt, attempt?)`: `readVault`/`writeVault` call `keyFor` with the next attempt number while the GCM check fails (never for a malformed envelope), and give `secrets-locked` once `attempts` (> 1) are used up; the passphrase `Unlock` sets 3, others keep 1 (plain `secrets-corrupt`). An `existingKdf: 'passphrase'` always opens with the passphrase; `KUNJ_SECRETS_KEY` is used only for a keychain-kdf file or a new vault with a mode other than `passphrase`. A new key is made only when `create` and no file exists; a Keychain read failing with anything but exit 44 is `secrets-locked`, never a miss; `add-generic-password` has no `-U` and the key is read back before use. `auto` falls back to the passphrase only when the tool is not installed (exit 127 / ENOENT) and no keychain file exists. A new passphrase is asked twice.
  - Also exported: `hiddenPrompt(msg, io?: { input; output }): Promise<string>` (readline, echo muted, prompt on stderr; Ctrl-C or end of input gives `secrets-locked`), `KeyProviderMode`, `GetUnlockOptions`, `PASSPHRASE_TRIES`, `defaultRunner`. Task 5's `set` reuses `hiddenPrompt` for the value (no inquirer).
  - The setting is `secrets.keyProvider` (string, default `auto`, values `auto|keychain|libsecret|passphrase`, category `secrets`).

- [x] **Step 1: Write the failing tests** with a recording `run` fake.
  - A `KUNJ_SECRETS_KEY` of 64 hex chars wins and runs nothing. A malformed one gives `secrets-locked`.
  - darwin auto reads with `security find-generic-password -s kunj-secrets -a kunj -w`.
  - When that misses and `create` is true, it writes a fresh key through `security -i` with the command on **stdin**. Assert that no recorded argv contains the 64-hex key.
  - linux auto runs `secret-tool lookup service kunj-secrets`. A store passes the key on stdin.
  - Passphrase: a `prompt` fake answering wrong three times gives `secrets-locked`. No prompt and no TTY gives `secrets-locked`.
  - An `existingKdf: 'passphrase'` file never touches the keychain.
- [x] **Step 2:** Run the test. Expected: FAIL.
- [x] **Step 3: Implement.** The passphrase check verifies by decrypting: return an `Unlock` whose `keyFor` re-prompts on a GCM failure, up to 3 tries. Expose the try count through the vault by having `readVault` and `writeVault` call `keyFor` again on a decrypt failure (not a malformed envelope) when `unlock.kdf === 'passphrase'`. Hidden prompt: `readline` with output muted (no inquirer).
- [x] **Step 4:** Run the test. Expected: PASS.
- [x] **Step 5:** Commit: `git commit -m "Secrets: keychain, libsecret and passphrase key providers"`.

### Task 4: Resolution and host file delivery

**Status: done** in the commit "Secrets: resolution by scope and target, host file rendering". Rulings in the ledger.

**Files:**
- Create: `src/lib/secrets/resolve.ts`, `src/lib/secrets/deliver.ts`
- Test: `src/lib/secrets/__tests__/resolve.test.ts`, `src/lib/secrets/__tests__/deliver.test.ts`

**Interfaces:**
- Consumes: `SecretEntry` (Task 2).
- Produces:
  - `resolveSecrets(global: SecretEntry[], repo: SecretEntry[], branch: string | undefined, target: 'host'|'container'): SecretEntry[]` applies the order global, then repo, then branch (most specific wins by name), then filters by target.
  - `envOf(entries: SecretEntry[]): Record<string,string>` (env-delivered only).
  - `renderFiles(entries: SecretEntry[]): Map<string, string>` maps the relative file to `NAME=value` lines. Values are double-quoted with `\\`, `"` and newline escaped (`\n`) so `parseDotenv` reads them back, sorted by name. `parseDotenv` turns a raw CR into LF and has no `\r` escape, so a value containing `\r` does not round-trip; `set`/`import` keep it in the vault as given, and only the rendered file loses it.
  - `writeHostFiles(worktreeRoot: string, files: Map<string,string>, opts: { force?: boolean }): Promise<string[]>` checks `git check-ignore -q` per file and throws `SecretError('… is not ignored by git', 'not-ignored')` before writing anything. It writes with mode 0600 and refuses paths outside the root (`..`, absolute).
  - `loadSecrets(opts: { branch?: string; target: 'host'|'container'; create?: false }): Promise<SecretEntry[]>` does the glue: config, `getKunjDir`, `getUnlock`, both `readVault`s and `resolveSecrets`. It returns `[]` without unlocking when no `secrets.enc` exists.
  - As built: `resolveSecrets`, `envOf` and `loadSecrets` (with `SecretTarget`, `LoadSecretsOptions`) are in resolve.ts; `renderFiles` and `writeHostFiles` in deliver.ts. `loadSecrets` also takes optional seams `kunjDir`, `globalDir`, `mode`, `env`, `platform`, `run`, `prompt`, `tty` (defaults: current repo, `secrets.keyProvider`, the process); `branch` undefined means no branch layer (callers pass the current branch). `resolveSecrets` sorts by name, drops `delivery.file` and `scope` meaning from global entries, and filters by target after the override. `writeHostFiles` returns the relative paths written, refuses (plain `Error`) a path outside the root, also through a symlinked directory, even with `force`, and writes via temp file + rename.
  - Add `vaultKdf(file: string): Kdf | undefined` to vault.ts (reads the envelope's `kdf` without decrypting; `undefined` when missing; `secrets-corrupt` when not a v1 envelope) so the caller can pass `getUnlock` its `existingKdf`. Rules from Task 3 the glue must keep: `mode` is `secrets.keyProvider` from the resolved config; `existingKdf` is the kdf of whichever vault file exists, so a new repo vault next to a keychain global one reuses the same key instead of minting one; when the global and repo files have different kdfs, call `getUnlock` once per kdf and open each file with its own `Unlock`; reads pass `create: false`. Pass one `Unlock` (per kdf) to both files so a passphrase is asked once per command. Test with a fake `Runner`/`prompt`, never the real Keychain.
- [x] **Step 1: Write the failing tests.**
  - A branch entry `X` overrides repo `X` for `feature/x` only. `main` still gets the repo value.
  - A host-only entry is absent for `target: 'container'`.
  - A global entry with `delivery.file` is ignored for files (globals are env only).
  - A `renderFiles` value containing a newline, a quote and `#` survives a round trip through `parseDotenv`.
  - In a temp git repo with `.gitignore` containing `.env`, `writeHostFiles` writes `.env` with mode 0600. Without that ignore it rejects with code `not-ignored` and `.env` does not exist. `force` writes it. `../x` is refused.
- [x] **Step 2:** Run the tests. Expected: FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Run the tests. Expected: PASS.
- [x] **Step 5:** Commit: `git commit -m "Secrets: resolution by scope and target, host file rendering"`.

### Task 5: `kunj secret` command

**Files:**
- Create: `src/commands/secret.ts`
- Modify: `src/commands/fast.ts` (add `secret`), `src/commands/index.ts`, `src/lib/json-types.ts` (`SecretListJson`), `src/lib/keep.ts` (only if `deleteKeptFile` needs exporting for `--delete`)
- Test: `src/commands/__tests__/secret.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `export interface SecretListJson { secrets: Array<{ name: string; scope: 'global'|'repo'|'branch'; branch?: string; targets: Array<'host'|'container'>; delivery: { env: boolean; file?: string }; updatedAt: string }> }`
  - Subcommands per the spec table: `set`, `import`, `list`, `get`, `rm`, `env`, `apply [-a]`.

- Write paths (`set`, `import`, `rm`) call `getUnlock` with `create: true` and `existingKdf` from `vaultKdf` of both files (Task 4); only when neither file exists may a new key be made.

- [ ] **Step 1: Write the failing tests.** Inject `Unlock` (or `getUnlock`'s `run`/`prompt`) through a test seam on the command, the way `repoId` is a seam in events, and use a temp HOME.
  - `set FOO` with the value on stdin stores `targets: ['host','container']` and env.
  - `set FOO --global --file .env` is refused (globals are env only).
  - `set 1BAD` gives `bad-name`.
  - `list --json` matches `SecretListJson` and the output contains no value.
  - `get FOO --json` is refused. `get` prints the value plus a newline.
  - `get NOPE` gives `secret-not-found`.
  - `rm` removes the entry.
  - `env` prints `export FOO='v'` with `'` escaped as `'\''`.
  - `import fixture.env --yes` adds its names with the defaults (repo scope, host and container, env plus `.env`). `--json` prints the names only. `--delete` removes the source, and the keep copy too when the source is the keep file.
  - `apply` renders into the current worktree, and `-a` into every worktree.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Read the `set` value from a hidden prompt on a TTY, otherwise from stdin, stripping one trailing newline.
  - The import confirmation lists the names and their add or replace status.
  - A `parseDotenv` error is rethrown as `SecretError('<file>: line N: …', 'bad-dotenv')` (no stack trace, never the file's text). Add a test.
  - Defaults:
    - Targets: `host,container`.
    - Delivery: env.
    - Branch: the current branch, only with `--branch`. A plain `set` stores at repo scope.
- [ ] **Step 4:** Run the tests and `npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "kunj secret: set, import, list, get, rm, env, apply"`.

### Task 6: Host delivery: `kunj run`, `kunj agent` and `worktree add`

**Files:**
- Create: `src/commands/run.ts`
- Modify:
  - `src/commands/fast.ts` (add `run`)
  - `src/commands/index.ts`
  - `src/lib/agent-session.ts`: `agentArgv` takes the command it is given. Add `kunjSelf(): string[]`, which is `[process.execPath, entry]` with the same `.ts`→`dist/index.js` rule as `autoforward.ts:142`. Factor that rule into one helper both use.
  - `src/commands/agent.ts` (wrap the command)
  - `src/lib/worktree.ts:620` (render secret files after `applyKeptFiles`; failures are warnings, as keep files are)
- Test: `src/commands/__tests__/run.test.ts`, `src/lib/__tests__/agent-session.test.ts`

**Interfaces:**
- Consumes: `loadSecrets`, `envOf`, `renderFiles`, `writeHostFiles` (Task 4).
- Produces: `kunj run [--branch b] -- <cmd…>`. It spawns `cmd` with `{ ...process.env, ...envOf(host secrets) }` and `stdio: 'inherit'`, renders file deliveries first, and exits with the child's code (signal: 128+n).

- [ ] **Step 1: Write the failing tests.**
  - `run -- node -e "process.exit(process.env.FOO==='v'?3:4)"` exits 3 with the host secret `FOO=v`.
  - A container-only secret is absent.
  - When the vault has no files, `run` works with no unlock attempted (the `getUnlock` spy is not called).
  - `agentArgv` built by `kunj agent` for a branch whose secrets include `FOO=v` contains `run`, `--branch` and the branch, and no element contains `v` as a value or `FOO=`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. In `agent.ts`, the tmux command becomes the shell-quoted `kunjSelf()` + `run --branch <b> -- <shell> -lc <agent.command>`. The direct path calls the same `run` logic in-process. Keep `KUNJ_*` as they are.
- [ ] **Step 4:** Run the tests and `npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Secrets on the host: kunj run, kunj agent under kunj run, new worktrees"`.

### Task 7: Container delivery

**Files:**
- Modify:
  - `src/lib/container/lifecycle.ts`: `StartOptions.secrets?: { env: Record<string,string>; files: Map<string,string>; stamp: string }`. Merge `env` over `forwardedEnv(...)` at line 736. Render `files` in `copyFiles` (create and resume) under `/workspace`, mode 0600, plus a `.git/info/exclude` line each. Set the label `kunj.secrets` = `stamp` on create. On resume, warn with the `--rebuild` hint when the label differs and `env` is non-empty.
  - `src/lib/container/names.ts` (`LABEL.secrets = 'kunj.secrets'`)
  - `src/commands/container.ts`: `start`/`agent` load container secrets via `loadSecrets({ target: 'container', branch })`. Snapshot builds pass none. `list` sets `secretsChanged` from `vaultStamp`.
  - `src/lib/json-types.ts` (`ContainerJson.secretsChanged?: boolean`)
- Test: `src/lib/container/__tests__/lifecycle.test.ts` (FakeBackend), `src/lib/container/__tests__/integration.docker.test.ts`

**Interfaces:**
- Consumes: `loadSecrets`, `envOf`, `renderFiles`, `vaultStamp`.
- Produces: `ContainerJson.secretsChanged`.

- [ ] **Step 1: Write the failing FakeBackend tests.**
  - A secret env `FOO` lands in the env file passed to `run`, and is in no exec's `env` or argv and no label.
  - A secret overrides a `container.env` value of the same name.
  - A file delivery is extracted at `/workspace/.env` with mode 0600, and `.git/info/exclude` gains `.env`.
  - Resume re-extracts the files and does not touch env.
  - The label `kunj.secrets` equals the stamp, and a changed stamp on resume prints the `--rebuild` hint.
  - `namesFor: '<b>:snapshot'` starts get no secrets.
- [ ] **Step 2: Docker test (add to `integration.docker.test.ts`).** A container-targeted `FOO` is visible through `exec env`. A host-only `BAR` is not. BAR's value appears nowhere in `docker inspect`, and no label contains FOO's value (FOO is in `Config.Env`, as env-file variables always are; see Ruling 6). The snapshot image's `Config.Env` contains neither.
- [ ] **Step 3:** Run `npx jest src/lib/container/__tests__/lifecycle.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `npm test`, `npm run lint`, and `npm run test:docker` (it skips itself without Docker). Expected: PASS.
- [ ] **Step 6:** Commit: `git commit -m "Secrets in branch containers: env file, rendered files, secretsChanged"`.

### Task 8: Migration prompts and docs

**Files:**
- Modify:
  - `src/commands/secret.ts`: `list` with no secrets and a keep `.env` prints `Found a kept .env: kunj secret import ~/.kunj/<repo>/keep/.env --delete`.
  - `src/commands/setup.ts`: offer the same import (lazy inquirer is already used there).
  - `CLAUDE.md`: a Secrets subsection under Branch Containers, plus the command list.
  - `docs/specs/container-system.md`: status "Shipped" with the commits.
  - `docs/specs/README.md`: move the line to Done with the commits.
  - `docs-site/src/content/docs/…`: a secrets page, then run `npm run gen` in `docs-site` and commit the JSON.
  - `aj-log.md`
- Test: `src/commands/__tests__/secret.test.ts` (the hint)

- [ ] **Step 1:** Failing test: `list` with an empty vault and a keep `.env` prints the import hint, and prints nothing extra with `--json`.
- [ ] **Step 2:** Implement the hint and the setup offer. Run `npm test`. Expected: PASS.
- [ ] **Step 3:** Update the docs listed above and run `cd docs-site && npm run gen`.
- [ ] **Step 4:** Commit and push: `git commit -m "Secrets: import hint, setup offer, docs"`.
