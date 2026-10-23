import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { FakeBackend } from './fake-backend';
import { ExecIO } from '../backend';
import {
  BridgeRecord,
  DEFAULT_ALLOW_ORIGINS,
  bridgeFor,
  containerMcpEntry,
  installMcpConfig,
  makeOriginFilter,
  mcpServers,
  mergeClaudeConfig,
  originAllowed,
  portHint,
  readBridges,
  runBridge,
  serverEnv,
  updateBridges,
  writeBridges,
} from '../mcpbridge';

const call = (id: unknown, name: string, args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('originAllowed', () => {
  it('matches scheme and host, any port', () => {
    expect(originAllowed('http://localhost:3000/a?b', DEFAULT_ALLOW_ORIGINS)).toBe(true);
    expect(originAllowed('http://127.0.0.1/', DEFAULT_ALLOW_ORIGINS)).toBe(true);
    expect(originAllowed('http://LOCALHOST:8080', DEFAULT_ALLOW_ORIGINS)).toBe(true);
  });

  it('rejects other hosts, look-alike hosts, other schemes and garbage', () => {
    expect(originAllowed('http://localhost.evil.com/', DEFAULT_ALLOW_ORIGINS)).toBe(false);
    expect(originAllowed('http://evil.com/?http://localhost', DEFAULT_ALLOW_ORIGINS)).toBe(false);
    expect(originAllowed('http://localhost@evil.com/', DEFAULT_ALLOW_ORIGINS)).toBe(false);
    expect(originAllowed('https://localhost/', DEFAULT_ALLOW_ORIGINS)).toBe(false);
    expect(originAllowed('file:///etc/passwd', DEFAULT_ALLOW_ORIGINS)).toBe(false);
    expect(originAllowed('javascript:alert(1)', DEFAULT_ALLOW_ORIGINS)).toBe(false);
    expect(originAllowed('not a url', DEFAULT_ALLOW_ORIGINS)).toBe(false);
  });

  it('uses the configured list, ignoring entries that are not URLs', () => {
    expect(originAllowed('https://staging.example.com/x', ['https://staging.example.com', 'nonsense'])).toBe(true);
    expect(originAllowed('http://localhost/', ['https://staging.example.com'])).toBe(false);
  });
});

describe('makeOriginFilter', () => {
  const filter = makeOriginFilter(DEFAULT_ALLOW_ORIGINS);

  it('passes a navigate to localhost', () => {
    expect(filter(call(1, 'navigate_page', { url: 'http://localhost:3000/' }))).toEqual({ pass: true });
    expect(filter(call(2, 'new_page', { url: 'http://127.0.0.1:5173' }))).toEqual({ pass: true });
  });

  it('answers a navigate to another origin with a JSON-RPC error carrying the request id', () => {
    const r = filter(call(7, 'navigate_page', { url: 'https://example.com/' }));
    expect(r.pass).toBe(false);
    const reply = JSON.parse(r.reply!);
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32602 } });
    expect(reply.error.message).toContain('https://example.com');
    expect(reply.error.message).toContain('allowOrigins');
  });

  it('rejects localhost.evil.com and a new_page elsewhere', () => {
    expect(filter(call('a', 'navigate_page', { url: 'http://localhost.evil.com/' })).pass).toBe(false);
    expect(JSON.parse(filter(call('a', 'new_page', { url: 'http://192.168.1.1/' })).reply!).id).toBe('a');
  });

  it('rejects a url that is not a string', () => {
    expect(filter(call(3, 'navigate_page', { url: ['http://localhost'] })).pass).toBe(false);
  });

  it('passes a navigate without a url (back, forward, reload)', () => {
    expect(filter(call(4, 'navigate_page', { type: 'back' }))).toEqual({ pass: true });
  });

  it('passes other tools and other methods, whatever their urls', () => {
    expect(filter(call(5, 'take_screenshot', { url: 'https://example.com' }))).toEqual({ pass: true });
    expect(filter(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }))).toEqual({ pass: true });
    expect(filter(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toEqual({ pass: true });
  });

  it('passes malformed lines unchanged', () => {
    for (const line of ['', 'not json', '{"half":', '42', 'null', '"str"']) expect(filter(line)).toEqual({ pass: true });
  });

  it('answers every request of a batch that holds a blocked navigate', () => {
    const batch = `[${call(1, 'navigate_page', { url: 'https://evil.com' })},${call(2, 'list_pages', {})}]`;
    const r = filter(batch);
    expect(r.pass).toBe(false);
    expect(JSON.parse(r.reply!).map((m: { id: number }) => m.id)).toEqual([1, 2]);
  });
});

