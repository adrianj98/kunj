# Attention sidebar: group sessions by what they need

*Proposed 2026-11-23, not started.* The workspace app's sidebar groups environments by repository. With
several agents running, the question the sidebar should answer is *which one needs me*, and today the
answer is a scan for amber dots across every repository. This adds a second grouping, by state of the
work: **Needs you**, **Working**, **Your review**, **Waiting on others**, **Ready to merge**, **Done**.
Paradev groups the same way (needs attention, working, needs review, idle, merged).

## Status

| Part | State |
| --- | --- |
| CLI: `waitingFor` on agent sessions (permission vs. input) | To do |
| Core: `attentionBucket()`, seen tracking, ordering | To do |
| App: View > Group Sidebar By (Repository default, Attention opt-in), bucket headers, row subtitle with the repository | To do |
| App: dock badge, notification, Next Needing Attention (⌘⌥↓) | To do |

## Buckets

Computed per environment by `attentionBucket(env, seen:)` in Core (pure, unit tested). First match
wins:

| Bucket | When | Why there |
| --- | --- | --- |
| **Needs you** | an agent waits for a permission answer (`waitingFor: permission`); or an agent stopped and the user has not looked since (`waiting` and not seen); or the PR's checks failed (`checks: failure`); or changes were requested (`reviewDecision: CHANGES_REQUESTED`); or a container whose start failed / a missing worktree with open tabs | Nothing moves until the user acts |
| **Working** | any agent session `running` | Leave it alone |
| **Your review** | agents idle (seen) or none, and the branch has work not in a PR: dirty, or ahead of its base, and no open PR | The agent is done; the user reviews and opens a PR |
| **Waiting on others** | open PR, checks pending or green, review required or none given | Out of the user's hands |
| **Ready to merge** | open, not draft, checks green, approved (or `reviewDecision` null: no review rule) | One click left |
| **Done** | PR merged or closed | Clean up; collapsed by default |
| **Idle** | everything else open in the app (clean, no PR, no agent) | Listed last |

A draft PR with green checks counts as **Your review** (it still needs the user to mark it ready).

### Seen

An agent that finished (`Stop` hook → `waiting`) is news until the user looks. The app records, per
environment, when the agent entered `waiting` (the `agent` event's arrival time; the first listing
after launch counts as that time) and when the user last *saw* the environment: it was selected with
the window key for 2 s, or one of its agent tabs had focus. Waiting and seen after it entered waiting →
the agent drops out of **Needs you** into whatever else applies. A permission wait never drops out: it
is not news, it is a blocked agent.

Seen times live in `~/.kunj/<repo>/workspace.json` with the environment's layout (UI state), so a
relaunch does not bring back every finished agent as new.

### Order and membership

- Inside a bucket, most recently entered first. The app tracks when each environment entered its
  current bucket (in memory, seeded from `lastActivity` at launch).
- The bucket of a row is shown by its section; the row's mono line becomes `repo · kind · status verb`
  (the repository is no longer a header). Two repositories with the same branch name stay apart by
  that line.
- Which environments are listed: the open sessions, as today (`isOpen`), plus any environment in
  **Needs you**, **Working** or **Ready to merge** whether open or not. The rest of each repository's
  environments are behind one `N more…` row at the foot of the list, which expands to them grouped by
  repository (the current view).
- ⌘1–9 follow the visible order. The ⌘K search is unchanged: it lists matches flat, then by repo.
- Each bucket header collapses like a repository header does now; **Done** and **Idle** start
  collapsed, remembered in the `collapsedBuckets` default.

## Signals

| Signal | Shown as |
| --- | --- |
| Dock badge | the count of **Needs you** (setting `workspace.badge`, default on) |
| Notification | when an environment enters **Needs you** while the app is not active: `token-refresh needs you — Claude is asking to run npm test` (permission) / `— Claude finished` / `— 2 checks failed`. Setting `workspace.notify`: `off`, `permission` (default: only blocked agents), `all` |
| Next Needing Attention | ⌘⌥↓ selects the next **Needs you** row (wraps), and focuses its agent tab when the cause is an agent |
| Sidebar foot | `3 need you · 2 working` instead of `5 agents running` |

## CLI: `waitingFor`

The hooks cannot tell a permission prompt from a finished turn today: both write `waiting`. The
`Notification` hook's matcher already separates them, so it writes a second word:

