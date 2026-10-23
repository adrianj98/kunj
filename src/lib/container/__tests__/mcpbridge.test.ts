import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { FakeBackend } from './fake-backend';
import { ExecIO } from '../backend';
import {
  BROWSER_TOOLS,
  BROWSER_TOOL_ARGS,
  BATCH_REFUSAL,
  BridgeRecord,
  CHROME_DEVTOOLS_MCP,
  MAX_LINE_BYTES,
  RequestPolicy,
  bridgeFor,
  containerMcpEntry,
  filterToolsList,
  forwardedOriginAllowed,
  installMcpConfig,
  isPathKey,
  listenCommand,
  makeThrowawayProfile,
  makeRequestFilter,
  mcpServers,
  mergeClaudeConfig,
  originAllowed,
  originPolicy,
  portHint,
  readBridges,
  runBridge,
  serverEnv,
  stopCommand,
  updateBridges,
  validId,
  writeBridges,
} from '../mcpbridge';

const call = (id: unknown, name: string, args: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('originAllowed (configured allowOrigins)', () => {
  it('a port-less entry allows any port of that scheme and host', () => {
    expect(originAllowed('http://localhost:3000/a?b', ['http://localhost'])).toBe(true);
    expect(originAllowed('http://LOCALHOST:8080', ['http://localhost/'])).toBe(true);
  });

  it('an entry with a port allows only that port', () => {
    expect(originAllowed('http://localhost:3000/', ['http://localhost:3000'])).toBe(true);
    expect(originAllowed('http://localhost:3001/', ['http://localhost:3000'])).toBe(false);
    expect(originAllowed('http://localhost/', ['http://localhost:80'])).toBe(true);
  });

  it('rejects other hosts, look-alike hosts, other schemes and garbage', () => {
    const allow = ['http://localhost', 'http://127.0.0.1'];
    expect(originAllowed('http://localhost.evil.com/', allow)).toBe(false);
    expect(originAllowed('http://evil.com/?http://localhost', allow)).toBe(false);
    expect(originAllowed('http://localhost@evil.com/', allow)).toBe(false);
    expect(originAllowed('https://localhost/', allow)).toBe(false);
    expect(originAllowed('file:///etc/passwd', allow)).toBe(false);
    expect(originAllowed('javascript:alert(1)', allow)).toBe(false);
    expect(originAllowed('not a url', allow)).toBe(false);
    expect(originAllowed('http://localhost/', ['nonsense'])).toBe(false);
  });
});

describe('forwardedOriginAllowed (the default)', () => {
  it('allows http(s) on localhost or 127.0.0.1 only on a forwarded port', () => {
    expect(forwardedOriginAllowed('http://localhost:3001/', [3001])).toBe(true);
    expect(forwardedOriginAllowed('https://127.0.0.1:3001/x', [3001])).toBe(true);
    expect(forwardedOriginAllowed('http://localhost:5432/', [3001])).toBe(false);
    expect(forwardedOriginAllowed('http://localhost/', [3001])).toBe(false);
    expect(forwardedOriginAllowed('http://localhost:3001/', [])).toBe(false);
    expect(forwardedOriginAllowed('http://localhost.evil.com:3001/', [3001])).toBe(false);
    expect(forwardedOriginAllowed('ws://localhost:3001/', [3001])).toBe(false);
  });
});

describe('isPathKey', () => {
  it('matches the arguments that name host files and directories', () => {
    for (const k of ['filePath', 'filePaths', 'sourcePath', 'outputDirPath', 'requestFilePath', 'baseFilePath', 'path', 'dir', 'file', 'logFile', 'userDataDir']) {
      expect([k, isPathKey(k)]).toEqual([k, true]);
    }
  });
  it('leaves ordinary arguments alone', () => {
    for (const k of ['url', 'uid', 'function', 'args', 'text', 'profile', 'format', 'fullPage']) expect([k, isPathKey(k)]).toEqual([k, false]);
  });
});

describe('makeRequestFilter', () => {
  const policy: RequestPolicy = { allowOrigin: url => originAllowed(url, ['http://localhost']), describeOrigins: () => 'allowOrigins: http://localhost' };
  const filter = makeRequestFilter(policy);
  const refused = (line: string) => {
    const r = filter(line);
    expect(r.pass).toBe(false);
    return JSON.parse((r as { reply: string }).reply);
  };

  it('passes allowed tools, an allowed navigate, and evaluate_script without file arguments', () => {
    expect(filter(call(1, 'navigate_page', { url: 'http://localhost:3000/' }))).toMatchObject({ pass: true });
    expect(filter(call(2, 'navigate_page', { type: 'back' }))).toMatchObject({ pass: true });
    expect(filter(call(3, 'take_screenshot', { fullPage: true }))).toMatchObject({ pass: true });
    expect(filter(call(4, 'evaluate_script', { function: '() => document.title' }))).toMatchObject({ pass: true });
    expect(filter(call(5, 'click', { uid: '1_2' }))).toMatchObject({ pass: true });
  });

  it('answers a navigate to another origin with a JSON-RPC error carrying the request id', () => {
    const reply = refused(call(7, 'navigate_page', { url: 'https://example.com/' }));
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32602 } });
    expect(reply.error.message).toContain('https://example.com');
    expect(refused(call('a', 'new_page', { url: 'http://localhost.evil.com/' })).id).toBe('a');
    expect(refused(call(3, 'navigate_page', { url: ['http://localhost'] })).id).toBe(3);
  });

  it('refuses every tool that is not on the allowlist, upload_file first of all', () => {
    for (const tool of ['upload_file', 'take_heapsnapshot', 'performance_start_trace', 'lighthouse_audit', 'screencast_start', 'install_extension', 'unknown_tool']) {
      const reply = refused(call(9, tool, {}));
      expect(reply.id).toBe(9);
      expect(reply.error.message).toContain(tool);
    }
    expect(BROWSER_TOOLS).not.toContain('upload_file');
  });

  it('refuses a path-like argument on any tool, however deep', () => {
    expect(refused(call(1, 'take_screenshot', { filePath: '/Users/me/.zshrc' })).error.message).toContain('filePath');
    expect(refused(call(2, 'evaluate_script', { function: '() => 1', sourcePath: '/etc/hosts' })).error.message).toContain('sourcePath');
    expect(refused(call(3, 'get_network_request', { reqid: 1, responseFilePath: '/tmp/x' })).error.message).toContain('responseFilePath');
    expect(refused(call(4, 'fill_form', { elements: [{ uid: '1', value: 'x', nested: { outputDirPath: '/' } }] })).error.message).toContain('outputDirPath');
  });

  it('refuses an argument a tool does not take, however harmless its name', () => {
    expect(refused(call(1, 'take_screenshot', { fullPage: true, output: '/tmp/x' })).error.message).toContain('output');
    expect(refused(call(2, 'evaluate_script', { function: '() => 1', saveTo: 'x' })).error.message).toContain('saveTo');
    expect(filter(call(3, 'click', { uid: '1', pageId: 2 }))).toMatchObject({ pass: true });
    // an off-the-record context may not inherit the profile's download block
    expect(refused(call(5, 'new_page', { url: 'http://localhost/', isolatedContext: 'x' })).error.message).toContain('isolatedContext');
    expect(refused(call(4, 'click', 'not an object' as unknown as Record<string, unknown>)).id).toBe(4);
  });

  it('every allowed tool has an argument list, and none names a path', () => {
    for (const [tool, args] of Object.entries(BROWSER_TOOL_ARGS)) {
      expect([tool, args.filter(isPathKey)]).toEqual([tool, []]);
    }
  });

  it('refuses nesting past the depth limit (fail closed)', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(refused(call(1, 'fill_form', { elements: deep })).error.message).toContain('too deep');
  });

  it('refuses ids that are not short strings or safe integers', () => {
    expect(validId('a'.repeat(256))).toBe(true);
    expect(validId('a'.repeat(257))).toBe(false);
    expect(validId(2 ** 53)).toBe(false);
    expect(validId(1.5)).toBe(false);
    expect(validId({})).toBe(false);
    const reply = refused(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(300), method: 'ping' }));
    expect(reply.id).toBeNull();
    expect(filter(JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, result: {} }))).toEqual({ pass: false });
  });

  it("drops the container's roots/list_changed notification", () => {
    expect(filter(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }))).toEqual({ pass: false });
  });

  it('refuses methods that are not allowed, passes notifications and responses', () => {
    expect(refused(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///etc/passwd' } })).id).toBe(1);
    expect(filter(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }))).toMatchObject({ pass: true });
    expect(filter(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toMatchObject({ pass: true });
    expect(filter(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { roots: [] } }))).toMatchObject({ pass: true });
  });

  it('drops lines that are not JSON-RPC messages (fail closed), with no reply', () => {
    for (const line of ['', 'not json', '{"half":', '42', 'null', '"str"']) expect(filter(line)).toEqual({ pass: false, malformed: true });
  });

  it('refuses every batch with one fixed error, however big', () => {
    expect(refused(`[${call(2, 'list_pages', {})}]`)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32602, message: BATCH_REFUSAL } });
    const big = `[${Array.from({ length: 20000 }, (_, i) => call(i, 'x'.repeat(50), { url: 'u'.repeat(50) })).join(',')}]`;
    expect(big.length).toBeGreaterThan(1_000_000);
    const r = filter(big) as { reply: string };
    expect(r.reply.length).toBeLessThan(200);
    expect(refused('[]').id).toBeNull();
  });

  it('quotes at most 100 characters of what the container sent', () => {
    const method = 'm'.repeat(100_000);
    const reply = refused(JSON.stringify({ jsonrpc: '2.0', id: 1, method }));
    expect(reply.error.message.length).toBeLessThan(200);
    expect(reply.error.message).toContain('…');
    expect(refused(call(2, 'navigate_page', { url: `https://evil.example/${'a'.repeat(10_000)}` })).error.message.length).toBeLessThan(400);
    expect(refused(call(3, 't'.repeat(5000), {})).error.message.length).toBeLessThan(200);
  });
});

