// Container command - a sandboxed container per branch, cloned from origin.
//
//   kunj container start [branch] [-c] [--base <ref>]   create or resume a branch's container
//   kunj container shell [branch]                       interactive login shell in /workspace
//   kunj container exec [branch] -- <cmd...>            run a command
//   kunj container agent [branch] [-- <args>]           the agent in a tmux session
//   kunj container attach [branch]                      reattach to that session
//   kunj container forward [branch] <port>|<host>:<port>...
//   kunj container list [--all] [--no-status]
//   kunj container stop [branch]
//   kunj container remove [branch] [--force] [--keep-volumes]
//
// `ct` is an alias. The command is on the fast path (src/commands/fast.ts): keep heavy
// imports out of this module, and load inquirer lazily.

import chalk from 'chalk';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getOriginUrl, getRepoCommonDir, getRepoCommonRoot, getRepoName, loadResolvedConfig } from '../lib/config';
import { getCurrentBranch } from '../lib/git';
import { HookError, runActionHook } from '../lib/hooks';
import { recordRepo } from '../lib/repos';
import { getVersion } from '../lib/version';
import { detectDefaultBranch } from '../lib/base-branch';
import { ContainerBackend, ContainerInfo } from '../lib/container/backend';
import { LocalDockerBackend } from '../lib/container/docker';
import { ContainerStatus, describeGuard, emptyStatus } from '../lib/container/env';
import { Forwarder, forwardPort, parseForwardSpec } from '../lib/container/forward';
import { ContainerNames, LABEL, containerNames, repoIdFromUrl } from '../lib/container/names';
import {
  StartError,
  StartResult,
  containerStatus,
  inspectForRemove,
  removeContainer,
  startContainer,
  stopContainer,
} from '../lib/container/lifecycle';
import { CONTAINER_AGENT_COMMAND_DEFAULT } from '../lib/container/defaults';
import { KunjConfig } from '../types';

interface ContainerOptions {
  json?: boolean;
  create?: boolean;
  base?: string;
  image?: string;
  publish?: string;
  rebuild?: boolean;
  keepOnError?: boolean;
  hooks?: boolean;
  status?: boolean;
  all?: boolean;
  force?: boolean;
  keepVolumes?: boolean;
  context?: string;
}

interface Context {
  config: KunjConfig;
  repo: { root: string; name: string; id: string; originUrl: string };
  backend: ContainerBackend;
  dockerContext?: string;
}

// Expected outcomes (not running, nothing to remove, ...): printed without a stack trace
class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerError';
  }
}

const ACTIONS = ['start', 'shell', 'exec', 'agent', 'attach', 'forward', 'list', 'stop', 'remove'];
const WORKSPACE = '/workspace';
const DEFAULT_USER = 'dev';
const STATUS_TIMEOUT_MS = 2000;
const SHELL = 'exec $(command -v zsh || command -v bash || echo sh) -l';
const PORT_SPEC = /^\d+(:\d+)?$/;

// 'skipped' is --no-status on a running container
type ListStatus = Omit<ContainerStatus, 'status'> & { status: ContainerStatus['status'] | 'skipped' };

export class ContainerCommand extends BaseCommand {
  constructor() {
    super({
      name: 'container',
      aliases: ['ct'],
      description: 'Run a branch in a sandboxed container cloned from origin',
      arguments: '[action] [target] [extra...]',
      allowUnknownOption: true,
      options: [
        { flags: '-c, --create', description: '[start] Create the branch in the container from origin/<base>' },
        { flags: '--base <ref>', description: '[start] Base for a new branch (default: preferences.defaultBaseBranch, else the repo default)' },
        { flags: '--image <img>', description: '[start] Use this image instead of the configured one' },
        { flags: '--publish <ports>', description: '[start] Publish container ports, e.g. 3000,5432' },
        { flags: '--rebuild', description: '[start] Rebuild the image and recreate the container (volumes are kept)' },
        { flags: '--keep-on-error', description: '[start] Keep what a failed start created, for debugging' },
        { flags: '--no-hooks', description: "[start|remove] Skip kunj hooks (see 'kunj hooks --help')" },
        { flags: '--no-status', description: '[list] Skip the per-container status exec (faster listing)' },
        { flags: '-a, --all', description: "[list] Show every repository's containers" },
        { flags: '-f, --force', description: '[remove] Remove even when the container holds unpushed work' },
        { flags: '--keep-volumes', description: '[remove] Keep the workspace and home volumes' },
        { flags: '--context <name>', description: 'Docker context (default: container.dockerContext)' },
      ],
      helpText: [
        'Actions:',
        '  start [branch]                       create or resume the branch\'s container',
        '  shell [branch]                       login shell in /workspace',
        '  exec [branch] -- <cmd...>            run a command in the container',
        '  agent [branch] [-- <args>]           start or reattach the agent\'s tmux session',
        '  attach [branch]                      reattach to the agent\'s tmux session',
        '  forward [branch] <port>|<host>:<port>...  forward localhost ports into the container',
        '  list                                 containers of this repository (the default)',
        '  stop [branch]                        stop, keeping the workspace',
        '  remove [branch]                      remove, refusing while work is unpushed',
        '',
        '[branch] defaults to the current branch. `ct` is short for `container`.',
      ].join('\n'),
    });
  }

