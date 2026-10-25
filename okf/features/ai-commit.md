---
type: Feature
title: AI Commit Messages
description: kunj commit stages files interactively and writes the message with Claude on AWS Bedrock (via LangChain ChatBedrockConverse) in one of six commit styles.
resource: src/lib/ai-commit.ts
tags: [feature, ai, bedrock, commit]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`src/lib/ai-commit.ts` is the shared AI layer of kunj: it owns the Bedrock client and the prompts for
commit messages, stash messages, work log entries, PR log entries and standup bullets. `kunj commit`
(`src/commands/commit.ts`) is its main user. [AI Pull Requests](/features/ai-pr.md),
[Work Log](/features/work-log.md), `kunj stash` and `kunj team` reuse `getBedrockClient()`.

The model is whatever `ai.model` says. The default model id is
`anthropic.claude-3-5-sonnet-20240620-v1:0` (Claude 3.5 Sonnet), called through
`ChatBedrockConverse` from `@langchain/aws`. Only Bedrock is implemented: `ai.provider` accepts
`bedrock`, `openai` and `anthropic`, but the code reads it only to display it.

# Bedrock client

| Function | Behaviour |
|----------|-----------|
| `getDefaultModelId()` | `ai.model`, else `BEDROCK_MODEL`, else the Sonnet id above |
| `getAWSRegion()` | `ai.awsRegion`, else the AWS SDK region chain (`loadConfig(NODE_REGION_CONFIG_OPTIONS, ...)`), else `us-east-1`; cached |
| `getBedrockClient()` | One cached `ChatBedrockConverse` with `credentials: defaultProvider()` (env, shared files, SSO, IMDS, ...), `temperature: 0.7`, `maxTokens: 2000` |
| `checkAWSCredentials()` / `getAWSConfigInfo()` | Used to decide whether to offer AI at all |
| `listBedrockModels()` / `validateBedrockModel(id)` | Used by `kunj config` when picking `ai.model`/`ai.modelSmall` |

Newer Claude models need a cross-region inference profile id; `isInferenceProfileError()` detects
that and `logInferenceProfileHelp()` suggests `kunj config set ai.model us.<id>`.

Project context: `getProjectContext()` reads the first of `claude.md`, `.claude.md`, `CLAUDE.md`,
`.claude/context.md`, `README.md` in the current directory, truncated to 1000 characters, once per
process, and prepends it to prompts.

# Generating a commit message

`generateAICommitMessage(files, branchCommits, currentBranch, diff?)`:

1. Throws (and falls back) when `ai.enabled` is false.
2. Takes `git diff --cached`, truncated to 3000 characters.
3. Adds up to `ai.maxContextCommits` branch commits when `ai.includeBranchContext`.
4. Builds the prompt from `getCommitStylePrompt(style, subjectMaxLength, includeBody, customInstructions)`.
5. Asks for `TYPE:`, `MESSAGE:`, optional `BODY:` and `BRANCH_DESC:` lines and parses them with regexes.
6. Formats per style and returns `{ type, message, fullMessage, branchDescription }`.

On any error it returns a heuristic message (`suggestCommitType()` on file names, "Update N files").

# Commit styles

`src/lib/commit-styles.ts` exports `commitStyles` and `getCommitStylePrompt()` (unknown names fall back
to conventional).

| `ai.commitStyle` | Output shape |
|------------------|--------------|
| `conventional` (default) | `type: subject` |
| `semantic` | `[TYPE] subject` |
| `simple` | `subject` |
| `gitmoji` | `<emoji> subject` |
| `caveman` | `type: subject`, ultra-terse prompt |
| `custom` | driven by `ai.customInstructions` |

# kunj commit

Options: `-a/--all`, `-m/--message`, `--amend`, `--auto`, `--no-hooks`.

```
file statuses ─> stage (-a: all; else inquirer checkbox with diff preview; else already staged)
  ─> pre-commit hook
  ─> message: -m | --auto (AI, no prompt) | menu: "AI" or a conventional type + typed subject
  ─> commit-msg hook (message in a temp COMMIT_EDITMSG it may edit)
  ─> createCommit() ─> post-commit hook
  ─> if AI was used: generateWorkLogEntry() ─> appendToWorkLog()
  ─> push / push and create PR / skip   (--auto always pushes; -u origin when no upstream)
```

* An AI reply's `BRANCH_DESC` is saved as the branch description ([Branch Metadata](/features/branch-metadata.md)).
* The AI choice in the menu is disabled (greyed) when `ai.enabled` is off or no AWS credentials are found.
* "Push and create PR" runs `PrCommand.execute()` directly.
* The commit-msg file is only written when a source exists for that hook (`hasHookSources()`); an
  emptied file aborts the commit. See [Hooks](/features/hooks.md).
* `--amend` is declared but the code never reads it.

# Settings

| Key | Default |
|-----|---------|
| `ai.enabled` | `true` |
| `ai.provider` | `bedrock` (display only) |
| `ai.model` | `anthropic.claude-3-5-sonnet-20240620-v1:0` |
| `ai.modelSmall` | `anthropic.claude-3-haiku-20240307-v1:0` (used by `kunj team`) |
| `ai.awsRegion` | `us-east-1` |
| `ai.commitStyle` | `conventional` |
| `ai.subjectMaxLength` | `50` |
| `ai.includeBody` | `true` |
| `ai.includeBranchContext` | `true` |
| `ai.maxContextCommits` | `10` |
| `ai.customInstructions` | `''` |
| `ai.autoGenerateCommitMessage` | `true` (registered; not read by the commit code) |

# Related Concepts

* [AI Pull Requests](/features/ai-pr.md) - reuses the client and the style prompts
* [Work Log](/features/work-log.md) - entries written after an AI commit
* [Hooks](/features/hooks.md) - pre-commit, commit-msg, post-commit
* [Settings Registry](/architecture/settings-registry.md)

# Citations

[1] [src/lib/ai-commit.ts](/src/lib/ai-commit.ts)
[2] [src/lib/commit-styles.ts](/src/lib/commit-styles.ts)
[3] [src/commands/commit.ts](/src/commands/commit.ts)
[4] [src/settings/ai.ts](/src/settings/ai.ts)
[5] [src/commands/config.ts](/src/commands/config.ts)
