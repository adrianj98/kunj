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
//   kunj container blueprint init|snapshot|status|remove
//
// `ct` is an alias. The command is on the fast path (src/commands/fast.ts): keep heavy
// imports out of this module, and load inquirer lazily.

import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getKunjDir, getOriginUrl, getRepoCommonDir, getRepoCommonRoot, getRepoName, loadResolvedConfig } from '../lib/config';
import { getCurrentBranch, getGitRoot } from '../lib/git';
import { HookError, runActionHook } from '../lib/hooks';
import { recordRepo } from '../lib/repos';
import { getVersion } from '../lib/version';
import { shellQuote } from '../lib/config-vars';
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
import { parseOrigin, stripUserinfo } from '../lib/container/seed';
import { BLUEPRINT_PATH, Blueprint, ResolvedBlueprint, ToolValue, parseBlueprint, resolveBlueprint } from '../lib/container/blueprint';
import { inferBlueprint } from '../lib/container/infer';
import { planSnapshot, removeSnapshots, snapshotBlueprint, snapshotStatus } from '../lib/container/snapshot';
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
  snapshot?: boolean;
  global?: boolean;
  yes?: boolean;
  blueprint?: string;
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

const ACTIONS = ['start', 'shell', 'exec', 'agent', 'attach', 'forward', 'list', 'stop', 'remove', 'blueprint'];
const BLUEPRINT_ACTIONS = ['init', 'snapshot', 'status', 'remove'];
const WORKSPACE = '/workspace';
const STATUS_TIMEOUT_MS = 2000;
const SHELL = 'exec $(command -v zsh || command -v bash || echo sh) -l';
const PORT_SPEC = /^\d+(:\d+)?$/;

// 'skipped' is --no-status on a running container
type ListStatus = Omit<ContainerStatus, 'status'> & { status: ContainerStatus['status'] | 'skipped' };

export class ContainerCommand extends BaseCommand {
  private backend?: ContainerBackend;

