---
type: Feature
title: AI Pull Requests
description: kunj pr creates, lists and shows GitHub pull requests through gh, with the title and body drafted by Claude on Bedrock from the branch diff, commits and metadata.
resource: src/commands/pr.ts
tags: [feature, ai, pull-requests, github]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj pr` (`src/commands/pr.ts`) is a GitHub-only wrapper around the `gh` CLI. It exits early with
install instructions when `gh` is missing. Creating a PR drafts the title and description with
`generateAIPRDescription()` (`src/lib/ai-pr.ts`), which uses the Bedrock client and commit-style
prompts from [AI Commit Messages](/features/ai-commit.md).

`src/lib/pr-providers.ts` is a separate GitHub/GitLab abstraction used only by Git Flow's PR mode
([Integrations](/features/integrations.md)); `kunj pr` itself does not use it.

# Usage

| Invocation | Behaviour |
|------------|-----------|
| `kunj pr` | Create a PR for the current branch (or show the existing one) |
| `kunj pr 123` / `kunj pr #123` | Show that PR's status |
| `kunj pr -s/--status` | Status of the current branch's PR (`gh pr view`), checks and reviews; `--detailed` adds GitHub Actions steps |
| `kunj pr -l/--list` | Open PRs (`gh pr list ... --limit 20`); with `--json`, `{ pullRequests }` built from `--limit 50` |

Create options: `-t/--title`, `-b/--body`, `--base`, `-d/--draft`, `-w/--web`, `--no-hooks`.

# Create flow

```
base = --base | preferences.defaultBaseBranch | selectBaseBranch()   (main, master, develop,
                                                                      development, dev present)
current == base ──> error
prUrl in branches.json or `gh pr list --head <branch>` ──> show status, stop
commits = getCommitsSinceBranch(base)
title/body missing:
    ai.enabled && ai.autoGeneratePRDescription && checkAWSCredentials()
        ──> generateAIPRDescription(...)        else generatePrSuggestions() (heuristic)
    inquirer: title (input), body (editor)
pre-pr-create hook
ensurePushed(): git push -u origin <branch> when no upstream, else push if ahead
gh pr create --title ... --body ... --base <base> [--draft] [--web]
save prUrl to branch metadata ──> post-pr-create hook (pr-url)
generatePRLogEntry() ──> appendToWorkLog() with "PR: #<n>"
show status; offer to open in the browser (gh pr view --web)
```

A failing `pre-pr-create` hook stops before anything is pushed ([Hooks](/features/hooks.md)). Work log
failures never fail the PR.

# generateAIPRDescription

`generateAIPRDescription(currentBranch, baseBranch, branchMetadata, commits, diff?)` returns
`{ title, body }`.

| Input | Source / limit |
|-------|----------------|
| Diff | `git diff <base>...HEAD` (`getPRDiff()`), only when `ai.includeDiffInPR`; truncated to 5000 characters |
| Commits | up to `ai.maxContextCommits` when `ai.includeBranchContext` |
| Branch context | description, tags, notes from [Branch Metadata](/features/branch-metadata.md) |
| Jira | `jiraIssueKey` and `jiraIssueTitle` when linked |
| Style | `getCommitStylePrompt()` with `ai.subjectMaxLength` (falls back to 72) |

The reply is parsed from `TITLE:`, `SUMMARY:` and `CHANGES:` sections into a Markdown body. With
`ai.commitStyle` `caveman` a terse prompt is used instead.

The same file also has `generateAIJiraTicket()`, used by `kunj jira create --ai`.

# PR providers (Git Flow)

`PRProvider` has `createPR`, `mergePR` and `checkCLIAvailable`. `getPRProvider('github' | 'gitlab')`
returns `GitHubProvider` (`gh pr create`, `gh pr merge --merge --delete-branch`) or `GitLabProvider`
(`glab mr create`, `glab mr merge --yes`).

# Settings

| Key | Default |
|-----|---------|
| `ai.autoGeneratePRDescription` | `true` |
| `ai.includeDiffInPR` | `true` |
| `preferences.defaultBaseBranch` | `''` |
| plus the `ai.*` keys in [AI Commit Messages](/features/ai-commit.md) | |

# Related Concepts

* [AI Commit Messages](/features/ai-commit.md) - Bedrock client, styles, "Push and create PR"
* [Work Log](/features/work-log.md)
* [PR Lookup Cache](/features/pr-lookup-cache.md) - how worktree listings find PRs (separate code)
* [Shell Integration](/features/shell-integration.md) - `prompt-info` reads the saved `prUrl`
* [Base Branch](/features/base-branch.md)

# Citations

[1] [src/commands/pr.ts](/src/commands/pr.ts)
[2] [src/lib/ai-pr.ts](/src/lib/ai-pr.ts)
[3] [src/lib/pr-providers.ts](/src/lib/pr-providers.ts)
[4] [src/lib/ai-commit.ts](/src/lib/ai-commit.ts)
[5] [src/settings/ai.ts](/src/settings/ai.ts)
