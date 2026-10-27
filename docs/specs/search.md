# Search

*Decided 2026-10-27.* `kunj search` finds text in a repository's worktrees, and on request in its other
branches, its branch containers, its commit messages and its work logs. The workspace app and the VS Code
extension read its `--json` output.

## Status

| Part | State |
| --- | --- |
| CLI: `kunj search`, `SearchJson` | Shipped |
| Workspace app: Search panel | To do (see [Workspace app](#workspace-app)) |
| VS Code extension: quick pick | To do |

## Command

```bash
kunj search <pattern> [paths...] [-e <pattern>] [--in <scopes>] [--all] [-i] [-F] [-w] [-b <branches>] [--current] [--origin] [-m <n>] [--json]
```

| Scope | Default | Searches | How |
| --- | --- | --- | --- |
| `worktrees` | on | every worktree of the repository, uncommitted and untracked files included, ignored ones not | one `git grep --untracked` per worktree, 6 at a time |
| `branches` | off | the committed tree of each local branch without a worktree; `--origin` adds origin's branches with neither a worktree nor a local branch | one `git grep <refs...>` for all of them |
| `containers` | off | `/workspace` of each running branch container of the repository | `git grep` through `ContainerBackend.exec`, as the sandbox user, 4 at a time |
| `commits` | off | commit messages of all local and origin branches (or `--branch` ones) | one `git log --grep` |
| `logs` | off | `~/.kunj/<repo>/work-logs/*.md`, newest first | read in Node |

- `--in` takes a comma-separated list; `--all` is every scope.
- The pattern is an extended regex (`-E`) unless `-F`. `-i` ignores case, `-w` matches whole words. The
  same query goes to every scope: `git grep` gets the flags, `git log` gets `--fixed-strings` /
  `--extended-regexp` / `--regexp-ignore-case`, and `-w`, which `git log` lacks, is applied afterwards.
- `paths` are git pathspecs for the `git grep` scopes. `-e <pattern>` (or `--regexp=<pattern>`) gives the
  pattern as an option, for one that starts with `-`; every argument is then a path. The apps always use it.
- `--branch a,b` limits every scope to those branches; `--current` limits worktrees to the current one.
  The workspace app uses `--branch` to search the selected environment.
- `-m/--max-count` (default 200) is the number of matches kept per worktree, branch or container, and of
  commits and log lines in all. A source with more says `truncated`.
- A completed search exits 0 whether or not something matched; a failure exits 1 (BaseCommand).

### Rules

- **Fast path:** `search` is in `FAST_COMMANDS`. `src/lib/search.ts` imports only `child_process`,
  `fs`, `path` and a type. The container module is imported only for the `containers` scope.
- **No shell:** git is spawned with an argv; the pattern follows `-e`, the paths follow `--`. In a
  container the argv is `sh -c '<fixed script>' <limit> git …`, so the query is never parsed by the shell.
- **Bounded output:** on the host the `git grep` child is killed once the cap is reached; in a container
  `head` cuts the output before it crosses the backend. git's own exit status is printed past `head` on
  fd 3 (`kunj-grep-exit=<n>`): 0 or 1 is fine, above 128 is the SIGPIPE from `head`, anything else is
  reported as the source's `error`.
- **Containers:** a stopped container is not started (it is listed in `containers.stopped`); a snapshot
  build container (`<branch>:snapshot`) is skipped; Docker being down or not answering within 90 s gives
  `containers: { available: false, message }`, never a failed search. Like `kunj ct list`, a running
  container is exec'd in without waiting for READY.
- **Failures stay local:** a worktree or container whose search fails is a source with `error`; the
  others still report. The `branches` scope is one git call, so its failure is one source with
  `branch: null`.
- **Columns** are recomputed in JavaScript from the pattern (characters, not git's bytes) together with
  the match's `length`, for highlighting; when JavaScript cannot read the pattern git's column is kept
  and `length` is 0. Lines are cut to 400 characters.
- `GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false` on every git call.

## JSON

`SearchJson` in src/lib/json-types.ts (additive-only, like the rest of the contract):

```ts
{
  query: { pattern, ignoreCase, fixed, word, paths, maxCount, scopes, branches },
  repoRoot: string,
  searched: { worktrees, branches, containers },   // how many were searched
  sources: Array<{                                   // only those that matched or failed
    kind: 'worktree' | 'branch' | 'container',
    branch: string | null,
    path?, isCurrent?,                               // worktree
    ref?, remote?,                                   // branch: refs/heads/x or refs/remotes/origin/x
    container?,                                      // container name; match paths are relative to /workspace
    matches: Array<{ path, line, column, length, text }>,
    truncated: boolean,
    error?: string,
  }>,
  containers?: { available, message?, stopped: string[] },   // only with the containers scope
  commits?: Array<{ sha, author, date, subject, line, column, length, text }>,
  logs?: Array<{ date, file, line, column, length, text }>,
}
```

## Workspace app

A Search panel for the selected environment. By default it searches that environment only: a
worktree with `kunj search <q> --json --branch <b> --in worktrees`, a container with
`--in containers --branch <b>`. A scope menu widens it to all worktrees, branches, containers, commits
and logs. Results open in an editor tab at the line. Design and status: [workspace-ide.md](workspace-ide.md).

## Not done

- A persistent index (instant queries kept fresh by `kunj events`): not needed while `git grep` answers
  in well under a second on the repositories in use.
- ripgrep: one engine everywhere (host and containers, which have git but not always `rg`).
- Branch metadata (descriptions, tags, notes, PR titles) as a scope.