  constructor() {
    super({
      name: 'container',
      aliases: ['ct'],
      description: 'Run a branch in a sandboxed container cloned from origin',
      arguments: '[action] [target] [extra...]',
      options: [
        { flags: '-c, --create', description: '[start] Create the branch in the container from origin/<base>' },
        { flags: '--base <ref>', description: '[start] Base for a new branch (default: preferences.defaultBaseBranch, else the repo default)' },
        { flags: '--image <img>', description: '[start] Use this image instead of the configured one' },
        { flags: '--publish <ports>', description: '[start] Publish container ports, e.g. 3000,5432' },
        { flags: '--rebuild', description: '[start] Rebuild the image and recreate the container (volumes are kept); [blueprint snapshot] snapshot again even when up to date' },
        { flags: '--no-snapshot', description: "[start] Start from the base image, ignoring the blueprint's snapshot" },
        { flags: '--keep-on-error', description: '[start] Keep what a failed start created, for debugging' },
        { flags: '--no-hooks', description: "[start|remove] Skip kunj hooks (see 'kunj hooks --help')" },
        { flags: '--no-status', description: '[list] Skip the per-container status exec (faster listing)' },
        { flags: '-a, --all', description: "[list] Show every repository's containers" },
        { flags: '-f, --force', description: '[remove] Remove even when the container holds unpushed work' },
        { flags: '--keep-volumes', description: '[remove] Keep the workspace and home volumes' },
        { flags: '--global', description: '[blueprint init] Write the host copy (~/.kunj/<repo>/blueprint.json) instead of .kunj/blueprint.json' },
        { flags: '-y, --yes', description: '[blueprint init] Accept the inferred blueprint and overwrite an existing file' },
        { flags: '--blueprint <path>', description: '[blueprint snapshot|status] Use this blueprint file instead of the resolved one' },
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
        'Blueprint (how a new container is set up: tools, setup and maintain commands):',
        '  blueprint init [--global] [--yes]    infer one from this checkout and write .kunj/blueprint.json',
        '  blueprint snapshot [--base <ref>]    set it up once in a temporary container and save the image',
        '  blueprint status                     which blueprint, its hash and snapshot, stale or not',
        '  blueprint remove                     delete this repository\'s snapshot images',
        '',
        'The blueprint is read from origin/<default branch>:.kunj/blueprint.json, else',
        '~/.kunj/<repo>/blueprint.json. New containers start from the snapshot (--no-snapshot to skip it).',
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
    } catch (caught) {
      const error = await this.explainDockerError(caught);
      const message = error instanceof Error ? error.message : String(error);
      if (this.jsonMode) {
        const code = error instanceof StartError ? error.code : error instanceof HookError ? 'hook' : 'error';
        process.stdout.write(JSON.stringify({ error: { code, message } }) + '\n');
        process.exit(1);
      }
      // Every failure here is an outcome to report, not a crash: one line, no stack trace
      console.error(chalk.red(`✗ ${message}`));
      process.exitCode = 1;
    }
  }

  // "docker ps failed: …" says little when the daemon is down; `docker info` says that clearly.
  // Asked only after a failure, so a working listing costs no extra subprocess.
  private async explainDockerError(error: unknown): Promise<unknown> {
    if (!this.backend || !(error instanceof Error) || !/^docker /.test(error.message)) return error;
    try {
      await this.backend.info();
      return error;
    } catch (info) {
      return info instanceof Error ? info : error;
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
      case 'blueprint':
        return this.blueprint(target, options);
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
    // Credentials in the remote URL stay on the host (seed.ts strips them too)
    const originUrl = stripUserinfo(getOriginUrl() || '');
    const repo = { root, name: getRepoName() || path.basename(root), id: repoIdFromUrl(originUrl || root), originUrl };
    const dockerContext = options.context || config.container?.dockerContext || undefined;
    this.backend = new LocalDockerBackend({ context: dockerContext });
    return { config, repo, backend: this.backend, dockerContext };
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

  private recordedOptions(info: ContainerInfo): { firewall?: string; user?: string; imageKind?: string; blueprintHash?: string } {
    try {
      return JSON.parse(info.labels[LABEL.options] ?? '{}');
    } catch {
      return {};
    }
  }

  // '' (an image without remoteUser, or --image) means the image's own USER: no `-u`, which
  // docker exec resolves to the same user the container was started as
  private userOf(info: ContainerInfo): string {
    return this.recordedOptions(info).user ?? '';
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
    // The create hooks are for creating: resuming an existing container runs neither. --rebuild
    // recreates the container, so it counts. A failing pre hook throws and nothing is created.
    const willCreate = !!options.rebuild || (await ctx.backend.inspectLabels(names.container)) === null;
    if (willCreate) await runActionHook('pre-container-create', { branch, container: names.container, image: '' }, hookOptions);

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
      defaultBranch: async () => (await detectDefaultBranch(ctx.repo.root)) || undefined,
      noSnapshot: options.snapshot === false,
    });

    if (result.created) {
      await runActionHook('post-container-create', { branch, container: names.container, image: result.image }, hookOptions);
    }

    if (this.jsonMode) {
      this.outputJSON({ ...result, branch });
      return;
    }

    console.log(chalk.green(`✓ Container ${result.names.container} ${result.created ? 'created' : 'resumed'}`));
    console.log(`  image     ${result.image}`);
    console.log(`  branch    ${branch}`);
    if (result.user) console.log(`  user      ${result.user}`);
    console.log(`  firewall  ${result.firewall}`);
    const bp = blueprintSummary(result.blueprint);
    if (bp) console.log(`  blueprint ${bp}`);
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
    const user = this.userOf(main) || undefined;
    const command = agentCommandLine(ctx.config.container?.agentCommand, args);
    const probe = await ctx.backend.exec(main.id, ['sh', '-c', 'command -v tmux'], { user });
    if (probe.exitCode !== 0) {
      this.warn('tmux is not installed in the container; running the agent directly (it stops when you leave)');
    }
    // tmux runs a single command argument through the shell, so the setting keeps its quoting
    // -u: UTF-8 even when the image has no locale, so box-drawing glyphs render
    const argv = probe.exitCode === 0 ? ['tmux', '-u', 'new-session', '-A', '-s', 'agent', command] : ['sh', '-lc', command];
    const r = await ctx.backend.exec(main.id, argv, this.interactive(main, true));
    process.exitCode = r.exitCode;
  }

  private async attach(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const r = await ctx.backend.exec(main.id, ['tmux', '-u', 'attach', '-t', 'agent'], this.interactive(main, true));
    if (r.exitCode !== 0) throw new ContainerError(`No agent session; run kunj ct agent ${branch}`);
  }

  private interactive(main: ContainerInfo, tty: boolean) {
    return {
      tty,
      stdin: 'inherit' as const,
      stdout: 'inherit' as const,
      stderr: 'inherit' as const,
      user: this.userOf(main) || undefined,
      workdir: WORKSPACE,
      // The host's terminal type and a UTF-8 locale, so TUIs render the same inside (none of these are secrets)
      env: {
        TERM: process.env.TERM || 'xterm-256color',
        ...(process.env.COLORTERM ? { COLORTERM: process.env.COLORTERM } : {}),
        LANG: 'C.UTF-8',
      },
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
    const hasSocat = (await ctx.backend.exec(main.id, ['sh', '-c', 'command -v socat'], { user: this.userOf(main) || undefined })).exitCode === 0;

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

    // Asked once, and only when a container was started from a snapshot
    const blueprintMains = mains.filter(c => this.recordedOptions(c).imageKind === 'blueprint');
    const currentHash = blueprintMains.some(c => c.labels[LABEL.repo] === ctx.repo.id) ? await this.currentHash(ctx) : null;

    const containers = mains.map((c, i) => {
      const s = statuses[i];
      const recorded = this.recordedOptions(c);
      const stale = currentHash === null || c.labels[LABEL.repo] !== ctx.repo.id ? null : recorded.blueprintHash !== currentHash;
      return {
        branch: c.labels[LABEL.branch] ?? '',
        name: c.name,
        id: c.id,
        state: c.state,
        image: c.image,
        imageInfo: { tag: c.image, ...(recorded.imageKind ? { kind: recorded.imageKind } : {}) },
        ...(recorded.imageKind === 'blueprint' ? { blueprint: { hash: recorded.blueprintHash ?? '', stale } } : {}),
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
      if (c.blueprint) line += c.blueprint.stale ? chalk.yellow('  [blueprint stale]') : chalk.cyan('  [blueprint]');
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
  // blueprint
  // ---------------------------------------------------------------------

  private async blueprint(sub: string | undefined, options: ContainerOptions): Promise<void> {
    switch ((sub || 'status').toLowerCase()) {
      case 'init':
        return this.blueprintInit(options);
      case 'snapshot':
        return this.blueprintSnapshot(options);
      case 'status':
        return this.blueprintStatus(options);
      case 'remove':
        return this.blueprintRemove(options);
    }
    throw new ContainerError(`Unknown blueprint action '${sub}'. Expected one of: ${BLUEPRINT_ACTIONS.join(', ')}`);
  }

  // Resolved as a start resolves it: origin/<default branch>, then the host copy (or --blueprint)
  private resolveBlueprint(options: ContainerOptions, defaultBranch: string | undefined): Promise<ResolvedBlueprint | null> {
    return resolveBlueprint({ cwd: process.cwd(), repoKunjDir: getKunjDir(), defaultBranch, override: options.blueprint });
  }

  private snapshotInput(ctx: Context, branch: string, blueprint: ResolvedBlueprint, warn: (m: string) => void) {
    return {
      branch,
      blueprint,
      config: ctx.config,
      repo: ctx.repo,
      kunjVersion: getVersion(),
      cwd: process.cwd(),
      jsonMode: this.jsonMode,
      warn,
    };
  }

  /** The hash a snapshot of this repository's blueprint would have now; null when it cannot be computed. */
  private async currentHash(ctx: Context): Promise<string | null> {
    try {
      const defaultBranch = (await detectDefaultBranch(ctx.repo.root)) || undefined;
      const resolved = await this.resolveBlueprint({}, defaultBranch);
      if (!resolved || !defaultBranch) return null;
      return (await planSnapshot(this.snapshotInput(ctx, defaultBranch, resolved, () => {}))).hash;
    } catch {
      return null;
    }
  }

  private async blueprintInit(options: ContainerOptions): Promise<void> {
    let root: string;
    try {
      root = await getGitRoot();
    } catch {
      throw new ContainerError('Not in a git repository');
    }
    const file = options.global ? path.join(getKunjDir(), 'blueprint.json') : path.join(root, BLUEPRINT_PATH);
    const interactive = !options.yes && !this.jsonMode && !!process.stdin.isTTY;

    if (fs.existsSync(file) && !options.yes) {
      if (!interactive) throw new ContainerError(`${file} already exists; pass --yes to overwrite it`);
      const inquirer = (await import('inquirer')).default;
      const { overwrite } = await inquirer.prompt([
        { type: 'confirm', name: 'overwrite', message: `${file} already exists. Overwrite it?`, default: false },
      ]);
      if (!overwrite) {
        console.log(chalk.gray('Left unchanged'));
        return;
      }
    }

    const inferred = inferBlueprint(root);
    for (const reason of inferred.reasons) this.progress(chalk.gray(`  ${reason}`));

    let tools = inferred.tools;
    let setup = inferred.setup;
    let maintain = inferred.maintain;
    if (interactive) {
      const inquirer = (await import('inquirer')).default;
      const check = (key: keyof Blueprint, parse: (text: string) => unknown) => (text: string) => {
        try {
          parseBlueprint(JSON.stringify({ [key]: parse(text) }), key);
          return true;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };
      const toolsFrom = (text: string) => parseToolsText(text, inferred.tools);
      const answers = await inquirer.prompt([
        { type: 'input', name: 'tools', message: 'Tools (name=value, ...):', default: formatTools(tools), validate: check('tools', toolsFrom) },
        { type: 'input', name: 'setup', message: 'Setup commands (comma-separated):', default: setup.join(', '), validate: check('setup', commandsText) },
        { type: 'input', name: 'maintain', message: 'Maintain commands (comma-separated):', default: maintain.join(', '), validate: check('maintain', commandsText) },
      ]);
      tools = toolsFrom(answers.tools);
      setup = commandsText(answers.setup);
      maintain = commandsText(answers.maintain);
    } else {
      this.progress(`  tools     ${formatTools(tools) || chalk.gray('none')}`);
      this.progress(`  setup     ${setup.join(', ') || chalk.gray('none')}`);
      this.progress(`  maintain  ${maintain.join(', ') || chalk.gray('none')}`);
    }

    const doc: Record<string, unknown> = {
      ...(Object.keys(tools).length ? { tools } : {}),
      setup,
      maintain,
      ...(inferred.lockfiles.length ? { lockfiles: inferred.lockfiles } : {}),
    };
    const text = JSON.stringify(doc, null, 2) + '\n';
    try {
      parseBlueprint(text, file);
    } catch (err) {
      throw new ContainerError(err instanceof Error ? err.message : String(err));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);

    if (this.jsonMode) {
      this.outputJSON({ path: file, blueprint: doc, reasons: inferred.reasons });
      return;
    }
    console.log(chalk.green(`✓ Wrote ${file}`));
    if (!options.global) console.log(chalk.gray('  Commit and push it: the blueprint is read from origin/<default branch>'));
    console.log('');
    console.log('Next: kunj ct blueprint snapshot');
  }

  private async blueprintSnapshot(options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    // Task 9 lifts this with a host-made bundle
    if (parseOrigin(ctx.repo.originUrl).isSsh) {
      throw new ContainerError(
        'snapshots clone from origin without credentials; an SSH origin cannot be snapshotted yet (private origins are coming)'
      );
    }
    const defaultBranch = (await detectDefaultBranch(ctx.repo.root)) || undefined;
    const branch = (options.base || defaultBranch)?.replace(/^origin\//, '');
    if (!branch) throw new ContainerError('cannot detect the default branch; pass --base');
    // The blueprint a start would use, so the snapshot's hash matches the starts that look for it
    const resolved = await this.resolveBlueprint(options, defaultBranch || branch);
    if (!resolved) throw new ContainerError('No blueprint; run kunj ct blueprint init');

    this.progress(chalk.blue(`Snapshotting the blueprint (${resolved.path}) from ${branch}...`));
    const result = await snapshotBlueprint(ctx.backend, {
      ...this.snapshotInput(ctx, branch, resolved, this.warn),
      rebuild: !!options.rebuild,
      log: m => this.progress(chalk.gray(m)),
    });

    if (this.jsonMode) {
      this.outputJSON(result);
      return;
    }
    const from = result.ref ? ` from ${result.ref.slice(0, 7)}` : '';
    console.log(chalk.green(`✓ Snapshot ${result.tag} (${megabytes(result.sizeBytes)} MB)${from}`));
    for (const tool of result.tools) console.log(`  installed ${tool.name} ${tool.version}`);
    if (result.reused) console.log(chalk.gray('  reused: already up to date (--rebuild to snapshot again)'));
  }

  private async blueprintStatus(options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const defaultBranch = (await detectDefaultBranch(ctx.repo.root)) || undefined;
    const resolved = await this.resolveBlueprint(options, defaultBranch);
    if (!resolved) {
      if (this.jsonMode) {
        this.outputJSON({ source: null });
        return;
      }
      throw new ContainerError('No blueprint; run kunj ct blueprint init');
    }

    const branch = (options.base || defaultBranch)?.replace(/^origin\//, '');
    let hash: string | null = null;
    if (!branch) {
      this.warn('cannot detect the default branch; pass --base to compute the hash');
    } else {
      try {
        hash = (await planSnapshot(this.snapshotInput(ctx, branch, resolved, this.warn))).hash;
      } catch (err) {
        this.warn(`Could not compute the blueprint hash: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const { current, others } = await snapshotStatus(ctx.backend, ctx.repo.name, ctx.repo.id, hash ?? '');
    const stale = hash === null ? null : !current && others.length > 0;
    const snapshot = current
      ? { tag: current.tag, createdAt: current.labels[LABEL.blueprintCreatedAt] || current.createdAt, sizeBytes: current.size }
      : null;
    const notes = resolved.blueprint.notes ?? null;

    if (this.jsonMode) {
      this.outputJSON({ source: resolved.source, path: resolved.path, hash, snapshot, stale, others: others.map(i => i.tag), notes });
      return;
    }
    console.log(`Blueprint: ${resolved.path} ${chalk.gray(`(${resolved.source})`)}`);
    console.log(`  hash      ${hash ?? chalk.gray('unknown')}`);
    if (snapshot) {
      console.log(`  snapshot  ${snapshot.tag}  ${chalk.gray(`${snapshot.createdAt}  ${megabytes(snapshot.sizeBytes)} MB`)}`);
    } else if (stale) {
      console.log(`  snapshot  ${chalk.yellow(`stale (${others.map(i => i.tag).join(', ')})`)}; run kunj ct blueprint snapshot`);
    } else {
      console.log(`  snapshot  ${chalk.gray('none')}; run kunj ct blueprint snapshot`);
    }
    if (notes) console.log(`  notes     ${notes}`);
    if (resolved.blueprint.ignoredKeys.length) {
      console.log(chalk.yellow(`  ignored   ${resolved.blueprint.ignoredKeys.join(', ')}`));
    }
  }

  private async blueprintRemove(options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const removed = await removeSnapshots(ctx.backend, ctx.repo.name, ctx.repo.id, this.warn);
    if (this.jsonMode) {
      this.outputJSON({ removed });
      return;
    }
    if (removed.length === 0) console.log(chalk.gray('No snapshots to remove'));
    for (const tag of removed) console.log(chalk.green(`✓ Removed ${tag}`));
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

// container.agentCommand is shell text (it may quote its own arguments); extra args are data
export function agentCommandLine(setting: string | undefined, args: string[]): string {
  return [(setting || CONTAINER_AGENT_COMMAND_DEFAULT).trim(), ...args.map(shellQuote)].join(' ');
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function blueprintSummary(bp: StartResult['blueprint']): string | null {
  if (!bp) return null;
  if (bp.snapshot) return `snapshot ${bp.hash}${bp.stale ? ' (stale)' : ''}`;
  const ran = [bp.toolsRun.length ? 'tools' : '', bp.setupRan ? 'setup' : ''].filter(Boolean);
  return ran.length ? `no snapshot; ran ${ran.join(' + ')}` : 'no snapshot';
}

// `node=24, apt=jq git-lfs`: what `blueprint init` shows and lets the user edit
function formatTools(tools: Record<string, ToolValue>): string {
  return Object.entries(tools)
    .map(([name, value]) => `${name}=${value === true ? 'true' : Array.isArray(value) ? value.join(' ') : value}`)
    .join(', ');
}

// A tool proposed as a list (apt) stays a list; otherwise several words become one
function parseToolsText(text: string, proposed: Record<string, ToolValue>): Record<string, ToolValue> {
  const tools: Record<string, ToolValue> = {};
  for (const pair of text.split(',').map(p => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`"${pair}" is not name=value`);
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const words = value.split(/\s+/).filter(Boolean);
    tools[name] = value === 'true' ? true : Array.isArray(proposed[name]) || words.length > 1 ? words : value;
  }
  return tools;
}

function commandsText(text: string): string[] {
  return text.split(',').map(c => c.trim()).filter(Boolean);
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
