import { Command } from 'commander';
import { BaseCommand } from '../command';

class Failing extends BaseCommand {
  constructor(private error: unknown) {
    super({ name: 'fail', description: 'always fails' });
  }
  async execute(): Promise<void> {
    throw this.error;
  }
}

async function runJson(error: unknown): Promise<{ out: string; exit: unknown }> {
  const out: string[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out.push(String(chunk));
    return true;
  });
  let exit: unknown;
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code;
    throw new Error('exit');
  }) as any);
  const program = new Command();
  new Failing(error).register(program);
  await program.parseAsync(['fail', '--json'], { from: 'user' }).catch(() => undefined);
  return { out: out.join(''), exit };
}

afterEach(() => jest.restoreAllMocks());

describe('BaseCommand --json errors', () => {
  it('prints { code, message } when the error has a string code', async () => {
    const err = Object.assign(new Error('No worktree for x'), { code: 'no-worktree' });
    const { out, exit } = await runJson(err);
    expect(JSON.parse(out)).toEqual({ error: { code: 'no-worktree', message: 'No worktree for x' } });
    expect(exit).toBe(1);
  });

  it('keeps the plain string for errors without a code', async () => {
    const { out, exit } = await runJson(new Error('boom'));
    expect(JSON.parse(out)).toEqual({ error: 'boom' });
    expect(exit).toBe(1);
  });

  it('keeps the plain string when code is not a string', async () => {
    const { out } = await runJson(Object.assign(new Error('boom'), { code: 42 }));
    expect(JSON.parse(out)).toEqual({ error: 'boom' });
  });
});
