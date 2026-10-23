// Host MCP bridge: an MCP server that runs on the host (v1: a browser, Chrome DevTools MCP) made
// available to Claude Code in the container. The container cannot reach the host, so the host
// connects in: it keeps one `docker exec -i … socat UNIX-LISTEN:/run/kunj-mcp/<name>.sock STDIO`
// open, and when a client connects (Claude Code's MCP entry runs `socat - UNIX-CONNECT:<sock>`) it
// starts the configured stdio server on the host and pipes the two together, line by line, through
// the origin filter. One session at a time per server (socat without fork shares one stdio): when
// either side ends, both are stopped and a new listener waits for the next session.
//
// Running bridges are recorded in ~/.kunj/container-bridges.json (dead pids pruned on read) so
// `kunj ct list` can show them and `kunj ct agent` does not start a second one.
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { ContainerBackend } from './backend';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  allowOrigins?: string[];
}

/** The only server v1 bridges: a browser on the host. */
export const BROWSER_SERVER = 'chrome';
export const DEFAULT_ALLOW_ORIGINS = ['http://localhost', 'http://127.0.0.1'];
const DEFAULT_BROWSER: McpServerConfig = { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'] };

export const MCP_SOCKET_DIR = '/run/kunj-mcp';
// Both end up in a socat address, where ',' and ':' separate options: nothing but plain words
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const USER_NAME = /^[a-z_][a-z0-9_.-]*$/i;
// The tools that open a URL, and so are checked against allowOrigins
const NAVIGATING_TOOLS = ['navigate_page', 'new_page'];

const STATE_POLL_MS = 5000;
const RESTART_DELAY_MS = 500;
const MAX_RETRY_MS = 30000;
const SERVER_STOP_MS = 2000;

export function socketPath(name: string): string {
  return `${MCP_SOCKET_DIR}/${name}.sock`;
}

/** The container's Claude Code entry for a bridged server: a client of the bridge's socket. */
export function containerMcpEntry(name: string): { command: string; args: string[] } {
  return { command: 'socat', args: ['-', `UNIX-CONNECT:${socketPath(name)}`] };
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');

/**
 * The servers to bridge from `container.mcp` (host config only, never the blueprint). v1 bridges the
 * browser only: other names, and entries that are not valid, are reported to `warn` and skipped.
 * `chrome: {}` (or true) is Chrome DevTools MCP with an isolated profile.
 */
export function mcpServers(value: unknown, warn: (message: string) => void): Array<{ name: string; cfg: McpServerConfig }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const servers: Array<{ name: string; cfg: McpServerConfig }> = [];
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (name !== BROWSER_SERVER) {
      warn(`container.mcp.${name}: only the browser server "${BROWSER_SERVER}" is bridged for now; skipped`);
      continue;
    }
    const e = entry === true ? {} : entry;
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      warn(`container.mcp.${name}: expected { command?, args?, env?, allowOrigins? }; skipped`);
      continue;
    }
    const raw = e as Record<string, unknown>;
    const custom = raw.command !== undefined;
    if (
      (custom && (typeof raw.command !== 'string' || !raw.command.trim())) ||
      (raw.args !== undefined && !isStringArray(raw.args)) ||
      (raw.env !== undefined && !isStringRecord(raw.env)) ||
      (raw.allowOrigins !== undefined && !isStringArray(raw.allowOrigins))
    ) {
      warn(`container.mcp.${name}: command must be a non-empty string, args and allowOrigins lists of strings, env strings; skipped`);
      continue;
    }
    servers.push({
      name,
      cfg: {
        command: custom ? (raw.command as string) : DEFAULT_BROWSER.command,
        args: (raw.args as string[] | undefined) ?? (custom ? [] : DEFAULT_BROWSER.args),
        env: (raw.env as Record<string, string> | undefined) ?? {},
        allowOrigins: (raw.allowOrigins as string[] | undefined) ?? DEFAULT_ALLOW_ORIGINS,
      },
    });
  }
  return servers;
}

