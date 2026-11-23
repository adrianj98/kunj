# PR panel: checks, review threads and merge in the workspace app

*Proposed 2026-11-23; CLI built 2026-11-23, app not started.* A panel in the workspace app that shows the environment's pull
request the way GitHub's PR page would, minus the conversation: what CI says, which review threads are
open, whether it can merge. Every problem it shows has a one-click **hand it to the agent** action. Today
the app shows only `#123 open ✓` in the header and a Create PR button; everything after that happens in
the browser.

## Status

| Part | State |
| --- | --- |
| CLI: `kunj worktree pr [branch] --details --json` (`PullRequestDetailsJson`) | Done |
| CLI: `--failed-log`, `--merge`, `--ready`, `--resolve <thread>` | Done |
| App: PR mode of the right column, next-step banner, refresh policy | To do |
| App: Fix with Agent / Send to Agent (uses `kunj agent send`, [review-comments.md](review-comments.md)) | To do |
| GitLab | Later (`pr-details-unsupported`) |

## What the user sees

The Changes column's bar gets a second toggle, **Changes | PR** (View > Show Pull Request ⌘⇧K). PR mode
replaces the file list and diff with one scrolling panel. With no PR it shows only the **Create Pull
Request…** button (the existing action) and the branch's ahead count.

1. **Header.** `#123 Fix token refresh` (link), state pill (`Draft`, `Open`, `Merged`, `Closed`), base
   ← head, the review decision (`Approved`, `Changes requested`, `Review required`), and GitHub's merge
   state (`Clean`, `Behind`, `Conflicts`, `Blocked`, `Unstable`).
2. **Next step banner.** One suggested action, first match wins:
   | Condition | Banner | Button |
   | --- | --- | --- |
   | Unpushed commits | `2 commits not pushed` | Push (`git push` via a shell tab, so credentials prompts work) |
   | Draft and checks green | `Checks pass; still a draft` | Mark Ready (`--ready`) |
   | A failed check | `2 checks failed` | Fix with Agent |
   | Merge conflicts | `Conflicts with main` | Ask Agent to Rebase |
   | Unresolved threads | `3 unresolved comments` | Send to Agent |
   | Checks running | `4 checks running` | — |
   | Review required | `Waiting for review` | — |
   | Mergeable and approved (or no review rule) | `Ready to merge` | Merge… |
   | Merged | `Merged 2h ago` | Close Session… / Delete Worktree… |
3. **Checks.** One row per check run or status: icon (✓ ✗ … –), name, workflow, duration, a link to
   its page. Failed first, then running, then the rest collapsed under `N passed`. A failed row has
   **Fix with Agent**.
4. **Review threads.** Unresolved first: `path:line` (a click opens the file in the Changes diff at
   that line, or an editor tab when the file is not in the diff), the outdated tag, then each comment
   (author, relative time, Markdown body rendered as plain text with code blocks kept). Buttons:
   **Send to Agent** (this thread), **Resolve**, **Open on GitHub**. A section header button sends every
   unresolved thread at once. Resolved threads collapse under `N resolved`.