describe('mcpServers', () => {
  it('is empty when nothing is configured', () => {
    expect(mcpServers(undefined, () => {})).toEqual([]);
    expect(mcpServers({}, () => {})).toEqual([]);
  });

  it('gives chrome the default command and origins', () => {
    expect(mcpServers({ chrome: {} }, () => {})).toEqual([
      {
        name: 'chrome',
        cfg: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'], env: {}, allowOrigins: DEFAULT_ALLOW_ORIGINS },
      },
    ]);
    expect(mcpServers({ chrome: true }, () => {})).toHaveLength(1);
  });

  it('takes a configured command, args, env and origins', () => {
    const cfg = { command: 'node', args: ['srv.js'], env: { A: '1' }, allowOrigins: ['https://x.test'] };
    expect(mcpServers({ chrome: cfg }, () => {})).toEqual([{ name: 'chrome', cfg }]);
  });

  it('warns about and skips servers other than chrome, and invalid entries', () => {
    const warnings: string[] = [];
    expect(mcpServers({ github: { command: 'gh-mcp' }, chrome: { command: '' } }, m => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/github.*only the browser server "chrome"/);
    expect(warnings[1]).toMatch(/chrome/);
  });
});

describe('serverEnv', () => {
  it('passes only PATH, HOME and the configured env', () => {
    expect(serverEnv({ command: 'x', env: { DEBUG: '1' } }, { PATH: '/bin', HOME: '/h', GH_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k' })).toEqual({
      PATH: '/bin',
      HOME: '/h',
      DEBUG: '1',
    });
  });
});

describe('containerMcpEntry and mergeClaudeConfig', () => {
  it('points the server at the socket through socat', () => {
    expect(containerMcpEntry('chrome')).toEqual({ command: 'socat', args: ['-', 'UNIX-CONNECT:/run/kunj-mcp/chrome.sock'] });
  });

  it('creates the file when there is none', () => {
    expect(JSON.parse(mergeClaudeConfig(null, ['chrome'])!)).toEqual({ mcpServers: { chrome: containerMcpEntry('chrome') } });
  });

  it('keeps existing servers and other keys', () => {
    const text = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    expect(JSON.parse(mergeClaudeConfig(text, ['chrome'])!)).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x' }, chrome: containerMcpEntry('chrome') },
    });
  });

  it('is idempotent: null when nothing changes', () => {
    const once = mergeClaudeConfig('{}', ['chrome'])!;
    expect(mergeClaudeConfig(once, ['chrome'])).toBeNull();
  });

  it('refuses a file that is not a JSON object', () => {
    expect(() => mergeClaudeConfig('{broken', ['chrome'])).toThrow(/not valid JSON/);
    expect(() => mergeClaudeConfig('[]', ['chrome'])).toThrow(/not a JSON object/);
  });
});

describe('installMcpConfig', () => {
  const READ = 'sh -c f="$HOME/.claude.json"; [ -e "$f" ] || exit 3; cat "$f"';

  it('writes the merged config as the user, keeping existing servers', async () => {
    const b = new FakeBackend();
    b.execResults.set(READ, { exitCode: 0, stdout: JSON.stringify({ mcpServers: { other: { command: 'x' } } }) });
    await installMcpConfig(b, 'cid', 'sandbox', ['chrome']);
    const execs = b.callsOf('exec');
    expect(execs).toHaveLength(2);
    expect((execs[0][2] as ExecIO).user).toBe('sandbox');
    expect((execs[1][2] as ExecIO).user).toBe('sandbox');
    expect(JSON.parse(b.stdinData[1]!)).toEqual({ mcpServers: { other: { command: 'x' }, chrome: containerMcpEntry('chrome') } });
  });

  it('creates the file when it is missing', async () => {
    const b = new FakeBackend();
    b.execResults.set(READ, { exitCode: 3, stdout: '' });
    await installMcpConfig(b, 'cid', '', ['chrome']);
    expect((b.callsOf('exec')[0][2] as ExecIO).user).toBeUndefined();
    expect(JSON.parse(b.stdinData[1]!)).toEqual({ mcpServers: { chrome: containerMcpEntry('chrome') } });
  });

  it('writes nothing when the entry is already there', async () => {
    const b = new FakeBackend();
    b.execResults.set(READ, { exitCode: 0, stdout: mergeClaudeConfig(null, ['chrome'])! });
    await installMcpConfig(b, 'cid', 'sandbox', ['chrome']);
    expect(b.callsOf('exec')).toHaveLength(1);
  });

  it('throws when the file cannot be read', async () => {
    const b = new FakeBackend();
    b.execResults.set(READ, { exitCode: 1, stdout: '' });
    await expect(installMcpConfig(b, 'cid', 'sandbox', ['chrome'])).rejects.toThrow(/Could not read/);
  });
});

