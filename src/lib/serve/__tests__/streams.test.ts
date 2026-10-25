import { PassThrough, Readable, Writable } from 'stream';
import { ExecIO, ExecTimeoutError } from '../../container/backend';
import { FakeBackend } from '../../container/__tests__/fake-backend';
import { Harness, startHarness } from '../../container/__tests__/remote-harness';

const KUNJ = { id: 'c1', name: 'kunj-r-b-1', state: 'running' as const, image: 'i', createdAt: 't', labels: { 'kunj.repo': 'r' }, ports: [] };

function collect(): { stream: Writable; data: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _e, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { stream, data: () => Buffer.concat(chunks).toString() };
}

/** Reads a stream to its end (the fake's readAll, but with a latin1-safe Buffer). */
function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    stream.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

describe('RemoteKunjBackend: streams', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
    h.fake.existing.push(KUNJ);
  });

  afterEach(() => h.close());

  describe('exec', () => {
    it('returns the exit code and the collected stdout like the local backend', async () => {
      h.fake.execResults.set('id -un', { exitCode: 0, stdout: 'dev\n' });
      h.fake.execResults.set('test -f x', { exitCode: 1, stdout: '' });
      expect(await h.remote.exec('kunj-r-b-1', ['id', '-un'])).toEqual({ exitCode: 0, stdout: 'dev\n' });
      expect(await h.remote.exec('kunj-r-b-1', ['test', '-f', 'x'])).toEqual({ exitCode: 1, stdout: '' });
      const [, cmd, io] = h.fake.callsOf('exec')[0] as [string, string[], ExecIO];
      expect(cmd).toEqual(['id', '-un']);
      expect(io.stdin).toBe('ignore');
      expect(io.user).toBeUndefined();
    });

    it('passes user, workdir, env and timeoutMs through', async () => {
      await h.remote.exec('kunj-r-b-1', ['true'], { user: 'root', workdir: '/w', env: { A: '1' }, timeoutMs: 5000 });
      const [, , io] = h.fake.callsOf('exec')[0] as [string, string[], ExecIO];
      expect(io).toMatchObject({ user: 'root', workdir: '/w', env: { A: '1' }, timeoutMs: 5000 });
    });

    it('streams stdin in and stdout out (the fake echoes uppercased)', async () => {
      h.fake.echoUpper = true;
      const out = collect();
      const stdin = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
      const r = await h.remote.exec('kunj-r-b-1', ['cat'], { stdin, stdout: out.stream });
      expect(r.exitCode).toBe(0);
      expect(out.data()).toBe('HELLO WORLD');
      expect(h.fake.stdinData).toEqual(['hello world']);
      expect(h.fake.stdinEnded).toEqual([true]);
    });

    it('moves 8 MB each way intact', async () => {
      const big = Buffer.alloc(8 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = i % 251;
      h.fake.execHandler = async (_id, _cmd, io) => {
        const input = await readAll(io.stdin as NodeJS.ReadableStream);
        await new Promise<void>(resolve => (io.stdout as Writable).write(input, () => resolve()));
        return { exitCode: 0, stdout: '' };
      };
      const chunks: Buffer[] = [];
      const out = new Writable({ write: (c: Buffer, _e, cb) => (chunks.push(c), cb()) });
      const r = await h.remote.exec('kunj-r-b-1', ['cat'], { stdin: Readable.from([big]), stdout: out });
      expect(r.exitCode).toBe(0);
      expect(Buffer.concat(chunks).equals(big)).toBe(true);
    });

    it('delivers stdin EOF while stdout still flows, and stderr separately', async () => {
      h.fake.execHandler = async (_id, _cmd, io) => {
        await readAll(io.stdin as NodeJS.ReadableStream); // EOF seen before any output
        (io.stdout as Writable).write('out');
        (io.stderr as Writable).write('err');
        return { exitCode: 3, stdout: '' };
      };
      const out = collect();
      const err = collect();
      const r = await h.remote.exec('kunj-r-b-1', ['x'], { stdin: Readable.from(['in']), stdout: out.stream, stderr: err.stream });
      expect(r).toEqual({ exitCode: 3, stdout: '' });
      expect(out.data()).toBe('out');
      expect(err.data()).toBe('err');
    });

    it('maps a timeout to ExecTimeoutError with the local text', async () => {
      h.fake.hangOn.add('sleep 9');
      const err = await h.remote.exec('kunj-r-b-1', ['sleep', '9'], { timeoutMs: 1000 }).catch(e => e);
      expect(err).toBeInstanceOf(ExecTimeoutError);
      expect(err.message).toBe('docker exec timed out after 1000 ms');
    });

    it('passes a backend exec failure on verbatim', async () => {
      h.fake.execErrors.set('socat x', new Error('docker exec failed: Error response from daemon: container is not running'));
      await expect(h.remote.exec('kunj-r-b-1', ['socat', 'x'])).rejects.toThrow('docker exec failed: Error response from daemon: container is not running');
    });

    it('refuses an exec into a foreign container and never reaches the backend', async () => {
      h.fake.existing.push({ ...KUNJ, id: 'c2', name: 'theirs', labels: { app: 'x' } });
      const err = await h.remote.exec('theirs', ['sh']).catch(e => e);
      expect(err.message).toMatch(/remote-refused: theirs is not a kunj container/);
      expect(h.fake.callsOf('exec')).toEqual([]);
    });

    it('ends the server-side stdin and aborts the exec when the client drops the connection', async () => {
      let stdinClosed = false;
      let aborted = false;
      const execStarted = new Promise<void>(resolve => {
        h.fake.execHandler = (_id, _cmd, io) => {
          const stdin = io.stdin as PassThrough;
          stdin.on('close', () => (stdinClosed = true));
          io.signal!.addEventListener('abort', () => (aborted = true));
          resolve();
          return new Promise(res => stdin.on('close', () => res({ exitCode: 137, stdout: '' })));
        };
      });
      const stdin = new PassThrough();
      const exec = h.remote.exec('kunj-r-b-1', ['cat'], { stdin, stdout: collect().stream });
      await execStarted;
      await h.server.close(); // drops every connection, as a lost network would
      await expect(exec).rejects.toThrow(/exec ended: connection closed|unreachable/);
      await new Promise(r => setTimeout(r, 50));
      expect(stdinClosed).toBe(true);
      expect(aborted).toBe(true);
      h = await startHarness(); // for afterEach
    });
  });

  describe('TTY tail', () => {
    it('survives pty output that keeps coming after the drain wait ends (no write after end)', async () => {
      // A pty whose stream never ends and that writes after the exit: the server must detach it
      h.fake.execTty = async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        let done!: (code: number) => void;
        const exit = new Promise<number>(r => (done = r));
        setTimeout(() => {
          stdout.write('before exit');
          done(0);
          const t = setInterval(() => stdout.write('late'), 100);
          setTimeout(() => clearInterval(t), 3500);
        }, 50);
        return { stdin, stdout, resize: async () => {}, wait: () => exit, close: () => {} };
      };
      const uncaught: unknown[] = [];
      const onUncaught = (e: unknown) => uncaught.push(e);
      process.on('uncaughtException', onUncaught);
      try {
        const out: Buffer[] = [];
        const stdin = new PassThrough();
        const stdout = new Writable({ write: (c: Buffer, _e, cb) => (out.push(c), cb()) });
        const r = await h.remote.exec('kunj-r-b-1', ['sh'], { tty: true, stdin, stdout });
        expect(r.exitCode).toBe(0);
        expect(Buffer.concat(out).toString()).toContain('before exit');
        await new Promise(res => setTimeout(res, 1000));
        expect(uncaught).toEqual([]);
        // The server still answers
        expect(await h.remote.list({ 'kunj.repo': 'r' })).toHaveLength(1);
      } finally {
        process.off('uncaughtException', onUncaught);
      }
    }, 15000);
  });

  describe('copyIn and buildImage', () => {
    class CapturingFake extends FakeBackend {
      tars: Buffer[] = [];
      contexts: Buffer[] = [];
      async copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void> {
        await super.copyIn(id, dir, tar);
        this.tars.push(await readAll(tar));
      }
      async buildImage(tag: string, context: NodeJS.ReadableStream, opts?: unknown): Promise<void> {
        await super.buildImage(tag, context, opts);
        this.contexts.push(await readAll(context));
      }
    }

    it('copies the tar bytes into the right directory', async () => {
      await h.close();
      const fake = new CapturingFake();
      fake.existing.push(KUNJ);
      h = await startHarness(fake);
      const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
      await h.remote.copyIn('kunj-r-b-1', '/home/dev/.kunj', Readable.from([bytes]));
      expect(fake.callsOf('copyIn')).toEqual([['kunj-r-b-1', '/home/dev/.kunj']]);
      expect(fake.tars[0].equals(bytes)).toBe(true);
    });

    it('builds with the context body and the options header; refuses a foreign tag', async () => {
      await h.close();
      const fake = new CapturingFake();
      h = await startHarness(fake);
      await h.remote.buildImage('kunj-sandbox:1-a', Readable.from(['FROM x']), { dockerfile: 'Dockerfile.dind', buildArgs: { A: '1' } });
      expect(fake.callsOf('buildImage')).toEqual([['kunj-sandbox:1-a', { dockerfile: 'Dockerfile.dind', buildArgs: { A: '1' } }]]);
      expect(fake.contexts[0].toString()).toBe('FROM x');
      expect(await h.remote.imageExists('kunj-sandbox:1-a')).toBe(true);
      await expect(h.remote.buildImage('node:22', Readable.from(['x']))).rejects.toMatchObject({ code: 'remote-refused' });
    });
  });

  describe('logs', () => {
    it('delivers lines to onLine with their stream and the options', async () => {
      h.fake.logLines = [['stdout', 'a'], ['stderr', 'b']];
      const lines: Array<[string, string]> = [];
      await h.remote.logs('kunj-r-b-1', { follow: true, tail: 10, onLine: (s, l) => lines.push([s, l]) });
      expect(lines).toEqual([['stdout', 'a'], ['stderr', 'b']]);
      const [, opts] = h.fake.callsOf('logs')[0] as [string, { follow: boolean; tail: number; signal?: AbortSignal }];
      expect(opts).toMatchObject({ follow: true, tail: 10 });
      // A client that leaves a follow ends it on the box
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('events', () => {
    it('delivers events until aborted, then resolves', async () => {
      const seen: unknown[] = [];
      const controller = new AbortController();
      const done = h.remote.events({ 'kunj.repo': 'r' }, e => seen.push(e), controller.signal);
      await new Promise<void>(resolve => {
        const tick = () => (h.fake.callsOf('events').length ? resolve() : setTimeout(tick, 5));
        tick();
      });
      await new Promise(r => setTimeout(r, 20));
      h.fake.emitEvent({ action: 'start', name: 'kunj-r-b-1', labels: { 'kunj.repo': 'r' }, at: 't' });
      await new Promise(r => setTimeout(r, 50));
      controller.abort();
      await done;
      expect(seen).toEqual([{ action: 'start', name: 'kunj-r-b-1', labels: { 'kunj.repo': 'r' }, at: 't' }]);
      expect(h.fake.callsOf('events')).toEqual([[{ 'kunj.repo': 'r' }]]);
    });

    it('rejects when the server goes away first, as kunj events expects', async () => {
      const controller = new AbortController();
      const done = h.remote.events({ 'kunj.repo': 'r' }, () => {}, controller.signal);
      await new Promise(r => setTimeout(r, 50));
      const closed = h;
      h = await startHarness();
      await closed.close();
      await expect(done).rejects.toThrow(/docker events failed|unreachable/);
    });

    it('resolves at once when already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await h.remote.events({ 'kunj.repo': 'r' }, () => {}, controller.signal);
      expect(h.fake.callsOf('events')).toEqual([]);
    });
  });
});
