---
type: Feature
title: PR Lookup Cache
description: How the worktree listing finds each branch's pull request with one gh or glab call per repository, cached for 60 seconds in ~/.kunj/pr-cache.json.
resource: src/lib/worktree.ts
tags: [feature, worktree, pull-request, github, gitlab, cache]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The [worktree listing](/features/worktrees.md) shows each branch's pull request (number, state, checks,
review decision). Editors and apps refresh that listing often, so kunj never asks per branch: it fetches
every PR/MR of the repository in one `gh pr list` (or `glab mr list`) call, matches branches locally, and
caches the result on disk for 60 seconds. The code is the "Pull requests" section of
`src/lib/worktree.ts`.

Consumers: `kunj worktree list` (worktrees and, with `--containers`, the branch containers), and
`kunj worktree pr`. `src/lib/pr-providers.ts` is unrelated: it is the create/merge abstraction used by
git flow (`git-flow.ts`), and `kunj prompt-info` does its own `gh pr list --head` lookup.

# Fetching

`fetchPullRequests(cwd)` picks the provider from `git config --get remote.origin.url`: `github.com` ->
GitHub, a URL containing `gitlab` -> GitLab, anything else (e.g. GitHub Enterprise) tries GitHub then
GitLab.

| Provider | Command | Mapping |
|----------|---------|---------|
| GitHub | `gh pr list --state all --limit 200 --json number,title,state,url,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt` (env `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`) | `checks` from `summarizeChecks(statusCheckRollup)` |
| GitLab | `glab mr list --all --per-page 100 --output json` | `opened`->`open`; `checks` from `head_pipeline.status`; `reviewDecision` null |

Any failure (CLI missing, not authenticated, not that host) gives `pullRequests: null`.

`summarizeChecks()` returns `failure` if any check concluded FAILURE, ERROR, TIMED_OUT, CANCELLED,
ACTION_REQUIRED or STARTUP_FAILURE; `pending` if any is not completed or has no/pending conclusion;
`success` otherwise; null for an empty rollup.

`pickPullRequest(prs, branch)` takes the PRs whose `headBranch` is the branch, prefers an open one, else
the most recently updated.

```ts
interface PullRequestInfo {
  provider: 'github' | 'gitlab'; number: number; title: string;
  state: 'open' | 'merged' | 'closed'; url: string; draft: boolean;
  baseBranch: string | null; headBranch: string;
  reviewDecision: string | null; checks: 'success' | 'failure' | 'pending' | null; updatedAt: string | null;
}
```

# Cache

| Item | Value |
|------|-------|
| File | `~/.kunj/pr-cache.json` (`PR_CACHE_FILE`, `getPullRequestCachePath()`) |
| Key | normalized absolute git common dir (`git rev-parse --path-format=absolute --git-common-dir`), so all worktrees share one entry |
| Entry | `{ fetchedAt, provider, pullRequests }` |
| TTL | `DEFAULT_PR_MAX_AGE_SECONDS` = 60; `isCacheFresh()` is false for max age <= 0 |
| Eviction | entries older than 24 h are dropped on each write |
| Write | atomic (`<file>.<pid>.tmp` + rename), best effort |

`fetchPullRequestsCached(cwd, maxAge)` returns the entry with `fromCache: true` when fresh, else fetches
and writes. Failed lookups are cached too, so a missing `gh` does not cost a subprocess on every refresh.

# Flags and output

| Flag | Effect |
|------|--------|
| `--no-pr` | `list` skips the lookup; `pullRequestLookup: 'skipped'` |
| `--fresh` | `list`/`pr` pass max age 0, bypassing the cache |

`WorktreeListJson` carries `pullRequestLookup` (`github`, `gitlab`, `unavailable` when the lookup gave
null, or `skipped`) and `pullRequestsFromCache`. Each worktree gets `pullRequest` (null when none) and
`prLabel` (`#<n> <state>`). `listWorktreesDetailed()` also returns the full `pullRequests` array so
`--containers` can label branches that have no worktree. The lookup runs inside the listing's
`Promise.all`, concurrently with git.

`kunj worktree pr [target]` uses `getPullRequestForBranch()` with the same cache (60 s, or 0 with
`--fresh`), prints `{ branch, path, pullRequest }` with `--json`, and `-w` opens the URL with
`open`/`xdg-open`/`start`.

# Related Concepts

* [Worktrees](/features/worktrees.md) - the listing
* [AI pull requests](/features/ai-pr.md) - `kunj pr` and `pr-providers.ts`
* [Shell integration](/features/shell-integration.md) - `prompt-info`
* [JSON contract](/architecture/json-contract.md)

# Citations

[1] [src/lib/worktree.ts](/src/lib/worktree.ts)
[2] [src/commands/worktree.ts](/src/commands/worktree.ts)
[3] [src/lib/pr-providers.ts](/src/lib/pr-providers.ts)
[4] [src/commands/prompt-info.ts](/src/commands/prompt-info.ts)
[5] [src/lib/json-types.ts](/src/lib/json-types.ts)
[6] [CLAUDE.md](/CLAUDE.md)
