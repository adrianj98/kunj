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
| CLI: `kunj agent plan [--all] --json` (`AgentPlanJson`), `kunj ct agent --plan`, `plan: true` on the `agent` event | Shipped |
| CLI: parent link for a start from inside another agent's session (handoff) | Shipped |
| `kunj events` for a container's plan (the record's size in the status script) | To do |
| Workspace app: Overview window | To do |
| Optional `kunj-plan` skill (agent-declared steps) | Later |
| Rewind forks (needs the transcript) | Later, only if wanted |

## Decisions

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
7. **A subagent does not always get the task tools.** In `claude -p` it did; in an interactive session
   started by `kunj agent` it searched for `TaskCreate` and did not find it. Such a subagent is a loop
   with its task text and no stops. Not understood yet.
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

`kunj events`: an `agent` event with `plan: true` when a host record changes (the directory is
watched like `agent-state`). The app then asks `kunj agent plan` again. A container's record is not
in the events yet; the app re-reads it on the container's status events.

## The window

Mockup: [docs/workspace-app/design/mockups/overview.html](../workspace-app/design/mockups/overview.html) (example data, both themes).

Window ▸ Overview. Rows grouped by repository, one per agent session, children indented under their
parent with the branch drawn. Done stops filled, current ringed, pending hollow; amber when the agent
waits on the user. Hover shows the step's subject and times; click on a row opens that agent's tab.
An agent with no task list shows a single stop with its title, so it is still on the map.
Layout maths (stop spacing, subagent loops, long lines scrolling) goes in `KunjWorkspaceCore` so it is
unit tested; checked with `--demo --screenshot`.

## Later

- `kunj-plan` skill: `kunj agent plan set|step` for agent-declared steps that replace the task list.
- Rewind forks from the transcript's parent links.
- A Claude Code plugin with the same hooks for sessions kunj did not start.
