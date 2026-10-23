// Host MCP bridge: an MCP server that runs on the host (v1: a browser, Chrome DevTools MCP) made
// available to Claude Code in the container. The container cannot reach the host, so the host
// connects in: it keeps one `docker exec -i -u <user> … socat UNIX-LISTEN:/run/kunj-mcp/<name>.sock STDIO`
// open, and when a client connects (Claude Code's MCP entry runs `socat - UNIX-CONNECT:<sock>`) it
// starts the configured stdio server on the host and pipes the two together, line by line, through
// the request filter. One session at a time per server (socat without fork shares one stdio): when
// either side ends, both are stopped and a new listener waits for the next session.
//
// The server runs on the host, outside the sandbox, so what the agent may ask of it is deny by
// default: only the tools in BROWSER_TOOLS, never an argument naming a host path, navigation only to
// allowed origins. tools/list replies are rewritten so the agent never sees the rest.
//
// Running bridges are recorded in ~/.kunj/container-bridges.json (dead pids pruned on read) so
// `kunj ct list` can show them and `kunj ct agent` does not start a second one.
import * as childProcess from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { ContainerBackend } from './backend';
import { pidRegistry } from './pidregistry';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Origins navigate_page/new_page may open; unset: only the host ports forwarded for the container */
  allowOrigins?: string[];
}

/** The only server v1 bridges: a browser on the host. */
export const BROWSER_SERVER = 'chrome';

// chrome-devtools-mcp (checked against 1.12.0's tool definitions and options): an empty throwaway
// profile; the performance and memory tools (trace and heap snapshot files) and file: navigations
// switched off; no config file discovery, so a global cd4a config cannot switch them back on. Defence
// in depth only: the request filter below is what keeps the agent away from host files.
const DEFAULT_BROWSER: McpServerConfig = {
  command: 'npx',
  args: ['-y', 'chrome-devtools-mcp@latest', '--isolated', '--categoryPerformance=false', '--categoryMemory=false', '--fileNavigations=false'],
  env: { CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1' },
};

/**
 * The tools the agent may call through the bridge (chrome-devtools-mcp 1.12.0 names). Everything
 * else is refused and hidden from tools/list: upload_file, take_heapsnapshot and the memory tools,
 * performance traces, lighthouse_audit, screencasts, extensions, PWAs, WebMCP and DevTools comments
 * all read or write host files or reach beyond a page. The path arguments of the tools here
 * (take_screenshot/take_snapshot/evaluate_script filePath, evaluate_script sourcePath,
 * get_network_request requestFilePath/responseFilePath) are refused by name, see isPathKey.
 */
export const BROWSER_TOOLS: readonly string[] = [
  // pages and navigation
  'list_pages', 'select_page', 'new_page', 'navigate_page', 'close_page', 'wait_for',
  // input
  'click', 'hover', 'fill', 'fill_form', 'type_text', 'press_key', 'drag', 'handle_dialog',
  // reading the page
  'take_snapshot', 'take_screenshot', 'evaluate_script',
  'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request',
  // emulation
  'emulate', 'resize_page',
];

/** JSON-RPC methods the container may send; responses (no method) and notifications/* also pass. */
const ALLOWED_METHODS = [
  'initialize', 'ping', 'tools/list', 'tools/call',
  'prompts/list', 'resources/list', 'resources/templates/list', 'logging/setLevel',
];

export const MCP_SOCKET_DIR = '/run/kunj-mcp';
// Both end up in a socat address or a path, where ',' ':' '/' matter: nothing but plain words
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const USER_NAME = /^[a-z_][a-z0-9_.-]*$/i;
// The tools that open a URL, and so are checked against the allowed origins
const NAVIGATING_TOOLS = ['navigate_page', 'new_page'];
/** A longer line from the container ends the session: the host does not buffer without bound. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

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
        env: { ...(custom ? {} : DEFAULT_BROWSER.env), ...((raw.env as Record<string, string> | undefined) ?? {}) },
        ...(raw.allowOrigins !== undefined ? { allowOrigins: raw.allowOrigins as string[] } : {}),
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
// origins
// ---------------------------------------------------------------------

function effectivePort(u: URL): string {
  return u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
}

// `http://localhost:3000` names a port; `http://localhost` (and `http://localhost/`) does not
const EXPLICIT_PORT = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^/:?#@]*):\d+/i;

/**
 * Scheme and host must equal one of `allow`'s; an entry with a port allows only that port, one
 * without allows any port. Entries that are not URLs are ignored.
 */
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
      if (a.protocol !== target.protocol || a.hostname !== target.hostname) return false;
      return !EXPLICIT_PORT.test(entry) || effectivePort(a) === effectivePort(target);
    } catch {
      return false;
    }
  });
}

