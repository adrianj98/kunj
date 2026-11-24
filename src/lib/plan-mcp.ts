// `kunj agent mcp`: a tiny MCP server (stdio, one JSON-RPC message per line) that every claude kunj
// starts loads through kunj's plugin (claude-plugin/.mcp.json). Its one tool, set_plan, takes the
// agent's whole plan in one call (a few short steps and the one it is on), so keeping the Overview
// current costs the agent a single cheap call per change, like the work-band mod's set_topic. The
// plan is appended to the agent's record ($KUNJ_AGENT_PLAN) as a `KunjPlan` line that reducePlan()
// reads. No imports beyond fs: it is on the fast path and starts with every agent.

import * as fs from 'fs';

export const SET_PLAN_TOOL = 'set_plan';
/** The tool's name as Claude Code shows it: plugin `kunj`, server `kunj` (claude-plugin/.mcp.json) */
export const SET_PLAN_TOOL_ID = 'mcp__plugin_kunj_kunj__set_plan';
export const PLAN_MAX_STEPS = 8;
export const PLAN_STEP_MAX = 80;

const TOOL = {
  name: SET_PLAN_TOOL,
  description: 'Show the user your plan as a line of steps in kunj: two to six short steps (a few words each) and the one '
    + 'you are on now. Each call replaces the whole plan. Call it when you start on something, even short work (one '
    + 'step is fine), and again when you move to the next step or the plan changes. Do not call it when nothing changed.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: PLAN_MAX_STEPS, description: 'The steps in order, a few words each' },
      current: { type: 'integer', minimum: 0, description: 'Index of the step you are on now (0 is the first); the steps before it are done' },
    },
    required: ['steps', 'current'],
  },
};

export interface PlanInput { steps: string[]; current: number }

/** The tool's input checked and tidied, or the reason it is refused. */
export function parsePlanInput(args: unknown): PlanInput | string {
  const a = args as { steps?: unknown; current?: unknown } | null;
  if (!a || !Array.isArray(a.steps)) return 'set_plan takes { steps: string[], current: number }';
  const steps = a.steps
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(s => (s.length > PLAN_STEP_MAX ? `${s.slice(0, PLAN_STEP_MAX - 1)}…` : s));
  if (steps.length === 0) return 'set_plan needs at least one step';
  if (steps.length > PLAN_MAX_STEPS) return `set_plan takes at most ${PLAN_MAX_STEPS} steps`;
  const current = typeof a.current === 'number' && Number.isInteger(a.current) ? a.current : 0;
  return { steps, current: Math.min(Math.max(current, 0), steps.length - 1) };
}

/** The record line for a plan. */
export function planRecordLine(plan: PlanInput, now = Date.now()): string {
  return `${JSON.stringify({ kunj: { t: Math.floor(now / 1000) }, hook: { hook_event_name: 'KunjPlan', steps: plan.steps, current: plan.current } })}\n`;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/**
 * One message in, the reply out (null for a notification). `record`: where the plan goes, undefined
 * when the agent has no record (no tool is listed then).
 */
export function handlePlanMessage(msg: Message, record: string | undefined, version: string,
  append: (file: string, line: string) => void = (f, l) => fs.appendFileSync(f, l)): object | null {
  const reply = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notifications/initialized and the like
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'kunj', version },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: record ? [TOOL] : [] });
    case 'tools/call': {
      if (msg.params?.name !== SET_PLAN_TOOL || !record) return fail(-32602, `Unknown tool ${String(msg.params?.name)}`);
      const plan = parsePlanInput(msg.params?.arguments);
      if (typeof plan === 'string') return reply({ content: [{ type: 'text', text: plan }], isError: true });
      try {
        append(record, planRecordLine(plan));
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `The plan could not be saved: ${(e as Error).message}` }], isError: true });
      }
      const shown = plan.steps.map((s, i) => (i < plan.current ? `✓ ${s}` : i === plan.current ? `▶ ${s}` : `○ ${s}`)).join(' · ');
      return reply({ content: [{ type: 'text', text: `The plan shows: ${shown}` }] });
    }
    default:
      return fail(-32601, `Method not found: ${String(msg.method)}`);
  }
}

/** Serves stdin/stdout until stdin ends. */
export function servePlanMcp(version: string): Promise<void> {
  const record = process.env.KUNJ_AGENT_PLAN || undefined;
  return new Promise(resolve => {
    let buffered = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        let msg: Message;
        try { msg = JSON.parse(line); } catch { continue; }
        const out = handlePlanMessage(msg, record, version);
        if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
      }
    });
    process.stdin.on('end', () => resolve());
  });
}
