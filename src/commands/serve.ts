// kunj serve: ContainerBackend over HTTP and WebSocket for laptops that run their branch containers
// on this machine (docs/specs/remote-containers.md). Loopback by default; a token on every request.
//
//   kunj serve [--listen 127.0.0.1:7433] [--allow-privileged] [--allow-runtime sysbox-runc] [--verbose]
//   kunj serve --machines [--idle-exit <minutes>]      the coordinator (docs/specs/cloud-machines.md)
//   kunj serve --allow-pairing [--pair-window <min>]    a machine's first boot: one coordinator pairs
//   kunj serve token [--rotate] | token add <client> [--rotate] | token list | token remove <client>
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
  /** Commander gives the value as typed: one name or a comma-separated list */
  allowRuntime?: string | string[];
  verbose?: boolean;
  rotate?: boolean;
  context?: string;
  machines?: boolean;
  idleExit?: string;
  allowPairing?: boolean;
  pairWindow?: string;
  idleSuspend?: string;
  idleCommand?: string;
}

export interface ServeCommandDeps {
  /** The backend to serve (default: LocalDockerBackend on --context / container.dockerContext) */
  backend?: (context: string | undefined) => Promise<ContainerBackend>;
  /** Where the token lives (default ~/.kunj/serve/token, or ~/.kunj/coordinator/token with --machines) */
  tokenFile?: string;
  /** The coordinator's directory (default ~/.kunj/coordinator) */
  coordinatorDir?: string;
  /** The provider a coordinator uses (default: machine.provider from the config) */
  provider?: (name: string, config: Record<string, unknown>) => Promise<import('../lib/machines/provider').MachineProvider>;
  /** Called once listening; `stop` ends the server (tests; the default waits for SIGINT/SIGTERM) */
  onListening?: (address: { host: string; port: number }, stop: () => void) => void;
  stderr?: (line: string) => void;
  /** How long Docker may take to answer before the "Waiting for Docker" line (default 5000; tests) */
  slowDockerMs?: number;
  /** How long a coordinator waits for Docker before listening without it (default 2000; tests) */
  coordinatorDockerWaitMs?: number;
  /** How often an auto-started coordinator checks it is still the one in coordinator.json (default 60 s; tests) */
  ownerCheckMs?: number;
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
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ContainerError(`--listen ${text}: the port must be 0-65535 (0 picks a free one).`);
  return { host, port };
}

/** `sysbox-runc` or `a,b`: exact names (the guard compares whole names, never substrings). */
export function parseRuntimes(value: string | string[] | undefined): string[] {
  const parts = (Array.isArray(value) ? value : value ? [value] : []).flatMap(v => v.split(','));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Every value of `flag` in argv (`--flag v` and `--flag=v`), up to a `--`. */
export function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') break;
    if (argv[i] === flag && i + 1 < argv.length) values.push(argv[++i]);
    else if (argv[i].startsWith(flag + '=')) values.push(argv[i].slice(flag.length + 1));
  }
  return values;
}

export class ServeCommand extends BaseCommand {
  constructor(private readonly deps: ServeCommandDeps = {}) {
    super({
      name: 'serve',
      description: 'Serve this machine\'s Docker to kunj on other machines (remote containers)',
      arguments: '[action] [sub] [client]',
      options: [
        { flags: '--listen <host:port>', description: `Address to listen on (default 127.0.0.1:${DEFAULT_SERVE_PORT}); a non-loopback address needs --allow-remote-listen` },
        { flags: '--allow-remote-listen', description: 'Listen on a non-loopback address (plain HTTP on your network: prefer an SSH tunnel or a TLS proxy)' },
        { flags: '--allow-privileged', description: 'Let clients run privileged containers (container.dockerInDocker "privileged")' },
        { flags: '--allow-runtime <names>', description: 'Let clients use these --runtime values, e.g. sysbox-runc (comma-separated or repeated)' },
        { flags: '--context <name>', description: 'Docker context to serve (default: container.dockerContext)' },
        { flags: '--verbose', description: 'Log every request (method, route, status, duration); refusals are always logged' },
        { flags: '--rotate', description: '[token] Replace the token (or, with token add, that client\'s); every client using it must be given the new one' },
        { flags: '--machines', description: 'Coordinate cloud machines (machine.provider): one machine per branch session, reached through this server; token commands then act on the coordinator\'s tokens' },
        { flags: '--idle-suspend <minutes>', description: 'On a cloud machine: run --idle-command after this many minutes with no request, no open terminal and no agent working' },
        { flags: '--idle-command <path>', description: 'The program --idle-suspend runs to put this machine to sleep (written by the machine bootstrap)' },
        { flags: '--idle-exit <minutes>', description: 'Exit after this many minutes without a request (how kunj runs a local coordinator)' },
        { flags: '--allow-pairing', description: 'With no token yet, let one coordinator pair: POST /v1/pair hands out the token once (a machine\'s first boot)' },
        { flags: '--pair-window <minutes>', description: 'How long after start pairing stays open (default 10)' },
      ],
      helpText: [
        'Actions:',
        '  (default)        run the server until Ctrl-C; prints the token the first time',
        '  token            print the token (kunj remote add <name> … needs it on the laptop)',
        '  token add <name> a token for one more client, shown once (--rotate replaces it)',
        '  token list       the named clients, never their tokens',
        '  token remove <name>',
        '',
        'With --machines this server is the coordinator of cloud machines (machine.provider, machine.<provider>):',
        'clients ask it for a branch\'s machine and it alone talks to the cloud. On a laptop, kunj starts one on its',
        'own when a kunj machine command needs it (docs/specs/cloud-machines.md).',
        '',
        'The server listens on this machine\'s loopback. From the laptop, reach it through an SSH tunnel kunj',
        'opens (kunj remote add box --ssh user@box) or a URL you have put behind TLS (--url https://…).',
        'Anyone with the token controls the containers kunj makes here, so keep it like an SSH key.',
        `The token is in ${path.join('~', '.kunj', 'serve', 'token')} (0600).`,
      ].join('\n'),
    });
  }

