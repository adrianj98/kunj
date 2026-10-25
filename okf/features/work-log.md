---
type: Feature
title: Work Log
description: Daily Markdown work logs in ~/.kunj/{reponame}/work-logs/, appended by AI after commits and PRs and read back by kunj log, including standup summaries.
resource: src/lib/work-log.ts
tags: [feature, ai, work-log, standup]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The work log is a running diary of what was done in a repository, one Markdown file per day, written
as a side effect of [AI commits](/features/ai-commit.md) and [pull requests](/features/ai-pr.md). It
exists so a standup ("what did I do yesterday") can be produced without digging through git history.

Files live in `work-logs/` under the per-repo directory from `getKunjDir()` (normally
`~/.kunj/{reponame}/work-logs/YYYY-MM-DD.md`). `src/lib/work-log.ts` handles the files;
`src/commands/log.ts` shows them.

# File format

```md
# Work Log - Saturday, October 25, 2026

## 09:41

[feature] Added login form
- Built form component
- Wired auth endpoint
Files: src/login.tsx, src/api/auth.ts

## 14:02

...PR entry... PR: #42
```

`appendToWorkLog(entry)` writes the date header when the file is new (`formatDateHeader()`, en-US long
date), then `## HH:MM` (local time) and the entry. It rethrows on failure so callers can report it.

# Writers

| Trigger | Generator (in `src/lib/ai-commit.ts`) | Notes |
|---------|----------------------------------------|-------|
| `kunj commit` when the message came from AI | `generateWorkLogEntry(files, message, branch)` | Reads `git show HEAD`; prompt asks for `[tag] summary`, 2-4 short bullets and a `Files:` line, stating what changed, not why |
| `kunj pr` after a PR is created | `generatePRLogEntry(title, body, commits, branch, base)` | Trailing `PR: #` is replaced with the real number |

Both return null when `ai.enabled` is false, so nothing is logged without AI.

# kunj log

| Option | Behaviour |
|--------|-----------|
| (none) | Today's log |
| `-y/--yesterday` | Yesterday's |
| `-d/--date <YYYY-MM-DD>` | A given day |
| `-l/--list` | All log dates, newest first (`getAllWorkLogs()`); `--json`: `{ logs }` |
| `-s/--standup` | Yesterday and today as one-line bullets |
| `--ai` (with `--standup`) | `generateStandupBullets(content, label)` for 5-8 word bullets, falling back to the plain bullets |

A single day with `--json` prints `{ date, content }`. When the requested day has no log the command
lists up to five available dates.

Plain standup bullets come from `parseWorkLogEntries()` (split on `## ` headings into `{ time, content }`)
and `formatAsStandupBullets()` (first sentence, capped at 120 characters).

# Functions

| Function | Purpose |
|----------|---------|
| `getWorkLogDir()` / `initWorkLogDirectory()` | `<kunjDir>/work-logs`, created on demand |
| `getTodayDate()` / `getYesterdayDate()` | Local `YYYY-MM-DD` |
| `getTodayLogPath()` | Today's file path |
| `readTodayWorkLog()` / `readWorkLog(date)` | File contents or null |
| `getAllWorkLogs()` | Dates of all `.md` files, newest first |
| `parseWorkLogEntries()` / `formatAsStandupBullets()` | Standup helpers |

`getTodayDate()` is also used by `kunj team` for dated report file names.

# Related Concepts

* [AI Commit Messages](/features/ai-commit.md)
* [AI Pull Requests](/features/ai-pr.md)
* [Configuration](/architecture/configuration.md) - where the per-repo directory is
* [Integrations](/features/integrations.md) - `kunj team` reports

# Citations

[1] [src/lib/work-log.ts](/src/lib/work-log.ts)
[2] [src/commands/log.ts](/src/commands/log.ts)
[3] [src/lib/ai-commit.ts](/src/lib/ai-commit.ts)
[4] [src/commands/commit.ts](/src/commands/commit.ts)
[5] [src/commands/pr.ts](/src/commands/pr.ts)
