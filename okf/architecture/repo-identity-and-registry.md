---
type: Architecture
title: Repo Identity and Registry
description: How kunj names a repository (name, id, origin URL) for derived names, and the ~/.kunj/repos.json registry of repositories behind `kunj repos`.
resource: src/lib/repos.ts
tags: [architecture, repos, registry, identity, macos-app]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Two related questions are answered here. **Who is this repository?** `repoIdentity()` in
`src/lib/repo-identity.ts` gives the name and stable id that container names, network names and agent
tmux session names are derived from. **Which repositories exist?** `~/.kunj/<repo>/` is keyed by name
and does not record where the repository lives, so `src/lib/repos.ts` keeps `~/.kunj/repos.json`, a
registry that tools without a workspace (the [macOS app](/apps/macos-app.md), the
[workspace app](/apps/workspace-app.md), `kunj events`) read to know what to show.

# repoIdentity

```ts
interface RepoIdentity { root: string; name: string; id: string; originUrl: string }
```

| Call | Source | Used by |
|------|--------|---------|
| `repoIdentity({ commonDir, repoRoot })` | Files only: `readOriginUrl(commonDir)` parses `[remote "origin"] url = ...` from `<commonDir>/config` | Worktree listing (agent session names), `kunj agent`, `kunj worktree shell` |
| `repoIdentity()` | Git in the cwd: `getRepoCommonRoot()`, `getOriginUrl()`, `getRepoName()` from `src/lib/config.ts`; throws `Not in a git repository` | Other callers |

* `originUrl` has credentials removed by `stripUserinfo()` (from `src/lib/container/seed.ts`).
* `name` is `repoNameFromUrl(originUrl)`, else the basename of the root without `.git`.
* `id` is `repoIdFromUrl(originUrl || root)` from `src/lib/container/names.ts`: lowercased, scheme and
  `user@` removed, scp-style `host:path` turned into `host/path`, trailing `/` and `.git` removed. It is
  what the `kunj.repo` container label carries ([Naming and Labels](/containers/naming-and-labels.md)).
* `kunjDirName({ root, gitCommonDir })` returns the identity name, i.e. the `~/.kunj/<name>` directory
  as `getKunjDir()` names it; it differs from the folder name for a bare clone or a renamed checkout.

`readOriginUrl()` exists so the worktree listing, which is on the
[fast path](/architecture/fast-path.md), adds no subprocess. It does not apply `insteadOf` rewrites or
`include` files.

# repos.json

```ts
interface KnownRepo {
  root: string;          // main worktree directory (the repository itself when bare)
  gitCommonDir: string;  // the .git directory (the repository itself when bare)
  name: string;          // basename of root, from repoVariables()
  bare: boolean;         // root === gitCommonDir
  hidden?: boolean;
  addedAt: string;
  lastSeen: string;
}
```

Entries are matched by `gitCommonDir` (resolved paths, case-insensitive on Windows). Writes are atomic
(`repos.json.<pid>.tmp` then `rename`). `getReposPath()` is resolved per call so tests can point `HOME`
elsewhere.

| Function | Behaviour |
|----------|-----------|
| `recordRepo(commonDir)` | Adds a new entry or bumps `lastSeen`, but only writes when the entry is new or `lastSeen` is at least `RECORD_INTERVAL_MS` (1 hour) old; never throws |
| `addRepo(commonDir)` | Adds, or un-hides and bumps an existing entry |
| `hideRepo(target)` | Sets `hidden` on the entry whose `root` or `gitCommonDir` matches; the entry is kept so running kunj there again does not bring it back |
| `listRepos({ includeHidden })` | Entries plus `exists` (common dir on disk), most recently seen first |
| `pruneRepos()` | Deletes entries whose common dir is gone, returns them |

# Where Repositories Get Recorded

| Caller | When |
|--------|------|
| `getKunjDir()` (`src/lib/config.ts`) | First resolution in a process |
| `kunj worktree list` | Every listing (`recordRepo(listing.gitCommonDir)`) |
| `kunj worktree session start` | How editor windows reach the list |
| `kunj ct list` | Every listing inside a repository |

# kunj repos

`src/commands/repos.ts` (on the fast path), `kunj repos [action] [path]`:

| Action | Effect | `--json` |
|--------|--------|----------|
| `list` (default), `-a/--all` includes hidden | Name, root, `[bare]`, `[hidden]`, `[missing]` | `ReposJson`: `{ repos: RepoJson[] }`, each `KnownRepoInfo` plus `kunjName` |
| `add [path]` | Adds the repository containing path (default cwd), via `getGitCommonDir()` | `{ success, repo }` |
| `remove <path>` | Hides it | `{ success, repo }` |
| `prune` | Forgets missing repositories | `{ success, removed }` |
| `github [--owner o] [--all]` | GitHub repositories the gh login can clone, `local` set when a known repository's origin is one (`src/lib/github-repos.ts`) | `GitHubReposJson` |
| `clone <owner/name\|url> [--dir] [--bare\|--no-bare]` | `gh repo clone` into `repos.cloneDir` (bare: `<name>.git` plus a default-branch worktree), then `addRepo()` | `RepoCloneJson` |

Spec: docs/specs/github-clone.md. Errors are `GitHubError` (`gh-missing`, `gh-auth`, `gh-failed`,
`bad-repo`, `clone-exists`, `clone-failed`).

`reposJson()` builds the JSON against `ReposJson` from the [JSON contract](/architecture/json-contract.md).

# Related Concepts

* [Configuration](/architecture/configuration.md) - `getRepoName()`, `getKunjDir()`
* [Naming and Labels](/containers/naming-and-labels.md)
* [Worktree Agents](/features/worktree-agents.md) - session names from the identity
* [Events Stream](/features/events-stream.md)
* [macOS App](/apps/macos-app.md)

# Citations

[1] [src/lib/repo-identity.ts](/src/lib/repo-identity.ts)
[2] [src/lib/repos.ts](/src/lib/repos.ts)
[3] [src/commands/repos.ts](/src/commands/repos.ts)
[4] [src/lib/config.ts](/src/lib/config.ts)
[5] [src/lib/container/names.ts](/src/lib/container/names.ts)
[6] [src/lib/worktree.ts](/src/lib/worktree.ts)
[7] [src/commands/worktree.ts](/src/commands/worktree.ts)
[8] [src/lib/json-types.ts](/src/lib/json-types.ts)
