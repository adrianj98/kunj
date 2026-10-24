import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SetupCommand } from '../setup';

const dirs = { kunj: '', global: '' };
jest.mock('../../lib/config', () => ({
  getKunjDir: jest.fn(() => dirs.kunj),
  getGlobalKunjDir: jest.fn(() => dirs.global),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

let home: string;
let logged: string[];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-setup-')));
  dirs.global = path.join(home, '.kunj');
  dirs.kunj = path.join(dirs.global, 'app');
  logged = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.join(' '));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function keepEnv(): string {
  const kept = path.join(dirs.kunj, 'keep', '.env');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, 'A=1\n');
  return kept;
}

describe('setup offers to import a kept .env', () => {
  test('asks, and on yes imports the kept .env with --delete', async () => {
    const kept = keepEnv();
    const confirm = jest.fn(async () => true);
    const runImport = jest.fn(async () => undefined);
    await new SetupCommand().offerSecretImport({ confirm, runImport });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runImport).toHaveBeenCalledWith(kept);
  });

  test('on no, imports nothing and prints the command for later', async () => {
    keepEnv();
    const runImport = jest.fn(async () => undefined);
    await new SetupCommand().offerSecretImport({ confirm: async () => false, runImport, home: () => home });
    expect(runImport).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('kunj secret import ~/.kunj/app/keep/.env --delete');
  });

  test('does not ask without a kept .env, or when the repo already has a vault (no unlock to find out)', async () => {
    const confirm = jest.fn(async () => true);
    const runImport = jest.fn(async () => undefined);
    await new SetupCommand().offerSecretImport({ confirm, runImport });
    keepEnv();
    fs.writeFileSync(path.join(dirs.kunj, 'secrets.enc'), '{}');
    await new SetupCommand().offerSecretImport({ confirm, runImport });
    expect(confirm).not.toHaveBeenCalled();
    expect(runImport).not.toHaveBeenCalled();
  });

  test('a failed import is a warning, not a failed setup', async () => {
    keepEnv();
    await expect(
      new SetupCommand().offerSecretImport({ confirm: async () => true, runImport: async () => { throw new Error('locked'); } }),
    ).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/locked/);
  });
});
