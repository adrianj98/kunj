import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness, startHarness, HARNESS_TOKEN } from '../../lib/container/__tests__/remote-harness';
import { readRemotes } from '../../lib/remotes';
import { RemoteCommand, RemoteCommandDeps } from '../remote';

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({})),
}));

describe('kunj remote', () => {
  let dir: string;
  let file: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-remote-cmd-'));
    file = path.join(dir, 'remotes.json');
    stdout = [];
    stderr = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(' '));
    });
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cmd = (deps: Partial<RemoteCommandDeps> = {}) => new RemoteCommand({ file, isTTY: () => false, stdin: async () => 'from-stdin\n', ...deps });

  it('adds an --ssh remote with the token from stdin, lists it without the token, removes it', async () => {
    await cmd().execute('add', 'box', { ssh: 'me@box', port: '7500', tokenStdin: true });
    expect(readRemotes(file).box).toMatchObject({ ssh: 'me@box', port: 7500, token: 'from-stdin' });
    expect(stdout.join('\n')).toContain('Added remote box: ssh me@box (port 7500)');
    expect(stdout.join('\n')).toContain('kunj remote ping box');
    stdout.length = 0;
    await cmd().execute('list', {});
    expect(stdout.join('\n')).toContain('box');
    expect(stdout.join('\n')).not.toContain('from-stdin');
    stdout.length = 0;
    await cmd().execute('list', { json: true });
    const json = JSON.parse(stdout.join(''));
    expect(json).toEqual({ remotes: [{ name: 'box', via: 'ssh', ssh: 'me@box', port: 7500, addedAt: expect.any(String) }] });
    expect(JSON.stringify(json)).not.toContain('from-stdin');
    await cmd().execute('remove', 'box', {});
    expect(readRemotes(file)).toEqual({});
    await expect(cmd().execute('remove', 'box', {})).rejects.toMatchObject({ code: 'remote-unknown' });
  });

  it('adds a --url remote (https anywhere, http only loopback), with the prompt on a TTY', async () => {
    const prompt = jest.fn(async () => 'prompted');
    await cmd({ isTTY: () => true, promptToken: prompt }).execute('add', 'tls', { url: 'https://box.example/kunj/' });
    expect(prompt).toHaveBeenCalled();
    expect(readRemotes(file).tls).toMatchObject({ url: 'https://box.example/kunj', token: 'prompted' });
    await expect(cmd().execute('add', 'lan', { url: 'http://10.0.0.5:7433', tokenStdin: true })).rejects.toMatchObject({ code: 'bad-remote' });
    await expect(cmd().execute('add', 'both', { url: 'https://x', ssh: 'me@x' })).rejects.toThrow(/exactly one/);
    await expect(cmd().execute('add', 'none', {})).rejects.toThrow(/exactly one/);
    await expect(cmd().execute('add', 'local', { ssh: 'me@x', tokenStdin: true })).rejects.toMatchObject({ code: 'bad-remote' });
    expect(Object.keys(readRemotes(file))).toEqual(['tls']);
  });

  it('--token warns about the shell history and replaces the token with `token`', async () => {
    await cmd().execute('add', 'box', { ssh: 'me@box', token: 'argv-token' });
    expect(stderr.join('\n')).toContain('shell history');
    await cmd().execute('token', 'box', { tokenStdin: true });
    expect(readRemotes(file).box.token).toBe('from-stdin');
    await expect(cmd().execute('token', 'nope', { tokenStdin: true })).rejects.toMatchObject({ code: 'remote-unknown' });
  });

  describe('ping', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await startHarness();
    });
    afterEach(() => h.close());

    it('reports the server versions, context and features over the wire', async () => {
      await cmd().execute('add', 'box', { url: `http://127.0.0.1:${h.port}`, token: HARNESS_TOKEN });
      stdout.length = 0;
      await cmd().execute('ping', 'box', { json: true });
      const json = JSON.parse(stdout.join(''));
      expect(json).toMatchObject({ name: 'box', via: 'url', kunj: 'test', context: 'default', engine: h.fake.infoResult, features: { editorAttach: false, localPorts: true } });
      stdout.length = 0;
      await cmd().execute('ping', 'box', {});
      expect(stdout.join('\n')).toMatch(/✓ box \(http:\/\/127\.0\.0\.1:\d+\): kunj serve test, Docker fake on Fake Linux, context default/);
    });

    it('says when the token is wrong, and when the remote is unknown', async () => {
      await cmd().execute('add', 'box', { url: `http://127.0.0.1:${h.port}`, token: 'wrong' });
      await expect(cmd().execute('ping', 'box', {})).rejects.toMatchObject({ code: 'remote-unauthorized' });
      await expect(cmd().execute('ping', 'nope', {})).rejects.toMatchObject({ code: 'remote-unknown' });
    });
  });
});
