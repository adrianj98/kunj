# Agent overview: where every agent is in its plan

*Designed 2026-11-23. The CLI side is built; the window is not.* An Overview window in the workspace app with one row per
running agent. Each row is a horizontal subway line: the stops are the steps of the plan the agent is
working through, with the current one marked. Forks, handoffs, subagents and branch changes are drawn
on the line.

```
feature/search  ●━━━●━━━●━━━━━━━━━━━━━◉━━━○      waiting · 4/5 "Wire JSON contract"
                    ┃   ┗━●━━●━━◉━━○━━┛          subagent "write the tests", own steps
                    ┗━━━●━━━◉━━━○                handoff → feature/search-ui, own agent
main ⇄ fix/x    ●━━●━━⇄━━●━━━◉━━━○               switched to fix/x after step 2
```

## Status

| Part | State |
| --- | --- |
| Probe: what the hooks really deliver | Done 2026-11-23, Claude Code 2.1.330 (see What the probe found) |
| CLI: plan capture in the agent hooks, host and container (`agent.plan`) | Shipped |
| CLI: `kunj agent plan [--all] --json` (`AgentPlanJson`), `kunj ct agent --plan`, the `plan` event | Shipped |
| CLI: `kunj agent overview [--containers] --json` (`AgentOverviewJson`): grouping, text and layout | Shipped; run against a recorded live session |
| CLI: parent link for a start from inside another agent's session (handoff) | Shipped |
| `kunj events` for a container's plan: a `plan` event with `container` when the records' size in the status script changes | Shipped |
| Workspace app: Overview window (Window ▸ Overview, ⌘⇧O) | Shipped 2026-11-23: built and tested on a Mac (314 tests), `--demo --overview --screenshot` matches the mockup in both themes, and run against a live agent started by this kunj (steps, current step, branch change, subagent loop) |
| Optional `kunj-plan` skill (agent-declared steps) | Later |
| Rewind forks (needs the transcript) | Later, only if wanted |

## Decisions

- **The CLI is the brain, the app only draws** (asked for by the user, 2026-11-23). `kunj agent
  overview --json` decides which agents are shown, how they group, every text and every position.
  A consumer decodes that and strokes it; the workspace app keeps only the filter buttons, the
  total over several repositories and which lane a click is on. A second consumer (the VS Code
  extension) gets the same picture for free, and the layout is tested where kunj's tests run.
- **Steps come from the agent's own task list, read by hooks.** No skill, no MCP server and no Claude
  Code plugin: kunj already passes hooks to its agents with `claude --settings`
  (`claudeHookSettings()` in src/lib/agent-session.ts). The agent does nothing extra.
- **Subagents show their own steps** (decided by the user), not a plain loop.
- **No transcript reading in v1.** Its format is not documented. The price: a rewind (Esc Esc) is not
  drawn as a dead-end spur.
- Agents not started by kunj (a plain `claude`) are not on the map. A plugin could add them later.

## What Claude Code gives us

From the hooks reference (code.claude.com/docs/en/hooks), checked 2026-11-23:

- `PreToolUse`/`PostToolUse` also fire for a subagent's tool calls, with `agent_id` and `agent_type`
  in the input. `SubagentStart` gives `agent_id`, `agent_type`; `SubagentStop` adds
  `agent_transcript_path` and `last_assistant_message`.
- The task tools are `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`; `TodoWrite` is off by default
  since v2.1.268. There are also `TaskCreated` / `TaskCompleted` events (`task_id`, `task_subject`,
  `task_description`).
- `ExitPlanMode`'s `tool_input` carries `plan` (the Markdown) and `planFilePath`.
- `SessionStart` has `source`: `startup`, `resume`, `clear`, `compact`, `fork`. No field names the
  parent session.
- `CwdChanged` gives `old_cwd`, `new_cwd` (main conversation only). Every hook input has `cwd`.
- `WorktreeCreate` **replaces** worktree creation (the hook must print the path), so kunj must not
  hook it just to observe. A worktree entered with `EnterWorktree` is seen through `PostToolUse` and
  `CwdChanged`; `git worktree add` in Bash fires neither, but `kunj events` reports the worktree.