describe('originPolicy', () => {
  it('defaults to the forwarded ports, read at every check', () => {
    let ports = [3001];
    const p = originPolicy({ command: 'x' }, () => ports);
    expect(p.allowOrigin('http://localhost:3001')).toBe(true);
    ports = [];
    expect(p.allowOrigin('http://localhost:3001')).toBe(false);
    expect(p.describeOrigins()).toMatch(/none is forwarded/);
  });

  it('uses allowOrigins when set', () => {
    const p = originPolicy({ command: 'x', allowOrigins: ['https://staging.example.com'] }, () => [3001]);
    expect(p.allowOrigin('https://staging.example.com/a')).toBe(true);
    expect(p.allowOrigin('http://localhost:3001')).toBe(false);
  });
});

describe('filterToolsList', () => {
  it('keeps only allowed tools and strips path-like properties from their schemas', () => {
    const result = {
      tools: [
        { name: 'take_screenshot', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' }, filePath: { type: 'string' }, output: {} }, required: ['filePath', 'output'] } },
        { name: 'evaluate_script', inputSchema: { type: 'object', properties: { function: { type: 'string' }, sourcePath: {}, filePath: {} } } },
        { name: 'upload_file', inputSchema: { type: 'object', properties: { filePaths: {} } } },
        { name: 'take_heapsnapshot', inputSchema: {} },
      ],
      nextCursor: 'x',
    };
    expect(filterToolsList(result)).toEqual({
      tools: [
        { name: 'take_screenshot', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } }, required: [] } },
        { name: 'evaluate_script', inputSchema: { type: 'object', properties: { function: { type: 'string' } } } },
      ],
      nextCursor: 'x',
    });
  });
});

