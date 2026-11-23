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
  /** What a marker's label takes before the loops of its lane */
  markerLabelHeight: 22,
  /** Space right of the last stop */
  trailing: 150,
  /** A character's width in the label of a lane with no steps, to make room for it */
  loneLabelCharWidth: 6.4,
} as const;

export type OverviewMetrics = { [K in keyof typeof OVERVIEW_METRICS]: number };

const isWaiting = (p: AgentPlanItemJson): boolean => p.running !== false && p.state === 'waiting';

/** The agents shown: an ended session is left out, one whose state is unknown (no tmux) is kept. */
export function activePlans(plans: AgentPlanItemJson[]): AgentPlanItemJson[] {
  return plans.filter(p => p.running !== false);
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

/** "feat/x · worktree", "feat/x · container", "handoff · feat/x", with "agent <id>" for one of several */
export function planPlace(plan: AgentPlanItemJson, child: boolean): string {
  const extra = plan.id ? ` · agent ${plan.id}` : '';
  return child ? `handoff · ${plan.branch}${extra}` : `${plan.branch} · ${plan.container ? 'container' : 'worktree'}${extra}`;
}

/** "Waiting for input", "Step 3 of 5", "All 5 steps done", "Working" (no task list) */
export function planStatus(plan: AgentPlanItemJson): string {
  if (isWaiting(plan)) return 'Waiting for input';
  const n = plan.steps.length;
  if (n === 0) return 'Working';
  if (plan.current === null || plan.current >= n) return `All ${n} step${n === 1 ? '' : 's'} done`;
  return `Step ${plan.current + 1} of ${n}`;
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
    case 'branch': return `${marker.from ?? '?'} → ${marker.to ?? '?'}`;
    case 'worktree': return `${folder(marker.from)} → ${folder(marker.to)}`;
    case 'fork': return 'fork';
    default: return null;
  }
}

export function subagentLabel(sub: AgentPlanSubagentJson): string {
  return `subagent · ${sub.task?.trim() || sub.type}${sub.running ? '' : ' · done'}`;
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

export function layoutFamily(family: OverviewFamily, m: OverviewMetrics = OVERVIEW_METRICS): AgentOverviewFamilyJson {
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
      elbow = { fromX, fromY: lanes[lane.parent].y, toX: x0, toY: y };
    }
    firstX.push(x0);
    const x = (i: number) => x0 + i * m.stopSpacing;

    let stops: AgentOverviewStopJson[];
    let lastX: number;
    const labelBeside = n === 0;
    if (labelBeside) {
      // still on the map: one stop saying there is no list
      const label = 'No task list yet';
      stops = [{ x: x0, y, kind: 'current', label }];
      lastX = x0 + label.length * m.loneLabelCharWidth;
    } else {
      stops = plan.steps.map((step, i) => ({ x: x(i), y, kind: stopKind(step, plan.current === i), label: step.subject }));
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
      markers.push({ x: mx, y, labelY: y + 13, label });
      lastX = Math.max(lastX, mx);
    }
    const markerRoom = markers.length ? m.markerLabelHeight : 0;

    const spans = plan.subagents.map(sub => loopSpan(sub, plan.current, n));
    const levels = loopLevels(spans);
    const loops: AgentOverviewLoopJson[] = plan.subagents.map((sub, k) => {
      const a = x(spans[k].from);
      const b = x(spans[k].to);
      const ly = y + markerRoom + m.loopDrop + levels[k] * m.loopSpacing;
      const count = sub.steps.length;
      const sx = (i: number) => (count <= 1 ? (a + b) / 2 : a + 24 + (i * (b - a - 48)) / (count - 1));
      const currentSub = sub.running ? sub.steps.findIndex(s => s.status === 'in_progress') : -1;
      const subStops = sub.steps.map((step, i): AgentOverviewStopJson => ({ x: sx(i), y: ly, kind: stopKind(step, currentSub === i), label: step.subject }));
      let doneToX = b;
      if (sub.running) {
        // as far as its current step, else its last finished one; with no steps, none of it
        let reached = currentSub;
        if (reached === -1) sub.steps.forEach((s, i) => { if (s.status === 'completed') reached = i; });
        doneToX = reached === -1 ? a : sx(reached);
      }
      lastX = Math.max(lastX, b);
      return { fromX: a, toX: b, lineY: y, y: ly, running: sub.running, doneToX, stops: subStops, label: subagentLabel(sub) };
    });

    const levelCount = levels.length ? Math.max(...levels) + 1 : 0;
    const loopRoom = levelCount === 0 ? 0 : m.loopDrop + (levelCount - 1) * m.loopSpacing + m.loopLabelHeight - (m.laneHeight - m.lineOffset) + 12;
    // a marker's label fits under the line on its own; it only needs room when loops follow it
    const height = m.laneHeight + (levelCount === 0 ? 0 : markerRoom) + Math.max(0, loopRoom);
    lanes.push({
      session: plan.session, id: plan.id, branch: plan.branch, worktree: plan.worktree,
      ...(plan.container ? { container: plan.container } : {}),
      title: planTitleText(plan), place: planPlace(plan, lane.parent !== null), status: planStatus(plan), waiting: isWaiting(plan),
      child: lane.parent !== null, top, height, y, stops, ...(line ? { line } : {}), loops, markers, ...(elbow ? { elbow } : {}), labelBeside,
    });
    top += height;
    right = Math.max(right, lastX);
  });
  return { width: m.labelWidth + right + m.trailing, height: top, lanes };
}

/** Everything `kunj agent overview` prints about the plans: the running agents, grouped and laid out. */
export function buildOverview(plans: AgentPlanItemJson[], m: OverviewMetrics = OVERVIEW_METRICS): {
  agents: number; waiting: number; summary: string; metrics: { labelWidth: number; stopSpacing: number }; families: AgentOverviewFamilyJson[];
} {
  const active = activePlans(plans);
  const waiting = active.filter(isWaiting).length;
  return {
    agents: active.length, waiting, summary: overviewSummary(active.length, waiting),
    metrics: { labelWidth: m.labelWidth, stopSpacing: m.stopSpacing },
    families: overviewFamilies(active).map(f => layoutFamily(f, m)),
  };
}
