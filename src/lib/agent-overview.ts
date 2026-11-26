// The Overview's brain: which agents are shown, how they group, their text and every position.
// Pure: plans in (`kunj agent plan`'s items), `AgentOverviewJson` families out. The workspace app's
// Overview window only strokes what this returns, so nothing here may depend on a view.
// Spec: docs/specs/agent-overview.md; mockup docs/workspace-app/design/mockups/overview.html
// (the same constants).

import type {
  AgentOverviewFamilyJson, AgentOverviewLaneJson, AgentOverviewLoopJson, AgentOverviewMarkerJson, AgentOverviewStopJson,
  AgentPlanItemJson, AgentPlanMarkerJson, AgentPlanStepJson, AgentPlanSubagentJson,
} from './json-types';

export const OVERVIEW_METRICS = {
  /** The label column on the left (title, place, status) */
  labelWidth: 248,
  /** x of a root lane's first stop, from the right edge of the label column */
  firstStop: 56,
  stopSpacing: 116,
  /** A lane's height without loops */
  laneHeight: 74,
  /** The line's y inside its lane */
  lineOffset: 40,
  /** A loop's bottom under the line for the first level; each further level adds loopSpacing */
  loopDrop: 30,
  loopSpacing: 38,
  /** Room under a loop's bottom for its label */
  loopLabelHeight: 24,
  /** What a marker's label takes when it goes under the loops of its lane */
  markerLabelHeight: 22,
  /** A character's width in a marker's label (mono 10), and the label's padding, to tell when it would cover a loop */
  markerCharWidth: 6.2,
  markerLabelPadding: 16,
  /** Space right of the last stop */
  trailing: 150,
  /** A character's width in the label of a lane with no steps, to make room for it */
  loneLabelCharWidth: 6.4,
} as const;

export type OverviewMetrics = { [K in keyof typeof OVERVIEW_METRICS]: number };

const isWaiting = (p: AgentPlanItemJson): boolean => p.running !== false && p.state === 'waiting';

/** The agents running: an ended session is left out, one whose state is unknown (no tmux) is kept. */
export function activePlans(plans: AgentPlanItemJson[]): AgentPlanItemJson[] {
  return plans.filter(p => p.running !== false);
}

/** An ended agent's last plan is shown for this long after its last change. */
export const ENDED_PLAN_DAYS = 3;

const placeOf = (p: AgentPlanItemJson): string => p.container ? `c:${p.container}` : `w:${p.worktree}`;

/**
 * The ended agents whose last plan is still shown (dimmed): the newest of each place (worktree or
 * container) that has no running agent, with steps, changed in the last ENDED_PLAN_DAYS. So a restart
 * or a suspended session keeps its line, and old conversations do not pile up.
 */
export function endedPlans(plans: AgentPlanItemJson[], now: number = Date.now()): AgentPlanItemJson[] {
  const busy = new Set(activePlans(plans).map(placeOf));
  const newest = new Map<string, AgentPlanItemJson>();
  for (const p of plans) {
    if (p.running !== false || !p.steps.length || busy.has(placeOf(p))) continue;
    const at = p.updatedAt ? Date.parse(p.updatedAt) : NaN;
    if (!(at >= now - ENDED_PLAN_DAYS * 86_400_000)) continue;
    const seen = newest.get(placeOf(p));
    if (!seen || (seen.updatedAt ?? '') < (p.updatedAt ?? '')) newest.set(placeOf(p), p);
  }
  return plans.filter(p => [...newest.values()].includes(p));
}

export interface OverviewFamily {
  /** `parent`: index into the same array of the lane this one branches off; null for the root */
  lanes: Array<{ plan: AgentPlanItemJson; parent: number | null }>;
}

/**
 * Groups plans by `parent.session`. A plan whose parent is not listed (it ended) is a root. Order:
 * roots as given, each followed by its children depth first. A parent cycle (which kunj never
 * writes) loses nobody: its first member not yet placed starts a family.
 */
