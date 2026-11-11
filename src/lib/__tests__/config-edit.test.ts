import { initializeSettings, settingsRegistry } from '../../settings';
import { buildConfigSchema, parseSetJson, setConfigPath, unsetConfigPath } from '../config-edit';

initializeSettings();
const all = settingsRegistry.getAll();

test('schema lists every registered key once, in a known category', () => {
  const s = buildConfigSchema(all);
  expect(s.settings.map(x => x.key).sort()).toEqual(all.map(x => x.key).sort());
  expect(new Set(s.settings.map(x => x.key)).size).toBe(s.settings.length);
  const ids = s.categories.map(c => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const x of s.settings) expect(ids).toContain(x.category);
  expect(ids.indexOf('general')).toBeLessThan(ids.indexOf('container'));
  expect(s.categories.find(c => c.id === 'lsp')!.title).toBe('Language servers');
});

test('schema carries type, default, options and sensitive', () => {
  const by = Object.fromEntries(buildConfigSchema(all).settings.map(x => [x.key, x]));
  expect(by['agent.tmux']).toMatchObject({ type: 'boolean', default: true, category: 'agent' });
  expect(by['preferences.branchSort'].options!.length).toBeGreaterThan(1);
  expect(by['jira.apiToken'].sensitive).toBe(true);
  expect(by['agent.tmux'].sensitive).toBeUndefined();
  expect(by['lsp.servers']).toMatchObject({ type: 'object', default: {} });
  expect(by['container.mcp'].type).toBe('object');
  expect(by['container.services'].type).toBe('object');
});

test('schema is plain JSON', () => {
  const s = buildConfigSchema(all);
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
});

test.each<[string, unknown]>([
  ['agent.command="true"', 'true'],
  ['agent.command="12"', '12'],
  ['agent.command=""', ''],
  ['agent.command="a=b \\"q\\"\\nline"', 'a=b "q"\nline'],
  ['agent.command="-x"', '-x'],
  ['agent.tmux=false', false],
  ['container.pruneAfterDays=0', 0],
  ['container.env=["A,B","C"]', ['A,B', 'C']],
  ['lsp.servers={"go":{"command":"gopls"}}', { go: { command: 'gopls' } }],
  ['hooks.pre-commit="npm test"', 'npm test'],
  ['hooks.pre-commit=["a","b"]', ['a', 'b']],
])('parseSetJson %s', (input, value) => {
  expect(parseSetJson(input, all).value).toEqual(value);
});

test.each([
  ['nope.key=1', 'unknown-setting'],
  ['agent.tmux="yes"', 'bad-value'],
  ['agent.tmux', 'bad-value'],
  ['agent.tmux=', 'bad-value'],
  ['agent.command=12', 'bad-value'],
  ['agent.command=null', 'bad-value'],
  ['preferences.branchSort="sideways"', 'bad-value'],
  ['preferences.pageSize=-1', 'bad-value'],
  ['preferences.pageSize=1e999', 'bad-value'],
  ['container.env={"a":1}', 'bad-value'],
  ['container.mcp=[]', 'bad-value'],
  ['hooks.pre-commit=[1]', 'bad-value'],
  ['agent.command={not json', 'bad-value'],
])('parseSetJson refuses %s with %s', (input, code) => {
  expect(() => parseSetJson(input, all)).toThrow(expect.objectContaining({ jsonCode: code, name: 'UserError' }));
});

test('setConfigPath creates parents and keeps neighbours', () => {
  const c: any = { agent: { command: 'x' }, stale: { key: 1 } };
  setConfigPath(c, 'agent.tmux', false);
  setConfigPath(c, 'lsp.idleStopMinutes.cold', 3);
  expect(c).toEqual({ agent: { command: 'x', tmux: false }, stale: { key: 1 }, lsp: { idleStopMinutes: { cold: 3 } } });
});

test('unsetConfigPath removes the key and the parents it empties', () => {
  const c: any = { lsp: { idleStopMinutes: { cold: 3 } }, agent: { tmux: false, command: 'x' } };
  expect(unsetConfigPath(c, 'lsp.idleStopMinutes.cold')).toBe(true);
  expect(unsetConfigPath(c, 'agent.tmux')).toBe(true);
  expect(c).toEqual({ agent: { command: 'x' } });
  expect(unsetConfigPath(c, 'agent.tmux')).toBe(false);
  expect(unsetConfigPath(c, 'agent.command.deeper')).toBe(false);
  expect(unsetConfigPath(c, 'nothing.here')).toBe(false);
  expect(c).toEqual({ agent: { command: 'x' } });
});

test('paths through the prototype are refused', () => {
  expect(() => setConfigPath({}, '__proto__.polluted', true)).toThrow();
  expect(() => unsetConfigPath({}, 'a.constructor')).toThrow();
  expect(({} as any).polluted).toBeUndefined();
});
