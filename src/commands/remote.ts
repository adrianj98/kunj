// kunj remote: the kunj serve machines this laptop knows (src/lib/remotes.ts) and their tokens.
//
//   kunj remote add <name> --ssh user@box [--port 7433] | --url https://… [--token <t> | --token-stdin]
//   kunj remote list [--json]
//   kunj remote remove <name>
//   kunj remote ping <name> [--json]
//   kunj remote token <name> [--token <t> | --token-stdin]
//
// Tokens never appear in a listing or in --json output; they are asked for with a hidden prompt
// unless given. On the fast path (src/commands/fast.ts): keep top-level imports light.

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadResolvedConfig } from '../lib/config';
import { ContainerError } from '../lib/container/errors';
import {
  DEFAULT_SERVE_PORT,
  RemoteEntry,
  checkPort,
  checkRemoteName,
  checkRemoteUrl,
  checkSshDestination,
  checkToken,
  describeRemote,
  getRemotesPath,
  readRemotes,
  requireRemote,
  writeRemotes,
} from '../lib/remotes';
import type { RemoteListJson, RemotePingJson } from '../lib/json-types';

interface RemoteOptions {
  json?: boolean;
  ssh?: string;
  port?: string;
  url?: string;
  token?: string;
  tokenStdin?: boolean;
}

export interface RemoteCommandDeps {
  file?: string;
  /** The token when neither --token nor --token-stdin was given (default: a hidden prompt, or stdin without a TTY) */
  promptToken?: () => Promise<string>;
  stdin?: () => Promise<string>;
  isTTY?: () => boolean;
  /** How `ping` reaches a remote (default: selectBackend over the real network) */
  select?: typeof import('../lib/container/select-backend').selectBackend;
}

const ACTIONS = ['add', 'list', 'remove', 'ping', 'token'];

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', d => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
    process.stdin.on('error', reject);
  });
}

export class RemoteCommand extends BaseCommand {
  constructor(private readonly deps: RemoteCommandDeps = {}) {
    super({
      name: 'remote',
      description: 'Machines running kunj serve, for remote branch containers',
      arguments: '[action] [name]',
      options: [
        { flags: '--ssh <destination>', description: '[add] Reach the server through an SSH tunnel to user@host (the server listens on its loopback)' },
        { flags: '--port <port>', description: `[add] The server's port on the box, with --ssh (default ${DEFAULT_SERVE_PORT})` },
        { flags: '--url <url>', description: '[add] Reach the server at this URL (https://, or http:// to a loopback address)' },
        { flags: '--token <token>', description: '[add|token] The server\'s token (lands in your shell history; prefer --token-stdin or the prompt)' },
        { flags: '--token-stdin', description: '[add|token] Read the token from stdin' },
      ],
      helpText: () =>
        [
          'Actions:',
          '  add <name> --ssh user@host [--port n]   a server reached through an SSH tunnel kunj opens',
          '  add <name> --url https://…             a server you put behind TLS yourself',
          '  list (default)                         the known remotes, without their tokens',
          '  remove <name>',
          '  ping <name>                            versions, features and Docker context of the server',
          '  token <name>                           replace the stored token',
          '',
          'Then kunj ct … --remote <name>, or kunj config --set container.remote=<name> in the repository,',
          "runs that repository's containers there. --remote local forces this machine's Docker.",
          `Remotes are kept in ${getRemotesPath()} (0600).`,
        ].join('\n'),
    });
  }

  private file(): string {
    return this.deps.file ?? getRemotesPath();
  }

  private async tokenFrom(opts: RemoteOptions): Promise<string> {
    let token: string;
    if (opts.token !== undefined) {
      if (!this.jsonMode) console.error(chalk.yellow('⚠ --token puts the token in your shell history; --token-stdin or the prompt avoid that'));
      token = opts.token;
    } else if (opts.tokenStdin) {
      token = (await (this.deps.stdin ?? readStdin)()).trim();
    } else if ((this.deps.isTTY ?? (() => !!process.stdin.isTTY))()) {
      const prompt = this.deps.promptToken ?? (async () => (await import('../lib/secrets/keyprovider')).hiddenPrompt('Token: '));
      token = (await prompt()).trim();
    } else {
      token = (await (this.deps.stdin ?? readStdin)()).trim();
    }
    checkToken(token);
    return token;
  }

  async execute(action?: any, name?: any, options?: any): Promise<void> {
    // Commander passes (action, name, options, command); with fewer positionals the options shift left
    const args: unknown[] = [action, name, options];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object');
    const opts = (optIndex === -1 ? {} : args[optIndex]) as RemoteOptions;
    const positionals = (optIndex === -1 ? args : args.slice(0, optIndex)).filter((a): a is string => typeof a === 'string');
    if (opts.json) this.jsonMode = true;
    const verb = (positionals[0] || 'list').toLowerCase();
    const target = positionals[1];
    if (!ACTIONS.includes(verb)) throw new ContainerError(`Unknown remote action '${verb}'. Expected one of: ${ACTIONS.join(', ')}`);

    switch (verb) {
      case 'list':
        return this.list();
      case 'add':
        return this.add(target, opts);
      case 'remove':
        return this.remove(target);
      case 'ping':
        return this.ping(target);
      case 'token':
        return this.token(target, opts);
    }
  }