export function overviewFamilies(plans: AgentPlanItemJson[]): OverviewFamily[] {
  const sessions = new Set(plans.map(p => p.session));
  const children = new Map<string, AgentPlanItemJson[]>();
  const roots: AgentPlanItemJson[] = [];
  for (const p of plans) {
    const parent = p.parent?.session;
    if (parent && parent !== p.session && sessions.has(parent)) children.set(parent, [...(children.get(parent) ?? []), p]);
    else roots.push(p);
  }
  const placed = new Set<string>();
  const add = (plan: AgentPlanItemJson, parent: number | null, lanes: OverviewFamily['lanes']) => {
    if (placed.has(plan.session)) return;
    placed.add(plan.session);
    lanes.push({ plan, parent });
    const index = lanes.length - 1;
    for (const child of children.get(plan.session) ?? []) add(child, index, lanes);
  };
  const families: OverviewFamily[] = [];
  for (const p of [...roots, ...plans]) {
    if (placed.has(p.session)) continue;
    const lanes: OverviewFamily['lanes'] = [];
    add(p, null, lanes);
    families.push({ lanes });
  }
  return families;
}

// ---- text

export function planTitleText(plan: AgentPlanItemJson): string {
  return plan.title?.trim() || plan.branch;
}

/**
 * "feat/x · worktree", "feat/x · container", "handoff · feat/x", with "agent <id>" for one of several.
 * The short part comes first, so a consumer that cuts the end of a long line keeps it: "handoff ·
 * agent two · feat/…" (an indented lane has less room than a root one).
 */
export function planPlace(plan: AgentPlanItemJson, child: boolean): string {
  const extra = plan.id ? ` · agent ${plan.id}` : '';
  return child ? `handoff${extra} · ${plan.branch}` : `${plan.branch} · ${plan.container ? 'container' : 'worktree'}${extra}`;
}

/** "Waiting for input", "Step 3 of 5", "All 5 steps done", "Working" (no task list); "Ended at step 3 of 5" */
export function planStatus(plan: AgentPlanItemJson): string {
  if (isWaiting(plan)) return 'Waiting for input';
  const n = plan.steps.length;
  const ended = plan.running === false;
  if (n === 0) return ended ? 'Ended' : 'Working';
  if (plan.current === null || plan.current >= n) return `${ended ? 'Ended, all' : 'All'} ${n} step${n === 1 ? '' : 's'} done`;
  return `${ended ? 'Ended at step' : 'Step'} ${plan.current + 1} of ${n}`;
}

export function overviewSummary(agents: number, waiting: number): string {
  if (agents === 0) return 'No agents running';
  const base = `${agents} agent${agents === 1 ? '' : 's'}`;
  return waiting === 0 ? base : `${base} · ${waiting} waiting for you`;
}

const folder = (p: string | undefined): string => (p ? p.replace(/\/+$/, '').split('/').pop() || '?' : '?');

/** A marker's label; null for one that is not drawn (`compact`, or a type this version does not know) */
export function markerLabel(marker: AgentPlanMarkerJson): string | null {
  switch (marker.type as string) {
    case 'branch': return `branch: ${marker.from ?? '?'} → ${marker.to ?? '?'}`;
    case 'worktree': return `worktree: ${folder(marker.from)} → ${folder(marker.to)}`;
    case 'fork': return 'fork';
    case 'new': return 'new conversation';
    default: return null;
  }
}

/**
 * "subagent · write tests", with " · done" once it ended. A subagent with no task list (all background
 * ones) shows its activity instead of stops: "· 12 tool calls, now Read" while it runs, "· done, 12 tool
 * calls" after.
 */
export function subagentLabel(sub: AgentPlanSubagentJson): string {
  const name = `subagent · ${sub.task?.trim() || sub.type}`;
  const calls = !sub.steps.length && sub.toolCalls ? `${sub.toolCalls} tool call${sub.toolCalls === 1 ? '' : 's'}` : '';
  if (sub.running) return calls ? `${name} · ${calls}${sub.lastTool ? `, now ${sub.lastTool}` : ''}` : name;
  return `${name} · done${calls ? `, ${calls}` : ''}`;
}

// ---- hover details (every line a consumer shows in a hover card; the times in this machine's zone)