/** The host server's environment: PATH and HOME, and what its config sets; never the forwarded container env. */
export function serverEnv(cfg: McpServerConfig, hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...(hostEnv.PATH !== undefined ? { PATH: hostEnv.PATH } : {}),
    ...(hostEnv.HOME !== undefined ? { HOME: hostEnv.HOME } : {}),
    ...(cfg.env ?? {}),
  };
}

// ---------------------------------------------------------------------
// origin filter
// ---------------------------------------------------------------------

/** Scheme and host must equal one of `allow`'s (any port); entries that are not URLs are ignored. */
export function originAllowed(url: string, allow: string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return allow.some(entry => {
    try {
      const a = new URL(entry);
      return a.protocol === target.protocol && a.hostname === target.hostname;
    } catch {
      return false;
    }
  });
}

/** The url of a tools/call that opens one, if it is not allowed; undefined when the message may pass. */
function blockedUrl(msg: unknown, allow: string[]): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const m = msg as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (m.method !== 'tools/call' || !NAVIGATING_TOOLS.includes(m.params?.name as string)) return undefined;
  const args = m.params?.arguments;
  if (typeof args !== 'object' || args === null || !('url' in args)) return undefined;
  const url = (args as { url: unknown }).url;
  if (typeof url !== 'string') return JSON.stringify(url) ?? 'a url that is not a string';
  return originAllowed(url, allow) ? undefined : url;
}

function errorReply(id: unknown, url: string, allow: string[]): object {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: -32602,
      message: `kunj: ${url} is not in this server's allowOrigins (${allow.join(', ')}); set container.mcp.${BROWSER_SERVER}.allowOrigins on the host to allow it`,
    },
  };
}

/**
 * A filter for the container→host direction of a JSON-RPC (MCP stdio) stream, one line at a time:
 * a navigate_page or new_page call to a URL outside `allow` is not passed on but answered with a
 * JSON-RPC error carrying its id. Lines that are not JSON pass through unchanged.
 */
export function makeOriginFilter(allow: string[]): (line: string) => { pass: boolean; reply?: string } {
  return line => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return { pass: true };
    }
    if (Array.isArray(msg)) {
      const blocked = msg.map(m => blockedUrl(m, allow));
      const first = blocked.find(u => u !== undefined);
      if (first === undefined) return { pass: true };
      // The whole batch is refused: every request in it gets the error
      const replies = msg.filter(m => m && typeof m === 'object' && 'id' in m).map(m => errorReply(m.id, first, allow));
      return { pass: false, reply: JSON.stringify(replies) };
    }
    const url = blockedUrl(msg, allow);
    if (url === undefined) return { pass: true };
    return { pass: false, reply: JSON.stringify(errorReply((msg as { id?: unknown }).id, url, allow)) };
  };
}

/** What the agent is told about ports: the browser runs on the host, so localhost is the host's. */
export function portHint(forwards: Array<{ port: number; hostPort: number }>): string {
  const head = "This browser runs on the user's machine, not in your container: localhost in it is the host.";
  if (forwards.length === 0) {
    return `${head} No container port is forwarded to the host yet; the user can forward one with kunj ct forward <port>.`;
  }
  const map = forwards
    .slice()
    .sort((a, b) => a.port - b.port)
    .map(f => `container port ${f.port} is http://localhost:${f.hostPort}`)
    .join('; ');
  return `${head} Forwarded ports: ${map}. Open those host URLs, not the container's ports.`;
}

// ---------------------------------------------------------------------
// the container's Claude Code config
// ---------------------------------------------------------------------

/** ~/.claude.json with `mcpServers.<name>` set for each name, other keys and servers kept; null when nothing changes. */
export function mergeClaudeConfig(text: string | null, names: string[]): string | null {
  let config: Record<string, unknown> = {};
  if (text !== null && text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('~/.claude.json in the container is not valid JSON; not changed');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('~/.claude.json in the container is not a JSON object; not changed');
    }
    config = parsed as Record<string, unknown>;
  }
  const existing = config.mcpServers;
  const servers: Record<string, unknown> = typeof existing === 'object' && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
  let changed = text === null || typeof existing !== 'object' || existing === null;
  for (const name of names) {
    const entry = containerMcpEntry(name);
    if (JSON.stringify(servers[name]) !== JSON.stringify(entry)) {
      servers[name] = entry;
      changed = true;
    }
  }
  if (!changed) return null;
  return JSON.stringify({ ...config, mcpServers: servers }, null, 2) + '\n';
}