- `Stop` → `waiting input`
- `Notification` with `permission_prompt` or `elicitation_dialog` → `waiting permission`
- `Notification` with `idle_prompt` → `waiting input`
- `UserPromptSubmit`, `PreToolUse` → `running` (unchanged)

Readers (`readAgentState()` for the host, `STATUS_SCRIPT`/`parseStatus()` in containers) take the
first word as the state and the second, when there is one, as `waitingFor`. Old files and old
containers write one word and read as `waitingFor` absent. Additive JSON:

```ts
export interface AgentSessionJson {
  // …existing
  /** With state 'waiting': what the agent waits for. Absent when unknown (older hooks, not claude). */
  waitingFor?: 'permission' | 'input';
}
export interface AgentState {
  // …existing
  /** 'permission' when any running session waits for a permission answer, else 'input' when any waits */
  waitingFor?: 'permission' | 'input' | null;
}
// EventJson agent event: waitingFor?: 'permission' | 'input' | null
```

`waitingFor` is also what review-comments.md uses to never paste a prompt into a permission dialog.

The events poll compares `waitingFor` too, so a session going from `waiting input` to
`waiting permission` (it cannot without running first, but a container's 5 s poll can miss the
`running`) still emits an `agent` event.

## App design

- **Core:** `AttentionBucket` enum, `attentionBucket(env:, seenAt:, waitingSince:)`,
  `attentionGroups(repos:, isOpen:, collapsed:, now:)` returning the same `SidebarGroup`-like rows
  (`SidebarSection` with a bucket or a repository), so `SidebarView` draws either. All pure, tested with
  fixtures that cover each row of the bucket table.
- **Model:** `Environment.agentWaitingFor` from the listing and events; `PullRequestInfo` already has
  `checks` and `reviewDecision`.
- **Setting:** View > Group Sidebar By > Repository / Attention (`sidebarGrouping` default,
  `repository`). **Repository is always the default**, for new installs and existing ones; Attention is
  opt-in and remembered once chosen.
- **No extra calls:** every input is already in `worktree list --json`, `ct list --json` and the event
  stream. The bucket of an environment without PR data (`--no-pr`, gh missing) ignores the PR rows.

## Decisions

- **Repository stays the default.** Attention is an opt-in view (decided 2026-11-23); the dock badge,
  notifications and ⌘⌥↓ work in either grouping, since they only need the buckets.
- **A grouping, not a filter.** Nothing is hidden that the repository view shows; it is reordered, and
  the rest is one `N more…` away.
- **Finished agents fade after a look.** Without "seen", a session that finished yesterday would sit in
  Needs you forever; Paradev and Conductor clear it the same way (by viewing).
- **Failed checks and requested changes are "needs you"** even with no agent: they are the commonest
  reason to come back to a branch. The PR panel (pr-panel.md) is where they are acted on.
- **Notifications default to permission only.** A finished turn is frequent; a blocked agent is the
  case that wastes time.

## Open questions

- Should **Working** rows show how long the agent has been running (from the bucket entry time)? Cheap;
  decide when it is on screen.
- An agent waiting `input` that the user saw but did not answer for hours: back to Needs you after a
  while? Probably not; it is the user's choice to leave it.

## Plan

1. CLI: two-word hook state, `waitingFor` in readers, JSON and events; tests (hook settings snapshot,
   parse old and new files, container `parseStatus`).
2. Core: buckets, seen and entry tracking, sections; tests.
3. App: grouping switch, section headers, row subtitle, `N more…`, ⌘1–9 order, foot; demo data and a
   screenshot next to `warm.png`.
4. App: dock badge, notifications (UserNotifications, asked on first switch to a non-`off` setting),
   ⌘⌥↓; Settings › App rows; user docs.

## Code map (planned)

| Piece | Where |
| --- | --- |
| Hook state words | `claudeHookSettings()`, `readAgentState()` in src/lib/agent-session.ts; `STATUS_SCRIPT` and `parseStatus()` in src/lib/container/env.ts |
| JSON | `AgentSessionJson`, `AgentState`, `EventJson` in src/lib/json-types.ts |
| Buckets | workspace-app/Sources/KunjWorkspaceCore/Model/Attention.swift |
| Sidebar | workspace-app/Sources/KunjWorkspace/Views/SidebarView.swift, SidebarRowView.swift |