describe('portHint', () => {
  it('names the host port of each forwarded container port', () => {
    const hint = portHint([{ port: 3000, hostPort: 3001 }, { port: 5173, hostPort: 5173 }]);
    expect(hint).toContain('container port 3000 is http://localhost:3001');
    expect(hint).toContain('container port 5173 is http://localhost:5173');
  });

  it('says how to forward when nothing is', () => {
    expect(portHint([])).toMatch(/kunj ct forward/);
  });
});

describe('bridge registry', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-bridges-'));
    file = path.join(dir, 'container-bridges.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const DEAD = 2 ** 22 + 12345; // above the default pid_max

  it('is empty when the file is missing or unreadable', () => {
    expect(readBridges(file)).toEqual([]);
    fs.writeFileSync(file, '{oops');
    expect(readBridges(file)).toEqual([]);
  });

  it('prunes dead pids on read and writes the pruned list back', () => {
    const live: BridgeRecord = { pid: process.pid, container: 'c1', name: 'chrome' };
    writeBridges([live, { pid: DEAD, container: 'c2', name: 'chrome' }], file);
    expect(readBridges(file)).toEqual([live]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([live]);
  });

  it('updateBridges and bridgeFor', () => {
    updateBridges(rs => [...rs, { pid: process.pid, container: 'c1', name: 'chrome' }], file);
    expect(bridgeFor('c1', file)).toBe(process.pid);
    expect(bridgeFor('c2', file)).toBeUndefined();
    expect(bridgeFor('c1', file, process.pid)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// runBridge against FakeBackend: the listener exec is a scripted client; the MCP server is a real
// node process that echoes each request's method (and exits on "exit").

const ECHO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'exit') process.exit(0);
  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', instructions: 'from the server' } : { echo: m.method, env: process.env.GH_TOKEN || null };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

interface Client {
  send(obj: unknown): void;
  /** The next line the bridge sends to the container */
  next(): Promise<any>;
  /** Resolves when the bridge ends the exec's stdin (the server is gone) */
  stdinEnded: Promise<void>;
}

/** Programs the listener execs: each runs `script` with a client, then ends with exit 0. */
function scriptedListener(b: FakeBackend, scripts: Array<(c: Client) => Promise<void>>) {
  const pending: Array<() => void> = [];
  b.execHandler = (_id, cmd, io) => {
    const line = cmd.join(' ');
    if (line.includes('UNIX-LISTEN')) {
      const script = scripts.shift();
      const stdin = io.stdin as NodeJS.ReadableStream;
      const stdout = io.stdout as NodeJS.WritableStream;
      if (!script) return new Promise(resolve => pending.push(() => resolve({ exitCode: 143, stdout: '' })));
      const queue: any[] = [];
      const waiters: Array<(v: any) => void> = [];
      let buf = '';
      stdin.on('data', (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          const w = waiters.shift();
          if (w) w(msg);
          else queue.push(msg);
        }
      });
      const stdinEnded = new Promise<void>(resolve => stdin.on('end', () => resolve()));
      const client: Client = {
        send: obj => stdout.write(JSON.stringify(obj) + '\n'),
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve))),
        stdinEnded,
      };
      return script(client).then(() => ({ exitCode: 0, stdout: '' }));
    }
    if (line.includes('kill')) {
      pending.splice(0).forEach(f => f());
    }
    return undefined;
  };
}

function recordingSpawn() {
  const calls: Array<{ command: string; args: string[]; options: childProcess.SpawnOptions }> = [];
  const spawn = ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    calls.push({ command, args, options });
    return childProcess.spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
  }) as unknown as typeof childProcess.spawn;
  return { calls, spawn };
}

const CFG = { command: process.execPath, args: ['-e', ECHO_SERVER], env: {}, allowOrigins: DEFAULT_ALLOW_ORIGINS };

