// kunj serve: ContainerBackend over HTTP and WebSocket for laptops that run their branch containers
// on this machine (docs/specs/remote-containers.md). Loopback by default; a token on every request.
//
//   kunj serve [--listen 127.0.0.1:7433] [--allow-privileged] [--allow-runtime sysbox-runc] [--verbose]
//   kunj serve token [--rotate]
//
// On the fast path (src/commands/fast.ts): keep top-level imports light.

import chalk from 'chalk';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getGlobalKunjDir, loadResolvedConfig } from '../lib/config';
import { ContainerBackend } from '../lib/container/backend';
import { ContainerError } from '../lib/container/errors';
import { DEFAULT_SERVE_PORT } from '../lib/remotes';
import { getVersion } from '../lib/version';

interface ServeOptions {
  json?: boolean;
  listen?: string;
  allowRemoteListen?: boolean;
  allowPrivileged?: boolean;
  allowRuntime?: string[];
  verbose?: boolean;
  rotate?: boolean;
  context?: string;
}

export interface ServeCommandDeps {
  /** The backend to serve (default: LocalDockerBackend on --context / container.dockerContext) */
  backend?: (context: string | undefined) => Promise<ContainerBackend>;
  /** Where the token lives (default ~/.kunj/serve/token) */
  tokenFile?: string;
  /** Called once listening; `stop` ends the server (tests; the default waits for SIGINT/SIGTERM) */
  onListening?: (address: { host: string; port: number }, stop: () => void) => void;
  stderr?: (line: string) => void;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/;

/** `host:port`, `:port`, `port` or `host`; defaults 127.0.0.1:7433. */
export function parseListen(text: string | undefined): { host: string; port: number } {
  if (!text) return { host: '127.0.0.1', port: DEFAULT_SERVE_PORT };
  let host = '127.0.0.1';
  let portText = text;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2] ?? '';
  } else if (text.includes(':')) {
    const at = text.lastIndexOf(':');
    host = text.slice(0, at) || host;
    portText = text.slice(at + 1);
  } else if (!/^\d+$/.test(text)) {
    host = text;
    portText = '';
  }
  // Port 0 lets the OS pick one (printed once listening)
  const port = portText === '' ? DEFAULT_SERVE_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ContainerError(`--listen ${text}: the port must be 0-65535`);
  return { host, port };
}

export class ServeCommand extends BaseCommand {
  constructor(private readonly deps: ServeCommandDeps = {}) {
    super({
      name: 'serve',
      description: 'Serve this machine\'s Docker to kunj on other machines (remote containers)',
      arguments: '[action]',
      options: [
        { flags: '--listen <host:port>', description: `Address to listen on (default 127.0.0.1:${DEFAULT_SERVE_PORT}); a non-loopback address needs --allow-remote-listen` },
        { flags: '--allow-remote-listen', description: 'Listen on a non-loopback address (plain HTTP on your network: prefer an SSH tunnel or a TLS proxy)' },
        { flags: '--allow-privileged', description: 'Let clients run privileged containers (container.dockerInDocker "privileged")' },
        { flags: '--allow-runtime <name>', description: 'Let clients use this --runtime, e.g. sysbox-runc (repeatable)', defaultValue: [] },
        { flags: '--context <name>', description: 'Docker context to serve (default: container.dockerContext)' },
        { flags: '--verbose', description: 'Log every request (method, route, status, duration); refusals are always logged' },
        { flags: '--rotate', description: '[token] Replace the token; every client must be given the new one' },
      ],
      helpText: [
        'Actions:',
        '  (default)        run the server until Ctrl-C; prints the token the first time',
        '  token            print the token (kunj remote add <name> … needs it on the laptop)',
        '',
        'The server listens on this machine\'s loopback. From the laptop, reach it through an SSH tunnel kunj',
        'opens (kunj remote add box --ssh user@box) or a URL you have put behind TLS (--url https://…).',
        'Anyone with the token controls the containers kunj makes here, so keep it like an SSH key.',
        `The token is in ${path.join('~', '.kunj', 'serve', 'token')} (0600).`,
      ].join('\n'),
    });
  }

  private tokenFile(): string {
    return this.deps.tokenFile ?? path.join(getGlobalKunjDir(), 'serve', 'token');
  }

  async execute(action?: any, options?: any): Promise<void> {
    // Commander passes (action, options, command); without the positional the options shift left
    const args: unknown[] = [action, options];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object');
    const opts = (optIndex === -1 ? {} : args[optIndex]) as ServeOptions;
    const verb = typeof action === 'string' ? action : 'run';
    if (opts.json) this.jsonMode = true;

    const { loadOrCreateToken, rotateToken } = await import('../lib/serve/token');
    if (verb === 'token') {
      const token = opts.rotate ? rotateToken(this.tokenFile()) : loadOrCreateToken(this.tokenFile()).token;
      if (this.jsonMode) this.outputJSON({ token, file: this.tokenFile(), rotated: !!opts.rotate });
      else console.log(token);
      return;
    }
    if (verb !== 'run') throw new ContainerError(`Unknown serve action '${verb}'. Expected: token`);

    const listen = parseListen(opts.listen);
    if (!LOOPBACK.test(listen.host) && !opts.allowRemoteListen) {
      throw new ContainerError(
        `--listen ${opts.listen} is not a loopback address: the connection would be plain HTTP on your network. ` +
          'Keep the default and reach it through an SSH tunnel (kunj remote add <name> --ssh user@host) or a TLS proxy, ' +
          'or pass --allow-remote-listen if you know what you are doing',
      );
    }

    const stderr = this.deps.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
    const config = await loadResolvedConfig(process.cwd()).catch(() => ({}) as Awaited<ReturnType<typeof loadResolvedConfig>>);
    const dockerContext = opts.context || config.container?.dockerContext || undefined;
    const backend = await (this.deps.backend ?? (async ctx => new (await import('../lib/container/docker')).LocalDockerBackend({ context: ctx })))(dockerContext);
    const engine = await backend.info(); // fails early, with docker's own message, when the daemon is down

    const { token, created } = loadOrCreateToken(this.tokenFile());
    const { createServeServer } = await import('../lib/serve/server');
    const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    const server = createServeServer({
      backend,
      token,
      version: getVersion(),
      allowPrivileged: !!opts.allowPrivileged,
      allowRuntimes: opts.allowRuntime ?? [],
      log: line => {
        if (opts.verbose || /^(refused|unauthorized)/.test(line)) stderr(`${stamp()} ${line}`);
      },
    });
    const address = await server.listen(listen.host, listen.port);

    if (created) {
      stderr(chalk.yellow('New token (shown once; kunj serve token prints it again):'));
      stderr(`  ${token}`);
      stderr(chalk.gray(`On the laptop: kunj remote add <name> --ssh <user>@<this host> --port ${address.port}  (or --url https://…), then paste it`));
    }
    stderr(`kunj serve ${getVersion()} listening on ${address.address}:${address.port}  (Docker ${engine.serverVersion}, ${engine.operatingSystem})`);
    if (opts.allowPrivileged) stderr(chalk.yellow('privileged containers allowed'));
    if (opts.allowRuntime?.length) stderr(chalk.yellow(`runtimes allowed: ${opts.allowRuntime.join(', ')}`));

    await new Promise<void>(resolve => {
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        server.close().then(resolve, resolve);
      };
      if (this.deps.onListening) this.deps.onListening({ host: address.address, port: address.port }, stop);
      else {
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      }
    });
  }
}
