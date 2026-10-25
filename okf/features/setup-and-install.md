---
type: Feature
title: Setup and Install
description: kunj setup, the interactive onboarding (shell aliases, Jira, secret import, companion apps), and kunj install, which downloads the VS Code extension and macOS apps from GitHub releases.
resource: src/commands/setup.ts
tags: [feature, onboarding, install, companion-apps]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj setup` (`src/commands/setup.ts`) is the first-run wizard. `kunj install` (`src/commands/install.ts`
over `src/lib/apps.ts`) installs the three companion apps - the [VS Code extension](/apps/vscode-extension.md),
the [macOS menu bar app](/apps/macos-app.md) and the [Workspace app](/apps/workspace-app.md) - from the
GitHub release assets that the [release workflow](/architecture/release-process.md) attaches. Setup ends
by offering the same install.

`src/lib/self.ts` is a small helper for how the CLI re-runs itself (see the last section).

# kunj setup

Options: `-s/--shell <shell>` (bash, zsh, fish), `-f/--force` (skip confirmations, overwrite aliases).

| Step | What happens |
|------|--------------|
| 1. Shell | `detectShell()` from `$SHELL` or a prompt; rc file `~/.zshrc`, `~/.bashrc` (else `~/.bash_profile`) or `~/.config/fish/config.fish` |
| 2. Aliases | Writes a `# Kunj CLI Aliases` section (replacing an existing one after confirmation): `kj`, `ksw`, `kcom`, `kpr`, `klist`, `kclean` |
| 3. Apply | Optionally sources the rc file in a child shell |
| 4. Jira | `setupJiraIntegration()` asks for base URL, email and token, checks them with `checkJiraCredentials()` and saves them with `saveConfig()` ([Integrations](/features/integrations.md)) |
| 5. Secrets | `offerSecretImport()`: when the repo has a kept `.env` and no repo `secrets.enc`, offers `kunj secret import <keep>/.env --delete` ([Secrets](/secrets/overview.md), [Keep Files](/features/keep-files.md)); decided without unlocking anything |
| 6. Apps | `offerCompanionApps()`: `InstallCommand.ask()` then `installOne()` per chosen app; failures print a `kunj install <app>` retry hint |

Note: the `kclean` alias points at `kunj clean`, which is not a registered command.

# kunj install

`kunj install [vscode|macos|workspace|all]` with `--release <version>`, `--editor <cli>`, `-y/--yes`.
Without an argument it shows a checkbox list (already installed apps are marked "update" and unchecked);
`--yes` or `all` installs every available app. On non-macOS only `vscode` is available.

| App | Release asset pattern | Installed as |
|-----|-----------------------|--------------|
| `vscode` | `/^kunj-worktrees-.*\.vsix$/` | `<editor> --install-extension <vsix> --force` (`editorCli()`: first word of `--editor`, default `code`); id `kunj.kunj-worktrees` |
| `macos` | `/^Kunj-macos-.*\.zip$/` | `Kunj.app` (executable `KunjBar`) |
| `workspace` | `/^Kunj-workspace-.*\.zip$/` | `Kunj Workspace.app` (executable `KunjWorkspace`) |

```
findReleaseAsset(app, version)           GET api.github.com/repos/adrianj98/kunj/releases?per_page=20
  pickAsset(): skip drafts; the release whose tag matches the CLI version (package.json, or --release),
               else the newest release that has the asset
downloadAsset() ──> temp dir
vscode: installVscodeExtension()
macOS:  installMacApp(): ditto -x -k into staging ──> pkill -x <executable> ──> replace the existing
        copy (or install to /Applications if writable, else ~/Applications) ──> ditto ──>
        xattr -dr com.apple.quarantine (not notarized) ──> open
```

A version without the asset prints which release was used instead. With no release at all the error
says how to build from source (`macos-app/scripts/bundle.sh --install`,
`workspace-app/scripts/bundle.sh --install`, `vscode-extension && npm run install-local`).
`--json` prints `{ success, results: [{ app, success, release?, path?, error? }] }`; any failure sets
exit code 1.

The asset names are the contract between `src/lib/apps.ts` and the release workflow; keep them in step.

# self.ts

`kunjEntry()` returns the script node should run to start kunj again: `process.argv[1]`, or the built
`dist/index.js` when running under ts-node (a `.ts` entry plain node cannot run). It is used for the
`[process.execPath, kunjEntry()]` prefix of the `kunj run` command line in `src/lib/agent-session.ts` ([Worktree Agents](/features/worktree-agents.md))
and by the detached auto-forwarder in `src/lib/container/autoforward.ts` ([Forwarding](/containers/forwarding.md)).

# Related Concepts

* [Shell Integration](/features/shell-integration.md) - completion and prompt setup (separate from `setup`)
* [Release Process](/architecture/release-process.md) - where the assets come from
* [VS Code Extension](/apps/vscode-extension.md), [macOS App](/apps/macos-app.md), [Workspace App](/apps/workspace-app.md)
* [Secrets Overview](/secrets/overview.md)

# Citations

[1] [src/commands/setup.ts](/src/commands/setup.ts)
[2] [src/commands/install.ts](/src/commands/install.ts)
[3] [src/lib/apps.ts](/src/lib/apps.ts)
[4] [src/lib/self.ts](/src/lib/self.ts)
[5] [src/lib/agent-session.ts](/src/lib/agent-session.ts)
[6] [src/lib/container/autoforward.ts](/src/lib/container/autoforward.ts)
