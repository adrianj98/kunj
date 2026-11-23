// Where an agent is in its plan, from what its Claude Code hooks recorded.
//
// kunj's plan hooks (claudeHookSettings() in agent-session.ts) append one JSON line per event to
// the file named by KUNJ_AGENT_PLAN: `{"kunj":{"t":<unix s>,"branch":"<b>"},"hook":<hook input>}`.
// The hooks stay a single printf; everything about Claude Code's shapes is here, in reducePlan(),
// which is pure. Shapes recorded from Claude Code 2.1.330 (src/lib/__tests__/fixtures/).
// Spec: docs/specs/agent-overview.md.

import * as fs from 'fs';
import * as path from 'path';
import type { AgentPlanMarkerJson, AgentPlanStepJson, AgentPlanSubagentJson } from './json-types';

export const CONTAINER_AGENT_PLAN_FILE = '/tmp/kunj-agent-plan';

// The task tools the hooks record. Newer models only have them with CLAUDE_CODE_ENABLE_TODO_TOOLS=1,
// which `kunj agent` sets with the hooks.
export const PLAN_TOOL_MATCHER = 'TaskCreate|TaskUpdate|TodoWrite|ExitPlanMode';
export const PLAN_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } as const;

export function agentPlanDir(kunjDir: string): string {
  return path.join(kunjDir, 'agent-plan');
}

export function agentPlanFile(kunjDir: string, session: string): string {
  return path.join(agentPlanDir(kunjDir), `${session}.ndjson`);
}

// One printf, so a line is one write and two agents appending at once do not interleave. No single
// quotes (the settings JSON is single-quoted on the command line). A branch name with a `"` makes
// a line that does not parse; the reducer skips it.
export function planHookCommand(): string {
  return '[ -z "$KUNJ_AGENT_PLAN" ] || printf "%s\\n" "{\\"kunj\\":{\\"t\\":$(date +%s),\\"branch\\":\\"$(git branch --show-current 2>/dev/null)\\"},\\"hook\\":$(cat)}" >> "$KUNJ_AGENT_PLAN"';
}

// A subagent's tool call, for the activity of a subagent that keeps no task list (a background one
// has no task tools at all). Every PreToolUse runs it; the main agent's calls (no agent_id) cost one
// cat and a case. It never copies the hook input: only the subagent id and the tool name, each cut to
// a safe set of characters, so the record stays small and a value cannot break the line. It looks only
// at the input before its first "tool_input": (Claude Code writes agent_id and tool_name ahead of it),
// so a tool whose own arguments hold an agent_id or tool_name key neither names the subagent nor makes
// a main-agent call look like one. An input that put them after tool_input would record nothing.
// No single quotes (the settings JSON is single-quoted on the command line).
export function subagentToolHookCommand(): string {
  const field = (name: string, chars: string) => String.raw`$(printf %s "$i" | sed -n "s/.*\"${name}\":\"\(${chars}*\)\".*/\1/p" | head -c 64)`;
  const line = String.raw`{\"kunj\":{\"t\":$(date +%s)},\"hook\":{\"hook_event_name\":\"SubagentTool\",\"agent_id\":\"$a\",\"tool_name\":\"$n\"}}`;
  return String.raw`[ -z "$KUNJ_AGENT_PLAN" ] || { i=$(cat); i=${"${"}i%%\"tool_input\":*}; case "$i" in *\"agent_id\":\"*) `
    + `a=${field('agent_id', '[A-Za-z0-9_-]')}; n=${field('tool_name', '[A-Za-z0-9_.-]')}; `
    + String.raw`[ -z "$a" ] || printf "%s\n" "${line}" >> "$KUNJ_AGENT_PLAN";; esac; }`;
}

// The first line of a handed-off session's file: who started it and on which step
export function parentLine(session: string, step: number | null): string {
  return `${JSON.stringify({ kunj: { t: Math.floor(Date.now() / 1000), parent: { session, step } } })}\n`;
}

export interface ReducedPlan {
  title: string | null;
  steps: AgentPlanStepJson[];
  current: number | null;
  markers: AgentPlanMarkerJson[];
  subagents: AgentPlanSubagentJson[];
  parent?: { session: string; step: number | null };
  updatedAt: string | null;
  /** The branch on the last line that had one */
  branch: string | null;
  /** Claude's transcript, for a title when there was no plan mode */
  transcript: string | null;
}