  async execute(action?: any, target?: any, extra?: any, options: ContainerOptions = {}): Promise<void> {
    // Commander passes (action, target, extra[], options, command); when fewer positionals
    // are supplied the options object shifts left. The variadic is an array, not the options.
    const args: unknown[] = [action, target, extra];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object' && !Array.isArray(a));
    if (optIndex !== -1) {
      options = args[optIndex] as ContainerOptions;
      args.splice(optIndex);
    }
    [action, target, extra] = args as [string?, string?, unknown?];
    const rest: string[] = Array.isArray(extra) ? extra.map(String) : extra !== undefined ? [String(extra)] : [];
    if (options.json) this.jsonMode = true;

    try {
      const verb = (action || 'list').toLowerCase();
      if (!ACTIONS.includes(verb)) {
        throw new ContainerError(`Unknown container action '${action}'. Expected one of: ${ACTIONS.join(', ')}`);
      }
      await this.dispatch(verb, target, rest, options);
    } catch (error) {
      if (!this.jsonMode) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof StartError ? error.code : error instanceof HookError ? 'hook' : 'error';
      process.stdout.write(JSON.stringify({ error: { code, message } }) + '\n');
      process.exit(1);
    }
  }

  private async dispatch(verb: string, target: string | undefined, rest: string[], options: ContainerOptions): Promise<void> {
    switch (verb) {
      case 'list':
        return this.list(options);
      case 'start':
        return this.start(target, options);
      case 'shell':
        return this.shell(target, options);
      case 'exec': {
        const split = this.splitCommand(target, rest);
        return this.exec(split.branch, split.command, options);
      }
      case 'agent': {
        const split = this.splitCommand(target, rest);
        return this.agent(split.branch, split.command, options);
      }
      case 'attach':
        return this.attach(target, options);
      case 'forward': {
        // `forward 3000` names a port, not a branch
        const specs = target && PORT_SPEC.test(target) ? [target, ...rest] : rest;
        return this.forward(target && PORT_SPEC.test(target) ? undefined : target, specs, options);
      }
      case 'stop':
        return this.stop(target, options);
      case 'remove':
        return this.remove(target, options);
    }
  }

  // Commander drops the `--`, so `exec -- ls -la` arrives as target 'ls'. Everything after
  // `--` on the command line is the command; a positional before it is the branch.
  private splitCommand(target: string | undefined, rest: string[]): { branch?: string; command: string[] } {
    const positionals = target === undefined ? rest : [target, ...rest];
    const dash = process.argv.indexOf('--');
    if (dash === -1) return { branch: target, command: rest };
    const count = process.argv.length - dash - 1;
    const split = Math.max(0, positionals.length - count);
    return { branch: split > 0 ? positionals[0] : undefined, command: positionals.slice(split) };
  }

  // ---------------------------------------------------------------------
  // shared
  // ---------------------------------------------------------------------

  private async context(options: ContainerOptions): Promise<Context> {
    const config = await loadResolvedConfig(process.cwd());
    const root = getRepoCommonRoot();
    if (!root) throw new ContainerError('Not in a git repository');
    const originUrl = getOriginUrl() || '';
    const repo = { root, name: getRepoName() || path.basename(root), id: repoIdFromUrl(originUrl || root), originUrl };
    const dockerContext = options.context || config.container?.dockerContext || undefined;
    return { config, repo, backend: new LocalDockerBackend({ context: dockerContext }), dockerContext };
  }

  private names(ctx: Context, branch: string): ContainerNames {
    return containerNames(ctx.repo.name, ctx.repo.id, branch);
  }

  private async findMain(ctx: Context, branch: string): Promise<ContainerInfo | undefined> {
    const names = this.names(ctx, branch);
    const found = await ctx.backend.list({ [LABEL.repo]: ctx.repo.id, [LABEL.branch]: branch });
    return found.find(c => c.name === names.container);
  }

