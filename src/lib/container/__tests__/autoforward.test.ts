import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: (...args: unknown[]) => mockSpawn(...args) }));

// No real listener: a forward is a host port handed back by the mock
const mockClosed: number[] = [];
jest.mock('../forward', () => ({
  ...jest.requireActual('../forward'),
  forwardPort: jest.fn(async (_b: unknown, _id: string, spec: { container: number }, opts: { nextFree?: boolean }) => {
    if (spec.container === 4444) throw new Error('no free port');
    return { hostPort: spec.container + (opts.nextFree ? 1 : 0), close: async () => void mockClosed.push(spec.container) };
  }),
}));

import { FakeBackend } from './fake-backend';
import { forwardPort } from '../forward';
import {
  AutoForwardChange,
  ForwardRecord,
  diffPorts,
  forwarderFor,
  ignoredPorts,
  parseSsListen,
  readForwards,
  runAutoForward,
  spawnDetached,
  updateForwards,
  writeForwards,
} from '../autoforward';

describe('parseSsListen', () => {
  it('reads IPv4, IPv6 and wildcard listeners, once each, sorted', () => {
    const out = [
      'LISTEN 0      511             *:3000        *:*',
      'LISTEN 0      4096      0.0.0.0:5173   0.0.0.0:*',
      'LISTEN 0      4096         [::]:5173      [::]:*',
      'LISTEN 0      128     127.0.0.1:5432   0.0.0.0:*',
      'LISTEN 0      128         [::1]:8080      [::]:*',
      'LISTEN 0      128   0.0.0.0%lo:9000   0.0.0.0:*',
      'LISTEN 0      128  [::ffff:127.0.0.1]:9001 [::]:*',
      '',
    ].join('\n');
    expect(parseSsListen(out)).toEqual([3000, 5173, 5432, 8080, 9000, 9001]);
  });

  it("skips Docker's embedded DNS and addresses the tunnel cannot reach through 127.0.0.1", () => {
    const out = [
      'LISTEN 0      4096   127.0.0.11:40335 0.0.0.0:*',
      'LISTEN 0      4096   172.18.0.3:7000  0.0.0.0:*',
      'LISTEN 0      4096   [fd00::3]:7001   [::]:*',
      'garbage',
      'LISTEN 0 4096 127.0.0.1:notaport 0.0.0.0:*',
    ].join('\n');
    expect(parseSsListen(out)).toEqual([]);
  });
});

describe('diffPorts', () => {
  it('adds new listeners and removes gone ones, skipping < 1024 and ignored ports', () => {
    expect(diffPorts(new Set([3000, 4000]), [22, 80, 1023, 1024, 3000, 5000, 9229], [9229])).toEqual({
      add: [1024, 5000],
      remove: [4000],
    });
  });

  it('removes a forward whose port became ignored', () => {
    expect(diffPorts(new Set([9229]), [9229], [9229])).toEqual({ add: [], remove: [9229] });
  });
});

describe('ignoredPorts', () => {
  it('reads a list or the single value config --set stores', () => {
    expect(ignoredPorts(['9229', 5555, 'x'])).toEqual([9229, 5555]);
    expect(ignoredPorts(9229)).toEqual([9229]);
    expect(ignoredPorts('9229')).toEqual([9229]);
    expect(ignoredPorts(undefined)).toEqual([]);
  });
});

