// The remote protocol against a real Docker engine, through the parts the fake cannot stand in for:
// the Engine-API TTY exec (a pty the client resizes) and a tar copied in. Run with `npm run
// test:docker`; skipped when `docker info` fails. Self-contained: a throwaway kunj-labelled container.
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { PassThrough, Readable, Writable } from 'stream';
import { LocalDockerBackend } from '../docker';
import { RemoteKunjBackend, Terminal } from '../remote';
import { createServeServer, ServeServer } from '../../serve/server';
import { docker } from './git-origin';

let dockerUp = false;
try {
  dockerUp = !!JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20000 })).ServerVersion;
} catch {
  dockerUp = false;
}

jest.setTimeout(300_000);

const NAME = `kunj-remote-it-${Math.random().toString(36).slice(2, 8)}`;
const TOKEN = 'remote-docker-test-token';

function collect(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return { stream: new Writable({ write: (c: Buffer, _e, cb) => (chunks.push(c), cb()) }), text: () => Buffer.concat(chunks).toString() };
}

(dockerUp ? describe : describe.skip)('remote protocol against Docker', () => {
  let server: ServeServer;
  let remote: RemoteKunjBackend;
  let term: { stdin: PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(on: boolean): void }; stdout: Writable & { columns: number; rows: number }; out: () => string; winch: () => void };

  beforeAll(async () => {
    docker(['run', '-d', '--name', NAME, '--label', 'kunj.repo=remote-it', '--label', 'kunj.branch=x', 'alpine:3.20', 'sleep', 'infinity']);
    server = createServeServer({ backend: new LocalDockerBackend(), token: TOKEN, version: 'test' });
    const { port } = await server.listen('127.0.0.1', 0);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(on: boolean) { stdin.isRaw = on; } });
    const collected = collect();
    const stdout = Object.assign(collected.stream, { columns: 100, rows: 30 });
    let resize: (() => void) | undefined;
    const terminal: Terminal = { stdin, stdout, onResize: cb => ((resize = cb), () => (resize = undefined)) };
    term = { stdin, stdout, out: collected.text, winch: () => resize?.() };
    remote = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, name: 'it', terminal });
    await remote.ready();
  });

  afterAll(async () => {
    await server?.close();
    try {
      docker(['rm', '-f', NAME]);
    } catch {
      /* already gone */
    }
  });

  it('runs a pty the client resizes, and returns the shell\'s exit code', async () => {
    const done = remote.exec(NAME, ['sh'], { tty: true, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { TERM: 'xterm' } });
    await new Promise(r => setTimeout(r, 1500));
    term.stdin.write('stty size\n');
    await new Promise(r => setTimeout(r, 1000));
    term.stdout.columns = 132;
    term.stdout.rows = 43;
    term.winch();
    await new Promise(r => setTimeout(r, 1000));
    term.stdin.write('stty size\n');
    await new Promise(r => setTimeout(r, 1000));
    term.stdin.write('exit 7\n');
    expect(await done).toEqual({ exitCode: 7, stdout: '' });
    expect(term.out()).toContain('30 100');
    expect(term.out()).toContain('43 132');
    expect(term.stdin.isRaw).toBe(false);
  });

  it('copies a tar in and reads the file back with a plain exec', async () => {
    const tar = execFileSync('sh', ['-c', 'd=$(mktemp -d) && printf hello > "$d/greeting.txt" && tar --no-xattrs -C "$d" -cf - greeting.txt'], {
      maxBuffer: 1 << 20,
      // macOS tar otherwise adds Apple xattrs (com.apple.provenance) the daemon cannot set
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    // docker cp extracts into a directory that must exist, as the local backend's callers ensure
    await remote.copyIn(NAME, '/tmp', Readable.from([tar]));
    const r = await remote.exec(NAME, ['cat', '/tmp/greeting.txt']);
    expect(r).toEqual({ exitCode: 0, stdout: 'hello' });
  });

  it('refuses a container that is not kunj\'s', async () => {
    const other = `${NAME}-other`;
    docker(['run', '-d', '--name', other, 'alpine:3.20', 'sleep', '30']);
    try {
      await expect(remote.exec(other, ['true'])).rejects.toThrow(/not a kunj container/);
    } finally {
      docker(['rm', '-f', other]);
    }
  });
});