const READ_CLAUDE_CONFIG = 'f="$HOME/.claude.json"; [ -e "$f" ] || exit 3; cat "$f"';
// Written next to it and renamed, private like Claude Code's own
const WRITE_CLAUDE_CONFIG = 'umask 077; f="$HOME/.claude.json"; t="$f.kunj.$$"; cat > "$t" && mv "$t" "$f"';

/**
 * Adds the bridged servers to the container user's ~/.claude.json (as that user, after READY and
 * the seed); idempotent, and an unchanged file is not rewritten.
 */
export async function installMcpConfig(backend: ContainerBackend, id: string, user: string, names: string[]): Promise<void> {
  const as = user || undefined;
  const read = await backend.exec(id, ['sh', '-c', READ_CLAUDE_CONFIG], { user: as });
  if (read.exitCode !== 0 && read.exitCode !== 3) throw new Error(`Could not read ~/.claude.json in the container (exit ${read.exitCode})`);
  const merged = mergeClaudeConfig(read.exitCode === 3 ? null : read.stdout, names);
  if (merged === null) return;
  const stdin = new PassThrough();
  stdin.end(merged);
  const write = await backend.exec(id, ['sh', '-c', WRITE_CLAUDE_CONFIG], { user: as, stdin });
  if (write.exitCode !== 0) throw new Error(`Could not write ~/.claude.json in the container (exit ${write.exitCode})`);
}

// ---------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------

export interface BridgeRecord {
  pid: number;
  container: string;
  name: string;
}

export function bridgesFile(): string {
  return path.join(os.homedir(), '.kunj', 'container-bridges.json');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(r: any): r is BridgeRecord {
  return !!r && Number.isInteger(r.pid) && r.pid > 0 && typeof r.container === 'string' && typeof r.name === 'string';
}

/** The live bridges; entries of dead processes are pruned (and the file rewritten without them). */
export function readBridges(file: string = bridgesFile()): BridgeRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const live = Array.isArray(parsed) ? parsed.filter(isRecord).filter(r => isAlive(r.pid)) : [];
  if (live.length !== (Array.isArray(parsed) ? parsed.length : -1)) {
    try {
      writeBridges(live, file);
    } catch {
      // read-only home: the pruned list is still right for this caller
    }
  }
  return live;
}