/** "14:02" today, "Nov 25 14:02" another day; null for a missing or bad time */
export function clockText(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) return hm;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${month} ${d.getDate()} ${hm}`;
}

/** "45s", "3m 10s", "2h 5m"; null when either end is missing or the order is wrong */
export function durationText(fromIso: string | null | undefined, toIso: string | null | undefined): string | null {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!(ms >= 0)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

const kindWord = (kind: AgentOverviewStopJson['kind']): string => (kind === 'done' ? 'done' : kind === 'current' ? 'in progress' : 'to do');

/** "Step 3 of 5 · in progress", then when it started and, once done, when it finished and how long it took */
export function stepDetail(step: AgentPlanStepJson, index: number, count: number, kind: AgentOverviewStopJson['kind'],
  now: number, prefix = 'Step'): string[] {
  const lines = [`${prefix} ${index + 1} of ${count} · ${kindWord(kind)}`];
  const started = clockText(step.startedAt, now);
  const finished = clockText(step.completedAt, now);
  const took = durationText(step.startedAt, step.completedAt);
  if (started) lines.push(`Started ${started}`);
  if (finished) lines.push(`Finished ${finished}${took ? ` · took ${took}` : ''}`);
  return lines;
}

/** The subagent's type, task, state, progress, tool calls and where it left and rejoined the line */
export function subagentDetail(sub: AgentPlanSubagentJson): string[] {
  const lines = [`Subagent: ${sub.type}`];
  if (sub.task?.trim()) lines.push(`Task: ${sub.task.trim()}`);
  lines.push(sub.running ? 'Running' : 'Done');
  if (sub.steps.length) {
    const done = sub.steps.filter(s => s.status === 'completed').length;
    lines.push(`${sub.steps.length} step${sub.steps.length === 1 ? '' : 's'}, ${done} done`);
  }
  if (sub.toolCalls) lines.push(`${sub.toolCalls} tool call${sub.toolCalls === 1 ? '' : 's'}${sub.lastTool ? ` · last: ${sub.lastTool}` : ''}`);
  if (sub.fromStep !== null) {
    lines.push(sub.toStep !== null && sub.toStep !== sub.fromStep
      ? `From step ${sub.fromStep + 1} to step ${sub.toStep + 1}` : `Started at step ${sub.fromStep + 1}`);
  }
  return lines;
}

/** What the marker says in full: what happened, from and to (whole paths for a worktree), and when */
export function markerDetail(marker: AgentPlanMarkerJson, now: number): string[] {
  const lines: string[] = [];
  switch (marker.type) {
    case 'branch': lines.push('Switched branch', `From: ${marker.from ?? '?'}`, `To: ${marker.to ?? '?'}`); break;
    case 'worktree': lines.push('Moved to another worktree', `From: ${marker.from ?? '?'}`, `To: ${marker.to ?? '?'}`); break;
    case 'fork': lines.push('Forked the conversation'); break;
    case 'new': lines.push('A new conversation (/clear or a fresh start)'); break;
  }
  const at = clockText(marker.at, now);
  if (at) lines.push(`At ${at}`);
  return lines;
}

/** The agent: where it runs, its session, how far it is, its subagents, who handed it the work, its last change */
export function laneDetail(plan: AgentPlanItemJson, parent: AgentPlanItemJson | null, now: number): string[] {
  const lines = [`Branch: ${plan.branch}`];
  lines.push(plan.container ? `Container: ${plan.container}` : `Worktree: ${plan.worktree}`);
  if (plan.id) lines.push(`Agent: ${plan.id}`);
  lines.push(`Session: ${plan.session}`);
  lines.push(planStatus(plan));
  const current = plan.current !== null ? plan.steps[plan.current] : undefined;
  if (current) lines.push(`Now: ${current.subject}`);
  if (plan.subagents.length) {
    const running = plan.subagents.filter(s => s.running).length;
    lines.push(`${plan.subagents.length} subagent${plan.subagents.length === 1 ? '' : 's'}${running ? `, ${running} running` : ''}`);
  }
  if (parent) {
    const at = plan.parent?.step;
    lines.push(`Handed off from “${planTitleText(parent)}”${at !== null && at !== undefined ? ` at step ${at + 1}` : ''}`);
  }
  const changed = clockText(plan.updatedAt, now);
  if (changed) lines.push(`Last change ${changed}`);
  return lines;
}

/**
 * The elbow's label, where the work goes on: "handoff → feat/x" when the new agent has a branch of its
 * own, "handoff · agent two" on the same branch (another session of the same worktree or container).
 */
export function handoffLabel(plan: AgentPlanItemJson, parent: AgentPlanItemJson): string {
  if (plan.branch !== parent.branch) return `handoff → ${plan.branch}`;
  return plan.id ? `handoff · agent ${plan.id}` : 'handoff';
}

export function handoffDetail(plan: AgentPlanItemJson, parent: AgentPlanItemJson): string[] {
  const at = plan.parent?.step;
  const lines = [`Handed off from “${planTitleText(parent)}”${at !== null && at !== undefined ? ` at step ${at + 1}` : ''}`];
  lines.push(plan.branch !== parent.branch ? `New branch: ${plan.branch} (from ${parent.branch})` : `Same branch: ${plan.branch}`);
  if (plan.container) lines.push(`Container: ${plan.container}`);
  else if (plan.worktree !== parent.worktree) lines.push(`Worktree: ${plan.worktree}`);
  return lines;
}

// ---- geometry

/** A loop's span in stop indexes: at least one stop wide; a running one reaches the current step. */
export function loopSpan(sub: AgentPlanSubagentJson, current: number | null, stepCount: number): { from: number; to: number } {
  const last = Math.max(0, stepCount - 1);
  const from = Math.min(Math.max(0, sub.fromStep ?? 0), last);
  let to = sub.toStep ?? (sub.running ? (current ?? from) : from);
  to = Math.min(Math.max(to, from), Math.max(last, from));
  if (to === from) to = from + 1;
  return { from, to };
}

/** Levels so that two loops that overlap are not drawn on each other: the first level free at its start. */
export function loopLevels(spans: Array<{ from: number; to: number }>): number[] {
  const ends: number[] = [];
  return spans.map(s => {
    let level = ends.findIndex(end => end <= s.from);
    if (level === -1) level = ends.length;
    ends[level] = s.to;
    return level;
  });
}

const stopKind = (step: AgentPlanStepJson, isCurrent: boolean): AgentOverviewStopJson['kind'] =>
  step.status === 'completed' ? 'done' : isCurrent ? 'current' : 'todo';

/** Subagents grouped by their loop's span, in the order of each span's first one */
export function groupSubagents(subs: AgentPlanSubagentJson[], span: (s: AgentPlanSubagentJson) => { from: number; to: number }):
  Array<{ span: { from: number; to: number }; subs: AgentPlanSubagentJson[] }> {
  const groups = new Map<string, { span: { from: number; to: number }; subs: AgentPlanSubagentJson[] }>();
  for (const sub of subs) {
    const sp = span(sub);
    const key = `${sp.from}:${sp.to}`;
    const g = groups.get(key);
    if (g) g.subs.push(sub); else groups.set(key, { span: sp, subs: [sub] });
  }
  return [...groups.values()];
}

/** A stack shows one dot per subagent up to this many; more, and its bottom fills by the share done */
export const STACK_DOTS = 6;
/** A stack's hover card names at most this many of its subagents */
const STACK_DETAIL_LINES = 12;

/** "5 subagents · 2 running, 3 done", "5 subagents · all done" */
export function subagentStackLabel(subs: AgentPlanSubagentJson[]): string {
  const running = subs.filter(s => s.running).length;
  const done = subs.length - running;
  const state = running === 0 ? 'all done' : done === 0 ? `${running} running` : `${running} running, ${done} done`;
  return `${subs.length} subagents · ${state}`;
}

/** "write tests · running, 12 tool calls, now Read" */
function stackMemberLine(sub: AgentPlanSubagentJson): string {
  const name = sub.task?.trim() || sub.type;
  const calls = sub.toolCalls ? `, ${sub.toolCalls} tool call${sub.toolCalls === 1 ? '' : 's'}` : '';
  const steps = sub.steps.length ? `, ${sub.steps.filter(s => s.status === 'completed').length}/${sub.steps.length} steps` : '';
  return `${sub.running ? '●' : '✓'} ${name} · ${sub.running ? 'running' : 'done'}${steps}${calls}${sub.running && sub.lastTool ? `, now ${sub.lastTool}` : ''}`;
}

/**
 * Several subagents with one span as one loop (`count`): the finished ones first, then the running
 * ones, one dot each (a finished one `done`, a running one `current`), and the bottom drawn as done up
 * to the last finished dot, so the stack reads as a progress bar. Over STACK_DOTS there are no dots
 * and the bottom fills by the share done.
 */
function stackedLoop(subs: AgentPlanSubagentJson[], a: number, b: number, lineY: number, ly: number, now: number): AgentOverviewLoopJson {
  const ordered = [...subs.filter(s => !s.running), ...subs.filter(s => s.running)];
  const done = ordered.filter(s => !s.running).length;
  const running = ordered.length - done;
  let stops: AgentOverviewStopJson[] = [];
  let doneToX: number;
  if (ordered.length <= STACK_DOTS) {
    const sx = (i: number) => a + 24 + (i * (b - a - 48)) / (ordered.length - 1);
    stops = ordered.map((sub, i) => ({ x: sx(i), y: ly, kind: sub.running ? 'current' : 'done', label: sub.task?.trim() || sub.type,
      detail: subagentDetail(sub) }));
    doneToX = running === 0 ? b : done === 0 ? a : sx(done - 1);
  } else {
    doneToX = running === 0 ? b : a + ((b - a) * done) / ordered.length;
  }
  const lines = ordered.slice(0, STACK_DETAIL_LINES).map(stackMemberLine);
  if (ordered.length > STACK_DETAIL_LINES) lines.push(`and ${ordered.length - STACK_DETAIL_LINES} more`);
  const from = ordered[0].fromStep;
  const head = from === null ? 'Ran side by side' : `Ran side by side from step ${from + 1}`;
  return { fromX: a, toX: b, lineY, y: ly, running: running > 0, doneToX, stops, label: subagentStackLabel(ordered),
    detail: [head, ...lines], count: ordered.length };
}

export function layoutFamily(family: OverviewFamily, m: OverviewMetrics = OVERVIEW_METRICS, now: number = Date.now()): AgentOverviewFamilyJson {
  const lanes: AgentOverviewLaneJson[] = [];
  const firstX: number[] = [];
  let top = 0;
  let right = 0;

  family.lanes.forEach((lane, index) => {
    const plan = lane.plan;
    const n = plan.steps.length;
    const y = top + m.lineOffset;

    // a child starts half a stop after the stop it branched from
    let x0 = m.firstStop;
    let elbow: AgentOverviewLaneJson['elbow'];
    if (lane.parent !== null && lane.parent < lanes.length) {
      const parentPlan = family.lanes[lane.parent].plan;
      const at = Math.min(Math.max(0, plan.parent?.step ?? 0), Math.max(0, parentPlan.steps.length - 1));
      const fromX = firstX[lane.parent] + at * m.stopSpacing;
      x0 = fromX + m.stopSpacing / 2;
      elbow = { fromX, fromY: lanes[lane.parent].y, toX: x0, toY: y, label: handoffLabel(plan, parentPlan),
        detail: handoffDetail(plan, parentPlan) };
    }
    firstX.push(x0);
    const x = (i: number) => x0 + i * m.stopSpacing;

    let stops: AgentOverviewStopJson[];
    let lastX: number;
    const labelBeside = n === 0;
    if (labelBeside) {
      // still on the map: one stop saying there is no list
      const label = 'No task list yet';
      stops = [{ x: x0, y, kind: 'current', label, detail: ['The agent has not made a plan for this work yet'] }];
      lastX = x0 + label.length * m.loneLabelCharWidth;
    } else {
      stops = plan.steps.map((step, i) => {
        const kind = stopKind(step, plan.current === i);
        return { x: x(i), y, kind, label: step.subject, detail: stepDetail(step, i, n, kind, now) };
      });
      lastX = x(n - 1);
    }

    // done up to the current stop; with none left, the whole line
    let line: AgentOverviewLaneJson['line'];
    if (n > 1) {
      const c = plan.current;
      line = { fromX: x(0), toX: x(n - 1), doneToX: c !== null && c < n ? (c > 0 ? x(c) : null) : x(n - 1) };
    }

    const markers: AgentOverviewMarkerJson[] = [];
    for (const marker of plan.markers) {
      const label = markerLabel(marker);
      if (label === null) continue;
      const after = marker.afterStep === null ? null : Math.min(Math.max(0, marker.afterStep), Math.max(0, n - 1));
      const mx = after === null ? x0 - m.stopSpacing / 4 : x(after) + m.stopSpacing / 2;
      markers.push({ x: mx, y, labelY: y + 13, label, kind: marker.type as NonNullable<AgentOverviewMarkerJson['kind']>,
        detail: markerDetail(marker, now) });
      lastX = Math.max(lastX, mx);
    }

    // subagents that left and rejoin the line at the same stops (a fan-out) share one stacked loop
    const groups = groupSubagents(plan.subagents, sub => loopSpan(sub, plan.current, n));
    const spans = groups.map(g => g.span);
    const levels = loopLevels(spans);
    const loops: AgentOverviewLoopJson[] = groups.map((group, k) => {
      const a = x(spans[k].from);
      const b = x(spans[k].to);
      const ly = y + m.loopDrop + levels[k] * m.loopSpacing;
      lastX = Math.max(lastX, b);
      if (group.subs.length > 1) return stackedLoop(group.subs, a, b, y, ly, now);
      const sub = group.subs[0];
      const count = sub.steps.length;
      const sx = (i: number) => (count <= 1 ? (a + b) / 2 : a + 24 + (i * (b - a - 48)) / (count - 1));
      const currentSub = sub.running ? sub.steps.findIndex(s => s.status === 'in_progress') : -1;
      const subStops = sub.steps.map((step, i): AgentOverviewStopJson => {
        const kind = stopKind(step, currentSub === i);
        return { x: sx(i), y: ly, kind, label: step.subject, detail: stepDetail(step, i, count, kind, now, 'Subagent step') };
      });
      let doneToX = b;
      if (sub.running) {
        // as far as its current step, else its last finished one; with no steps, none of it
        let reached = currentSub;
        if (reached === -1) sub.steps.forEach((s, i) => { if (s.status === 'completed') reached = i; });
        doneToX = reached === -1 ? a : sx(reached);
      }
      return { fromX: a, toX: b, lineY: y, y: ly, running: sub.running, doneToX, stops: subStops, label: subagentLabel(sub),
        detail: subagentDetail(sub) };
    });

    const levelCount = levels.length ? Math.max(...levels) + 1 : 0;
    const loopRoom = levelCount === 0 ? 0 : m.loopDrop + (levelCount - 1) * m.loopSpacing + m.loopLabelHeight - (m.laneHeight - m.lineOffset) + 12;
    // A marker's label sits just under the line, where a loop's legs go down: one that would cover a
    // loop goes under the deepest loop's label instead (the diamond stays on the line)
    let moved = false;
    if (loops.length) {
      const bottom = Math.max(...loops.map(l => l.y)) + m.loopLabelHeight;
      for (const marker of markers) {
        const half = (marker.label.length * m.markerCharWidth + m.markerLabelPadding) / 2;
        if (loops.some(l => marker.x + half >= l.fromX - 8 && marker.x - half <= l.toX + 8)) {
          marker.labelY = bottom;
          moved = true;
        }
      }
    }
    const height = m.laneHeight + Math.max(0, loopRoom) + (moved ? m.markerLabelHeight : 0);
    lanes.push({
      session: plan.session, id: plan.id, branch: plan.branch, worktree: plan.worktree,
      ...(plan.container ? { container: plan.container } : {}),
      title: planTitleText(plan), place: planPlace(plan, lane.parent !== null), status: planStatus(plan), waiting: isWaiting(plan),
      child: lane.parent !== null, top, height, y, stops, ...(line ? { line } : {}), loops, markers, ...(elbow ? { elbow } : {}), labelBeside,
      ...(plan.running === false ? { ended: true } : {}),
      detail: laneDetail(plan, lane.parent !== null ? family.lanes[lane.parent].plan : null, now),
    });
    top += height;
    right = Math.max(right, lastX);
  });
  return { width: m.labelWidth + right + m.trailing, height: top, lanes };
}

/** Everything `kunj agent overview` prints about the plans: the running agents, grouped and laid out. */
export function buildOverview(plans: AgentPlanItemJson[], m: OverviewMetrics = OVERVIEW_METRICS, now: number = Date.now()): {
  agents: number; waiting: number; summary: string; metrics: { labelWidth: number; stopSpacing: number }; families: AgentOverviewFamilyJson[];
} {
  const active = activePlans(plans);
  const waiting = active.filter(isWaiting).length;
  return {
    agents: active.length, waiting, summary: overviewSummary(active.length, waiting),
    metrics: { labelWidth: m.labelWidth, stopSpacing: m.stopSpacing },
    // the running agents, then the ended ones still shown; the counts are the running ones only
    families: [...overviewFamilies(active), ...overviewFamilies(endedPlans(plans, now))].map(f => layoutFamily(f, m, now)),
  };
}