  private async requireMain(ctx: Context, branch: string): Promise<ContainerInfo> {
    const main = await this.findMain(ctx, branch);
    if (!main) throw new ContainerError(`No container for ${branch}; run kunj ct start ${branch}`);
    return main;
  }

  private async requireRunning(ctx: Context, branch: string): Promise<ContainerInfo> {
    const main = await this.requireMain(ctx, branch);
    if (main.state !== 'running') {
      throw new ContainerError(`Container for ${branch} is not running; run kunj ct start ${branch}`);
    }
    return main;
  }

  private recordedOptions(info: ContainerInfo): { firewall?: string; user?: string } {
    try {
      return JSON.parse(info.labels[LABEL.options] ?? '{}');
    } catch {
      return {};
    }
  }

  private userOf(info: ContainerInfo): string {
    return this.recordedOptions(info).user || DEFAULT_USER;
  }

  // target, else the current branch, else a picker (TTY only)
  private async resolveBranch(ctx: Context, target: string | undefined): Promise<string> {
    if (target) return target;
    const current = await getCurrentBranch();
    if (current) return current;
    if (this.jsonMode || !process.stdin.isTTY) {
      throw new ContainerError('No branch given and not on a branch');
    }
    const containers = (await ctx.backend.list({ [LABEL.repo]: ctx.repo.id })).filter(c => this.isMain(c));
    let choices = containers.map(c => c.labels[LABEL.branch]).filter(Boolean);
    if (choices.length === 0) choices = await remoteBranches();
    if (choices.length === 0) throw new ContainerError('No branch given and no branches to pick from');
    const inquirer = (await import('inquirer')).default;
    const { branch } = await inquirer.prompt([{ type: 'list', name: 'branch', message: 'Branch:', choices }]);
    return branch;
  }

  private isMain(c: ContainerInfo): boolean {
    const role = c.labels[LABEL.role];
    return role ? role === 'main' : !c.name.endsWith('-net-helper');
  }

  // In --json mode progress and warnings go to stderr so stdout stays one JSON document
  private progress(message: string): void {
    if (this.jsonMode) process.stderr.write(message + '\n');
    else console.log(message);
  }

  private warn = (message: string): void => {
    this.progress(chalk.yellow(`⚠ ${message}`));
  };

  // ---------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------