## What the probe found

Run against Claude Code 2.1.330; the recording is `src/lib/__tests__/fixtures/agent-plan-probe.ndjson`.

1. **Newer models have no task tools by default.** The tools reference keeps `TaskCreate` and friends
   for older models only; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` gives them to every model. `kunj agent`
   sets it together with the plan hooks (`PLAN_ENV`), so `agent.plan` costs the agent the tools'
   definitions in its context. Without it there is nothing to record.
2. `TaskCreate`: `tool_input { subject, description }`, `tool_response.task { id, subject }`.
   `TaskUpdate`: `tool_input { taskId, status?, subject? }`, status `in_progress`, `completed` or
   `deleted`; `tool_response { success, statusChange }`.
3. Hooks given with `--settings` do run inside subagents; their calls carry `agent_id` and
   `agent_type`, the main agent's calls carry neither.
4. A subagent shares the session's task list (its first task got id 2 after the main agent's 1), so
   ids never collide and a task belongs to whoever created it.
5. `SubagentStop` also fires for helper agents that never had a `SubagentStart`; they are ignored.
6. The `Agent` call's `PostToolUse` comes after the subagent ended, so its description is taken from
   `PreToolUse` and matched to the next `SubagentStart` of that type.
7. **A background subagent has no task tools at all** (checked 2026-11-23 on Claude Code 2.1.330): it
   has `TaskStop` only, neither `TaskCreate` nor `TodoWrite`, whatever the session has. A foreground
   subagent gets the session's task tools. An interactive session runs subagents in the background
   by default, so most subagents are a loop with their task text and no stops. What kunj shows for
   them instead is their activity: a `PreToolUse` hook (`subagentToolHookCommand()`) records each of a
   subagent's tool calls as `{"hook_event_name":"SubagentTool","agent_id","tool_name"}` (the main
   agent's calls are passed over: their input has no `agent_id`; the input itself is never copied,
   and an id or name outside `[A-Za-z0-9_.-]` is not written), the reducer counts them per subagent
   (`toolCalls`, `lastTool`; its `SubagentHandback` is not counted) and the loop reads "subagent ·
   survey the files · 12 tool calls, now Read", or "· done, 12 tool calls". Checked live 2026-11-23.
8. tmux outside a UTF-8 locale prints the tabs of `list-sessions -F` as underscores, so the tagged
   listing found no session; it now passes `-u` (also in `kunj sessions`).

## Capture

The hooks stay dumb, as today (a printf into `KUNJ_AGENT_STATE`): each plan hook **appends one JSON
line to `KUNJ_AGENT_PLAN`**, `{"kunj":{"t":<unix s>,"branch":"<current branch>"},"hook":<its input>}`
(`planHookCommand()`), and kunj does all the reading. A change in Claude Code's shapes is then a fix
in one TypeScript reducer, not in shell. One printf per event, so two agents appending at once do not
interleave.

- File: host `~/.kunj/<repo>/agent-plan/<session>.ndjson`; container `/tmp/kunj-agent-plan` (or
  `-<id>`), next to the state file.
- Hooks added (`claudeHookSettings(true)`): `PostToolUse` matching
  `TaskCreate|TaskUpdate|TodoWrite|ExitPlanMode`, `PreToolUse` matching `Agent|Task`, `SubagentStart`,
  `SubagentStop`, `CwdChanged`, and a second `SessionStart` hook. A few events per step, never one
  per tool call.
- No single quotes in the hook command (the settings JSON is single-quoted on the command line).
- `kunj agent start` empties the record for a new conversation and keeps it for `--resume`;
  `kunj agent forget` removes it. `SessionEnd` leaves it, so a finished line stays readable.
- `agent.plan` (default true) turns the hooks, the variable and the task tools off together.

## The reducer

`reducePlan()` in `src/lib/agent-plan.ts`, pure: the record's text in, one plan out. Unit tested from the probe's recording.

- **Steps:** tasks in creation order; status `pending` / `in_progress` / `completed`; the current
  step is the first `in_progress`, else the first `pending` after the last completed one.
  A deleted task disappears; a task added later is appended (the line grows).
- **Title:** the first heading of the last `ExitPlanMode` plan, else the session's first prompt
  (as `kunj agent saved` already has).
- **Subagents:** lines with an `agent_id` build that subagent's own step list, attached to the
  parent step that was current at `SubagentStart`, closed at `SubagentStop`. One with no tasks is a
  loop with only its task text (the `Agent` call's description).
- **Branch change:** the branch on a line differs from the one before: a `branch` marker after the
  current step. **Worktree change:** `CwdChanged` into another worktree: a `worktree` marker.
- **Fork:** `SessionStart` with `source: fork` marks the line as a copy; `compact` and `clear` are
  kept as markers, not drawn in v1.

## Parent links

`kunj agent start` run from inside an agent's session (the `/handoff` skill) sees the parent's
`KUNJ_AGENT_PLAN` in its environment and writes a first line `{ kunj: { parent: { session, step } } }`
into the new session's record (`parentLine()`), which a new conversation in that session keeps. The
app draws the child as a branch off the parent's line at that step, in its own row. A fork of one
conversation into a second session is not linked yet: `SessionStart` names no parent.

## CLI contract (additive)

`kunj agent plan [branch] [--session <id>] [--all] --json` → `AgentPlanJson` (json-types.ts):
`plans[]` of `{ session, id, branch, worktree, container?, title, running, state, steps[], current,
markers[], subagents[], parent?, updatedAt }`. `--all` is every worktree of the repository and needs
no current worktree. A session is listed while it runs (with no steps when nothing is recorded) and,
once ended, while its record exists. `kunj ct agent [branch] --plan [--session <id>] --json` gives the
same for a branch container, with one exec (`CONTAINER_PLAN_SCRIPT`); nothing for a stopped one.

`kunj agent overview [--containers] --json` → `AgentOverviewJson`: `repo`, `agents`, `waiting`,
`summary`, `metrics { labelWidth, stopSpacing }`, `families[]` of `{ width, height, lanes[] }`, and with
`--containers` `containers { available, message? }`. A lane carries its identity (`session`, `id`,
`branch`, `worktree`, `container?`), its three label lines (`title`, `place`, `status`), `waiting`,
`child`, and its drawing: `top`, `height`, `y`, `stops[]` (`x`, `y`, `kind` done/current/todo, `label`),
`line?` (`fromX`, `toX`, `doneToX`), `loops[]`, `markers[]`, `elbow?`, `labelBeside`. Points, y down;
inside a family x starts at the right edge of the label column and y at the family's top. It is built
by `buildOverview()` in `src/lib/agent-overview.ts` (pure, tested): `activePlans()` drops ended
sessions, `overviewFamilies()` puts a handed-off agent under its parent (one whose parent ended is a
root), `layoutFamily()` places everything (stops 116 apart, a child half a stop after the stop it
branched from, overlapping loops stacked in levels, a marker's label under the line, or under the
loops when it would cover one's legs). `--containers`
lists the repository's containers across its backends (`ContainerCommand.listJson`), reads the plans
of the running ones that have an agent (`agentPlansJson`, each on its own backend), and gives up on
them after 8 s: Docker down or slow is `available: false`, never a failed overview.

`kunj events`: `{ type: 'plan', session, repo }` when a host record changes (the directory is watched
like `agent-state`), and `{ type: 'plan', container, branch, repo }` when a container's records change
(the status poll's script prints their size, `plan=<bytes>`, `ContainerStatus.planBytes`). It is a type
of its own on purpose: there are several per step of work, an `agent` or `container` event would make
every consumer that does not draw plans run a listing, and it says nothing about what runs.

## Review fixes (2026-11-23)

From a code review of the CLI side, each with a test:

- `currentStep()`: tasks finished out of order no longer read as "all done" while one is pending.
- `kunj agent plan`: a session tagged with another worktree is not also listed, by its name, under the
  worktree that now has its branch; one item per session.
- The plan variables go to the agent's session only (`new-session -e`), never to the tmux client's
  environment: a client that starts the tmux server would hand them to every later session, and an
  agent started from any pane would look handed off.
- `kunj ct agent --plan` and the overview never wake a cloud machine, and find a branch's machine
  through a coordinator; a container that could not be read is named in `containers.unreadable`.
- A reattach after a failed tmux listing no longer empties the running agent's record.
- `TodoWrite` from a subagent whose start was not recorded replaces its list instead of doubling it.
- `kunj agent forget --all` also removes the record of an ended session with no saved conversation,
  and removing a worktree removes its branch's records.

## The window

Mockup: [docs/workspace-app/design/mockups/overview.html](../workspace-app/design/mockups/overview.html) (example data, both themes).

Window ▸ Overview (⌘⇧O), `OverviewWindow` + `OverviewCanvas` (workspace-app/Sources/KunjWorkspace/Overview).
Rows grouped by repository, one lane per running agent, a handed-off agent under its parent with the
branch drawn. Done stops filled, current ringed (green working, amber waiting), pending hollow. A
stop's tooltip is its subject; a click on a lane opens that agent's tab (`openHandedOffAgent`). An
agent with no task list is one stop, so it is still on the map. All / Waiting / Running filter
families (a family shows when any of its lanes passes).

- **Everything shown comes from `kunj agent overview --containers --json`** (`AgentOverviewJson`),
  one call per listed repository, all at once (`withTaskGroup`); one read at a time, and a request
  during a read runs one more after it. `KunjWorkspaceCore/Overview/AgentOverview.swift` is the
  decoder plus the three things the window does itself: `filterFamilies()` (a family shows when any
  lane passes), `overviewSummary()` (kunj's line for one repository, the totals for several) and
  `laneIndex(at:in:)` for a click. `OverviewCanvas` strokes the positions as given. No layout, no
  grouping and no wording in Swift.
- **Refresh:** `KunjEvent.agentPlan` (a `plan` event, of a host session or of a container) → `EnvironmentStore.onPlanChanged`, which runs no listing; the store's `onChange`
  (an agent started, ended or began waiting); and every 10 s while the window is visible. Changes
  are gathered for 0.3 s.
- **Checking it:** `--demo --overview --screenshot <png>` draws `DemoPlans`, the mockup's agents as kunj lays
  them out. That file and the test fixture are generated: `node workspace-app/scripts/gen-overview-demo.js`
  after `npm run build`, again after any change to the layout or to `AgentOverviewJson`.
- **Pulse:** the current stop of a working agent (not a waiting one) has a ring that grows and fades,
  as in the mockup: a `CAShapeLayer` per stop animated by Core Animation, so the view is never redrawn
  for it (a redraw per frame cost 15-20% CPU; the layers cost nothing measurable). Off while the window
  is closed, minimised or hidden, and with Reduce motion. `--overview` without `--screenshot` opens the
  window after launch, to try it by hand.
- **Keyboard and VoiceOver:** the canvas takes the keys when the window opens; ↑ ↓ choose an agent (Home,
  End), Return or Space opens its tab, a click chooses and opens. The chosen lane has the sidebar's
  selected-row fill, with its border while the keys are there; it is kept by session and repository
  across refreshes. Each lane is an accessibility button named "title, place, status: current step".
  `-overviewSelect <n>` chooses lane n for a screenshot.
- Not done: plan steps for a kunj older
  than this command (`agent plan` is then read as a branch name and the window shows kunj's error).

## Later

- `kunj-plan` skill: `kunj agent plan set|step` for agent-declared steps that replace the task list.
- Rewind forks from the transcript's parent links.
- A Claude Code plugin with the same hooks for sessions kunj did not start.