5. **Reviews.** A one-line list of reviewers and their latest verdict.
6. **Merge…** opens a sheet: method (squash / merge / rebase; only the ones the repository allows,
   GitHub's default pre-selected), *Delete branch* (default on), and the generated commit title. After a
   merge the environment's row moves to Merged (attention-sidebar.md) and the banner offers cleanup.

### Hand it to the agent

Every "to agent" action builds a prompt and sends it with `kunj agent send` / `kunj ct agent --send`
exactly as review comments do (same target popup, same Send When Idle, same Start Agent with … when
no agent runs):

- **Fix with Agent** (a failed check): `The CI check "<name>" (<workflow>) failed on <sha7>. The end of
  its log:` + the last 150 lines of `--failed-log`, + `Find the cause, fix it, run the check locally if
  you can, and commit.`
- **Send to Agent** (threads): each thread as `## path:line` + the quoted diff hunk GitHub stores + every
  comment with its author, + `Address these review comments, then reply with what you changed for each.`
- **Ask Agent to Rebase:** `Rebase this branch on origin/<base> and resolve the conflicts. Run the tests
  afterwards.`

The prompt texts are settings (`workspace.prompts.fixCheck`, `.reviewThreads`, `.rebase`) so a team
can change the wording. The app never resolves a thread on the agent's behalf; the user clicks
Resolve after reading the change.

## CLI

All on `kunj worktree pr` (fast path, already there), so the extension and the menu bar app can use
them too. Everything goes through `gh` with argv only (no shell), in the worktree's directory.

### `kunj worktree pr [branch] --details --json`

One `gh pr view <number> --json number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,
reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviews,updatedAt,mergedAt` and one
`gh api graphql` for the review threads (`pullRequest.reviewThreads(first: 100)` with `isResolved`,
`isOutdated`, `path`, `line`, `originalLine`, `diffSide`, and `comments(first: 50)` with `author`,
`body`, `createdAt`, `url`, `diffHunk`), run concurrently. The PR number comes from the existing cache
(`getPullRequestForBranch`), so a branch without a PR costs no extra call.

```ts
export interface PullRequestDetailsJson {
  branch: string;
  path: string;
  /** null when the branch has no PR; the other fields are then absent */
  pullRequest: PullRequestInfo | null;
  headSha?: string;
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  /** GitHub's mergeStateStatus, lowercased: clean, behind, blocked, dirty, draft, has_hooks, unstable, unknown */
  mergeState?: string;
  mergedAt?: string | null;
  /** Merge methods the repository allows; the first is its default */
  mergeMethods?: Array<'squash' | 'merge' | 'rebase'>;
  checks?: PullRequestCheckJson[];
  reviews?: Array<{ author: string; state: string; submittedAt: string }>;
  threads?: PullRequestThreadJson[];
  /** From the details cache (see below) */
  fromCache: boolean;
  fetchedAt: string;
}

export interface PullRequestCheckJson {
  name: string;
  workflow: string | null;
  /** queued and in_progress are 'pending' */
  state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | 'cancelled';
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The Actions job id when it is one, for --failed-log */
  jobId: number | null;
}

export interface PullRequestThreadJson {
  id: string;
  path: string;
  /** The line on the PR's head; null when outdated */
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  resolved: boolean;
  outdated: boolean;
  diffHunk: string;
  comments: Array<{ author: string; body: string; createdAt: string; url: string }>;
}
```

`mergeMethods` comes from `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`,
cached per repository for a day in the same cache file.

**Cache:** `~/.kunj/pr-details-cache.json`, keyed by repository and PR number, kept 20 s, or 5 s while
any check is pending (`--fresh` skips it). Same atomic write as `pr-cache.json`.

Errors: `gh-missing`, `gh-auth` (gh not logged in for the host), `pr-details-unsupported` (GitLab),
`no-pull-request` only for the action flags below.

### Actions

| Flag | Does | JSON |
| --- | --- | --- |
| `--failed-log [--check <name>] [--lines 150]` | `gh run view --job <jobId> --log-failed`, the last N lines (default 150, max 2000) of each failed Actions job, or of the named check; a non-Actions check gives its URL only | `{ checks: [{ name, jobId, url, log: string \| null, truncated }] }` |
| `--ready` | `gh pr ready <n>` | `{ pullRequest }` (fresh) |
| `--merge [--method squash\|merge\|rebase] [--delete-branch] [--subject <s>]` | `gh pr merge <n> --<method> [--delete-branch] [--subject]`; refuses `not-mergeable` unless GitHub says mergeable; never `--admin`, never `--auto` | `{ pullRequest }` |
| `--resolve <threadId>` | `gh api graphql` `resolveReviewThread` | `{ thread: PullRequestThreadJson }` |

`--merge` and `--resolve` act on GitHub as the user, so the app asks first (Merge… sheet, and Resolve
is a button the user clicks per thread). `--delete-branch` deletes the remote branch only; the local
worktree stays until the user deletes it from the banner. Each action invalidates both PR caches.

## App design

- **Model (Core, `PullRequest/PullRequestDetails.swift`):** Codable mirror of the JSON, `nextStep(details,
  env:) -> NextStep` (pure, the table above, unit tested), prompt builders.
- **Refresh:** only while the PR mode is visible for the selected environment: on open, on a `git`
  event of that repository (a push updates the remote ref), on the window becoming key, and every 20 s
  while a check is pending (5 s is the cache; the app does not need it faster). Hidden, it makes no
  calls. A failure keeps the last data with a `Couldn't refresh: <message>` line.
- **The sidebar does not use this.** The listing's `PullRequestInfo` already carries `checks` and
  `reviewDecision`, which is all attention-sidebar.md needs, so the panel costs nothing while closed.
  (One addition is proposed there: `unresolvedThreads` in the listing is *not* added; see Decisions.)
- **Layout:** a mode of the existing Changes column (same width, same toggle placement as Files |
  Search), not a third column: the window already has the terminal, Changes and Files columns, and the
  PR panel and the diff are rarely needed at the same time. Clicking a thread's `path:line` switches
  back to Changes mode at that line.

## Decisions

- **`gh`, not the REST API.** The user's `gh` login is already how kunj reads PRs; no token handling.
- **Threads need GraphQL.** `gh pr view --json` has no review threads with `isResolved`; one GraphQL
  query per refresh is the minimum.
- **No unresolved count in `worktree list`.** It would cost a GraphQL call per PR on every listing (the
  list is one `gh pr list` today). `reviewDecision: CHANGES_REQUESTED` is the listing's proxy.
- **No replying from the app in v1.** Replies are conversation; the agent's commits and a Resolve
  click are the loop. Reply could be `--reply <thread> --body-file` later.
- **Nothing automatic.** No auto-fix of failing checks, no auto-merge. Conductor's "fix failing checks"
  is also a button.

## As built (CLI, 2026-11-23)

- `PullRequestThreadJson` also has `originalLine` (the line an outdated thread was made on), and
  `--failed-log` rows an optional `error` when gh could not read the log. New JSON types:
  `PullRequestJson` (plain `worktree pr --json`), `PullRequestFailedLogJson`, `PullRequestActionJson`
  (`branchDeleted`, `branchDeleteError` for `--merge --delete-branch`), `PullRequestResolveJson`.
- `--merge` passes `--match-head-commit <headSha>`, so it merges only what kunj just read, and refuses a
  draft as `not-mergeable`. `--delete-branch` is a REST `DELETE git/refs/heads/<branch>`, not gh's flag
  (which also deletes the local branch and switches the worktree); a fork's branch is left alone.
- The merge methods are optional: when `gh repo view` fails the details come back without them.
- When the PR listing itself failed (gh missing or logged out), `--details` asks `gh pr view <branch>`
  so gh's error comes back as `gh-missing` / `gh-auth` rather than "no PR".
- Extra error codes: `check-not-found` (`--check` names no check), `bad-merge-method`, `bad-thread-id`.
- Tests use an injected fake `gh` (`Exec`), not one on PATH (src/lib/__tests__/pr-details.test.ts).

## Open questions

- GitHub threads as read-only zones in the Changes diff (they have `path`, `line`, `side`), so they can
  be quoted into a review-comments batch. Cheap once both specs exist; wait for use.
- Deployments and todo lists (Conductor's Checks tab shows them) are left out: no common source.

## Plan

1. CLI `--details` with the GraphQL query and the cache; tests with a fake `gh` on PATH (the existing
   PR lookup tests' pattern); docs-site reference.
2. `--failed-log`, `--ready`, `--merge`, `--resolve`; tests.
3. Core model, `nextStep`, prompt builders; tests.
4. App: Changes | PR toggle, panel, Merge sheet, the "to agent" actions on `kunj agent send`; demo data;
   user docs.

## Code map (planned)

| Piece | Where |
| --- | --- |
| Details, actions, cache | src/lib/pr-details.ts (built); flags in src/commands/worktree.ts (`pr`) |
| JSON | `PullRequestDetailsJson`, `PullRequestCheckJson`, `PullRequestThreadJson` in src/lib/json-types.ts |
| Model | workspace-app/Sources/KunjWorkspaceCore/PullRequest/ |
| Panel | workspace-app/Sources/KunjWorkspace/Views/PullRequestPanel.swift, mode in ChangesColumn.swift |