describe('mcpServers', () => {
  it('is empty when nothing is configured', () => {
    expect(mcpServers(undefined, () => {})).toEqual([]);
    expect(mcpServers({}, () => {})).toEqual([]);
  });

  it('gives chrome the pinned server, its hardening flags, a throwaway profile and no allowOrigins', () => {
    const [server] = mcpServers({ chrome: {} }, () => {});
    expect(CHROME_DEVTOOLS_MCP).toBe('chrome-devtools-mcp@1.12.0');
    expect(server.cfg.command).toBe('npx');
    expect(server.cfg.args).toEqual(['-y', 'chrome-devtools-mcp@1.12.0', '--categoryPerformance=false', '--categoryMemory=false', '--fileNavigations=false', '--no-usage-statistics']);
    expect(server.cfg.env).toEqual({ CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1' });
    expect(server.cfg.throwawayProfile).toBe(true);
    expect(server.cfg.allowOrigins).toBeUndefined();
    expect(mcpServers({ chrome: true }, () => {})).toHaveLength(1);
  });

  it('warns that custom args for the default command drop the hardening, and gives no throwaway profile', () => {
    const warnings: string[] = [];
    const [server] = mcpServers({ chrome: { args: ['-y', 'chrome-devtools-mcp@latest'] } }, m => warnings.push(m));
    expect(warnings[0]).toMatch(/args replaces the default arguments.*hardening flags/);
    expect(server.cfg.throwawayProfile).toBeUndefined();
    expect(mcpServers({ chrome: { command: 'node', args: ['x'] } }, m => warnings.push(m))[0].cfg.throwawayProfile).toBeUndefined();
    expect(warnings).toHaveLength(1);
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

describe('makeThrowawayProfile', () => {
  it('makes a profile that refuses downloads and keeps any in its own directory', () => {
    const p = makeThrowawayProfile();
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(p.profile, 'Default', 'Preferences'), 'utf8'));
      expect(prefs.download_restrictions).toBe(3);
      expect(prefs.download.default_directory).toBe(p.downloads);
      expect(prefs.download.prompt_for_download).toBe(false);
      expect(fs.statSync(p.tmp).isDirectory()).toBe(true);
      expect(p.profile.startsWith(p.dir) && p.downloads.startsWith(p.dir) && p.tmp.startsWith(p.dir)).toBe(true);
    } finally {
      fs.rmSync(p.dir, { recursive: true, force: true });
    }
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
// node process that echoes each request's method (and exits on notifications/exit).

const ECHO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
let initId;
let capsSeen;
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'notifications/exit') process.exit(0);
  // the answer to its own roots/list, sent when initialize arrived
  if (m.id === 'roots-1' && m.method === undefined) {
    return send({ jsonrpc: '2.0', id: initId, result: { protocolVersion: '2025-06-18', instructions: 'from the server', roots: m.result.roots, capsSeen } });
  }
  if (m.id === undefined) return;
  if (m.params && m.params.noreply) return;
  if (m.params && m.params.fail) return send({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: 'failed' } });
  if (m.params && m.params.arguments && m.params.arguments.uid === 'huge') {
    return process.stdout.write('{"x":"' + 'a'.repeat(17 * 1024 * 1024) + '"}\\n');
  }
  if (m.method === 'initialize') {
    initId = m.id;
    capsSeen = m.params && m.params.capabilities;
    return send({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
  }
  const result = m.method === 'tools/list' ? { tools: [{ name: 'take_screenshot', inputSchema: { type: 'object', properties: { filePath: {}, fullPage: {} } } }, { name: 'upload_file', inputSchema: {} }] }
    : m.method === 'prompts/list' ? { tools: [{ name: 'upload_file' }] }
    : { echo: m.method, env: process.env.GH_TOKEN || null, tmpdir: process.env.TMPDIR || null, args: process.argv.slice(1) };
  send({ jsonrpc: '2.0', id: m.id, result });
});
`;

interface Client {
  send(obj: unknown): void;
  raw(text: string | Buffer): void;
  /** The next line the bridge sends to the container */
  next(): Promise<any>;
  /** Resolves when the bridge ends the exec's stdin (the server is gone) */
  stdinEnded: Promise<void>;
}

/** Programs the listener execs: each runs `script` with a client, then ends with exit 0; the stop command ends a waiting one. */
function scriptedListener(b: FakeBackend, scripts: Array<(c: Client) => Promise<void>>) {
  const pending: Array<() => void> = [];
  b.execHandler = (_id, cmd, io) => {
    const line = cmd.join(' ');
    if (line.includes('exec socat UNIX-LISTEN')) {
      const script = scripts.shift();
      const stdin = io.stdin as NodeJS.ReadableStream;
      const stdout = io.stdout as NodeJS.WritableStream;
      const stdinEnded = new Promise<void>(resolve => stdin.on('end', () => resolve()));
      if (!script) {
        return new Promise(resolve => {
          pending.push(() => resolve({ exitCode: 143, stdout: '' }));
          stdinEnded.then(() => resolve({ exitCode: 0, stdout: '' }));
        });
      }
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
      const client: Client = {
        send: obj => stdout.write(JSON.stringify(obj) + '\n'),
        raw: text => stdout.write(text),
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve))),
        stdinEnded,
      };
      return script(client).then(() => ({ exitCode: 0, stdout: '' }));
    }
    if (line.includes('kill')) pending.splice(0).forEach(f => f());
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

const CFG = { command: process.execPath, args: ['-e', ECHO_SERVER], env: {}, allowOrigins: ['http://localhost'] };
const execsMatching = (b: FakeBackend, text: string) => b.callsOf('exec').filter(e => (e[1] as string[]).join(' ').includes(text));

describe('runBridge', () => {
  it('prepares /run/kunj-mcp as root and checks for socat', async () => {
    const b = new FakeBackend();
    b.execHandler = (_id, cmd) => (cmd.join(' ').includes('mkdir') ? Promise.resolve({ exitCode: 3, stdout: '' }) : undefined);
    const controller = new AbortController();
    await expect(runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal })).rejects.toThrow(/socat is not installed/);
    expect((b.callsOf('exec')[0][2] as ExecIO).user).toBe('root');
  });

  it('runs only mkdir/chown/chmod as root; the listener and the stop run as the user, socat without user=', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        await c.next();
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn });
    for (const [, cmd, io] of b.callsOf('exec') as Array<[string, string[], ExecIO]>) {
      const text = cmd.join(' ');
      if ((io.user ?? '') === 'root') {
        expect(text).toContain('mkdir -p "$d" && chown "$1" "$d" && chmod 700 "$d"');
        expect(text).not.toMatch(/pid|kill|socat UNIX/);
      } else {
        expect(io.user).toBe('sandbox');
      }
    }
    const listen = execsMatching(b, 'exec socat UNIX-LISTEN')[0];
    expect((listen[1] as string[]).join(' ')).not.toContain('user=');
    expect((listen[1] as string[]).join(' ')).toContain('mode=600');
    // stopped before listening (a stale listener) and on abort
    expect(execsMatching(b, 'kill').length).toBeGreaterThanOrEqual(2);
  });

  it('stops only the socat listener named in the pid file', () => {
    const script = stopCommand('chrome')[2];
    expect(script).toContain('grep -qaF "UNIX-LISTEN:/run/kunj-mcp/$1.sock," "/proc/$o/cmdline"');
    expect(script).toContain('*[!0-9]*');
    expect(stopCommand('chrome').slice(-1)).toEqual(['chrome']);
    expect(listenCommand('chrome')[2]).toContain('echo $$ > "/run/kunj-mcp/$1.pid"; exec socat');
  });

  it('round-trips JSON-RPC between the container and a server it starts on the first message', async () => {
    const b = new FakeBackend();
    const { calls, spawn } = recordingSpawn();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'http://localhost:3000' } } });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, hostEnv: { PATH: '/bin', HOME: '/h', GH_TOKEN: 's' } });

    expect(replies).toMatchObject([
      { jsonrpc: '2.0', id: 1, result: { echo: 'ping', env: null } },
      { jsonrpc: '2.0', id: 2, result: { echo: 'tools/call', env: null } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.env).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('answers a refused call itself; the server never sees it', async () => {
    const b = new FakeBackend();
    const { spawn } = recordingSpawn();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'new_page', arguments: { url: 'https://evil.example' } } });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'take_screenshot', arguments: { filePath: '/Users/me/.zshrc' } } });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', id: 11, method: 'ping' });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn });
    expect(replies[0]).toMatchObject({ id: 9, error: { code: -32602 } });
    expect(replies[1]).toMatchObject({ id: 10, error: { code: -32602 } });
    expect(replies[2]).toMatchObject({ jsonrpc: '2.0', id: 11, result: { echo: 'ping', env: null } });
  });

  it('by default allows only the forwarded ports, read when the call arrives', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    let ports: number[] = [];
    const replies: any[] = [];
    const nav = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'http://localhost:3001/' } } });
    scriptedListener(b, [
      async c => {
        c.send(nav(1));
        replies.push(await c.next());
        ports = [3001];
        c.send(nav(2));
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    const { allowOrigins: _ignored, ...noOrigins } = CFG;
    await runBridge(b, 'cid', 'chrome', noOrigins, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn, forwardedPorts: () => ports });
    expect(replies[0]).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(replies[1]).toMatchObject({ id: 2, result: { echo: 'tools/call' } });
  });

  it('rewrites tools/list and adds the port hint to the initialize result', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    let init: any;
    let list: any;
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
        init = await c.next();
        c.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        list = await c.next();
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn, instructions: () => 'PORTS' });
    expect(init.result.instructions).toBe('from the server\n\nPORTS');
    // The server's roots/list was answered by the bridge, never shown to the container
    expect(init.result.roots).toEqual([]);
    expect(list.result.tools).toEqual([{ name: 'take_screenshot', inputSchema: { type: 'object', properties: { fullPage: {} } } }]);
  });

  it('drops malformed lines (logged once) and starts no server for them or for a partial line', async () => {
    const b = new FakeBackend();
    const { calls, spawn } = recordingSpawn();
    const controller = new AbortController();
    const logs: string[] = [];
    scriptedListener(b, [
      async c => {
        c.raw('not json\n{"also": \n');
        c.raw('{"jsonrpc":"2.0","id":1,"method":"pi');
        await new Promise(r => setTimeout(r, 50));
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, log: m => logs.push(m) });
    expect(calls).toHaveLength(0);
    expect(logs.filter(l => l.includes('not a JSON-RPC message'))).toHaveLength(1);
  });

  it('ends the session on a line longer than 4 MB, without starting the server', async () => {
    const b = new FakeBackend();
    const { calls, spawn } = recordingSpawn();
    const controller = new AbortController();
    const logs: string[] = [];
    scriptedListener(b, [
      async c => {
        c.raw(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61));
        await c.stdinEnded;
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, log: m => logs.push(m) });
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/longer than 4194304 bytes; session ended/);
  });

  it('gives the default browser a throwaway profile and TMPDIR per session, removed afterwards', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    let result: any;
    let dirDuring = '';
    let prefsDuring = false;
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        result = (await c.next()).result;
        dirDuring = path.dirname(result.tmpdir ?? '');
        prefsDuring = fs.existsSync(path.join(dirDuring, 'profile', 'Default', 'Preferences'));
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', { ...CFG, args: [...CFG.args, '--'], throwawayProfile: true }, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn });
    expect(prefsDuring).toBe(true);
    expect(result.args.slice(-1)).toEqual([`--userDataDir=${path.join(dirDuring, 'profile')}`]);
    expect(path.basename(dirDuring)).toMatch(/^kunj-mcp-/);
    expect(fs.existsSync(dirDuring)).toBe(false);
  });

  it('filters every tool list by shape, ends a request on any reply, refuses duplicate ids in flight, keeps at most 1024', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        // tools/list that fails: the id is free again
        c.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { fail: true } });
        replies.push(await c.next());
        // a reply to another method that carries a tool list is filtered all the same
        c.send({ jsonrpc: '2.0', id: 7, method: 'prompts/list' });
        replies.push(await c.next());
        // 1030 never answered: 2029 is still in flight, so a second request under it is refused
        for (let i = 0; i < 1030; i++) c.send({ jsonrpc: '2.0', id: 1000 + i, method: 'tools/list', params: { noreply: true } });
        c.send({ jsonrpc: '2.0', id: 2029, method: 'tools/list' });
        replies.push(await c.next());
        // ...and 1000 was evicted, so it may be used again; its reply is filtered by shape
        c.send({ jsonrpc: '2.0', id: 1000, method: 'tools/list' });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn });
    expect(replies[0]).toMatchObject({ id: 7, error: { message: 'failed' } });
    expect(replies[1]).toMatchObject({ id: 7, result: { tools: [] } });
    expect(replies[2]).toMatchObject({ id: 2029, error: { code: -32600 } });
    expect(replies[3].id).toBe(1000);
    expect(replies[3].result.tools.map((t: { name: string }) => t.name)).toEqual(['take_screenshot']);
  });

  it('strips the container\'s roots capability and drops its replies to requests the bridge answered', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: { roots: { listChanged: true }, sampling: {} } } });
        replies.push(await c.next());
        // a spoofed answer to the server's roots/list: the server would answer it with another initialize result
        c.send({ jsonrpc: '2.0', id: 'roots-1', result: { roots: [{ uri: 'file:///Users' }] } });
        c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn });
    expect(replies[0].result.roots).toEqual([]);
    expect(replies[0].result.capsSeen).toEqual({ sampling: {} });
    expect(replies[1]).toMatchObject({ id: 1, result: { echo: 'ping' } });
  });

  it('ends the session, not the process, when handling a line throws, and removes the profile', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    const logs: string[] = [];
    let exitListenersDuring = 0;
    const exitListenersBefore = process.listenerCount('exit');
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        await c.next();
        exitListenersDuring = process.listenerCount('exit');
        c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'http://localhost:3000/' } } });
        await c.stdinEnded;
        controller.abort();
      },
    ]);
    const forwardedPorts = () => {
      throw new Error('boom');
    };
    const { allowOrigins: _ignored, ...noOrigins } = CFG;
    await runBridge(b, 'cid', 'chrome', { ...noOrigins, args: [...CFG.args, '--'], throwawayProfile: true }, {
      user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn, forwardedPorts, log: m => logs.push(m),
    });
    expect(logs.join('\n')).toMatch(/could not handle a request: boom; session ended/);
    expect(exitListenersDuring).toBe(exitListenersBefore + 1);
    expect(process.listenerCount('exit')).toBe(exitListenersBefore);
  });

  it('ends the session on a server line over 16 MB', async () => {
    const b = new FakeBackend();
    const controller = new AbortController();
    const logs: string[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'click', arguments: { uid: 'huge' } } });
        await c.stdinEnded;
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn: recordingSpawn().spawn, log: m => logs.push(m) });
    expect(logs.join('\n')).toMatch(/a line from the server is longer than 16777216 bytes; session ended/);
  });

  it('stops reading a container that does not read its replies, and ends the session past the cap', async () => {
    const run = async (maxBufferedToContainer?: number) => {
      const b = new FakeBackend();
      const controller = new AbortController();
      const logs: string[] = [];
      let fromContainer: any;
      let toContainer: any;
      b.execHandler = (_id, cmd, io) => {
        if (!cmd.join(' ').includes('exec socat UNIX-LISTEN')) return undefined;
        // Never reads io.stdin: replies pile up there
        toContainer = io.stdin;
        fromContainer = io.stdout;
        const refused = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_file', arguments: {} } }) + '\n';
        for (let i = 0; i < 5000; i++) fromContainer.write(refused); // about 570 KB
        return new Promise(resolve => {
          setTimeout(() => {
            controller.abort();
            resolve({ exitCode: 0, stdout: '' });
          }, 100);
        });
      };
      await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, log: m => logs.push(m), ...(maxBufferedToContainer ? { maxBufferedToContainer } : {}) });
      return { fromContainer, toContainer, logs };
    };

    const paused = await run();
    expect(paused.fromContainer.isPaused()).toBe(true);
    // Most of the input is still unread, and what waits for the container stays at about its two buffers
    expect(paused.fromContainer.readableLength + paused.fromContainer.writableLength).toBeGreaterThan(300_000);
    expect(paused.toContainer.readableLength + paused.toContainer.writableLength).toBeLessThan(256 * 1024);

    const capped = await run(1000);
    expect(capped.logs.join('\n')).toMatch(/the container is not reading \(over 1000 bytes waiting\); session ended/);
  });

  it('stops reading the container while the server is not keeping up', async () => {
    const b = new FakeBackend();
    const { EventEmitter } = jest.requireActual('events');
    const { Writable, PassThrough: Pass } = jest.requireActual('stream');
    const held: Array<() => void> = [];
    const written: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null,
      stdout: new Pass(),
      stdin: new Writable({ highWaterMark: 8, write(chunk: Buffer, _e: string, cb: () => void) { written.push(chunk.toString()); held.push(cb); } }),
      kill() {
        child.exitCode = 0;
        setImmediate(() => child.emit('exit', 0));
        return true;
      },
    });
    // write() calls, not _write: without backpressure all three would be handed over while stuck
    let writeCalls = 0;
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (...a: unknown[]) => {
      writeCalls++;
      return write(...a);
    };
    const spawn = (() => child) as unknown as typeof childProcess.spawn;
    const controller = new AbortController();
    let seenWhileStuck = -1;
    scriptedListener(b, [
      async c => {
        for (let id = 1; id <= 3; id++) {
          c.send({ jsonrpc: '2.0', id, method: 'ping' });
          await new Promise(r => setTimeout(r, 20));
        }
        seenWhileStuck = writeCalls;
        held.splice(0).forEach(cb => cb());
        await new Promise(r => setTimeout(r, 20));
        held.splice(0).forEach(cb => cb());
        await new Promise(r => setTimeout(r, 20));
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn });
    expect(seenWhileStuck).toBe(1);
    expect(written.map(w => JSON.parse(w).id)).toEqual([1, 2, 3]);
  });

  it('restarts the listener after the client disconnects and after the server exits', async () => {
    const b = new FakeBackend();
    const { calls, spawn } = recordingSpawn();
    const controller = new AbortController();
    const replies: any[] = [];
    scriptedListener(b, [
      async c => {
        c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        replies.push(await c.next());
      },
      async c => {
        c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        replies.push(await c.next());
        c.send({ jsonrpc: '2.0', method: 'notifications/exit' });
        await c.stdinEnded;
      },
      async c => {
        c.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
        replies.push(await c.next());
        controller.abort();
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: controller.signal, spawn, restartDelayMs: 0 });
    expect(replies.map(r => r.id)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(3);
    // the directory is prepared again before every listener
    expect(execsMatching(b, 'mkdir')).toHaveLength(3);
  });

  it('refuses to start on a stopped container', async () => {
    const b = new FakeBackend();
    b.states.set('cid', 'exited');
    await expect(runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: new AbortController().signal })).rejects.toThrow(/not running/);
    expect(b.callsOf('exec')).toHaveLength(0);
  });

  it('ends at once when the container restarted (StartedAt changed), before exec-ing into the new run', async () => {
    const b = new FakeBackend();
    scriptedListener(b, [
      async () => {
        b.startedAt.set('cid', '2026-10-23T12:00:00Z');
      },
    ]);
    await runBridge(b, 'cid', 'chrome', CFG, { user: 'sandbox', signal: new AbortController().signal, restartDelayMs: 0 });
    expect(execsMatching(b, 'exec socat UNIX-LISTEN')).toHaveLength(1);
    expect(execsMatching(b, 'mkdir')).toHaveLength(1);
  });

  it('ends at once when one check sees it stopped; needs two failed inspects', async () => {
    const stopped = new FakeBackend();
    stopped.execHandler = (_id, cmd) => {
      if (!cmd.join(' ').includes('exec socat UNIX-LISTEN')) return undefined;
      stopped.states.set('cid', 'exited');
      return Promise.resolve({ exitCode: 1, stdout: '' });
    };
    await runBridge(stopped, 'cid', 'chrome', CFG, { user: 'sandbox', signal: new AbortController().signal, restartDelayMs: 0 });
    // at start, before the first listener, after it: stopped
    expect(stopped.callsOf('containerRun')).toHaveLength(3);

    const gone = new FakeBackend();
    gone.execHandler = (_id, cmd) => {
      if (!cmd.join(' ').includes('exec socat UNIX-LISTEN')) return undefined;
      gone.states.set('cid', null);
      return Promise.resolve({ exitCode: 1, stdout: '' });
    };
    await runBridge(gone, 'cid', 'chrome', CFG, { user: 'sandbox', signal: new AbortController().signal, restartDelayMs: 0, stateIntervalMs: 0 });
    // at start, before the first listener, then two failed inspects
    expect(gone.callsOf('containerRun')).toHaveLength(4);
  });

  it('logs a listener that fails, and retries more slowly each time', async () => {
    const b = new FakeBackend();
    const started: number[] = [];
    b.execHandler = (_id, cmd, io) => {
      if (!cmd.join(' ').includes('exec socat UNIX-LISTEN')) return undefined;
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

  it('resolves the user with id -un when none is recorded, and runs the listener as that user', async () => {
    const b = new FakeBackend();
    b.execResults.set('id -un', { exitCode: 0, stdout: 'node\n' });
    const controller = new AbortController();
    scriptedListener(b, []);
    setTimeout(() => controller.abort(), 20);
    await runBridge(b, 'cid', 'chrome', CFG, { user: '', signal: controller.signal });
    const prepare = execsMatching(b, 'mkdir')[0];
    expect((prepare[1] as string[]).slice(-1)).toEqual(['node']);
    expect((execsMatching(b, 'exec socat UNIX-LISTEN')[0][2] as ExecIO).user).toBe('node');
  });

  it('refuses a user or name that could change the socat address', async () => {
    const b = new FakeBackend();
    const signal = new AbortController().signal;
    await expect(runBridge(b, 'cid', 'chrome', CFG, { user: 'a,fork', signal })).rejects.toThrow(/user/);
    await expect(runBridge(b, 'cid', 'x:y', CFG, { user: 'a', signal })).rejects.toThrow(/name/);
  });
});