export function writeBridges(records: BridgeRecord[], file: string = bridgesFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function updateBridges(change: (records: BridgeRecord[]) => BridgeRecord[], file: string = bridgesFile()): BridgeRecord[] {
  const next = change(readBridges(file));
  writeBridges(next, file);
  return next;
}

/** The pid of a live bridge for `container` (other than `exceptPid`), if one is registered. */
export function bridgeFor(container: string, file: string = bridgesFile(), exceptPid?: number): number | undefined {
  return readBridges(file).find(r => r.container === container && r.pid !== exceptPid)?.pid;
}

// ---------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------

/** Calls `onLine` with each complete line (without its '\n') of a byte stream; split on bytes, so UTF-8 survives. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; rest(): string } {
  let pending: Buffer[] = [];
  return {
    push(chunk) {
      let start = 0;
      let i: number;
      while ((i = chunk.indexOf(0x0a, start)) !== -1) {
        pending.push(chunk.subarray(start, i));
        onLine(Buffer.concat(pending).toString('utf8'));
        pending = [];
        start = i + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    },
    rest: () => Buffer.concat(pending).toString('utf8'),
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

// Run as root with "$1" the user and "$2" the server name. Exit 3: no socat. A listener left by a
// bridge that died (its pid file) is stopped, so the socket path is ours.
const PREPARE =
  'command -v socat >/dev/null || exit 3; ' +
  `d=${MCP_SOCKET_DIR}; mkdir -p "$d" && chown "$1" "$d" && chmod 700 "$d" || exit 4; ` +
  'p="$d/$2.pid"; if [ -f "$p" ]; then o=$(cat "$p"); ' +
  'grep -q kunj-mcp "/proc/$o/cmdline" 2>/dev/null && kill "$o" 2>/dev/null; rm -f "$p"; fi; exit 0';

function listenCommand(name: string, user: string): string[] {
  return [
    'sh',
    '-c',
    `echo $$ > "${MCP_SOCKET_DIR}/$1.pid"; exec socat UNIX-LISTEN:"${MCP_SOCKET_DIR}/$1.sock",unlink-early,mode=600,user="$2" STDIO`,
    'sh',
    name,
    user,
  ];
}

function killCommand(name: string): string[] {
  return ['sh', '-c', `p="${MCP_SOCKET_DIR}/$1.pid"; [ -f "$p" ] && kill "$(cat "$p")" 2>/dev/null; rm -f "$p"; exit 0`, 'sh', name];
}

export interface BridgeOptions {
  /** The container user the socket belongs to; '' resolves it with `id -un` */
  user: string;
  signal: AbortSignal;
  spawn?: typeof childProcess.spawn;
  /** Where PATH and HOME for the host server come from (default process.env) */
  hostEnv?: NodeJS.ProcessEnv;
  /** Appended to the instructions of the server's initialize result (the port map) */
  instructions?: () => string | undefined;
  log?: (message: string) => void;
  restartDelayMs?: number;
  stateIntervalMs?: number;
}

/**
 * Bridges `cfg`'s stdio server into the container at /run/kunj-mcp/<name>.sock until `signal`
 * aborts or the container is seen not running on two checks in a row.
 */