  private machinesPaths() {
    // required lazily: the plain server must not load the machine modules
    const { coordinatorDir, coordinatorPaths } = require('../lib/machines/config') as typeof import('../lib/machines/config');
    return coordinatorPaths(this.deps.coordinatorDir ?? coordinatorDir());
  }

  private tokenFile(machines?: boolean): string {
    if (this.deps.tokenFile) return this.deps.tokenFile;
    return machines ? this.machinesPaths().token : path.join(getGlobalKunjDir(), 'serve', 'token');
  }

  private clientsFile(machines?: boolean): string {
    return path.join(path.dirname(this.tokenFile(machines)), 'tokens.json');
  }

  async execute(action?: any, sub?: any, client?: any, options?: any): Promise<void> {
    // Commander passes (action, sub, client, options, command); with fewer positionals the options shift left
    const args: unknown[] = [action, sub, client, options];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object');
    const opts = (optIndex === -1 ? {} : args[optIndex]) as ServeOptions;
    const positionals = (optIndex === -1 ? args : args.slice(0, optIndex)).filter((a): a is string => typeof a === 'string');
    const verb = positionals[0] ?? 'run';
    if (opts.json) this.jsonMode = true;

    const { loadOrCreateToken, rotateToken, addClient, listClients, removeClient } = await import('../lib/serve/token');
    if (verb === 'token') {
      const tokenSub = positionals[1];
      const name = positionals[2];
      const clientsFile = this.clientsFile(opts.machines);
      if (tokenSub === 'add' || tokenSub === 'remove') {
        if (!name) throw new ContainerError(`Name the client: kunj serve token ${tokenSub} <name>${opts.machines ? ' --machines' : ''}.`);
        if (tokenSub === 'add') {
          let token: string;
          try {
            token = addClient(clientsFile, name, { rotate: !!opts.rotate });
          } catch (err) {
            throw new ContainerError((err as Error).message);
          }
          if (this.jsonMode) this.outputJSON({ client: name, token, file: clientsFile, rotated: !!opts.rotate });
          else console.log(token);
          return;
        }
        const removed = removeClient(clientsFile, name);
        if (this.jsonMode) this.outputJSON({ client: name, removed });
        else console.log(removed ? `Removed client ${name}; its token no longer works.` : `No client named ${name}.`);
        return;
      }
      if (tokenSub === 'list') {
        const clients = listClients(clientsFile);
        if (this.jsonMode) this.outputJSON({ clients, file: clientsFile });
        else if (clients.length === 0) console.log(chalk.gray(`No named clients (only the token in ${this.tokenFile(opts.machines)}).`));
        else for (const c of clients) console.log(`${c.name}  ${chalk.gray(c.createdAt)}`);
        return;
      }
      if (tokenSub !== undefined) throw new ContainerError(`Unknown token action '${tokenSub}'. Use kunj serve token [add|list|remove].`);
      const file = this.tokenFile(opts.machines);
      const token = opts.rotate ? rotateToken(file) : loadOrCreateToken(file).token;
      if (this.jsonMode) this.outputJSON({ token, file, rotated: !!opts.rotate });
      else console.log(token);
      return;
    }
    if (verb !== 'run') throw new ContainerError(`Unknown serve action '${verb}'. Run kunj serve to start the server, or kunj serve token to print the token.`);
    if (opts.machines && opts.allowPairing) throw new ContainerError('--machines and --allow-pairing do not go together: a coordinator pairs with machines, it is never paired itself.');

    const listen = parseListen(opts.listen);
    // Commander keeps only the last of a repeated option, so every occurrence is read from argv
    const repeated = flagValues(process.argv, '--allow-runtime');
    const allowRuntimes = parseRuntimes(repeated.length > 1 ? repeated : opts.allowRuntime);
    if (!LOOPBACK.test(listen.host) && !opts.allowRemoteListen) {
      throw new ContainerError(
        `--listen ${opts.listen} is not a loopback address: the connection would be plain HTTP on your network. ` +
          'Keep the default and reach it through an SSH tunnel (kunj remote add <name> --ssh user@host) or a TLS proxy, ' +
          'or pass --allow-remote-listen if you know what you are doing.',
      );
    }

    const stderr = this.deps.stderr ?? ((line: string) => process.stderr.write(line + '\n'));
    const config = await loadResolvedConfig(process.cwd()).catch(() => ({}) as Awaited<ReturnType<typeof loadResolvedConfig>>);
    const dockerContext = opts.context || config.container?.dockerContext || undefined;
    const backend = await (this.deps.backend ?? (async ctx => new (await import('../lib/container/docker')).LocalDockerBackend({ context: ctx })))(dockerContext);
    // A busy Docker Desktop answers after tens of seconds, or never: without this line the command
    // sits silent with nothing listening, which reads as a hang in kunj
    const waiting = setTimeout(
      () => stderr(chalk.gray('Waiting for Docker to answer (docker info)… not listening yet. If this stays, Docker is busy or stuck: try docker info yourself.')),
      this.deps.slowDockerMs ?? 5000,
    );
    // fails early, with docker's own message, when the daemon is down; a coordinator needs no Docker
    // and does not wait for it: a slow Docker kept an auto-started one from listening within the
    // launcher's wait, and the launcher started another, and another (docs/specs/cloud-machines.md)
    let dockerLate = false;
    const engine = opts.machines
      ? await Promise.race([
          backend.info().catch(() => null),
          new Promise<null>(resolve => setTimeout(() => { dockerLate = true; resolve(null); }, this.deps.coordinatorDockerWaitMs ?? 2000).unref?.()),
        ]).finally(() => clearTimeout(waiting))
      : await backend.info().finally(() => clearTimeout(waiting));

    const { fileAuthenticator } = await import('../lib/serve/token');
    const tokenFile = this.tokenFile(opts.machines);
    // A machine's first boot: no token until a coordinator pairs
    const fs = await import('fs');
    const pairing = !!opts.allowPairing && !fs.existsSync(tokenFile);
    const { token, created } = pairing ? { token: '', created: false } : loadOrCreateToken(tokenFile);
    const { createServeServer } = await import('../lib/serve/server');
    const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

    let extend: Parameters<typeof createServeServer>[0]['extend'];
    let machines: { coordinator: import('../lib/machines/coordinator').Coordinator; idleMs: number } | undefined;
    let providerName = '';
    if (opts.machines) {
      const { machineSettings, cacheStoreConfig } = await import('../lib/machines/config');
      const settings = machineSettings(config);
      providerName = settings.provider;
      if (!providerName) throw new ContainerError('kunj serve --machines needs machine.provider (for example: kunj config --set machine.provider=gce --global, then machine.gce).');
      const provider = await (this.deps.provider ?? (async (name, cfg) => (await import('../lib/machines/providers')).createProvider(name, cfg)))(providerName, settings.providerConfig);
      const { Coordinator, fileTokenStore } = await import('../lib/machines/coordinator');
      const { machineRoutes } = await import('../lib/serve/machines');
      const { bootstrapScript, defaultKunjPackage } = await import('../lib/machines/bootstrap');
      const { MACHINE_SERVE_PORT } = await import('../lib/machines/coordinator');
      const startupScript = settings.bootstrap
        ? bootstrapScript({ kunjPackage: settings.kunjPackage || defaultKunjPackage(getVersion()), port: MACHINE_SERVE_PORT, pairWindowMinutes: settings.pairWindowMinutes,
            // The fallback behind this coordinator's own idle loop, so it waits a little longer
            ...(settings.defaults.selfSuspend && provider.features.selfSuspend && provider.selfSuspendScript
              ? { selfSuspend: { script: provider.selfSuspendScript(), minutes: settings.idleMinutes + 15 } }
              : {}),
          })
        : undefined;
      const cacheConfig = cacheStoreConfig(settings.cache);
      if (cacheConfig && !provider.cacheSync) throw new ContainerError(`machine.cache is set, but the ${provider.name} provider has no cache store. Unset it with kunj config --unset machine.cache --global.`);
      const cache = cacheConfig ? provider.cacheSync!(cacheConfig) : undefined;
      const coordinator = new Coordinator({
        provider,
        startupScript,
        cache,
        network: settings.network,
        tokens: fileTokenStore(this.machinesPaths().machineTokens, provider.name),
        version: getVersion(),
        defaults: settings.defaults,
        log: line => stderr(`${stamp()} ${line}`),
      });
      extend = machineRoutes(coordinator);
      machines = { coordinator, idleMs: settings.idleMinutes * 60_000 };
    }

    // A cloud machine's own idle timer (docs/specs/cloud-machines.md): the fallback when no coordinator
    // is there to put it to sleep. Use is any request that is not the coordinator's idle question, an
    // open terminal or log stream, or an agent working in a container here.
    let openStreams = 0;
    let selfSuspend: import('../lib/machines/self-suspend').IdleWatch | undefined;
    if (opts.idleSuspend !== undefined) {
      const minutes = Number(opts.idleSuspend);
      if (!(minutes > 0)) throw new ContainerError(`--idle-suspend ${opts.idleSuspend}: give a number of minutes above 0.`);
      const command = opts.idleCommand;
      if (!command || !path.isAbsolute(command)) throw new ContainerError('--idle-suspend needs --idle-command <absolute path>: the program that suspends this machine.');
      const { idleWatch } = await import('../lib/machines/self-suspend');
      const { localAgentBusy } = await import('../lib/machines/idle');
      const { execFile } = await import('child_process');
      selfSuspend = idleWatch({
        idleMs: minutes * 60_000,
        busy: async () => openStreams > 0 || (await localAgentBusy(backend)),
        fire: () =>
          new Promise<void>((resolve, reject) =>
            execFile(command, [], { timeout: 60_000 }, (err, _out, errOut) => (err ? reject(new Error(String(errOut).trim().split('\n').pop() || err.message)) : resolve()))),
        log: line => stderr(`${stamp()} ${line}`),
      });
    }

    const idleMs = opts.idleExit !== undefined ? Number(opts.idleExit) * 60_000 : 0;
    if (opts.idleExit !== undefined && !(idleMs > 0)) throw new ContainerError(`--idle-exit ${opts.idleExit}: give a number of minutes above 0.`);
    let idleTimer: NodeJS.Timeout | undefined;
    let stopServer: (() => void) | undefined;
    const touch = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        // Not while a terminal or a build runs through this coordinator, and not while a machine is
        // awake: its idle loop is what puts that machine to sleep
        const held = machines
          ? (await machines.coordinator.openProxies()) > 0 || (await machines.coordinator.list().then(l => l.some(m => m.state === 'running'), () => false))
          : false;
        if (held) return touch();
        stderr(`${stamp()} no request for ${opts.idleExit} min: exiting`);
        stopServer?.();
      }, idleMs);
      idleTimer.unref?.();
    };

    const pairWindowMs = (opts.pairWindow !== undefined ? Number(opts.pairWindow) : 10) * 60_000;
    if (!(pairWindowMs > 0)) throw new ContainerError(`--pair-window ${opts.pairWindow}: give a number of minutes above 0.`);
    const server = createServeServer({
      backend,
      authenticate: pairing ? () => null : fileAuthenticator(tokenFile, this.clientsFile(opts.machines)),
      pairing: pairing
        ? {
            until: Date.now() + pairWindowMs,
            onPaired: t => {
              fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
              fs.writeFileSync(tokenFile, t + '\n', { mode: 0o600 });
            },
          }
        : undefined,
      extend,
      version: getVersion(),
      allowPrivileged: !!opts.allowPrivileged,
      allowRuntimes,
      onStream: open => {
        openStreams += open ? 1 : -1;
        selfSuspend?.touch();
      },
      log: line => {
        if (/^(GET|POST|DELETE|PUT) /.test(line) && !/ passive$/.test(line) && !/^GET \/v1\/info /.test(line)) selfSuspend?.touch();
        // Looking is not using: a listing of the machines (kunj events asks every 30 s) or /v1/info must
        // not keep an auto-started coordinator from its idle exit
        if (/^(GET|POST|DELETE|PUT) /.test(line) && !/^GET \/v1\/(machines|info) /.test(line)) touch();
        if (opts.verbose || /^(refused|unauthorized|paired)/.test(line)) stderr(`${stamp()} ${line}`);
      },
    });
    const address = await server.listen(listen.host, listen.port).catch((err: NodeJS.ErrnoException) => {
      // a plain message, not a stack trace: the common mistakes are an address this machine does not have and a busy port
      if (err.code === 'EADDRNOTAVAIL') throw new ContainerError(`--listen ${listen.host}:${listen.port}: ${listen.host} is not an address of this machine. Use one that ifconfig lists, or keep the default 127.0.0.1.`);
      if (err.code === 'EADDRINUSE') throw new ContainerError(`--listen ${listen.host}:${listen.port}: the port is already in use (another kunj serve?). Stop that one, or pick another port with --listen.`);
      throw err;
    });

    if (created && !opts.idleExit) {
      stderr(chalk.yellow(`New token (shown once; kunj serve token${opts.machines ? ' --machines' : ''} prints it again):`));
      stderr(`  ${token}`);
      stderr(chalk.gray(`On the laptop: kunj remote add <name> --ssh <user>@<this host> --port ${address.port}  (or --url https://…), then paste it`));
    }
    const docker = engine ? `Docker ${engine.serverVersion}, ${engine.operatingSystem}` : dockerLate ? 'Docker has not answered yet' : 'no Docker here';
    stderr(`kunj serve ${getVersion()} listening on ${address.address}:${address.port}  (${opts.machines ? `coordinator for ${providerName}; ` : ''}${docker})`);
    if (pairing) stderr(chalk.yellow(`waiting for a coordinator to pair (POST /v1/pair) for ${Math.round(pairWindowMs / 60000)} min`));
    let recordFile: string | undefined;
    if (opts.machines) {
      const { writeRecord } = await import('../lib/machines/local-coordinator');
      recordFile = this.machinesPaths().record;
      writeRecord(recordFile, { pid: process.pid, port: address.port, version: getVersion(), startedAt: new Date().toISOString() });
    }
    touch();
    // An auto-started coordinator (--idle-exit) is one of a kind: once coordinator.json names another
    // (a later start that took over) or is gone, this one has no clients left and quits, instead of
    // polling the cloud next to the new one for as long as a machine is awake
    let ownerCheck: NodeJS.Timeout | undefined;
    if (recordFile && opts.idleExit !== undefined) {
      const file = recordFile;
      ownerCheck = setInterval(() => {
        let owner: number | undefined;
        try {
          owner = JSON.parse(fs.readFileSync(file, 'utf8'))?.pid;
        } catch (err) {
          // only a missing record means gone; a read that failed for another reason is tried again
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
          owner = undefined;
        }
        if (owner !== process.pid) {
          stderr(`${stamp()} ${owner ? `coordinator ${owner} took over` : 'coordinator.json is gone'}: exiting`);
          stopServer?.();
        }
      }, this.deps.ownerCheckMs ?? 60_000);
      ownerCheck.unref?.();
    }
    let idleLoop: NodeJS.Timeout | undefined;
    if (machines) {
      const { coordinator, idleMs: machineIdleMs } = machines;
      const { agentBusy } = await import('../lib/machines/idle');
      let ticking = false;
      idleLoop = setInterval(async () => {
        if (ticking) return;
        ticking = true;
        try {
          await coordinator.idleTick(machineIdleMs, agentBusy);
        } catch (err) {
          if (opts.verbose) stderr(`${stamp()} idle check failed: ${(err as Error).message}`);
        } finally {
          ticking = false;
        }
      }, 60_000);
      idleLoop.unref?.();
    }
    if (opts.allowPrivileged) stderr(chalk.yellow('privileged containers allowed'));
    if (allowRuntimes.length) stderr(chalk.yellow(`runtimes allowed: ${allowRuntimes.join(', ')}`));

    await new Promise<void>(resolve => {
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (idleTimer) clearTimeout(idleTimer);
        server.close().then(resolve, resolve);
      };
      stopServer = stop;
      if (this.deps.onListening) this.deps.onListening({ host: address.address, port: address.port }, stop);
      else {
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      }
    });
    if (idleLoop) clearInterval(idleLoop);
    if (ownerCheck) clearInterval(ownerCheck);
    await machines?.coordinator.close();
    if (recordFile) (await import('../lib/machines/local-coordinator')).removeRecord(recordFile, process.pid);
    // An auto-started coordinator really ends: a docker call still out (a hung Docker answering the
    // start-up `docker info`) would otherwise keep the process alive after it stopped serving
    if (opts.idleExit !== undefined && !this.deps.onListening) {
      (backend as { killChildren?: () => void }).killChildren?.();
      process.exit(0);
    }
  }
}
