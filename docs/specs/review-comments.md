# Review comments: comment on the diff, send them to the agent

*Proposed 2026-11-23, not started.* In the workspace app's Changes column the user comments on lines of
the agent's diff, like a code review, and sends the batch to the environment's agent as one prompt. This
is the review loop every comparable app has (Conductor, JetBrains Air, the Codex app, Orca; see
[Comparable apps](#comparable-apps)), and the main thing the app lacks today: the only way to give an
agent feedback on its diff is to retype file names and line numbers into its terminal.

## Status

| Part | State |
| --- | --- |
| CLI: `kunj agent send` (host) and `kunj ct agent --send` (container) | To do |
| `AgentSendJson` in json-types.ts | To do |
| Diff page: comment gutter, comment zones, `comments` messages | To do |
| App: drafts per environment, Comments list in the Changes column, Send to agent | To do |
| Re-anchoring after the agent edits a commented file | To do |
| GitHub review threads shown in the diff (from [pr-panel.md](pr-panel.md)) | Later |

## What the user sees

1. **Adding a comment.** Hovering a line in either side of the Changes diff shows a `+` in the glyph
   margin. A click on it, or a selection of lines and **⌘⇧M** (also the diff's context menu, *Add Comment*),
   opens a comment box under the last line: a view zone with a text area, **Comment** (⌘↩) and Cancel.
   A saved comment stays in the diff as a compact zone (author `you`, the text, Edit and Delete on hover),
   and the commented lines get a `raised2` band in the gutter.
2. **The Comments list.** The Changes bar gets a `Comments N` pill once there is a draft. It switches the
   file list to a list of the drafts, grouped by file: `path:line` (or `line–line`), the first line of the
   text, and an `outdated` tag when the lines moved away (see Re-anchoring). A click opens that file in the
   diff and scrolls to the comment.
3. **A general note.** A text field at the top of the list for a comment that is about the whole change
   ("also add a test for the empty case"). It is sent first.
4. **Sending.** **Send to Agent** (⌘⇧↩, filled button at the foot of the list) builds one prompt from the
   note and every draft and sends it with `kunj agent send` / `kunj ct agent --send`:
   - **Which agent:** the environment's agent tab that was focused last; a popup on the button lists the
     others (`claude`, `claude 2`, `antigravity`) when there is more than one running.
   - **None running:** the button reads **Start Agent with Review**: `kunj agent start <b> --detach
     --session <new id> --prompt-file <f>` (worktrees; claude only, as `--prompt-file` is), then the tab
     opens. A container has no detached start: the agent tab opens (`kunj ct agent <b> --session <id>`)
     and the prompt is queued as below until that session reports `waiting` (claude's first `Stop` or
     idle notification), with **Send Now** in the list for an agent that reports no state.
   - **Agent working** (`state: running`): the button reads **Send When Idle**. The app keeps the prompt
     and sends it on the first `agent` event that reports this session `waiting`; the pill shows
     `Queued`. Cancel from the list's foot. Nothing is typed into an agent that is in the middle of a
     tool call.
   - After a send the drafts are marked **sent** (collapsed, struck through in the list, their zones
     dimmed) and the agent tab is selected. They are removed on the next send, by **Clear Sent**, or when
     the environment is closed.
5. **Copy as Prompt** (in the button's menu) puts the same text on the clipboard, for an agent the app
   does not run.

Comments are per environment and per scope: a comment made on *vs origin/main* stays when the scope
changes, and is shown in any scope whose diff still contains its file.

## The prompt

Plain Markdown that any agent reads; paths relative to the worktree root (also in a container, where
the root is `/workspace`):

````markdown
Review comments on your changes (vs origin/main, 3 comments). Address each one, then stop.

General: also add a test for the empty case.

## src/lib/token.ts:42-45
```ts
  if (!token) {
    return null;
  }
```
Throw `TokenError('missing')` here instead; callers already handle it.

## src/lib/token.ts:88 (old line, removed)
```ts
  cache.clear();
```
Why was this removed? The cache is still read in refresh().
````

- The quoted lines are the commented lines as they are now (the old side's text for a comment on a
  removed line, marked `old line, removed`), at most 30 lines per comment (`…` after).
- An `outdated` comment is sent with the text it was made on and `(this code has changed since)`.
- The whole prompt is capped by the CLI's 256 KB (`MAX_PROMPT_BYTES`); the app refuses earlier with a
  count of how much to cut, which in practice never happens.
- The first line is configurable: `workspace.reviewPromptHeader` (setting, string, `${count}` and
  `${scope}` expanded). Default as above.

## CLI

### `kunj agent send [branch] [--session <id>] --prompt-file <file> [--force] [--json]`

Types a prompt into a running host agent session as one bracketed paste followed by Enter.

1. Find the session like `kunj agent stop` does (`agentSessionName(…, id)`; a session started on an
   earlier branch of the worktree is found by its `@kunj_worktree` tag).
2. Refuse when it is not running (`agent-not-running`), when tmux is missing (`tmux-missing`), when the
   file is over `MAX_PROMPT_BYTES` (`prompt-too-large`) or unreadable (`prompt-not-found`).
3. Refuse when the session's hook state is `running` (`agent-busy`, exit 3), unless `--force`. A session
   with no state (an antigravity agent, hooks off) is sent to.
4. `tmux load-buffer -b kunj-send-<random> -` with the prompt on **stdin** (never in argv, so it is not in
   `ps`), then `tmux paste-buffer -p -d -b kunj-send-<random> -t <session>` (`-p`: bracketed paste, so the
   prompt's newlines do not submit it early; `-d` deletes the buffer), then `tmux send-keys -t <session>
   Enter`. If the paste fails the buffer is deleted (`delete-buffer`) before the error is reported.
5. With `--json`: `AgentSendJson`.

```ts
/** `kunj agent send --json`, `kunj ct agent --send --json` */
export interface AgentSendJson {
  branch: string;
  /** The tmux session the prompt was typed into */
  session: string;
  id: string | null;
  bytes: number;
  /** The session's state just before sending: 'running' only with --force */
  stateBefore: 'running' | 'waiting' | null;
}
```

Errors (`AgentError`, `{ error: { code, message } }` in `--json`): `agent-not-running`, `agent-busy`,
`tmux-missing`, `prompt-too-large`, `prompt-not-found`, `bad-session-id`.

### `kunj ct agent [branch] [--session <id>] --send <file> [--force] [--json]`

The same in a container: the prompt is streamed on the exec's **stdin** to a fixed script run as the
sandbox user (`tmux load-buffer -b … -` / `paste-buffer -p -d` / `send-keys Enter` against `agent` or
`agent-<id>`), which first reads `/tmp/kunj-agent-state[-<id>]` and exits 3 when it says `running` and
`KUNJ_FORCE` is not set. Nothing is passed with `docker exec -e` except that flag, and the prompt never
appears in argv. Works over remotes and cloud machines like every `ct` exec (`--remote`, wakes a sleeping
machine because it acts).

### Why a CLI verb and not the app typing into its own terminal

The app owns the PTY of each agent tab and could write the bracketed paste itself, but:

- the verb works with no tab open (Start Agent with Review, an agent started by `/handoff` or the CLI),
  and is testable with a fake tmux like the rest of `kunj agent`;
- a container's agent tab is a `kunj ct agent` attach whose PTY is several layers away (remote, machine);
- the busy check reads the same hook state the listing reports, in the same place;
- the app must never do what the CLI cannot (workspace-ide.md).

## App design

- **Diff page (`web/src/app.js`, diff mode).** New calls `window.kunj.setComments({ comments })`
  (each `{ id, side, startLine, endLine, text, state: 'draft' | 'sent' | 'outdated', editing? }` for
  the file shown) and messages `commentAdd { side, startLine, endLine }`, `commentSave { id?, side,
  startLine, endLine, text }`, `commentDelete { id }`. The page draws glyph-margin decorations and one
  view zone per comment (a DOM node in Monaco's zone, styled from the theme tokens); it never keeps
  comments itself, so a re-render after a file switch or a theme change comes from Swift.
  `glyphMargin: true` on both sides of the diff editor; ⌘⇧M and the context-menu action are
  `addAction`s on both editors, like *Go to Definition*.
- **Model (Core, `Review/ReviewComments.swift`).** `ReviewComment { id, envId, path, side, startLine,
  endLine, text, anchor: [String], scope, createdAt, state }` where `anchor` is the commented lines'
  text when it was made. `ReviewStore` holds them per environment; `reviewPrompt(comments:, note:,
  scope:, lines:)` builds the prompt (pure, unit tested with Swift Testing).
- **Persistence.** Drafts are UI state, so they go in `~/.kunj/<repo>/workspace.json` next to the tabs
  (`reviews: { <envId>: { note, comments } }`), written with the layout. Sent comments are not saved.
- **Sending.** `ActionRunner.sendReview(env:)` writes the prompt to a 0600 temp file, runs the verb
  with `--json`, deletes the file. `agent-busy` (a race with the agent starting) turns the send into
  Send When Idle instead of an error.
- **Queued sends** live in memory only; quitting the app with one queued asks (Send Now / Discard /
  Cancel) in the existing quit sheet.

### Re-anchoring

The agent edits the file it was told about, so the commented lines move. On every diff refresh the
app re-anchors each draft on the modified side:

1. The lines at `startLine…endLine` still equal `anchor`: keep.
2. Else the nearest exact occurrence of the whole `anchor` block within ±200 lines: move there.
3. Else `outdated`: shown at its old line number with the tag, never dropped silently.

Comments on the original side (removed lines) are anchored to the base and only go `outdated` when the
scope's base changes.

## Decisions

- **One batch, one prompt.** Comments are drafts until sent together, like a GitHub review, not a
  message per comment: an agent that is sent five prompts in a row answers the first and has the rest
  queued behind its own work.
- **No reply thread in the app.** The agent answers in its terminal; the app does not parse the
  agent's output. A comment is draft → sent → gone.
- **Never into a working agent by default.** Bracketed paste into Claude Code while a tool runs queues
  it, but other agents may not, and a stray Enter can confirm a permission prompt. Hence `agent-busy`
  and Send When Idle. A permission prompt also reports `waiting`; see attention-sidebar.md for
  `waitingFor`, which lets the app refuse to send into a permission prompt (Send When Idle waits for
  `waitingFor: input`).
- **Comments are not posted to GitHub.** That is a review of someone else's PR, a different feature.
  GitHub's own review threads come *in* through the PR panel ([pr-panel.md](pr-panel.md)).

## Open questions

- Should an editor tab (not only the Changes diff) take comments? Cheap with the same page code; left
  out of v1 to keep one entry point.
- A container agent's tab could show `Queued` too; needs the queued state in the tab model, not the
  environment.

## Plan

1. CLI: `kunj agent send`, `kunj ct agent --send`, `AgentSendJson`, tests with the fake tmux and
   `FakeBackend`; docs-site reference (`npm run gen`) and the agents page.
2. Core: `ReviewComment`, `ReviewStore`, `reviewPrompt`, re-anchoring, layout persistence; tests.
3. Diff page: gutter, zones, actions, messages; `--demo` data with two comments for a screenshot.
4. App: Comments pill and list, Send to Agent / Start Agent with Review / Send When Idle, Copy as
   Prompt, quit sheet; user docs (`workspace-app.mdx`).

## Code map (planned)

| Piece | Where |
| --- | --- |
| `kunj agent send` | src/commands/agent.ts, `sendToAgent()` in src/lib/agent-session.ts |
| `kunj ct agent --send` | src/commands/container.ts, `SEND_SCRIPT` in src/lib/container/env.ts |
| JSON | `AgentSendJson` in src/lib/json-types.ts |
| Diff page | workspace-app/web/src/app.js |
| Model, prompt, anchors | workspace-app/Sources/KunjWorkspaceCore/Review/ |
| Column UI | workspace-app/Sources/KunjWorkspace/Views/ChangesColumn.swift, `CommentsList` |

## Comparable apps

Conductor: line comments in its diff viewer become attachments sent with the next chat message.
JetBrains Air: comments on lines or selections in the Changes tab, sent back as follow-up; a separate
agentic review session can write comments too. Codex app and Orca: comment on diff lines and send them
to the agent. None of them lets the comments outlive a running agent the way a CLI verb does.
