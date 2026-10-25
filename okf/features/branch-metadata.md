---
type: Feature
title: Branch Metadata
description: Per-branch descriptions, tags, notes, stash records, PR URL, Jira link and Git Flow state kept in ~/.kunj/{reponame}/branches.json.
resource: src/lib/metadata.ts
tags: [feature, branches, metadata, storage]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Git has no place for "what is this branch for". kunj keeps that in a JSON file per repository,
`branches.json` in the per-repo kunj directory returned by `getKunjDir()` (normally
`~/.kunj/{reponame}/`, shared by all worktrees; see [Configuration](/architecture/configuration.md)).
The file name is the constant `BRANCHES_FILE` in `src/constants/index.ts`.

`src/lib/metadata.ts` is a small read-modify-write store; many commands write into it as a side effect,
and three commands edit it directly.

# Storage

```json
{
  "branches": {
    "feature/x": {
      "description": "Add login form",
      "tags": ["wip"],
      "notes": "waiting on API",
      "lastSwitched": "2026-10-25T09:00:00.000Z",
      "stashes": [{ "ref": "stash@{0}", "message": "kunj-auto-stash-feature/x-1729846800000",
                    "timestamp": "...", "files": 3, "additions": 10, "deletions": 2 }],
      "prUrl": "https://github.com/o/r/pull/12",
      "jiraIssueKey": "PROJ-123"
    }
  }
}
```

`BranchMetadata` (`src/types/index.ts`) fields:

| Field | Written by |
|-------|------------|
| `description` | `branch-desc`, `create`/`switch -c` `--desc`, AI commit (`BRANCH_DESC` in the reply) |
| `tags` | `branch-tag`, `create`/`switch -c` `--tag` |
| `notes` | `branch-note` |
| `relatedIssues` | `kunj issue` (the new issue URL) |
| `lastSwitched` | create, switch (both the old and new branch) |
| `stashes` (`BranchStash[]`) | auto-stash in `src/lib/stash.ts` |
| `prUrl` | `kunj pr`, Git Flow PR mode |
| `jiraIssueKey`, `jiraIssueTitle`, `jiraIssueStatus`, `jiraIssueType` | `kunj create` (key in branch name), `kunj jira link/create` |
| `flowType`, `flowBase`, `flowStatus`, `flowCreated` | `src/lib/git-flow.ts` |

# API

| Function | Behaviour |
|----------|-----------|
| `getBranchesPath()` | `path.join(getKunjDir(), BRANCHES_FILE)` |
| `loadBranchMetadata()` | Calls `initKunjDirectory()`, parses the file; returns `{ branches: {} }` when missing or unreadable |
| `saveBranchMetadata(m)` | Writes pretty JSON (not atomic); logs on failure |
| `getBranchMetadataItem(branch)` | One branch's record or `{}` |
| `updateBranchMetadata(branch, updates)` | Shallow merge into the record and save |

Clearing a field writes `undefined`, which `JSON.stringify` drops.

# Commands

| Command | Arguments / options | Behaviour |
|---------|---------------------|-----------|
| `kunj branch-desc [branch] [description...]` | `-c/--clear` | Set, show or clear the description (default branch: current) |
| `kunj branch-tag [branch] [tags...]` | `-c/--clear`, `-r/--remove <tag>` | Add tags (deduplicated), show, clear or remove one |
| `kunj branch-note [branch] [note...]` | `-c/--clear` | Set, show or clear notes |

All three are defined in `src/commands/branch-metadata.ts` as `BranchDescCommand`, `BranchTagCommand`
and `BranchNoteCommand`.

# Readers

* `kunj list` and `kunj switch` show description, tags, notes and stash summaries, and filter on
  "configured" (has a record) and WIP (`lastSwitched`, stash age, tags) - see [Branch Commands](/features/branch-commands.md).
* `kunj pr` uses description, tags, notes and the Jira key as AI context and `prUrl` to detect an
  existing PR ([AI Pull Requests](/features/ai-pr.md)).
* `kunj prompt-info` reads `prUrl` before asking `gh` ([Shell Integration](/features/shell-integration.md)).
* `kunj jira view` falls back to the linked `jiraIssueKey` ([Integrations](/features/integrations.md)).
* `src/ui/data.ts` loads it for the `kunj ui` dashboard.

# Related Concepts

* [Configuration](/architecture/configuration.md) - `getKunjDir()` and the per-repo directory
* [Branch Commands](/features/branch-commands.md)
* [Integrations](/features/integrations.md) - Jira links, Git Flow state
* [System Overview](/architecture/system-overview.md) - the `~/.kunj` layout

# Citations

[1] [src/lib/metadata.ts](/src/lib/metadata.ts)
[2] [src/commands/branch-metadata.ts](/src/commands/branch-metadata.ts)
[3] [src/types/index.ts](/src/types/index.ts)
[4] [src/constants/index.ts](/src/constants/index.ts)
[5] [src/lib/stash.ts](/src/lib/stash.ts)
[6] [src/commands/create.ts](/src/commands/create.ts)
[7] [src/commands/commit.ts](/src/commands/commit.ts)
[8] [src/commands/issue.ts](/src/commands/issue.ts)
[9] [src/lib/git-flow.ts](/src/lib/git-flow.ts)
