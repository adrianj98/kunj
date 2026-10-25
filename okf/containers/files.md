---
type: Container
title: Container Files
description: kunj ct file read|write reads and writes text files in a branch container's /workspace as the sandbox user, for the workspace app's editor tabs.
resource: src/lib/container/files.ts
tags: [container, files, workspace-app, json]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj ct file read [branch] <path>` prints a file of the container's `/workspace`, and
`kunj ct file write [branch] <path>` writes stdin to one. They exist so the
[workspace app](/apps/workspace-app.md) can open and save files of a container environment without running
`docker` itself. The logic is in `src/lib/container/files.ts`; the action is `ContainerCommand.file()`.

Both require a running container and run as the container's recorded user (`kunj.options.user`; no `-u`
when it is the image's own USER) with workdir `/workspace`, through `backend.exec`, so file ownership
matches what the agent sees.

# Path validation

`validateWorkspacePath(p)` returns the POSIX-normalised relative path (trailing `/` removed) or throws
`ContainerError` with code `bad-path` when the path:

* is empty or contains NUL;
* is absolute (`Path must be relative to /workspace`);
* normalises to `.`, `..` or starts with `../` (`Path must stay inside /workspace`).

It is a check on the path text only. Symlinks inside `/workspace` are followed: the sandbox boundary is the
container, not the path check.

# Read and write

| Function | Exec | Error |
| --- | --- | --- |
| `readWorkspaceFile(backend, id, rel, user)` | `sh -c 'cat -- "$1"' sh <rel>` | `not-found` (`Cannot read <rel>`) on non-zero exit |
| `writeWorkspaceFile(backend, id, rel, stdin, user)` | `sh -c 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"' sh <rel>` with stdin streamed | `write-failed` (`Cannot write <rel>`) |

The path is passed as a positional argument, never interpolated into the script. Write creates missing
parent directories. `read` decodes UTF-8, so the commands are for text files.

# CLI and JSON

`kunj ct file read <path>` uses the current branch; `file read <branch> <path>` names one (1 or 2
arguments, else a usage error). The path is validated before the Docker context is built.

| Command | Text output | `--json` |
| --- | --- | --- |
| `file read` | The file's content, raw | `FileReadJson`: `{ "path", "content" }` |
| `file write` | `✓ wrote <path>` | `FileWriteJson`: `{ "success": true, "path" }` |

Errors with `--json` are `{ "error": { "code", "message" } }`, the code being the `ContainerError` code
(`bad-path`, `not-found`, `write-failed`) via its `jsonCode` getter, or `error`.

# Related Concepts

* [Branch Containers](/containers/overview.md)
* [JSON contract](/architecture/json-contract.md) - `FileReadJson`, `FileWriteJson`
* [Workspace app](/apps/workspace-app.md)
* [Container Backend](/containers/backend.md)

# Citations

[1] [src/lib/container/files.ts](/src/lib/container/files.ts)
[2] [src/lib/container/errors.ts](/src/lib/container/errors.ts)
[3] [src/commands/container.ts](/src/commands/container.ts)
[4] [src/lib/json-types.ts](/src/lib/json-types.ts)
[5] [docs/specs/workspace-ide.md](/docs/specs/workspace-ide.md)
