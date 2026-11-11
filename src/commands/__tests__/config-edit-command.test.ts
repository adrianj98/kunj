import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// os.homedir() does not follow a HOME changed inside Jest, so the module is mocked: without this
// the test would write the developer's real ~/.kunj/config.json. Never falls back to the real home.
let mockHome = '/nonexistent-kunj-test-home';
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockHome };
});

import { ConfigCommand } from '../config';
import { getGlobalConfigPath } from '../../lib/config';
import { initializeSettings, settingsRegistry } from '../../settings';

initializeSettings();

describe('kunj config --schema, --set-json, --unset', () => {
  let home: string;
  let globalPath: string;
  let out: string[];
  const realCwd = process.cwd();

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-config-edit-')));
    mockHome = home;
    process.chdir(home);
    globalPath = path.join(home, '.kunj', 'config.json');
    // Guard: every write below must land in the temporary home
    if (getGlobalConfigPath() !== globalPath) throw new Error(`refusing to run against ${getGlobalConfigPath()}`);
    out = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.join(' ')); });
    jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(realCwd);
    mockHome = '/nonexistent-kunj-test-home';
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = async (options: Record<string, unknown>, json = true) => {
    const cmd = new ConfigCommand();
    (cmd as any).jsonMode = json;
    out = [];
    await cmd.execute(options);
    return json ? JSON.parse(out.join('\n')) : out.join('\n');
  };
  const globalFile = () => JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  const seed = (config: unknown) => {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, typeof config === 'string' ? config : JSON.stringify(config));
  };

  test('--schema --json prints the schema', async () => {
    const schema = await run({ schema: true });
    expect(schema.settings.length).toBe(settingsRegistry.getAll().length);
    expect(schema.categories[0]).toEqual({ id: 'general', title: 'General' });
  });

  test('--schema as text hides the default of a sensitive setting', async () => {
    const text = await run({ schema: true }, false);
    expect(text).toContain('agent.tmux');
    expect(text.split('\n').length).toBe(settingsRegistry.getAll().length);
  });

  test('--set-json --global writes the exact value and reports it', async () => {
    expect(await run({ setJson: 'agent.command="true"', global: true })).toEqual({ key: 'agent.command', value: 'true', scope: 'global' });
    expect(globalFile().agent.command).toBe('true');
  });

  test('--set-json keeps keys it does not know', async () => {
    seed({ stale: { x: 1 }, agent: { tmux: true } });
    await run({ setJson: 'agent.tmuxStatus=true', global: true });
    expect(globalFile()).toEqual({ stale: { x: 1 }, agent: { tmux: true, tmuxStatus: true } });
  });

  test('--set-json refuses a bad value and leaves the file alone', async () => {
    seed({ agent: { tmux: true } });
    const before = fs.readFileSync(globalPath, 'utf8');
    await expect(run({ setJson: 'agent.tmux="yes"', global: true })).rejects.toMatchObject({ jsonCode: 'bad-value' });
    await expect(run({ setJson: 'no.such=1', global: true })).rejects.toMatchObject({ jsonCode: 'unknown-setting' });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(before);
  });

  test('a config file that is not JSON is never overwritten', async () => {
    seed('{ "agent": ');
    await expect(run({ setJson: 'agent.tmux=false', global: true })).rejects.toMatchObject({ jsonCode: 'config-corrupt' });
    await expect(run({ unset: 'agent.tmux', global: true })).rejects.toMatchObject({ jsonCode: 'config-corrupt' });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe('{ "agent": ');
  });

  test.each(['null', '5', '[1]', '"x"'])('a config file holding %s is refused, not crashed on or half-written', async text => {
    seed(text);
    await expect(run({ setJson: 'agent.tmux=false', global: true })).rejects.toMatchObject({ jsonCode: 'config-corrupt', name: 'UserError' });
    await expect(run({ unset: 'agent.tmux', global: true })).rejects.toMatchObject({ jsonCode: 'config-corrupt' });
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(text);
  });

  test('--unset removes, then reports removed:false', async () => {
    seed({ lsp: { maxServers: 2 }, agent: { tmux: false } });
    expect(await run({ unset: 'lsp.maxServers', global: true })).toEqual({ key: 'lsp.maxServers', scope: 'global', removed: true });
    expect(globalFile()).toEqual({ agent: { tmux: false } });
    expect(await run({ unset: 'lsp.maxServers', global: true })).toEqual({ key: 'lsp.maxServers', scope: 'global', removed: false });
  });

  test('without --global the local config is written, not the global one', async () => {
    seed({ agent: { tmux: true } });
    // Outside a repository the local config is ./.kunj, which in the home directory is the global one
    const work = path.join(home, 'work');
    fs.mkdirSync(work);
    process.chdir(work);
    expect((await run({ setJson: 'preferences.pageSize=20' })).scope).toBe('local');
    expect(globalFile()).toEqual({ agent: { tmux: true } });
    const list = await run({ list: true });
    expect(list.local.preferences.pageSize).toBe(20);
  });

  test('--set still guesses types', async () => {
    await run({ set: 'agent.command=true', global: true }, false);
    expect(globalFile().agent.command).toBe(true);
  });

  test('text output of --set-json never prints the value', async () => {
    const text = await run({ setJson: 'jira.apiToken="s3cret"', global: true }, false);
    expect(text).toContain('jira.apiToken');
    expect(text).not.toContain('s3cret');
  });
});
