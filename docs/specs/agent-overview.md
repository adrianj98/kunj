# Agent overview: where every agent is in its plan

*Design, 2026-11-23. Nothing built yet.* An Overview window in the workspace app with one row per
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
| Probe: what the hooks really deliver (see Unknowns) | To do, first |
| CLI: plan capture in the agent hooks, host and container | To do |
| CLI: `kunj agent plan --json` (`AgentPlanJson`), `plan` action on the `agent` event | To do |
| CLI: parent link for handoffs and `--resume` forks | To do |
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

## Unknowns the probe settles

A throwaway script: start `claude -p` with a hook that appends its stdin to a file, ask it to make
three tasks, start a subagent that makes two, enter plan mode. Then read the file.

1. The `tool_input` of `TaskCreate` / `TaskUpdate` (the docs give no shape) and whether
   `TaskCreated` / `TaskCompleted` alone are enough (they have no "in progress").
2. Whether hooks given with `--settings` run inside subagents (the docs say "settings files").
   If not: write them to a settings file kunj owns and pass its path.
3. Whether `agent_id` is absent on the main agent's calls.
4. Whether a subagent's task ids can collide with the main agent's.

## Capture

The hooks stay dumb, as today (a printf into `KUNJ_AGENT_STATE`): the plan hooks **append the hook's
input, one JSON line, to `KUNJ_AGENT_PLAN`** and kunj does all the reading. A change in Claude Code's
shapes is then a fix in one TypeScript reducer, not in shell.

- File: host `~/.kunj/<repo>/agent-plan/<session>.ndjson`; container `/tmp/kunj-agent-plan` (or
  `-<id>`), next to the state file.
- Hooks added: `PostToolUse` matching `TaskCreate|TaskUpdate|TodoWrite|ExitPlanMode|EnterWorktree|Agent`,
  `SubagentStart`, `SubagentStop`, `CwdChanged`, `SessionStart` (already there for resume; `source`
  is what marks a fork or a compaction).
- Each appended line is followed by one more with the time and `git branch --show-current` in the
  hook's `cwd`. These hooks fire a few times per step, not per tool call, so the git call is cheap.
  `PreToolUse` for every tool stays the printf it is.
- No single quotes in the hook commands (the settings JSON is single-quoted on the command line).
- `SessionEnd` leaves the file: a finished line stays readable. `kunj agent forget` and a new
  `startup` in the same session name truncate it. Size is capped when reading (last 2 MB).

## The reducer

`src/lib/agent-plan.ts`, pure: NDJSON in, one `AgentPlan` out. Unit tested from recorded files.

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
`KUNJ_AGENT_PLAN` in its environment and writes a first line `{ kunj: 'parent', session, step }` into
the new session's file. `--resume` of a saved conversation into a new session name does the same. The
app draws the child as a branch off the parent's line at that step, in its own row.

## CLI contract (additive)

`kunj agent plan [branch] [--session <id>] [--all] --json` → `AgentPlanJson`, on the fast path like
the rest of `kunj agent`; for a container, `kunj ct agent --plan --json` reads the file with one exec.

```ts
interface AgentPlanJson { plans: AgentPlan[] }
interface AgentPlan {
  session: string; branch: string; worktree: string; container?: string;
  title: string | null;
  state: 'running' | 'waiting' | null;
  steps: PlanStep[];
  current: number | null;               // index into steps
  markers: PlanMarker[];                // branch, worktree, fork, compact
  subagents: PlanSubagent[];
  parent?: { session: string; step: number | null };
  updatedAt: string;
}
interface PlanStep { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed';
  startedAt?: string; completedAt?: string }
interface PlanMarker { type: 'branch' | 'worktree' | 'fork' | 'compact'; afterStep: number | null;
  from?: string; to?: string; at: string }
interface PlanSubagent { id: string; type: string; task: string | null; fromStep: number | null;
  toStep: number | null; running: boolean; steps: PlanStep[] }
```

`kunj events`: the `agent` event gains `action: 'plan'` when a plan file changes (the host directory
is watched like `agent-state`; in a container the status script prints the file's size, which joins
the polled status). The app then asks `kunj agent plan` for that session only.

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