interface Task extends AgentPlanStepJson {
  owner: string | null; // the subagent that created it; null: the session itself
}

const STATUSES = ['pending', 'in_progress', 'completed'];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function currentStep(steps: AgentPlanStepJson[]): number | null {
  const active = steps.findIndex(s => s.status === 'in_progress');
  if (active >= 0) return active;
  let last = -1;
  steps.forEach((s, i) => { if (s.status === 'completed') last = i; });
  // the next one after the last finished; tasks done out of order leave an earlier one, which is then it
  const next = steps.findIndex((s, i) => i > last && s.status === 'pending');
  if (next >= 0) return next;
  const earlier = steps.findIndex(s => s.status === 'pending');
  return earlier >= 0 ? earlier : null;
}

// Where a marker or a subagent attaches: the step in progress, else the last one finished
export function planPosition(steps: AgentPlanStepJson[]): number | null {
  const active = steps.findIndex(s => s.status === 'in_progress');
  if (active >= 0) return active;
  let last: number | null = null;
  steps.forEach((s, i) => { if (s.status === 'completed') last = i; });
  return last;
}

export function planTitle(plan: unknown): string | null {
  if (typeof plan !== 'string') return null;
  const lines = plan.split('\n').map(l => l.trim()).filter(Boolean);
  const heading = lines.find(l => /^#{1,6}\s+\S/.test(l)) ?? lines[0];
  if (!heading) return null;
  const text = heading.replace(/^#{1,6}\s+/, '').replace(/^plan:\s*/i, '').trim();
  return text ? (text.length > 100 ? `${text.slice(0, 99)}…` : text) : null;
}

// The worktree a directory is in: the longest listed root that contains it
function worktreeOf(dir: string | undefined, worktrees: string[]): string | undefined {
  if (!dir) return undefined;
  let best: string | undefined;
  for (const w of worktrees) {
    if ((dir === w || dir.startsWith(w.endsWith('/') ? w : `${w}/`)) && (!best || w.length > best.length)) best = w;
  }
  return best;
}

/** `text`: the recorded lines. `worktrees`: the repository's worktree roots, to tell a move between two. */
export function reducePlan(text: string, worktrees: string[] = []): ReducedPlan {
  let tasks = new Map<string, Task>();
  let order: string[] = [];
  let title: string | null = null;
  let markers: AgentPlanMarkerJson[] = [];
  let subagents = new Map<string, AgentPlanSubagentJson>();
  let pendingTasks: Array<{ type?: string; task: string }> = []; // Agent calls not yet started
  let parent: ReducedPlan['parent'];
  let updatedAt: string | null = null;
  let branch: string | null = null;
  let transcript: string | null = null;

  const mainSteps = (): Task[] => order.map(id => tasks.get(id)!).filter(t => t.owner === null);
  const setStatus = (task: Task, status: unknown, at: string) => {
    if (typeof status !== 'string' || !STATUSES.includes(status) || task.status === status) return;
    task.status = status as Task['status'];
    if (status === 'in_progress') task.startedAt ??= at;
    if (status === 'completed') task.completedAt = at;
  };

  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: any;
    try { line = JSON.parse(raw); } catch { continue; }
    const meta = line?.kunj;
    if (!meta || typeof meta !== 'object') continue;
    const at: string = typeof meta.t === 'number' && isFinite(meta.t) ? new Date(meta.t * 1000).toISOString() : (updatedAt ?? new Date(0).toISOString());
    updatedAt = at;

    if (meta.parent && typeof meta.parent.session === 'string') {
      parent = { session: meta.parent.session, step: typeof meta.parent.step === 'number' ? meta.parent.step : null };
      continue;
    }
    const hook = line.hook;
    if (!hook || typeof hook !== 'object') continue;
    transcript = str(hook.transcript_path) ?? transcript;
    const agent = str(hook.agent_id) ?? null;
    const event = hook.hook_event_name;
    const input = hook.tool_input && typeof hook.tool_input === 'object' ? hook.tool_input : {};

    // A new conversation in the same session starts a new line
    if (event === 'SessionStart' && (hook.source === 'startup' || hook.source === 'clear')) {
      tasks = new Map(); order = []; title = null; markers = []; subagents = new Map(); pendingTasks = [];
    }

    let moved = false;
    if (event === 'CwdChanged') {
      const from = worktreeOf(str(hook.old_cwd), worktrees);
      const to = worktreeOf(str(hook.new_cwd), worktrees);
      if (from && to && from !== to) {
        markers.push({ type: 'worktree', afterStep: planPosition(mainSteps()), from, to, at });
        moved = true;
      }
    }
    const now = str(meta.branch);
    if (now && agent === null) {
      if (branch && now !== branch && !moved) markers.push({ type: 'branch', afterStep: planPosition(mainSteps()), from: branch, to: now, at });
      branch = now;
    }

    if (event === 'SessionStart') {
      if (hook.source === 'fork' || hook.source === 'compact') markers.push({ type: hook.source, afterStep: planPosition(mainSteps()), at });
    } else if (event === 'SubagentStart' && agent) {
      const type = str(hook.agent_type) ?? 'agent';
      let i = pendingTasks.findIndex(p => p.type === type);
      if (i < 0) i = pendingTasks.length ? 0 : -1;
      const task = i >= 0 ? pendingTasks.splice(i, 1)[0].task : null;
      subagents.set(agent, { id: agent, type, task, fromStep: planPosition(mainSteps()), toStep: null, running: true, steps: [] });
    } else if (event === 'SubagentTool' && agent) {
      // only the subagents whose start was recorded; their tool calls say what they are doing
      const sub = subagents.get(agent);
      // its hand-back to the caller is how it ends, not work it did
      if (sub && hook.tool_name !== 'SubagentHandback') {
        sub.toolCalls = (sub.toolCalls ?? 0) + 1;
        const tool = str(hook.tool_name);
        if (tool) sub.lastTool = tool;
      }
    } else if (event === 'SubagentStop' && agent) {
      const sub = subagents.get(agent);
      if (sub) { sub.running = false; sub.toStep = planPosition(mainSteps()); }
    } else if (event === 'PreToolUse' && (hook.tool_name === 'Agent' || hook.tool_name === 'Task')) {
      const task = str(input.description);
      if (task) pendingTasks.push({ type: str(input.subagent_type), task });
    } else if (event === 'PostToolUse' && hook.tool_name === 'TaskCreate') {
      const made = hook.tool_response?.task;
      const id = str(made?.id) ?? (typeof made?.id === 'number' ? String(made.id) : undefined);
      const subject = str(made?.subject) ?? str(input.subject);
      if (id && subject && !tasks.has(id)) {
        tasks.set(id, { id, subject, status: 'pending', owner: agent && subagents.has(agent) ? agent : null });
        order.push(id);
      }
    } else if (event === 'PostToolUse' && hook.tool_name === 'TaskUpdate') {
      const id = str(input.taskId) ?? (typeof input.taskId === 'number' ? String(input.taskId) : undefined);
      const task = id ? tasks.get(id) : undefined;
      if (task && hook.tool_response?.success !== false) {
        if (input.status === 'deleted') {
          tasks.delete(task.id);
          order = order.filter(o => o !== task.id);
        } else {
          if (str(input.subject)) task.subject = input.subject;
          setStatus(task, input.status, at);
        }
      }
    } else if (event === 'PostToolUse' && hook.tool_name === 'TodoWrite' && Array.isArray(input.todos)) {
      // The legacy tool rewrites the whole list: keep the times of entries that are still there
      // the same owner for what is replaced and what replaces it: a subagent whose start was not
      // recorded (a cut record) writes to the session's own list both times
      const owner = agent && subagents.has(agent) ? agent : null;
      const before = [...tasks.values()].filter(t => t.owner === owner);
      for (const t of before) { tasks.delete(t.id); order = order.filter(o => o !== t.id); }
      input.todos.forEach((todo: any, i: number) => {
        const subject = str(todo?.content);
        if (!subject) return;
        const id = `${owner ?? 'todo'}-${i}`;
        const old = before.find(t => t.subject === subject);
        const task: Task = { id, subject, status: 'pending', owner, startedAt: old?.startedAt, completedAt: old?.completedAt };
        if (old) task.status = old.status;
        setStatus(task, todo.status, at);
        if (task.status !== 'completed') delete task.completedAt;
        tasks.set(id, task); order.push(id);
      });
    } else if (event === 'PostToolUse' && hook.tool_name === 'ExitPlanMode' && agent === null) {
      title = planTitle(input.plan) ?? title;
    }
  }

  const clean = ({ owner: _owner, ...step }: Task): AgentPlanStepJson => {
    const out: AgentPlanStepJson = { id: step.id, subject: step.subject, status: step.status };
    if (step.startedAt) out.startedAt = step.startedAt;
    if (step.completedAt) out.completedAt = step.completedAt;
    return out;
  };
  const all = order.map(id => tasks.get(id)!);
  const steps = all.filter(t => t.owner === null).map(clean);
  for (const sub of subagents.values()) sub.steps = all.filter(t => t.owner === sub.id).map(clean);
  return { title, steps, current: currentStep(steps), markers, subagents: [...subagents.values()], ...(parent ? { parent } : {}), updatedAt, branch, transcript };
}

// The recorded session names of a repository (the files of its agent-plan directory)
export function recordedPlanSessions(kunjDir: string): string[] {
  try {
    return fs.readdirSync(agentPlanDir(kunjDir)).filter(f => f.endsWith('.ndjson')).map(f => f.slice(0, -'.ndjson'.length));
  } catch {
    return [];
  }
}

// Removes the records of a branch's sessions (`base` and `base-a-<id>`), e.g. when its worktree is
// removed; returns the sessions whose record went. Never throws.
export function removePlanRecords(kunjDir: string, base: string): string[] {
  const removed: string[] = [];
  for (const session of recordedPlanSessions(kunjDir)) {
    if (session !== base && !session.startsWith(`${base}-a-`)) continue;
    try {
      fs.unlinkSync(agentPlanFile(kunjDir, session));
      removed.push(session);
    } catch { /* already gone */ }
  }
  return removed;
}

// A plan file's text; '' when there is none. Past `maxBytes` only the end is read (a first partial
// line then fails to parse and is skipped), so a huge file costs a bounded read.
export function readPlanFile(file: string, maxBytes = 16 * 1024 * 1024): string {
  try {
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      return buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, size - maxBytes)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// In a branch container: the records are /tmp/kunj-agent-plan (session `agent`) and
// /tmp/kunj-agent-plan-<id> (`agent-<id>`). One exec prints them all, each after a header line
// `#kunj-plan <session> <1|0 tmux session exists> <state>`; a record line starts with `{`.
// ---------------------------------------------------------------------------

export const CONTAINER_PLAN_SCRIPT = `for f in ${CONTAINER_AGENT_PLAN_FILE} ${CONTAINER_AGENT_PLAN_FILE}-*; do [ -f "$f" ] || continue; i=\${f#${CONTAINER_AGENT_PLAN_FILE}}; r=0; tmux has-session -t "=agent$i" 2>/dev/null && r=1; echo "#kunj-plan agent$i $r $(head -c 16 /tmp/kunj-agent-state$i 2>/dev/null)"; cat "$f"; echo; done`;

const CONTAINER_PLAN_HEADER = /^#kunj-plan (agent(?:-([A-Za-z0-9_-]{1,32}))?) ([01])(?: (\S*))?$/;

export interface ContainerPlanRecord {
  session: string;
  id: string | null;
  running: boolean;
  state: 'running' | 'waiting' | null;
  text: string;
}

export function parseContainerPlans(stdout: string): ContainerPlanRecord[] {
  const records: Array<ContainerPlanRecord & { lines: string[] }> = [];
  let current: string[] | null = null;
  for (const line of stdout.split('\n')) {
    const m = CONTAINER_PLAN_HEADER.exec(line);
    if (m) {
      current = [];
      records.push({ session: m[1], id: m[2] ?? null, running: m[3] === '1', state: m[4] === 'running' || m[4] === 'waiting' ? m[4] : null, text: '', lines: current });
    } else if (line.startsWith('#kunj-plan ')) {
      current = null; // a name kunj does not give: skip its record
    } else if (current) {
      current.push(line);
    }
  }
  return records.map(({ lines, ...r }) => ({ ...r, text: lines.join('\n') }));
}
