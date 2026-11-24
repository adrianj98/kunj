import { Readable } from 'stream';
import { FakeBackend } from './fake-backend';
import { testBackend } from './remote-harness';
import { MAX_READ_BYTES, readWorkspaceFile, validateWorkspacePath, writeWorkspaceFile } from '../files';

describe('validateWorkspacePath', () => {
  test.each(['', '/etc/passwd', '../x', 'src/../../x', 'a\0b', '.', '..'])('refuses %j', p => {
    expect(() => validateWorkspacePath(p)).toThrow(expect.objectContaining({ code: 'bad-path', jsonCode: 'bad-path' }));
  });

  test('normalises ./src//a.ts', () => expect(validateWorkspacePath('./src//a.ts')).toBe('src/a.ts'));
  test('keeps a path that dips and returns', () => expect(validateWorkspacePath('a/../b.ts')).toBe('b.ts'));
});

describe('workspace files', () => {
  const readCall = (backend: ReturnType<typeof testBackend>) => backend.callsOf('exec')[0] as [string, string[], { user?: string; workdir?: string; maxStdout?: number }];

  /** Sets the result of the read of `rel` (whatever the script text is) */
  function onRead(backend: ReturnType<typeof testBackend>, rel: string, result: { exitCode: number; stdout: string }, max = MAX_READ_BYTES) {
    backend.execHandler = (_id, cmd) => (cmd[0] === 'sh' && cmd[4] === rel && cmd[5] === String(max) ? Promise.resolve(result) : undefined);
  }

  test('read checks the size, then cats, as the sandbox user in /workspace', async () => {
    const backend = testBackend();
    onRead(backend, 'src/a.ts', { exitCode: 0, stdout: 'hello' });
    expect(await readWorkspaceFile(backend, 'c1', 'src/a.ts', 'dev')).toBe('hello');
    const [id, cmd, io] = readCall(backend);
    expect(id).toBe('c1');
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(cmd[2]).toContain('stat -L -c %s -- "$1"');
    expect(cmd[2]).toContain('exec cat -- "$1"');
    expect(cmd.slice(3)).toEqual(['sh', 'src/a.ts', String(8 * 1024 * 1024)]);
    expect(io).toMatchObject({ user: 'dev', workdir: '/workspace' });
  });

  test('read of a missing file is not-found', async () => {
    const backend = testBackend();
    onRead(backend, 'src/a.ts', { exitCode: 1, stdout: '' });
    await expect(readWorkspaceFile(backend, 'c1', 'src/a.ts')).rejects.toMatchObject({ code: 'not-found', jsonCode: 'not-found' });
  });

  test('a file over the cap by its size is too-large, with the size', async () => {
    const backend = testBackend();
    onRead(backend, 'big.bin', { exitCode: 3, stdout: String(300 * 1024 * 1024) });
    await expect(readWorkspaceFile(backend, 'c1', 'big.bin')).rejects.toMatchObject({
      code: 'too-large',
      jsonCode: 'too-large',
      message: expect.stringContaining('300.0 MB'),
    });
  });

  test('output past the cap (a file that grew after stat) is too-large', async () => {
    const backend = testBackend();
    onRead(backend, 'grows.log', { exitCode: 0, stdout: 'x'.repeat(11) }, 10);
    await expect(readWorkspaceFile(backend, 'c1', 'grows.log', undefined, 10)).rejects.toMatchObject({ code: 'too-large' });
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
