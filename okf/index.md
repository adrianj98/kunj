---
okf_version: "0.1"
---

# Kunj Knowledge Bundle

This bundle documents the **kunj** codebase, a Git branch, worktree and branch-container CLI
(TypeScript, Node) with AI commit and PR messages, encrypted secrets, and three companion apps
(a VS Code extension, a macOS menu bar app and a macOS workspace app), in
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog).
Each concept is one markdown file with YAML frontmatter; concepts link to one
another to form a knowledge graph of the system, and cite the source files they describe.
Every file was written against the code as of 2026-10-25, not only from CLAUDE.md or docs/specs.

## Architecture

* [System Overview](/architecture/system-overview.md) - What kunj is, the pieces it ships as, how they talk to each other at runtime, and what lives under ~/.kunj.
* [Command System](/architecture/command-system.md) - How kunj commands are declared (BaseCommand + CommandConfig), collected (getAllCommands, CommandRegistry) and wired into Commander, including --json and error printing.
* [Fast Path](/architecture/fast-path.md) - The startup shortcut that loads only the requested command for frequently invoked commands, and the performance rules that keep those commands cheap.
* [Settings Registry](/architecture/settings-registry.md) - The central registry where every kunj setting is declared with its type, default, category and help text, and from which the default config is generated.
* [Configuration](/architecture/configuration.md) - Two-tier JSON config (global ~/.kunj/config.json, per-repository ~/.kunj/<repo>/config.json), how the per-repo directory is resolved, the legacy ./.kunj migration, and loadConfig vs loadResolvedConfig.
* [Config Variables](/architecture/config-variables.md) - The ${name} expansion available in any config string, how the repository variables are resolved cheaply, and the shell-aware quoting used for hook commands.
* [Repo Identity and Registry](/architecture/repo-identity-and-registry.md) - How kunj names a repository (name, id, origin URL) for derived names, and the ~/.kunj/repos.json registry of repositories behind `kunj repos`.
* [Git Layer](/architecture/git-layer.md) - How kunj talks to git - the shared helpers in src/lib/git.ts, the worktree-specific helpers, status parsing (porcelain v1 and v2), bare-repository handling and GIT_OPTIONAL_LOCKS.
* [JSON Contract](/architecture/json-contract.md) - The published, type-only JSON contract of `kunj ... --json` in src/lib/json-types.ts, its consumers, the error shapes and the additive-only compatibility rule.
* [Release Process](/architecture/release-process.md) - How kunj is built, tested in CI, versioned at runtime and released by tag to npm and GitHub (with the VS Code extension and the two macOS apps as assets), plus the GitHub Pages deploy.
* [Testing](/architecture/testing.md) - The test layers of kunj - Jest unit tests with the FakeBackend, the opt-in Docker integration suite, the opt-in functional suite that drives the built CLI, and the Swift tests of the two macOS apps.

## Features

* [Features Index](/features/index.md) - Branch commands, AI, worktrees, editor sessions, agents, shells, hooks, events.

## Branch Containers

* [Branch Containers Index](/containers/index.md) - Backend, lifecycle and READY, firewall, images, seed, services, forwarding, prune, Docker-in-Docker, MCP bridge, blueprints and snapshots.

## Secrets

* [Secret Manager](/secrets/overview.md) - kunj's encrypted secret store - global, repo and branch scoped secrets delivered by explicit target to host commands, worktree files and branch containers.
* [Secrets Vault](/secrets/vault.md) - The encrypted secrets.enc files - an AES-256-GCM JSON envelope holding secret entries - and the .env parser used to import them.
* [Secret Key Providers](/secrets/key-providers.md) - Where the vault key comes from - KUNJ_SECRETS_KEY, the macOS Keychain, libsecret or an scrypt passphrase - chosen by secrets.keyProvider and the existing file's kdf.
* [Secret Resolution and Delivery](/secrets/resolution-and-delivery.md) - How the secrets for a branch and target are resolved, and how they reach host commands, worktree files and branch containers.
* [kunj run](/secrets/kunj-run.md) - Runs a host command with the branch's host-targeted secrets in its environment, and is how kunj agent and kunj worktree shell start their tmux commands without putting values in argv.

## Applications

* [VS Code Extension (Kunj Worktrees)](/apps/vscode-extension.md) - A VS Code extension that shows the repository's git worktrees and branch containers in a tree view and drives every action through the kunj CLI's JSON output.
* [macOS Menu Bar App (Kunj.app)](/apps/macos-app.md) - A SwiftUI menu bar app that lists the worktrees and branch containers of every repository kunj knows, opens them, notifies on pull request changes and organizes editor and terminal windows across desktops.
* [Workspace App (Kunj Workspace.app)](/apps/workspace-app.md) - A native macOS app that shows every worktree and branch container as an environment with its own terminals, agent tabs, Changes diff and editor tabs, all driven through kunj's JSON commands.
* [Docs Site and Landing Page](/apps/docs-site.md) - The Astro Starlight user documentation in docs-site/ and the static landing page in site/, published together to GitHub Pages under /kunj/.
