import { Readable } from 'stream';
import { FakeBackend } from './fake-backend';
import { testBackend } from './remote-harness';
import { readWorkspaceFile, validateWorkspacePath, writeWorkspaceFile } from '../files';

describe('validateWorkspacePath', () => {
  test.each(['', '/etc/passwd', '../x', 'src/../../x', 'a\0b', '.', '..'])('refuses %j', p => {
    expect(() => validateWorkspacePath(p)).toThrow(expect.objectContaining({ code: 'bad-path', jsonCode: 'bad-path' }));
  });

  test('normalises ./src//a.ts', () => expect(validateWorkspacePath('./src//a.ts')).toBe('src/a.ts'));
  test('keeps a path that dips and returns', () => expect(validateWorkspacePath('a/../b.ts')).toBe('b.ts'));
});

describe('workspace files', () => {
  const READ = 'sh -c cat -- "$1" sh src/a.ts';

  test('read runs cat as the sandbox user in /workspace', async () => {
    const backend = testBackend();
    backend.execResults.set(READ, { exitCode: 0, stdout: 'hello' });
    expect(await readWorkspaceFile(backend, 'c1', 'src/a.ts', 'dev')).toBe('hello');
    const [id, cmd, io] = backend.callsOf('exec')[0] as [string, string[], { user?: string; workdir?: string }];
    expect(id).toBe('c1');
    expect(cmd).toEqual(['sh', '-c', 'cat -- "$1"', 'sh', 'src/a.ts']);
    expect(io).toMatchObject({ user: 'dev', workdir: '/workspace' });
  });

  test('read of a missing file is not-found', async () => {
    const backend = testBackend();
    backend.execResults.set(READ, { exitCode: 1, stdout: '' });
    await expect(readWorkspaceFile(backend, 'c1', 'src/a.ts')).rejects.toMatchObject({ code: 'not-found', jsonCode: 'not-found' });
  });

  test('write pipes stdin and creates the directory', async () => {
    const backend = testBackend();
    await writeWorkspaceFile(backend, 'c1', 'src/a.ts', Readable.from(['new']), 'dev');
    const [, cmd, io] = backend.callsOf('exec')[0] as [string, string[], { user?: string; workdir?: string }];
    expect(cmd[2]).toContain('mkdir -p');
    expect(cmd[2]).toContain('cat >');
    expect(cmd[4]).toBe('src/a.ts');
    expect(io).toMatchObject({ user: 'dev', workdir: '/workspace' });
    expect(backend.stdinData).toEqual(['new']);
  });

  test('a failing write is write-failed', async () => {
    const backend = testBackend();
    backend.execResults.set('sh -c mkdir -p -- "$(dirname -- "$1")" && cat > "$1" sh x', { exitCode: 1, stdout: '' });
    await expect(writeWorkspaceFile(backend, 'c1', 'x', Readable.from([]))).rejects.toMatchObject({ code: 'write-failed' });
  });
});