  private list(): void {
    const remotes = readRemotes(this.file());
    const names = Object.keys(remotes).sort();
    if (this.jsonMode) {
      const json: RemoteListJson = {
        remotes: names.map(n => ({ name: n, via: remotes[n].url ? 'url' : 'ssh', ssh: remotes[n].ssh, port: remotes[n].ssh ? remotes[n].port ?? DEFAULT_SERVE_PORT : undefined, url: remotes[n].url, addedAt: remotes[n].addedAt })),
      };
      this.outputJSON(json);
      return;
    }
    if (names.length === 0) {
      console.log(chalk.gray('No remotes. Add one with kunj remote add <name> --ssh user@host (or --url https://…)'));
      return;
    }
    for (const n of names) console.log(`${chalk.white(n.padEnd(16))} ${chalk.gray(describeRemote(remotes[n]))}`);
  }

  private async add(name: string | undefined, opts: RemoteOptions): Promise<void> {
    if (!name) throw new ContainerError('Usage: kunj remote add <name> --ssh user@host | --url https://…');
    checkRemoteName(name);
    if (!!opts.ssh === !!opts.url) throw new ContainerError('Give exactly one of --ssh user@host or --url https://…');
    const entry: RemoteEntry = { token: '', addedAt: new Date().toISOString() };
    if (opts.url) {
      checkRemoteUrl(opts.url);
      entry.url = opts.url.replace(/\/+$/, '');
      if (opts.port) throw new ContainerError('--port goes with --ssh; put the port in the URL');
    } else {
      checkSshDestination(opts.ssh!);
      entry.ssh = opts.ssh;
      if (opts.port !== undefined) {
        const port = Number(opts.port);
        checkPort(port);
        entry.port = port;
      }
    }
    entry.token = await this.tokenFrom(opts);
    const remotes = readRemotes(this.file());
    const replaced = !!remotes[name];
    remotes[name] = entry;
    writeRemotes(remotes, this.file());
    if (this.jsonMode) {
      this.outputJSON({ success: true, name, via: entry.url ? 'url' : 'ssh', replaced });
      return;
    }
    console.log(chalk.green(`✓ ${replaced ? 'Replaced' : 'Added'} remote ${name}: ${describeRemote(entry)}`));
    if (entry.ssh) console.log(chalk.gray(`Connect once from a terminal (kunj remote ping ${name}) so ssh records the host key before any app uses it`));
    console.log(chalk.gray(`Use it with kunj ct … --remote ${name}, or kunj config --set container.remote=${name}`));
  }

  private remove(name: string | undefined): void {
    if (!name) throw new ContainerError('Usage: kunj remote remove <name>');
    const remotes = readRemotes(this.file());
    if (!remotes[name]) throw new ContainerError(`No remote named "${name}"`, 'remote-unknown');
    delete remotes[name];
    writeRemotes(remotes, this.file());
    if (this.jsonMode) this.outputJSON({ success: true, name });
    else console.log(chalk.green(`✓ Removed remote ${name}`));
  }

  private async token(name: string | undefined, opts: RemoteOptions): Promise<void> {
    if (!name) throw new ContainerError('Usage: kunj remote token <name> [--token-stdin]');
    const remotes = readRemotes(this.file());
    if (!remotes[name]) throw new ContainerError(`No remote named "${name}"`, 'remote-unknown');
    remotes[name].token = await this.tokenFrom(opts);
    writeRemotes(remotes, this.file());
    if (this.jsonMode) this.outputJSON({ success: true, name });
    else console.log(chalk.green(`✓ Token of ${name} replaced`));
  }

  private async ping(name: string | undefined): Promise<void> {
    if (!name) throw new ContainerError('Usage: kunj remote ping <name>');
    const entry = requireRemote(name, this.file());
    const select = this.deps.select ?? (await import('../lib/container/select-backend')).selectBackend;
    const config = await loadResolvedConfig(process.cwd()).catch(() => ({}) as Awaited<ReturnType<typeof loadResolvedConfig>>);
    const started = Date.now();
    const selection = await select({ remote: name, config, remotes: () => entry });
    try {
      const { RemoteKunjBackend } = await import('../lib/container/remote');
      const remote = selection.backend as InstanceType<typeof RemoteKunjBackend>;
      const engine = await remote.info();
      const json: RemotePingJson = {
        name,
        via: entry.url ? 'url' : 'ssh',
        kunj: remote.serverVersion ?? '?',
        context: remote.serverContext ?? '?',
        features: remote.features,
        engine,
        ms: Date.now() - started,
      };
      if (this.jsonMode) {
        this.outputJSON(json);
        return;
      }
      console.log(chalk.green(`✓ ${name} (${describeRemote(entry)}): kunj serve ${json.kunj}, Docker ${engine.serverVersion} on ${engine.operatingSystem}, context ${json.context}, ${json.ms} ms`));
      const dind = remote.features.dockerInDocker;
      console.log(chalk.gray(`  Docker-in-Docker: ${dind.length ? dind.join(', ') : 'off'}; editor attach: no (use kunj ct shell, or Remote-SSH)`));
    } finally {
      await selection.close();
    }
  }
}
