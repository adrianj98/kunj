---
type: Container
title: Container Editor Open
description: kunj ct open attaches VS Code or Cursor to a running branch container through the Dev Containers extension, resuming the container first when needed.
resource: src/lib/container/editor.ts
tags: [container, editor, vscode, devcontainers]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj ct open [branch] [--new-window]` opens the branch container's `/workspace` in the editor configured by
`worktree.editorCommand` (default `code`). VS Code-like editors attach through the Dev Containers extension
(`ms-vscode-remote.remote-containers`), which opens a `vscode-remote://attached-container+<hex>/<folder>` URI
and takes the user and folder for that container from a per-image "attached container configuration" file.
kunj writes that file, then launches the editor. The helpers are in `src/lib/container/editor.ts` (plain
`fs`/`path`, on the fast path); the action is `ContainerCommand.open()` in `src/commands/container.ts`.

# Flow

```
list containers of the branch -> none? "No container for <branch>"
needsResume(found, names)? -> startOrResume(..., { keepStaleHelper: true })
editor = worktree.editorCommand ('' -> error)
allowlist mode? -> warn: add VS Code update/marketplace domains to container.network.allow
not VS Code-like -> print a `docker [--context c] exec -it [-u user] -w /workspace <name> sh -lc ...` line
VS Code-like -> writeEditorImageConfig -> openWorktree(editor, ['--folder-uri', uri], { newWindow })
             -> print EDITOR_CREDENTIALS_WARNING
```

`open` only resumes, through the same `startOrResume()` as start (so create hooks and secret file rendering
apply), and never rebuilds: `--rebuild`, `--create`, `--image` and `--publish` do not apply. It resumes when
the main container, its helper or a service is down (`needsResume()` in lifecycle.ts), and passes
`keepStaleHelper` so a running helper on an older image is left alone (only `kunj ct start` replaces it).
With `--context`, it warns that the editor finds the container through its own Docker context.

# The URI and the image config

| Function | What it does |
| --- | --- |
| `attachedContainerUri(name, folder)` | `vscode-remote://attached-container+<hex of {"containerName":"/<name>"}>/workspace` |
| `imageConfigFileName(image)` | Escapes only `:`, `/` and `%` as lowercase `%xx`, plus `.json` (the extension's own scheme, not `encodeURIComponent`) |
| `imageConfigPaths(home, platform)` | `<base>/Code` and `<base>/Cursor` `/User/globalStorage/ms-vscode-remote.remote-containers/imageConfigs`; base is `~/Library/Application Support` (macOS), `~/AppData/Roaming` (Windows), `~/.config` (Linux) |
| `writeImageConfig(dir, image, cfg)` | Merges `{ remoteUser?, workspaceFolder }` into the file, keeping the user's other keys; a file that is not plain JSON is left alone |

`writeEditorImageConfig()` writes the config for the editor in use and for the other one when its User
directory exists. `remoteUser` is the recorded container user (omitted when it is the image's own USER).
The behaviour was checked against extension version 0.470.0.

# Credentials warning

While a window is attached, the Dev Containers extension may copy the host's `~/.gitconfig`, install a git
credential helper backed by the host's credentials, and forward the host's SSH agent and gpg-agent into the
container, where the agent can use them. kunj does not change that, so `open` always prints
`EDITOR_CREDENTIALS_WARNING` (and returns it as `warning` with `--json`). The git parts can be turned off
with `"dev.containers.copyGitConfig": false` and `"dev.containers.gitCredentialHelperConfigLocation": "none"`;
SSH and GPG forwarding have no setting.

# JSON output

```json
{ "success": true, "branch": "b", "name": "kunj-...", "editor": "code", "uri": "vscode-remote://...", "warning": "..." }
```

For a non-VS Code editor: `uri: null` and `exec` with the docker exec line instead of `warning`.

# Related Concepts

* [Worktrees](/features/worktrees.md) - `buildOpenCommand()` / `openWorktree()`, `worktree.editorCommand`
* [Container Lifecycle](/containers/lifecycle.md) - `needsResume()`, resume
* [Tokens](/containers/tokens.md) - kunj's own, origin-scoped credentials
* [VS Code extension](/apps/vscode-extension.md)

# Citations

[1] [src/lib/container/editor.ts](/src/lib/container/editor.ts)
[2] [src/commands/container.ts](/src/commands/container.ts)
[3] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[4] [docs/specs/container-phase-2.md](/docs/specs/container-phase-2.md)
[5] [CLAUDE.md](/CLAUDE.md)
