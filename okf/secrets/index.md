# Secrets

`kunj secret` and `kunj run`: encrypted global, repo and branch secrets and where they are delivered. Code in `src/lib/secrets/`.

# Concepts

* [Secret Manager](/secrets/overview.md) - kunj's encrypted secret store - global, repo and branch scoped secrets delivered by explicit target to host commands, worktree files and branch containers.
* [Secrets Vault](/secrets/vault.md) - The encrypted secrets.enc files - an AES-256-GCM JSON envelope holding secret entries - and the .env parser used to import them.
* [Secret Key Providers](/secrets/key-providers.md) - Where the vault key comes from - KUNJ_SECRETS_KEY, the macOS Keychain, libsecret or an scrypt passphrase - chosen by secrets.keyProvider and the existing file's kdf.
* [Secret Resolution and Delivery](/secrets/resolution-and-delivery.md) - How the secrets for a branch and target are resolved, and how they reach host commands, worktree files and branch containers.
* [kunj run](/secrets/kunj-run.md) - Runs a host command with the branch's host-targeted secrets in its environment, and is how kunj agent and kunj worktree shell start their tmux commands without putting values in argv.