  private async start(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const names = this.names(ctx, branch);
    const { config } = ctx;
    const publish = parsePublish(options.publish);

    let base: string | undefined;
    if (options.create) {
      base = options.base || config.preferences?.defaultBaseBranch || (await detectDefaultBranch(ctx.repo.root)) || undefined;
      base = base?.replace(/^origin\//, '');
    }

    const hookOptions = { hooks: config.hooks, jsonMode: this.jsonMode, skip: options.hooks === false };
    // A failing pre hook throws and nothing is created
    await runActionHook('pre-container-create', { branch, container: names.container, image: '' }, hookOptions);

    this.progress(chalk.blue(`Starting the container for '${branch}'...`));
    const result: StartResult = await startContainer(ctx.backend, {
      branch,
      create: !!options.create,
      base,
      imageOverride: options.image,
      publish,
      rebuild: !!options.rebuild,
      config,
      repo: ctx.repo,
      kunjVersion: getVersion(),
      hostEnv: process.env,
      cwd: process.cwd(),
      jsonMode: this.jsonMode,
      skipHooks: options.hooks === false,
      keepOnError: !!options.keepOnError,
      confirmPush: () => this.confirmPush(branch),
      warn: this.warn,
    });

    await runActionHook('post-container-create', { branch, container: names.container, image: result.image }, hookOptions);

    if (this.jsonMode) {
      this.outputJSON({ ...result, branch });
      return;
    }

    console.log(chalk.green(`✓ Container ${result.names.container} ${result.created ? 'created' : 'resumed'}`));
    console.log(`  image     ${result.image}`);
    console.log(`  branch    ${branch}`);
    console.log(`  firewall  ${result.firewall}`);
    for (const file of result.keptFiles) console.log(`  kept      ${file}`);
    for (const file of result.copiedFiles) console.log(`  copied    ${file}`);
    for (const port of result.publish) console.log(`  port      localhost:${port.host} → :${port.container}`);
    console.log('');
    console.log(`Next: kunj ct agent ${branch}`);
    console.log(`      kunj ct shell ${branch}`);
  }

  // Asked by startContainer when the branch is not on origin; it pushes on yes
  private async confirmPush(branch: string): Promise<boolean> {
    if (this.jsonMode || !process.stdin.isTTY) return false;
    const inquirer = (await import('inquirer')).default;
    const { push } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'push',
        message: `The container clones from origin, which does not have all of '${branch}'. Push it now?`,
        default: true,
      },
    ]);
    return push;
  }

  // ---------------------------------------------------------------------
  // shell / exec / agent / attach
  // ---------------------------------------------------------------------

  private async shell(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const r = await ctx.backend.exec(main.id, ['sh', '-lc', SHELL], this.interactive(main, !!process.stdin.isTTY));
    process.exitCode = r.exitCode;
  }

  private async exec(target: string | undefined, command: string[], options: ContainerOptions): Promise<void> {
    if (command.length === 0) throw new ContainerError('Usage: kunj ct exec [branch] -- <command...>');
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const r = await ctx.backend.exec(main.id, command, this.interactive(main, !!process.stdin.isTTY));
    process.exitCode = r.exitCode;
  }

  private async agent(target: string | undefined, args: string[], options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const user = this.userOf(main);
    const agentCommand = (ctx.config.container?.agentCommand || CONTAINER_AGENT_COMMAND_DEFAULT).split(/\s+/).filter(Boolean);
    const probe = await ctx.backend.exec(main.id, ['sh', '-c', 'command -v tmux'], { user });
    const command =
      probe.exitCode === 0 ? ['tmux', 'new-session', '-A', '-s', 'agent', ...agentCommand, ...args] : [...agentCommand, ...args];
    if (probe.exitCode !== 0) {
      this.warn('tmux is not installed in the container; running the agent directly (it stops when you leave)');
    }
    const r = await ctx.backend.exec(main.id, command, this.interactive(main, true));
    process.exitCode = r.exitCode;
  }

  private async attach(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const r = await ctx.backend.exec(main.id, ['tmux', 'attach', '-t', 'agent'], this.interactive(main, true));
    if (r.exitCode !== 0) throw new ContainerError(`No agent session; run kunj ct agent ${branch}`);
  }

  private interactive(main: ContainerInfo, tty: boolean) {
    return {
      tty,
      stdin: 'inherit' as const,
      stdout: 'inherit' as const,
      stderr: 'inherit' as const,
      user: this.userOf(main),
      workdir: WORKSPACE,
    };
  }

  // ---------------------------------------------------------------------
  // forward
  // ---------------------------------------------------------------------

  private async forward(target: string | undefined, specTexts: string[], options: ContainerOptions): Promise<void> {
    if (specTexts.length === 0) throw new ContainerError('Usage: kunj ct forward [branch] <port>|<hostPort>:<port>...');
    const specs = specTexts.map(parseForwardSpec);
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const hasSocat = (await ctx.backend.exec(main.id, ['sh', '-c', 'command -v socat'], { user: this.userOf(main) })).exitCode === 0;

    const forwarders: Array<{ container: number; forwarder: Forwarder }> = [];
    try {
      for (const spec of specs) {
        forwarders.push({ container: spec.container, forwarder: await forwardPort(ctx.backend, main.id, spec, { hasSocat }) });
      }
    } catch (error) {
      await Promise.all(forwarders.map(f => f.forwarder.close()));
      throw error;
    }

    const list = forwarders.map(f => ({ container: f.container, host: f.forwarder.hostPort }));
    if (this.jsonMode) {
      this.outputJSON({ forwards: list });
    } else {
      for (const f of list) console.log(`localhost:${f.host} → :${f.container}`);
      console.log(chalk.gray('Forwarding; press Ctrl-C to stop'));
    }

    await new Promise<void>(resolve => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        Promise.all(forwarders.map(f => f.forwarder.close())).then(() => resolve(), () => resolve());
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    process.exit(0);
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  private async list(options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const commonDir = getRepoCommonDir();
    if (commonDir) recordRepo(commonDir);

    let all = await ctx.backend.list(options.all ? {} : { [LABEL.repo]: ctx.repo.id });
    if (options.all) all = all.filter(c => c.labels[LABEL.repo]);
    const mains = all.filter(c => this.isMain(c));
    const helpers = new Map(all.filter(c => !this.isMain(c)).map(c => [c.name, c]));

    const statuses = await Promise.all(
      mains.map(async (c): Promise<ListStatus> => {
        if (c.state !== 'running') return emptyStatus('stopped');
        if (options.status === false) return { ...emptyStatus('stopped'), status: 'skipped' };
        return containerStatus(ctx.backend, c.id, this.userOf(c), STATUS_TIMEOUT_MS);
      })
    );

    const containers = mains.map((c, i) => {
      const s = statuses[i];
      return {
        branch: c.labels[LABEL.branch] ?? '',
        name: c.name,
        id: c.id,
        state: c.state,
        image: c.image,
        createdAt: c.createdAt,
        firewall: this.recordedOptions(c).firewall || 'default',
        ports: c.ports.map(p => ({ container: p.container, host: p.host, kind: 'publish' as const })),
        agent: { running: s.agentRunning },
        workspace: { head: s.head ? s.head.slice(0, 7) : null, ahead: s.ahead, dirty: s.dirty },
        status: s.status,
      };
    });

    if (this.jsonMode) {
      this.outputJSON({
        repo: ctx.repo.name,
        backend: { kind: 'docker', context: ctx.dockerContext || 'default' },
        containers,
      });
      return;
    }

    console.log(chalk.blue(options.all ? 'Containers (all repositories):' : `Containers for ${ctx.repo.name}:`));
    console.log(chalk.gray('─'.repeat(70)));
    if (containers.length === 0) {
      console.log(chalk.gray('  none'));
    }
    containers.forEach((c, i) => {
      const running = c.state === 'running';
      let line = `${running ? chalk.green('●') : chalk.gray('○')} ${chalk.white(c.branch)}  ${running ? chalk.green(c.state) : chalk.gray(c.state)}  ${chalk.gray(c.image)}`;
      if (c.agent.running) line += chalk.cyan('  [agent]');
      if (c.workspace.ahead) line += chalk.cyan(`  +${c.workspace.ahead} ahead`);
      if (c.workspace.dirty) line += chalk.yellow('  dirty');
      if (c.status === 'timeout' || c.status === 'error') line += chalk.red(`  status ${c.status}`);
      if (c.ports.length) line += '  ' + c.ports.map(p => `${p.host}→${p.container}`).join(' ');
      const helper = helpers.get(`${mains[i].name}-net-helper`);
      if (running && helper?.state !== 'running') line += chalk.red('  [firewall helper down]');
      console.log(line);
    });
    console.log('');
    console.log(chalk.gray("Tip: Use 'kunj ct start <branch>' to start a container"));
  }

  // ---------------------------------------------------------------------
  // stop / remove
  // ---------------------------------------------------------------------

  private async stop(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireMain(ctx, branch);
    await stopContainer(ctx.backend, this.names(ctx, branch));
    if (this.jsonMode) {
      this.outputJSON({ success: true, branch, name: main.name });
      return;
    }
    console.log(chalk.green(`✓ Stopped ${main.name}`));
  }

  private async remove(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireMain(ctx, branch);
    const names = this.names(ctx, branch);
    const removeCtx = { user: this.userOf(main), kunjVersion: getVersion(), warn: this.warn };

    // Inspected here (not inside removeContainer) so each problem prints on its own line
    if (!options.force) {
      this.progress(chalk.gray('Checking the container for unpushed work...'));
      const problems = describeGuard(await inspectForRemove(ctx.backend, names, removeCtx));
      if (problems.length) {
        throw new ContainerError(
          [`${names.container} holds work origin does not have:`, ...problems.map(p => `  - ${p}`), 'Push it first, or use --force'].join('\n')
        );
      }
    }

    const hookOptions = { hooks: ctx.config.hooks, jsonMode: this.jsonMode, skip: options.hooks === false };
    const hookValues = { branch, container: names.container, image: main.image };
    await runActionHook('pre-container-delete', hookValues, hookOptions);
    await removeContainer(ctx.backend, names, { ...removeCtx, force: true, keepVolumes: !!options.keepVolumes });
    await runActionHook('post-container-delete', hookValues, hookOptions);

    if (this.jsonMode) {
      this.outputJSON({ success: true, branch, name: names.container, keptVolumes: !!options.keepVolumes });
      return;
    }
    console.log(chalk.green(`✓ Removed ${names.container}${options.keepVolumes ? ' (volumes kept)' : ''}`));
  }
}

function parsePublish(text: string | undefined): number[] {
  if (!text) return [];
  return text
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const port = Number(p);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ContainerError(`Invalid port "${p}" in --publish: expected e.g. 3000,5432`);
      }
      return port;
    });
}

// Branch names on origin, for the picker when there are no containers yet
async function remoteBranches(): Promise<string[]> {
  const { execFile } = await import('child_process');
  return new Promise(resolve => {
    execFile('git', ['branch', '-r', '--format=%(refname:short)'], (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        stdout
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('origin/') && l !== 'origin/HEAD' && l !== 'origin')
          .map(l => l.slice('origin/'.length))
      );
    });
  });
}
