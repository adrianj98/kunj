---
type: Feature
title: Integrations
description: Jira Cloud, GitHub issues, Slack, the kunj team activity report and Git Flow - the optional integrations around branches and pull requests.
resource: src/lib/jira.ts
tags: [feature, jira, slack, github, git-flow, team]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Besides branches and worktrees, kunj has a set of optional integrations, each off by default or only
active when its CLI or credentials exist:

| Command | Library | External dependency |
|---------|---------|---------------------|
| `kunj jira list/view/link/create` | `src/lib/jira.ts` (`jira.js` `Version3Client`) | Jira Cloud REST API |
| `kunj issue` | - | `gh issue create`, `gh label list` |
| `kunj team` | `src/lib/team-analysis.ts`, `src/lib/slack.ts`, `src/lib/jira.ts` | `gh`, Bedrock, optionally Slack and Jira |
| `kunj flow init/feature/release/hotfix` | `src/lib/git-flow.ts`, `src/lib/pr-providers.ts` | optionally `gh` or `glab` |

There is no `kunj slack` command: Slack is only a data source for `kunj team`, configured through
`kunj config` (which has an interactive channel picker for `slack.channels`).

# Jira

`getJiraClient()` reads `jira.baseUrl`, `jira.email`, `jira.apiToken`, falling back to
`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and caches the client (`clearClientCache()`).

| Subcommand | Behaviour |
|------------|-----------|
| `jira list [--sprint] [--all] [--json]` | JQL on `assignee = currentUser()` (unresolved by default; `--sprint` uses the active sprint of `jira.boardId`). Uses `/rest/api/3/search/jql` directly because `jira.js` lacks it. |
| `jira view [key] [--json]` | Key from the argument, else the branch's `jiraIssueKey`, else `extractJiraKey()` on the branch name |
| `jira link <key>` | Stores `jiraIssueKey/Title/Status/Type` in [Branch Metadata](/features/branch-metadata.md) |
| `jira create [-s] [-t] [-d] [--assign] [--sprint] [--ai/--no-ai]` | Creates an issue (`createIssue()`, `addIssueToSprint()`); with AI (`--ai`, or `jira.aiGeneration` unless `--no-ai`) the ticket is drafted by `generateAIJiraTicket()` from branch commits; then offers to create a branch through `CreateCommand` |

`extractJiraKey()` matches `/[A-Z]+-\d+/`; `generateBranchName(issue, prefix)` returns `<prefix>/<KEY>`.
`kunj create` auto-links a key found in a new branch name when `jira.enabled`.

| Setting | Default |
|---------|---------|
| `jira.enabled` | `false` |
| `jira.baseUrl`, `jira.email`, `jira.apiToken`, `jira.projectKey`, `jira.boardId` | `''` |
| `jira.defaultIssueType` | `Task` |
| `jira.aiGeneration` | `true` |

# GitHub issues

`kunj issue` (`-t/--title`, `-f/--body-file`, `-l/--label`, `--tag`/`--no-tag`, `-w/--web`/`--no-web`)
prompts for title, body and labels (from `gh label list`), runs `gh issue create`, records the issue
URL in the branch's `relatedIssues`, optionally creates a git tag, and offers `gh issue view --web`.

# Team report

`kunj team` (`--no-ai`, `-l/--limit` default 50, `-f/--force`) builds an activity report of open PRs:

```
gh pr list --state open ──> per PR: diff, comments, reviews ──> <kunjDir>/team/diffs, activity
   (unchanged PRs skipped via team/cache.json unless --force)
jira.enabled ──> searchIssues() recent activity     slack.enabled ──> fetchMultiChannelHistory()
   (Slack fetch checkpointed in the cache: lastSlackFetch, cachedSlackMessages)
AI map: per-PR summaries with a small client (ai.modelSmall | BEDROCK_MODEL_SMALL | ai.model,
        temperature 0.3, maxTokens 500)
AI reduce: analyzeTeamActivity() ──> projects ──> generateProjectReport() per project
──> <kunjDir>/team/report-YYYY-MM-DD.md   (--json prints the result)
```

Slack (`getSlackClient()`) uses `slack.token` or `SLACK_BOT_TOKEN` with `@slack/web-api`. Settings:
`slack.enabled` (`false`), `slack.token`, `slack.signingSecret`, `slack.appToken` (`''`), `slack.channels` (`[]`).

# Git Flow

`kunj flow init` asks for main and develop branches, `flow.mode` (`local` merges or `pr`) and
`flow.prProvider` (`github`/`gitlab`). `kunj flow feature|release|hotfix [start|finish] [name]`:

| Type | Starts from | Finish (local mode) | Finish (pr mode) |
|------|-------------|---------------------|------------------|
| feature | develop | merge into develop | merge PR into develop |
| release | develop | merge into main, tag, merge back to develop when `flow.mergeBackToDevelop` | `mergePR` into main, tag, PR main into develop |
| hotfix | main | same as release | same as release |

In PR mode start also pulls the base, pushes the branch and tries to open a PR with `getPRProvider()`
([AI Pull Requests](/features/ai-pr.md)). Branch state goes to `flowType`, `flowBase`, `flowStatus`,
`flowCreated`, `prUrl`. Settings: `flow.enabled` (`false`), `flow.mainBranch` (`main`),
`flow.developBranch` (`develop`), `flow.featurePrefix`/`releasePrefix`/`hotfixPrefix`
(`feature/`, `release/`, `hotfix/`), `flow.autoDeleteOnFinish` (`true`), `flow.mode` (`local`),
`flow.prProvider` (`github`), `flow.mergeBackToDevelop` (`true`).

# Related Concepts

* [Branch Metadata](/features/branch-metadata.md)
* [AI Commit Messages](/features/ai-commit.md) - the Bedrock client
* [AI Pull Requests](/features/ai-pr.md) - `generateAIJiraTicket()`, PR providers
* [Setup and Install](/features/setup-and-install.md) - `kunj setup` offers Jira setup
* [Settings Registry](/architecture/settings-registry.md)

# Citations

[1] [src/lib/jira.ts](/src/lib/jira.ts)
[2] [src/commands/jira.ts](/src/commands/jira.ts)
[3] [src/commands/issue.ts](/src/commands/issue.ts)
[4] [src/commands/team.ts](/src/commands/team.ts)
[5] [src/lib/team-analysis.ts](/src/lib/team-analysis.ts)
[6] [src/lib/slack.ts](/src/lib/slack.ts)
[7] [src/commands/flow.ts](/src/commands/flow.ts)
[8] [src/lib/git-flow.ts](/src/lib/git-flow.ts)
[9] [src/lib/pr-providers.ts](/src/lib/pr-providers.ts)
[10] [src/settings/jira.ts](/src/settings/jira.ts), [src/settings/slack.ts](/src/settings/slack.ts), [src/settings/flow.ts](/src/settings/flow.ts)
