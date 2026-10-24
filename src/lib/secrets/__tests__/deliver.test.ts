import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderFiles, writeHostFiles } from '../deliver';
import { parseDotenv } from '../dotenv';
import { SecretError } from '../errors';
import { SecretEntry } from '../vault';

const at = '2026-10-24T00:00:00.000Z';
function entry(name: string, value: string, file?: string, env = true): SecretEntry {
  return { name, value, targets: ['host'], delivery: { env, ...(file ? { file } : {}) }, updatedAt: at };
}

describe('renderFiles', () => {
  it('groups file deliveries by file, sorted by name, as NAME="value" lines', () => {
    const files = renderFiles([entry('B', '2', '.env'), entry('A', '1', '.env'), entry('C', '3', 'config/.env.local'), entry('D', '4')]);
    expect([...files.keys()].sort()).toEqual(['.env', 'config/.env.local']);
    expect(files.get('.env')).toBe('A="1"\nB="2"\n');
    expect(files.get('config/.env.local')).toBe('C="3"\n');
  });

  it('renders a value with a newline, a quote, a backslash, # and = so parseDotenv reads it back', () => {
    const tricky = 'line1\nsay "hi" # not a comment = x\\n \\t ${HOME} \'single\'';
    const files = renderFiles([entry('T', tricky, '.env'), entry('E', '', '.env')]);
    expect(parseDotenv(files.get('.env')!)).toEqual([
      { name: 'E', value: '' },
      { name: 'T', value: tricky },
    ]);
  });
});

describe('writeHostFiles', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-deliver-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const one = new Map([['.env', 'A="1"\n']]);

  async function refused(p: Promise<unknown>, code: string): Promise<SecretError> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretError);
    expect((err as SecretError).jsonCode).toBe(code);
    return err as SecretError;
  }

  it('writes an ignored file with mode 0600', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
    expect(await writeHostFiles(root, one, {})).toEqual(['.env']);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A="1"\n');
    expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('makes an existing file 0600 when it replaces it', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(root, '.env'), 'old', { mode: 0o644 });
    await writeHostFiles(root, one, {});
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A="1"\n');
    expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('refuses a file git does not ignore with not-ignored and writes nothing', async () => {
    const err = await refused(writeHostFiles(root, one, {}), 'not-ignored');
    expect(err.message).toContain('.env');
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('writes none of the files when any one is not ignored', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
    const two = new Map([
      ['.env', 'A="1"\n'],
      ['config/app.env', 'B="2"\n'],
    ]);
    await refused(writeHostFiles(root, two, {}), 'not-ignored');
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'config'))).toBe(false);
  });

  it('writes a file git does not ignore with force', async () => {
    expect(await writeHostFiles(root, one, { force: true })).toEqual(['.env']);
    expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
  });

  it('creates parent directories', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), '*.env\n');
    await writeHostFiles(root, new Map([['config/app.env', 'B="2"\n']]), {});
    expect(fs.readFileSync(path.join(root, 'config', 'app.env'), 'utf8')).toBe('B="2"\n');
  });

  it.each(['../x', 'a/../../x', '/etc/x', '', '.', 'a/..'])('refuses the path %p outside the root, even with force', async (p) => {
    const err = await writeHostFiles(root, new Map([[p, 'A="1"\n']]), { force: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(fs.existsSync(path.join(path.dirname(root), 'x'))).toBe(false);
  });

  it('refuses to write through a symlinked directory that leads outside the root', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-outside-')));
    try {
      fs.symlinkSync(outside, path.join(root, 'link'));
      fs.writeFileSync(path.join(root, '.gitignore'), 'link\nlink/\n');
      const err = await writeHostFiles(root, new Map([['link/.env', 'A="1"\n']]), { force: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(fs.existsSync(path.join(outside, '.env'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(['.git/config', '.GIT/config', 'sub/.git/hooks/pre-commit'])('refuses %p inside a .git directory even when git ignores it', async (p) => {
    fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
    const before = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const err = await writeHostFiles(root, new Map([[p, 'A="1"\n']]), { force: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, 'sub'))).toBe(false);
  });

  it('refuses a path through a symlinked directory before writing any file or creating any directory', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-outside-')));
    try {
      fs.symlinkSync(outside, path.join(root, 'link'));
      const files = new Map([
        ['.env', 'A="1"\n'],
        ['link/sub/deep/.env', 'B="2"\n'],
      ]);
      const err = await writeHostFiles(root, files, { force: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('replaces a symlink at the file path rather than writing through it', async () => {
    const outside = path.join(os.tmpdir(), `kunj-target-${process.pid}`);
    fs.writeFileSync(outside, 'untouched');
    try {
      fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
      fs.symlinkSync(outside, path.join(root, '.env'));
      await writeHostFiles(root, one, {});
      expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
      expect(fs.lstatSync(path.join(root, '.env')).isSymbolicLink()).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
