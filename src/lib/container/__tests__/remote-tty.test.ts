import { PassThrough, Writable } from 'stream';
import { RemoteKunjBackend, Terminal } from '../remote';
import { Harness, startHarness, HARNESS_TOKEN } from './remote-harness';

const KUNJ = { id: 'c1', name: 'kunj-r-b-1', state: 'running' as const, image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] };

/** A terminal made of streams: raw mode and size changes recorded, output collected. */
function fakeTerminal(size = { columns: 120, rows: 40 }) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: jest.fn() });
  stdin.setRawMode.mockImplementation((on: boolean) => {
    stdin.isRaw = on;
  });
  const chunks: Buffer[] = [];
  const stdout = Object.assign(new Writable({ write: (c: Buffer, _e, cb) => (chunks.push(c), cb()) }), size);
  let resize: (() => void) | undefined;
  const terminal: Terminal = {
    stdin,
    stdout,
    onResize: cb => {
      resize = cb;
      return () => (resize = undefined);
    },
  };
  return { terminal, stdin, stdout, output: () => Buffer.concat(chunks).toString(), winch: () => resize?.(), resizeSubscribed: () => !!resize };
}

const inherit = { tty: true, stdin: 'inherit' as const, stdout: 'inherit' as const, stderr: 'inherit' as const, user: 'dev', workdir: '/workspace', env: { TERM: 'xterm' } };

describe('RemoteKunjBackend: TTY exec', () => {
  let h: Harness;
  let term: ReturnType<typeof fakeTerminal>;
  let remote: RemoteKunjBackend;

  beforeEach(async () => {
    h = await startHarness();
    h.fake.existing.push(KUNJ);
    term = fakeTerminal();
    remote = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${h.port}`, token: HARNESS_TOKEN, name: 'harness', terminal: term.terminal });
    await remote.ready();
  });

  afterEach(() => h.close());

  const session = () => h.fake.ttySessions[0];
  const started = () => new Promise<void>(resolve => {
    const tick = () => (h.fake.ttySessions.length ? resolve() : setTimeout(tick, 5));
    tick();
  });

  it('runs the pty: raw mode on, size sent first, bytes both ways, exit code back, raw mode off once', async () => {
    const done = remote.exec('kunj-r-b-1', ['sh', '-l'], inherit);
    await started();
    expect(term.stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(session().opts).toEqual({ user: 'dev', workdir: '/workspace', env: { TERM: 'xterm' }, cols: 120, rows: 40 });
    term.stdin.write('ls\r');
    term.stdin.write(Buffer.from([0x03])); // Ctrl-C goes to the pty, not to kunj
    await new Promise(r => setTimeout(r, 50));
    expect(Buffer.concat(session().input)).toEqual(Buffer.from('ls\r\x03'));
    h.fake.ttyExitCode = 7;
    h.fake.endTty();
    expect(await done).toEqual({ exitCode: 7, stdout: '' });
    expect(term.output()).toBe('$ sh -l\r\nLS\r\x03');
    expect(term.stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(term.resizeSubscribed()).toBe(false);
  });

  it('sends a resize on every size change', async () => {
    const done = remote.exec('kunj-r-b-1', ['sh'], inherit);
    await started();
    term.stdout.columns = 80;
    term.stdout.rows = 24;
    term.winch();
    await new Promise(r => setTimeout(r, 50));
    expect(session().resizes).toEqual([{ cols: 80, rows: 24 }]);
    h.fake.endTty(0);
    await done;
  });

  it('stdin EOF reaches the pty and ends the session with the fake exit code', async () => {
    const done = remote.exec('kunj-r-b-1', ['sh'], inherit);
    await started();
    term.stdin.end();
    expect(await done).toEqual({ exitCode: 0, stdout: '' });
    expect(session().stdinEnded).toBe(true);
  });

  it('restores the terminal when the server goes away, and reports the lost connection', async () => {
    const done = remote.exec('kunj-r-b-1', ['sh'], inherit);
    await started();
    const closed = h;
    h = await startHarness(); // for afterEach
    await closed.close();
    await expect(done).rejects.toThrow(/exec ended: connection closed|unreachable/);
    expect(term.stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(closed.fake.ttySessions[0].closed).toBe(true);
  });

  it('is refused for a foreign container and for env other than TERM, COLORTERM, LANG, with raw mode never left on', async () => {
    h.fake.existing.push({ ...KUNJ, id: 'c2', name: 'theirs', labels: { app: 'x' } });
    await expect(remote.exec('theirs', ['sh'], inherit)).rejects.toThrow(/not a kunj container/);
    await expect(remote.exec('kunj-r-b-1', ['sh'], { ...inherit, env: { TOKEN: 'x' } })).rejects.toThrow(/may not set TOKEN/);
    expect(h.fake.ttySessions).toEqual([]);
    expect(term.stdin.isRaw).toBe(false);
  });

  it('uses the io streams instead of the terminal when they are given', async () => {
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    const stdout = new Writable({ write: (c: Buffer, _e, cb) => (chunks.push(c), cb()) });
    const done = remote.exec('kunj-r-b-1', ['cat'], { tty: true, stdin, stdout });
    await started();
    expect(session().opts).toMatchObject({ cols: 80, rows: 24 });
    stdin.end('hi');
    await done;
    expect(Buffer.concat(chunks).toString()).toBe('$ cat\r\nHI');
    expect(term.stdin.setRawMode).not.toHaveBeenCalled();
  });
});
