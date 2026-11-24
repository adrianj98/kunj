import { handlePlanMessage, parsePlanInput, planRecordLine, SET_PLAN_TOOL } from '../plan-mcp';

describe('kunj agent mcp (set_plan)', () => {
  const lines: string[] = [];
  const append = (_file: string, line: string) => { lines.push(line); };
  beforeEach(() => { lines.length = 0; });

  test('initialize answers with the client protocol version and a tools capability', () => {
    expect(handlePlanMessage({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, '/r', '1.2.3'))
      .toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kunj', version: '1.2.3' } } });
  });

  test('notifications get no reply; unknown methods an error', () => {
    expect(handlePlanMessage({ method: 'notifications/initialized' }, '/r', 'v')).toBeNull();
    expect(handlePlanMessage({ id: 2, method: 'resources/list' }, '/r', 'v')).toMatchObject({ error: { code: -32601 } });
  });

  test('set_plan is listed only when the agent has a record', () => {
    expect((handlePlanMessage({ id: 3, method: 'tools/list' }, '/r', 'v') as any).result.tools.map((t: any) => t.name)).toEqual([SET_PLAN_TOOL]);
    expect((handlePlanMessage({ id: 3, method: 'tools/list' }, undefined, 'v') as any).result.tools).toEqual([]);
  });

  test('a call appends one KunjPlan line and says what the user sees', () => {
    const out = handlePlanMessage({ id: 4, method: 'tools/call', params: { name: SET_PLAN_TOOL, arguments: { steps: ['Find', 'Fix'], current: 1 } } }, '/r', 'v', append) as any;
    expect(out.result.content[0].text).toBe('The plan shows: ✓ Find · ▶ Fix');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).hook).toEqual({ hook_event_name: 'KunjPlan', steps: ['Find', 'Fix'], current: 1 });
  });

  test('a bad call is a tool error and writes nothing', () => {
    const out = handlePlanMessage({ id: 5, method: 'tools/call', params: { name: SET_PLAN_TOOL, arguments: { steps: [] } } }, '/r', 'v', append) as any;
    expect(out.result.isError).toBe(true);
    expect(lines).toHaveLength(0);
  });

  test('parsePlanInput tidies: blanks dropped, long steps cut, current clamped', () => {
    expect(parsePlanInput({ steps: ['  a  b ', '', 'x'.repeat(100)], current: 9 }))
      .toEqual({ steps: ['a b', `${'x'.repeat(79)}…`], current: 1 });
    expect(parsePlanInput({ steps: Array(9).fill('s'), current: 0 })).toMatch(/at most 8/);
    expect(parsePlanInput(null)).toMatch(/takes/);
  });

  test('planRecordLine is one line with the time in seconds', () => {
    expect(planRecordLine({ steps: ['a'], current: 0 }, 5500)).toBe('{"kunj":{"t":5},"hook":{"hook_event_name":"KunjPlan","steps":["a"],"current":0}}\n');
  });
});