describe('runBridge', () => {
  it('prepares /run/kunj-mcp as root and checks for socat', async () => {
    const b = new FakeBackend();
    b.execHandler = (_id, cmd) => (cmd.join(' ').includes('mkdir') ? Promise.resolve({ exitCode: 3, stdout: '' }) : undefined);
    const controller = new AbortController();
    await expect(runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal })).rejects.toThrow(/socat is not installed/);
    expect((b.callsOf('exec')[0][2] as ExecIO).user).toBe('root');
  });

  it('round-trips JSON-RPC between the container and a server it starts on the first message', async () => {
    const b = new FakeBackend();
    const { calls, spawn } = recordingSpawn();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'http://localhost:3000' } } });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, hostEnv: { PATH: '/bin', HOME: '/h', GH_TOKEN: 's' } });

    expect(replies).toEqual([
      { jsonrpc: '2.0', id: 1, result: { echo: 'tools/list', env: null } },
      { jsonrpc: '2.0', id: 2, result: { echo: 'tools/call', env: null } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.env).toEqual({ PATH: '/bin', HOME: '/h' });

    const execs = b.callsOf('exec');
    const prepare = execs.find(e => (e[1] as string[]).join(' ').includes('mkdir'))!;
    expect((prepare[2] as ExecIO).user).toBe('root');
    expect((prepare[1] as string[]).slice(-2)).toEqual(['sandbox', 'chrome']);
    const listen = execs.find(e => (e[1] as string[]).join(' ').includes('UNIX-LISTEN'))!;
    expect((listen[2] as ExecIO).user).toBe('root');
    expect((listen[1] as string[]).join(' ')).toContain('mode=600');
    // On abort the listener is killed through its pid file
    expect(execs.some(e => (e[1] as string[]).join(' ').includes('kill'))).toBe(true);
  });

  it('answers a navigate to another origin itself; the server never sees it', async () => {
    const b = new FakeBackend();
    const { spawn } = recordingSpawn();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'new_page', arguments: { url: 'https://evil.example' } } });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', id: 10, method: 'ping' });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn });
    expect(replies[0]).toMatchObject({ id: 9, error: { code: -32602 } });
    expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 10, result: { echo: 'ping', env: null } });
  });

  it('adds the port hint to the instructions of the initialize result', async () => {
    const b = new FakeBackend();
    const { spawn } = recordingSpawn();
    const controller = new AbortController();
    let init: any;
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
        init = await c.next();
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, instructions: () => 'PORTS' });
    expect(init.result.instructions).toBe('from the server\n\nPORTS');
  });

  it('restarts the listener after the client disconnects and after the server exits', async () => {
    const b = new FakeBackend();
    const { calls, spawn } = recordingSpawn();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      // the client goes away: the server is stopped, a new listener waits
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'a' });
        replies.push(await c.next());
      },
      // the server exits: the bridge ends the exec's stdin
      async c => {
        c.send({ jsonrpc: '2.0', id: 2, method: 'b' });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', method: 'exit' });
        await c.stdinEnded;
      },
      async c => {
        c.send({ jsonrpc: '2.0', id: 3, method: 'c' });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, restartDelayMs: 0 });
    expect(replies.map(r => r.result.echo)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(3);
  });

  it('returns once the container is seen not running twice in a row', async () => {
    const b = new FakeBackend();
    b.states.set('cid', 'exited');
    b.execHandler = (_id, cmd) =>
      cmd.join(' ').includes('UNIX-LISTEN') ? Promise.resolve({ exitCode: 1, stdout: '' }) : undefined;
    const controller = new AbortController();
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, restartDelayMs: 0, stateIntervalMs: 0 });
    expect(b.callsOf('containerState').length).toBe(2);
  });

  it('logs a listener that fails, and retries more slowly each time', async () => {
    const b = new FakeBackend();
    const started: number[] = [];
    b.execHandler = (_id, cmd, io) => {
      if (!cmd.join(' ').includes('UNIX-LISTEN')) return undefined;
      started.push(Date.now());
      (io.stderr as NodeJS.WritableStream).write('socat: bind: Address in use\n');
      return Promise.resolve({ exitCode: 1, stdout: '' });
    };
    const logs: string[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, restartDelayMs: 40, log: m => logs.push(m) });
    expect(logs[0]).toBe('MCP chrome: listener ended without a client (exit 1): socat: bind: Address in use');
    // 40, 80, 160 ms apart: about four attempts in 400 ms, not ten
    expect(started.length).toBeGreaterThanOrEqual(3);
    expect(started.length).toBeLessThanOrEqual(5);
  });

  it('resolves the user with id -un when none is recorded', async () => {
    const b = new FakeBackend();
    b.execResults.set('id -un', { exitCode: 0, stdout: 'node\n' });
    const controller = new AbortController();
    scriptedListener(b, []);
    setTimeout(() => controller.abort(), 20);
    await runBridge(b, 'cid', 'chrome', CFG, { user: '', signal: controller.signal });
    const prepare = b.callsOf('exec').find(e => (e[1] as string[]).join(' ').includes('mkdir'))!;
    expect((prepare[1] as string[]).slice(-2)).toEqual(['node', 'chrome']);
  });

  it('refuses a user or name that could change the socat address', async () => {
    const b = new FakeBackend();
    const signal = new AbortController().signal;
    await expect(runBridge(b, 'cid', 'chrome', CFG, { user: 'a,fork', signal })).rejects.toThrow(/user/);
    await expect(runBridge(b, 'cid', 'x:y', CFG, { user: 'a', signal })).rejects.toThrow(/name/);
  });
});
