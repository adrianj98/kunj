# Directory Update Log

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