/** The default: http(s) to localhost or 127.0.0.1 on one of `ports` (the container's forwarded host ports). */
export function forwardedOriginAllowed(url: string, ports: number[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return (
    (target.protocol === 'http:' || target.protocol === 'https:') &&
    LOCAL_HOSTS.includes(target.hostname) &&
    ports.map(String).includes(effectivePort(target))
  );
}

// ---------------------------------------------------------------------
// request filter (container → host)
// ---------------------------------------------------------------------

/** filePath, sourcePath, outputDirPath, filePaths, path, dir ...: an argument that names a host file or directory. */
export function isPathKey(key: string): boolean {
  return /^(path|paths|file|files|dir|dirs|directory)$/i.test(key) || /[a-z0-9](Path|Paths|File|Files|Dir|Dirs|Directory)$/.test(key);
}

/** The first path-like key anywhere in `value` (objects and arrays, recursively). */
function findPathKey(value: unknown, depth = 0): string | undefined {
  if (depth > 32 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const k = findPathKey(v, depth + 1);
      if (k) return k;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isPathKey(k)) return k;
    const nested = findPathKey(v, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export interface RequestPolicy {
  /** Whether navigate_page/new_page may open `url` */
  allowOrigin(url: string): boolean;
  /** For the error message: what is allowed */
  describeOrigins(): string;
}

export function originPolicy(cfg: McpServerConfig, forwardedPorts: () => number[]): RequestPolicy {
  if (cfg.allowOrigins) {
    const list = cfg.allowOrigins;
    return { allowOrigin: url => originAllowed(url, list), describeOrigins: () => `allowOrigins: ${list.join(', ') || 'none'}` };
  }
  return {
    allowOrigin: url => forwardedOriginAllowed(url, forwardedPorts()),
    describeOrigins: () => {
      const ports = forwardedPorts();
      return ports.length
        ? `the container's forwarded ports on localhost: ${ports.join(', ')}`
        : "the container's forwarded ports, and none is forwarded";
    },
  };
}

/** Why a message must not reach the host server; undefined when it may. */
function refusal(msg: unknown, policy: RequestPolicy): string | undefined {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return 'kunj: not a JSON-RPC message';
  const m = msg as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (m.method === undefined) return undefined; // a response to a request of the server's
  if (typeof m.method !== 'string') return 'kunj: not a JSON-RPC message';
  if (m.method.startsWith('notifications/')) return undefined;
  if (!ALLOWED_METHODS.includes(m.method)) return `kunj: ${m.method} is not allowed through the bridge`;
  if (m.method !== 'tools/call') return undefined;

  const name = m.params?.name;
  if (typeof name !== 'string' || !BROWSER_TOOLS.includes(name)) {
    return `kunj: the tool ${typeof name === 'string' ? name : '(none)'} is not available through the bridge`;
  }
  const args = m.params?.arguments;
  const key = findPathKey(args);
  if (key) return `kunj: the argument ${key} is not allowed through the bridge: the browser runs on the host, and host files are out of reach`;
  if (NAVIGATING_TOOLS.includes(name) && typeof args === 'object' && args !== null && 'url' in args) {
    const url = (args as { url: unknown }).url;
    if (typeof url !== 'string') return 'kunj: url must be a string';
    if (!policy.allowOrigin(url)) {
      return `kunj: ${url} is not allowed (${policy.describeOrigins()}); forward the port with kunj ct forward, or set container.mcp.${BROWSER_SERVER}.allowOrigins on the host`;
    }
  }
  return undefined;
}

function errorReply(id: unknown, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message } };
}

export type Verdict = { pass: true } | { pass: false; malformed?: true; reply?: string };

/**
 * The filter for the container→host direction of the JSON-RPC stream, one line at a time: a request
 * that is refused is answered with a JSON-RPC error carrying its id and not passed on; a line that is
 * not a JSON-RPC message is dropped (fail closed). A batch with anything refused is refused whole.
 */
export function makeRequestFilter(policy: RequestPolicy): (line: string) => Verdict {
  return line => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return { pass: false, malformed: true };
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return { pass: false, malformed: true };
      const reasons = msg.map(m => refusal(m, policy));
      const first = reasons.find(r => r !== undefined);
      if (first === undefined) return { pass: true };
      const replies = msg.filter(m => m && typeof m === 'object' && 'id' in m && 'method' in m).map(m => errorReply(m.id, first));
      return replies.length ? { pass: false, reply: JSON.stringify(replies) } : { pass: false };
    }
    if (typeof msg !== 'object' || msg === null) return { pass: false, malformed: true };
    const reason = refusal(msg, policy);
    if (reason === undefined) return { pass: true };
    const m = msg as { id?: unknown; method?: unknown };
    // A notification has no id and gets no reply
    return m.id === undefined ? { pass: false } : { pass: false, reply: JSON.stringify(errorReply(m.id, reason)) };
  };
}