export async function runBridge(
  backend: ContainerBackend,
  containerId: string,
  name: string,
  cfg: McpServerConfig,
  opts: BridgeOptions,
): Promise<void> {
  if (!SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name "${name}"`);
  if (opts.user && !USER_NAME.test(opts.user)) throw new Error(`Invalid container user "${opts.user}"`);
  const { signal } = opts;
  const log = opts.log ?? (() => {});

  let user = opts.user;
  if (!user) {
    const r = await backend.exec(containerId, ['id', '-un']);
    user = r.stdout.trim();
    if (r.exitCode !== 0 || !USER_NAME.test(user)) throw new Error('Cannot tell which user the container runs as');
  }

  const prepared = await backend.exec(containerId, ['sh', '-c', PREPARE, 'sh', user, name], { user: 'root' });
  if (prepared.exitCode === 3) throw new Error('socat is not installed in the container; the MCP bridge needs it');
  if (prepared.exitCode !== 0) throw new Error(`Could not create ${MCP_SOCKET_DIR} in the container (exit ${prepared.exitCode})`);

  const filter = makeOriginFilter(cfg.allowOrigins ?? DEFAULT_ALLOW_ORIGINS);
  const restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS;
  const stateIntervalMs = opts.stateIntervalMs ?? STATE_POLL_MS;
  let notRunning = 0;
  // A listener only ends without a client when something is wrong: retry ever more slowly
  let retryMs = restartDelayMs;

  const onAbort = () => {
    backend.exec(containerId, killCommand(name), { user: 'root' }).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort);
  try {
    while (!signal.aborted) {
      const connected = await session(backend, containerId, name, user, cfg, filter, opts, log);
      if (signal.aborted) break;
      if (!connected) {
        // The container may be going away: one failed check is not enough to stop
        notRunning = (await backend.containerState(containerId)) === 'running' ? 0 : notRunning + 1;
        if (notRunning >= 2) return;
        await sleep(notRunning ? stateIntervalMs : retryMs, signal);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      } else {
        notRunning = 0;
        retryMs = restartDelayMs;
        await sleep(restartDelayMs, signal);
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One listener and, once a client writes, one server process. True when a client connected. */
async function session(
  backend: ContainerBackend,
  containerId: string,
  name: string,
  user: string,
  cfg: McpServerConfig,
  filter: (line: string) => { pass: boolean; reply?: string },
  opts: BridgeOptions,
  log: (message: string) => void,
): Promise<boolean> {
  const spawn = opts.spawn ?? childProcess.spawn;
  const toContainer = new PassThrough();
  const fromContainer = new PassThrough();
  const stderr = new PassThrough();
  // socat's own errors, kept (bounded) for the log when the listener fails
  let errText = '';
  stderr.on('data', (d: Buffer) => {
    if (errText.length < 2000) errText += d.toString();
  });

  let server: childProcess.ChildProcess | undefined;
  let serverExited: Promise<void> = Promise.resolve();
  let initializeId: unknown;
  let execDone = false;

  const toClient = (line: string) => {
    if (!toContainer.writableEnded) toContainer.write(line + '\n');
  };

  // host → container: the server's replies, with the port map added to its initialize result
  const fromServer = lineSplitter(line => {
    if (initializeId !== undefined && opts.instructions) {
      try {
        const msg = JSON.parse(line);
        if (msg && msg.id === initializeId && msg.result && typeof msg.result === 'object') {
          initializeId = undefined;
          const extra = opts.instructions();
          if (extra) {
            const own = typeof msg.result.instructions === 'string' && msg.result.instructions ? `${msg.result.instructions}\n\n` : '';
            msg.result.instructions = own + extra;
            line = JSON.stringify(msg);
          }
        }
      } catch {
        // not JSON: passed on as it is
      }
    }
    toClient(line);
  });

  const startServer = () => {
    log(`MCP ${name}: client connected; starting ${cfg.command}`);
    const child = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: serverEnv(cfg, opts.hostEnv ?? process.env),
    });
    server = child;
    serverExited = new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.once('error', err => {
        log(`MCP ${name}: could not start ${cfg.command}: ${err.message}`);
        resolve();
      });
    });
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer) => fromServer.push(d));
    // The server is gone: end the session, so socat closes the client's connection
    serverExited.then(() => {
      if (!toContainer.writableEnded) toContainer.end();
      // socat normally exits on that EOF; make sure the listener does not linger
      if (!execDone) {
        setTimeout(() => {
          if (!execDone) backend.exec(containerId, killCommand(name), { user: 'root' }).catch(() => undefined);
        }, SERVER_STOP_MS).unref();
      }
    });
  };

  // container → host: through the origin filter
  const fromClient = lineSplitter(line => {
    const verdict = filter(line);
    if (!verdict.pass) {
      log(`MCP ${name}: refused a request outside allowOrigins`);
      if (verdict.reply) toClient(verdict.reply);
      return;
    }
    if (opts.instructions && initializeId === undefined) {
      try {
        const msg = JSON.parse(line);
        if (msg && msg.method === 'initialize' && msg.id !== undefined) initializeId = msg.id;
      } catch {
        // not JSON
      }
    }
    if (server?.stdin && !server.stdin.writableEnded) server.stdin.write(line + '\n');
  });
  fromContainer.on('data', (chunk: Buffer) => {
    if (!server) startServer();
    fromClient.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  try {
    const r = await backend.exec(containerId, listenCommand(name, user), { user: 'root', stdin: toContainer, stdout: fromContainer, stderr });
    if (!server && !opts.signal.aborted) {
      const detail = errText.trim().split('\n')[0];
      log(`MCP ${name}: listener ended without a client (exit ${r.exitCode})${detail ? `: ${detail}` : ''}`);
    }
  } catch (err) {
    log(`MCP ${name}: listener failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    execDone = true;
  }

  if (!toContainer.writableEnded) toContainer.end();
  const s = server as childProcess.ChildProcess | undefined;
  if (s) {
    if (s.exitCode === null && s.signalCode === null) {
      s.stdin?.end();
      s.kill('SIGTERM');
      const killer = setTimeout(() => s.kill('SIGKILL'), SERVER_STOP_MS);
      await serverExited;
      clearTimeout(killer);
    }
    log(`MCP ${name}: session ended`);
  }
  return !!s;
}