describe('forward registry', () => {
  let dir: string;
  let file: string;
  const dead = 2 ** 22 + 12345; // above every pid_max default: never a live process

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-fwd-'));
    file = path.join(dir, 'container-forwards.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rec = (pid: number, port: number, container = 'kunj-app-feat-abc'): ForwardRecord => ({ pid, container, port, hostPort: port, kind: 'forward' });

  it('is empty when the file is missing or unreadable', () => {
    expect(readForwards(file)).toEqual([]);
    fs.writeFileSync(file, '{not json');
    expect(readForwards(file)).toEqual([]);
  });

  it('prunes dead pids on read and writes the pruned list back', () => {
    writeForwards([rec(process.pid, 3000), rec(dead, 4000)], file);
    expect(readForwards(file)).toEqual([rec(process.pid, 3000)]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([rec(process.pid, 3000)]);
  });

  it('writes atomically, leaving no temp file behind', () => {
    writeForwards([rec(process.pid, 3000)], file);
    expect(fs.readdirSync(dir)).toEqual(['container-forwards.json']);
  });

  it('updateForwards applies a change to the pruned list', () => {
    writeForwards([rec(dead, 1), rec(process.pid, 3000)], file);
    updateForwards(rs => [...rs, rec(process.pid, 5000)], file);
    expect(readForwards(file)).toEqual([rec(process.pid, 3000), rec(process.pid, 5000)]);
  });

  it('forwarderFor finds a live forwarder of the container', () => {
    writeForwards([rec(dead, 0, 'c1'), rec(process.pid, 0, 'c2')], file);
    expect(forwarderFor('c1', file)).toBeUndefined();
    expect(forwarderFor('c2', file)).toBe(process.pid);
  });
});

describe('spawnDetached', () => {
  it('starts this CLI detached with stdio ignored and unrefs it', () => {
    const unref = jest.fn();
    mockSpawn.mockReturnValueOnce({ pid: 4242, unref });
    expect(spawnDetached(['ct', 'forward', 'feat', '--auto'])).toBe(4242);
    expect(mockSpawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], 'ct', 'forward', 'feat', '--auto'], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    expect(unref).toHaveBeenCalled();
  });

  it('throws when no process was started', () => {
    mockSpawn.mockReturnValueOnce({ pid: undefined, unref: jest.fn() });
    expect(() => spawnDetached(['ct'])).toThrow(/background/);
  });
});

describe('runAutoForward', () => {
  const SS = 'ss -ltnH';
  let backend: FakeBackend;

  beforeEach(() => {
    backend = new FakeBackend();
    mockClosed.length = 0;
    (forwardPort as jest.Mock).mockClear();
  });

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise(r => setTimeout(r, 2));
    }
  }

  it('forwards a new listener on the next free host port and drops it when it goes away', async () => {
    const changes: AutoForwardChange[] = [];
    const controller = new AbortController();
    backend.execResults.set(SS, { exitCode: 0, stdout: 'LISTEN 0 511 *:22 *:*\n' });
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, user: 'dev', onChange: c => changes.push(c), signal: controller.signal });

    await until(() => backend.callsOf('exec').length >= 3);
    expect(changes).toEqual([]);

    backend.execResults.set(SS, { exitCode: 0, stdout: 'LISTEN 0 511 *:22 *:*\nLISTEN 0 511 *:3000 *:*\n' });
    await until(() => changes.length === 1);
    expect(changes).toEqual([{ event: 'add', port: 3000, hostPort: 3001 }]);
    expect((forwardPort as jest.Mock).mock.calls[0].slice(1)).toEqual(['cid', { container: 3000 }, { hasSocat: true, nextFree: true }]);

    backend.execResults.set(SS, { exitCode: 0, stdout: '' });
    await until(() => changes.length === 2);
    expect(changes[1]).toEqual({ event: 'remove', port: 3000, hostPort: 3001 });
    expect(mockClosed).toEqual([3000]);

    controller.abort();
    await run;
    expect(backend.callsOf('exec')[0][1]).toEqual(['sh', '-c', 'command -v socat']);
    expect(backend.callsOf('exec').slice(1).every(c => (c[1] as string[]).join(' ') === SS && (c[2] as { user: string }).user === 'dev')).toBe(true);
  });

  it('keeps forwards when a poll fails, and closes them when aborted', async () => {
    const changes: AutoForwardChange[] = [];
    const controller = new AbortController();
    backend.execResults.set(SS, { exitCode: 0, stdout: 'LISTEN 0 511 *:3000 *:*\n' });
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, onChange: c => changes.push(c), signal: controller.signal });
    await until(() => changes.length === 1);

    backend.execResults.set(SS, { exitCode: 1, stdout: '' });
    const polls = backend.callsOf('exec').length;
    await until(() => backend.callsOf('exec').length >= polls + 3);
    expect(changes).toHaveLength(1);

    controller.abort();
    await run;
    expect(mockClosed).toEqual([3000]);
  });

  it('does not retry a port it could not forward until its listener comes back', async () => {
    const controller = new AbortController();
    backend.execResults.set(SS, { exitCode: 0, stdout: 'LISTEN 0 511 *:4444 *:*\n' });
    const errors: string[] = [];
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, signal: controller.signal, onError: m => errors.push(m) });
    await until(() => backend.callsOf('exec').length >= 6);
    controller.abort();
    await run;
    expect(forwardPort).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['Could not forward port 4444: no free port']);
  });

  it('returns once the container is no longer running', async () => {
    backend.states.set('cid', 'exited');
    backend.execResults.set(SS, { exitCode: 0, stdout: 'LISTEN 0 511 *:3000 *:*\n' });
    await runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, stateIntervalMs: 1, signal: new AbortController().signal });
    expect(backend.callsOf('containerState')).toEqual([['cid']]);
  });

  it('honours the ignore list', async () => {
    const changes: AutoForwardChange[] = [];
    const controller = new AbortController();
    backend.execResults.set(SS, { exitCode: 0, stdout: 'LISTEN 0 511 *:9229 *:*\nLISTEN 0 511 *:3000 *:*\n' });
    const run = runAutoForward(backend, 'cid', { ignore: [9229], intervalMs: 2, onChange: c => changes.push(c), signal: controller.signal });
    await until(() => changes.length === 1);
    controller.abort();
    await run;
    expect(changes.map(c => c.port)).toEqual([3000]);
  });
});