/** Removes path-like properties from a JSON schema (its properties and required), recursively. */
function stripPathProperties(schema: unknown, depth = 0): unknown {
  if (depth > 32 || typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map(s => stripPathProperties(s, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = Object.fromEntries(
        Object.entries(v).filter(([name]) => !isPathKey(name)).map(([name, s]) => [name, stripPathProperties(s, depth + 1)])
      );
    } else if (k === 'required' && Array.isArray(v)) {
      out[k] = v.filter(name => typeof name !== 'string' || !isPathKey(name));
    } else {
      out[k] = stripPathProperties(v, depth + 1);
    }
  }
  return out;
}

/** A tools/list result with only BROWSER_TOOLS, their path-like arguments removed from the schemas. */
export function filterToolsList(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !Array.isArray((result as { tools?: unknown }).tools)) return result;
  const tools = (result as { tools: unknown[] }).tools
    .filter((t): t is { name: string; inputSchema?: unknown } => !!t && typeof t === 'object' && BROWSER_TOOLS.includes((t as { name?: unknown }).name as string))
    .map(t => ({ ...t, ...(t.inputSchema !== undefined ? { inputSchema: stripPathProperties(t.inputSchema) } : {}) }));
  return { ...result, tools };
}

/** What the agent is told about ports: the browser runs on the host, so localhost is the host's. */
export function portHint(forwards: Array<{ port: number; hostPort: number }>): string {
  const head = "This browser runs on the user's machine, not in your container: localhost in it is the host.";
  if (forwards.length === 0) {
    return `${head} No container port is forwarded to the host yet, so there is nothing it may open; the user can forward one with kunj ct forward <port>.`;
  }
  const map = forwards
    .slice()
    .sort((a, b) => a.port - b.port)
    .map(f => `container port ${f.port} is http://localhost:${f.hostPort}`)
    .join('; ');
  return `${head} Forwarded ports: ${map}. Open those host URLs, not the container's ports. Tools that read or write files are not available.`;
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

const registry = pidRegistry<BridgeRecord>(bridgesFile, (r: any): r is BridgeRecord => typeof r.container === 'string' && typeof r.name === 'string');

/** The live bridges; entries of dead processes are pruned (and the file rewritten without them). */
export function readBridges(file: string = bridgesFile()): BridgeRecord[] {
  return registry.read(file);
}

export function writeBridges(records: BridgeRecord[], file: string = bridgesFile()): void {
  registry.write(records, file);
}

export function updateBridges(change: (records: BridgeRecord[]) => BridgeRecord[], file: string = bridgesFile()): BridgeRecord[] {
  return registry.update(change, file);
}

/** The pid of a live bridge for `container` (other than `exceptPid`), if one is registered. */
export function bridgeFor(container: string, file: string = bridgesFile(), exceptPid?: number): number | undefined {
  return readBridges(file).find(r => r.container === container && r.pid !== exceptPid)?.pid;
}

// ---------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------

/**
 * Calls `onLine` with each complete line (without its '\n') of a byte stream; split on bytes, so
 * UTF-8 survives. A line growing past `maxBytes` calls `onOverflow` once and nothing more is read.
 */
function lineSplitter(onLine: (line: string) => void, maxBytes = Infinity, onOverflow: () => void = () => {}): { push(chunk: Buffer): void } {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overflowed = false;
  const overflow = () => {
    overflowed = true;
    pending = [];
    onOverflow();
  };
  return {
    push(chunk) {
      if (overflowed) return;
      let start = 0;
      let i: number;
      while ((i = chunk.indexOf(0x0a, start)) !== -1) {
        if (pendingBytes + (i - start) > maxBytes) return overflow();
        pending.push(chunk.subarray(start, i));
        const line = Buffer.concat(pending).toString('utf8');
        pending = [];
        pendingBytes = 0;
        start = i + 1;
        onLine(line);
      }
      const rest = chunk.length - start;
      if (pendingBytes + rest > maxBytes) return overflow();
      if (rest > 0) {
        pending.push(chunk.subarray(start));
        pendingBytes += rest;
      }
    },
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

// The only command run as root, with "$1" the user: the directory, owned by the user. Nothing is
// ever written into it as root. Exit 3: no socat; 4: the directory could not be made.
const PREPARE =
  `d=${MCP_SOCKET_DIR}; command -v socat >/dev/null || exit 3; [ -L "$d" ] && exit 4; ` +
  'mkdir -p "$d" && chown "$1" "$d" && chmod 700 "$d" || exit 4';

/** As the user, "$1" the server name: stops the listener in the pid file, only if it is that socat. */
export function stopCommand(name: string): string[] {
  const dir = MCP_SOCKET_DIR;
  return [
    'sh',
    '-c',
    `p="${dir}/$1.pid"; [ -f "$p" ] || exit 0; o=$(cat "$p"); rm -f "$p"; ` +
      'case "$o" in ""|*[!0-9]*) exit 0;; esac; ' +
      `grep -qaF "UNIX-LISTEN:${dir}/$1.sock," "/proc/$o/cmdline" 2>/dev/null && kill "$o" 2>/dev/null; exit 0`,
    'sh',
    name,
  ];
}

/** As the user: the listener, its pid in the pid file (sh execs socat, so the pid is socat's). */
export function listenCommand(name: string): string[] {
  return [
    'sh',
    '-c',
    `echo $$ > "${MCP_SOCKET_DIR}/$1.pid"; exec socat UNIX-LISTEN:"${MCP_SOCKET_DIR}/$1.sock",unlink-early,mode=600 STDIO`,
    'sh',
    name,
  ];
}

export interface BridgeOptions {
  /** The container user the socket and listener belong to; '' resolves it with `id -un` */
  user: string;
  signal: AbortSignal;
  spawn?: typeof childProcess.spawn;
  /** Where PATH and HOME for the host server come from (default process.env) */
  hostEnv?: NodeJS.ProcessEnv;
  /** The host ports forwarded for the container, read at each check: the default allowed origins */
  forwardedPorts?: () => number[];
  /** Appended to the instructions of the server's initialize result (the port map) */
  instructions?: () => string | undefined;
  log?: (message: string) => void;
  restartDelayMs?: number;
  stateIntervalMs?: number;
}

/**
 * Bridges `cfg`'s stdio server into the container at /run/kunj-mcp/<name>.sock for one run of the
 * container: until `signal` aborts, the container is seen not running or restarted (its StartedAt
 * changed), or two state checks in a row fail.
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

  const run = await backend.containerRun(containerId);
  if (!run || run.state !== 'running') throw new Error('The container is not running');

  let user = opts.user;
  if (!user) {
    const r = await backend.exec(containerId, ['id', '-un']);
    user = r.stdout.trim();
    if (r.exitCode !== 0 || !USER_NAME.test(user)) throw new Error('Cannot tell which user the container runs as');
  }

  const policy = originPolicy(cfg, opts.forwardedPorts ?? (() => []));
  const filter = makeRequestFilter(policy);
  const restartDelayMs = opts.restartDelayMs ?? RESTART_DELAY_MS;
  const stateIntervalMs = opts.stateIntervalMs ?? STATE_POLL_MS;
  const ctx: SessionContext = { backend, containerId, name, user, cfg, filter, opts, log, warnedMalformed: false };
  let failedChecks = 0;
  // A listener only ends without a client when something is wrong: retry ever more slowly
  let retryMs = restartDelayMs;

  const onAbort = () => {
    backend.exec(containerId, stopCommand(name), { user }).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort);
  try {
    while (!signal.aborted) {
      // Bound to the run it started in: a restarted container is a new run, and nothing is exec'd in
      // it before its own start has the firewall up again
      const now = await backend.containerRun(containerId);
      if (!now) {
        if (++failedChecks >= 2) return;
        await sleep(stateIntervalMs, signal);
        continue;
      }
      failedChecks = 0;
      if (now.state !== 'running' || now.startedAt !== run.startedAt) return;

      const prepared = await backend.exec(containerId, ['sh', '-c', PREPARE, 'sh', user], { user: 'root' });
      if (prepared.exitCode === 3) throw new Error('socat is not installed in the container; the MCP bridge needs it');
      if (prepared.exitCode !== 0) throw new Error(`Could not create ${MCP_SOCKET_DIR} in the container (exit ${prepared.exitCode})`);
      // A listener left by a bridge that died
      await backend.exec(containerId, stopCommand(name), { user });
      if (signal.aborted) break;

      const connected = await session(ctx);
      if (signal.aborted) break;
      if (connected) {
        retryMs = restartDelayMs;
        await sleep(restartDelayMs, signal);
      } else {
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

interface SessionContext {
  backend: ContainerBackend;
  containerId: string;
  name: string;
  user: string;
  cfg: McpServerConfig;
  filter: (line: string) => Verdict;
  opts: BridgeOptions;
  log: (message: string) => void;
  warnedMalformed: boolean;
}

/** One listener and, once a client sends a message that may pass, one server process. True when a client connected. */
async function session(ctx: SessionContext): Promise<boolean> {
  const { backend, containerId, name, user, cfg, filter, opts, log } = ctx;
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
  let connected = false;
  let execDone = false;
  // Requests whose replies are rewritten: initialize (the port hint) and tools/list (the allowlist)
  const watched = new Map<string, 'initialize' | 'tools/list'>();
  const idKey = (id: unknown) => JSON.stringify(id);

  const stopListener = () => {
    if (!execDone) backend.exec(containerId, stopCommand(name), { user }).catch(() => undefined);
  };

  const toClient = (line: string) => {
    if (toContainer.writableEnded) return;
    if (!toContainer.write(line + '\n') && server?.stdout && !server.stdout.isPaused()) {
      server.stdout.pause();
      toContainer.once('drain', () => server?.stdout?.resume());
    }
  };

  // host → container: the server's replies, tools/list cut down to the allowlist, the port map added
  const fromServer = lineSplitter(line => {
    if (watched.size) {
      try {
        const msg = JSON.parse(line);
        const kind = msg && msg.id !== undefined ? watched.get(idKey(msg.id)) : undefined;
        if (kind && msg.result && typeof msg.result === 'object') {
          watched.delete(idKey(msg.id));
          if (kind === 'tools/list') {
            msg.result = filterToolsList(msg.result);
          } else {
            const extra = opts.instructions?.();
            if (extra) {
              const own = typeof msg.result.instructions === 'string' && msg.result.instructions ? `${msg.result.instructions}\n\n` : '';
              msg.result.instructions = own + extra;
            }
          }
          line = JSON.stringify(msg);
        }
      } catch {
        // not JSON: passed on as it is (the host server is trusted)
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
      setTimeout(stopListener, SERVER_STOP_MS).unref();
    });
  };

  // container → host: through the request filter; the server starts on the first message that passes
  const fromClient = lineSplitter(
    line => {
      const verdict = filter(line);
      if (!verdict.pass) {
        if (verdict.malformed) {
          if (!ctx.warnedMalformed) log(`MCP ${name}: dropped a line from the container that is not a JSON-RPC message`);
          ctx.warnedMalformed = true;
        } else {
          log(`MCP ${name}: refused a request`);
        }
        if (verdict.reply) toClient(verdict.reply);
        return;
      }
      try {
        const msg = JSON.parse(line);
        if (msg && (msg.method === 'initialize' || msg.method === 'tools/list') && msg.id !== undefined) {
          watched.set(idKey(msg.id), msg.method);
        }
      } catch {
        // passed the filter, so it is JSON
      }
      if (!server) startServer();
      const stdin = server?.stdin;
      if (stdin && !stdin.writableEnded && !stdin.write(line + '\n') && !fromContainer.isPaused()) {
        // The server is not keeping up: stop reading the container until it drains
        fromContainer.pause();
        stdin.once('drain', () => fromContainer.resume());
      }
    },
    MAX_LINE_BYTES,
    () => {
      log(`MCP ${name}: a line from the container is longer than ${MAX_LINE_BYTES} bytes; session ended`);
      if (!toContainer.writableEnded) toContainer.end();
      stopListener();
    },
  );
  fromContainer.on('data', (chunk: Buffer) => {
    connected = true;
    fromClient.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  try {
    const r = await backend.exec(containerId, listenCommand(name), { user, stdin: toContainer, stdout: fromContainer, stderr });
    if (!connected && !opts.signal.aborted) {
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
  }
  if (connected) log(`MCP ${name}: session ended`);
  return connected;
}
