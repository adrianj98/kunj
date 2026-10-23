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
  parseProcNetTcp,
  readForwards,
  runAutoForward,
  spawnDetached,
  updateForwards,
  writeForwards,
} from '../autoforward';

// Lines as Linux prints them: little-endian hex address words, hex port, st 0A = LISTEN
const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TCP6_HEADER = '  sl  local_address                         remote_address                        st tx_queue rx_queue';
const tcp = (n: number, local: string, st = '0A') => `   ${n}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0`;
const tcp6 = (n: number, local: string, st = '0A') => `   ${n}: ${local} 00000000000000000000000000000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000`;
const V6_ANY = '00000000000000000000000000000000';
const V6_LOOPBACK = '00000000000000000000000001000000';
const V6_MAPPED_LOOPBACK = '0000000000000000FFFF00000100007F';

/** /proc/net/tcp and /proc/net/tcp6 of a container listening on `ports` (all addresses) */
function procNet(...ports: number[]): string {
  const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, '0');
  return [TCP_HEADER, ...ports.map((p, i) => tcp(i, `00000000:${hex(p)}`)), TCP6_HEADER, ''].join('\n');
}

describe('parseProcNetTcp', () => {
  it('reads IPv4, IPv6, wildcard, loopback and mapped listeners, once each, sorted', () => {
    const out = [
      TCP_HEADER,
      tcp(0, '00000000:0BB8'), // 0.0.0.0:3000
      tcp(1, '0100007F:1538'), // 127.0.0.1:5432
      tcp(2, '0200007F:1F90'), // 127.0.0.2:8080
      TCP6_HEADER,
      tcp6(0, `${V6_ANY}:1435`), // [::]:5173
      tcp6(1, `${V6_ANY}:0BB8`), // [::]:3000 again
      tcp6(2, `${V6_MAPPED_LOOPBACK}:2329`), // [::ffff:127.0.0.1]:9001
      '',
    ].join('\n');
    expect(parseProcNetTcp(out)).toEqual([3000, 5173, 5432, 8080, 9001]);
  });

  it("skips non-LISTEN sockets, Docker's DNS, other addresses and garbage", () => {
    const out = [
      TCP_HEADER,
      tcp(0, '0100007F:0BB8', '01'), // ESTABLISHED
      tcp(1, '0B00007F:9DAF'), // 127.0.0.11: Docker's embedded DNS
      tcp(2, '030012AC:1B58'), // 172.18.0.3:7000, unreachable through 127.0.0.1
      tcp6(3, '000000FD000000000000000003000000:1B59'), // fd00::3
      'garbage',
      '   4: 0100007F:ZZZZ 00000000:0000 0A',
      '   5: 0100:0BB8 00000000:0000 0A',
    ].join('\n');
    expect(parseProcNetTcp(out)).toEqual([]);
  });

  it('drops a port bound only on ::1 (the tunnel connects to 127.0.0.1), but not one also on IPv4', () => {
    const out = [
      TCP_HEADER,
      tcp(0, '0100007F:0BB9'), // 127.0.0.1:3001
      TCP6_HEADER,
      tcp6(0, `${V6_LOOPBACK}:0BB8`), // [::1]:3000 only
      tcp6(1, `${V6_LOOPBACK}:0BB9`), // [::1]:3001 and 127.0.0.1:3001
    ].join('\n');
    expect(parseProcNetTcp(out)).toEqual([3001]);
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

  it('runs the built dist/index.js when the entry is a TypeScript file (ts-node)', () => {
    const argv = process.argv;
    process.argv = [argv[0], '/x/kunj/src/index.ts'];
    mockSpawn.mockReturnValueOnce({ pid: 1, unref: jest.fn() });
    try {
      spawnDetached(['ct']);
    } finally {
      process.argv = argv;
    }
    expect(mockSpawn.mock.calls.at(-1)[1]).toEqual([path.resolve(__dirname, '../../../../dist/index.js'), 'ct']);
  });

  it('throws when no process was started', () => {
    mockSpawn.mockReturnValueOnce({ pid: undefined, unref: jest.fn() });
    expect(() => spawnDetached(['ct'])).toThrow(/background/);
  });
});

describe('runAutoForward', () => {
  const PROC = 'cat /proc/net/tcp /proc/net/tcp6';
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
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(22) });
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, user: 'dev', onChange: c => changes.push(c), signal: controller.signal });

    await until(() => backend.callsOf('exec').length >= 3);
    expect(changes).toEqual([]);

    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(22, 3000) });
    await until(() => changes.length === 1);
    expect(changes).toEqual([{ event: 'add', port: 3000, hostPort: 3001 }]);
    expect((forwardPort as jest.Mock).mock.calls[0].slice(1)).toEqual(['cid', { container: 3000 }, { hasSocat: true, nextFree: true }]);

    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet() });
    await until(() => changes.length === 2);
    expect(changes[1]).toEqual({ event: 'remove', port: 3000, hostPort: 3001 });
    expect(mockClosed).toEqual([3000]);

    controller.abort();
    await run;
    expect(backend.callsOf('exec')[0][1]).toEqual(['sh', '-c', 'command -v socat']);
    expect(backend.callsOf('exec').slice(1).every(c => (c[1] as string[]).join(' ') === PROC && (c[2] as { user: string }).user === 'dev')).toBe(true);
  });

  it('reads /proc/net/tcp when the kernel has no tcp6 (cat exits 1)', async () => {
    const changes: AutoForwardChange[] = [];
    const controller = new AbortController();
    const tcpOnly = [TCP_HEADER, tcp(0, '00000000:0BB8')].join('\n');
    backend.execResults.set(PROC, { exitCode: 1, stdout: tcpOnly });
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, onChange: c => changes.push(c), signal: controller.signal });
    await until(() => changes.length === 1);
    controller.abort();
    await run;
    expect(changes[0].port).toBe(3000);
  });

  it('keeps forwards when a poll fails, and warns once while the listeners cannot be read', async () => {
    const changes: AutoForwardChange[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(3000) });
    const run = runAutoForward(backend, 'cid', {
      ignore: [],
      intervalMs: 2,
      onChange: c => changes.push(c),
      onError: m => errors.push(m),
      signal: controller.signal,
    });
    await until(() => changes.length === 1);

    // e.g. an image without cat: the exec fails on every poll
    backend.execResults.set(PROC, { exitCode: 127, stdout: '' });
    const polls = backend.callsOf('exec').length;
    await until(() => backend.callsOf('exec').length >= polls + 5);
    expect(changes).toHaveLength(1);
    expect(errors).toEqual(["Cannot read the container's listening ports (/proc/net/tcp); nothing new is forwarded until it can be read"]);

    // Readable again, then failing again: one more warning
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(3000) });
    await until(() => backend.callsOf('exec').length >= polls + 8);
    backend.execResults.set(PROC, { exitCode: 127, stdout: '' });
    await until(() => backend.callsOf('exec').length >= polls + 12);
    expect(errors).toHaveLength(2);

    controller.abort();
    await run;
    expect(mockClosed).toEqual([3000]);
  });

  it('does not retry a port it could not forward until its listener comes back', async () => {
    const controller = new AbortController();
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(4444) });
    const errors: string[] = [];
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, signal: controller.signal, onError: m => errors.push(m) });
    await until(() => backend.callsOf('exec').length >= 6);
    controller.abort();
    await run;
    expect(forwardPort).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['Could not forward port 4444: no free port']);
  });

  it('returns once the container is seen not running twice in a row', async () => {
    backend.states.set('cid', 'exited');
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(3000) });
    await runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, stateIntervalMs: 1, signal: new AbortController().signal });
    expect(backend.callsOf('containerState')).toEqual([['cid'], ['cid']]);
  });

  it('survives a single failed state check', async () => {
    const controller = new AbortController();
    const state = jest.spyOn(backend, 'containerState').mockResolvedValueOnce(null);
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet() });
    const run = runAutoForward(backend, 'cid', { ignore: [], intervalMs: 2, stateIntervalMs: 1, signal: controller.signal });
    await until(() => state.mock.calls.length >= 4);
    controller.abort();
    await run;
    expect(backend.callsOf('containerState').length).toBeGreaterThanOrEqual(3);
  });

  it('honours the ignore list', async () => {
    const changes: AutoForwardChange[] = [];
    const controller = new AbortController();
    backend.execResults.set(PROC, { exitCode: 0, stdout: procNet(9229, 3000) });
    const run = runAutoForward(backend, 'cid', { ignore: [9229], intervalMs: 2, onChange: c => changes.push(c), signal: controller.signal });
    await until(() => changes.length === 1);
    controller.abort();
    await run;
    expect(changes.map(c => c.port)).toEqual([3000]);
  });
});
