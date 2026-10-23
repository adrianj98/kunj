// Container command - a sandboxed container per branch, cloned from origin.
//
//   kunj container start [branch] [-c] [--base <ref>]   create or resume a branch's container
//   kunj container shell [branch]                       interactive login shell in /workspace
//   kunj container exec [branch] -- <cmd...>            run a command
//   kunj container agent [branch] [-- <args>]           the agent in a tmux session
//   kunj container attach [branch]                      reattach to that session
//   kunj container open [branch] [--new-window]         attach the editor (worktree.editorCommand)
//   kunj container forward [branch] <port>|<host>:<port>|<service>:<port>...
//   kunj container forward [branch] --auto [--detach]  forward every port the container listens on
//   kunj container mcp [branch]                        bridge container.mcp's host servers in the foreground
//   kunj container logs [branch] [service] [--follow]
//   kunj container list [--all] [--no-status]
//   kunj container stop [branch]
//   kunj container remove [branch] [--force] [--keep-volumes]
//   kunj container prune [--all] [--dry-run] [--force] [--yes]
//   kunj container blueprint init|snapshot|status|remove
//   kunj container file read|write [branch] <path>
//
// `ct` is an alias. The command is on the fast path (src/commands/fast.ts): keep heavy
// imports out of this module, and load inquirer lazily.

import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getKunjDir, getOriginUrl, getRepoCommonDir, getRepoCommonRoot, getRepoName, loadConfig, loadResolvedConfig, resetRepoCache } from '../lib/config';
import { getCurrentBranch, getGitRoot } from '../lib/git';
import { HookError, runActionHook } from '../lib/hooks';
import { listRepos, recordRepo } from '../lib/repos';
import { getVersion } from '../lib/version';
import { shellQuote } from '../lib/config-vars';
import { detectDefaultBranch } from '../lib/base-branch';
import { ContainerBackend, ContainerInfo } from '../lib/container/backend';
import { LocalDockerBackend } from '../lib/container/docker';
import { ContainerStatus, describeGuard, emptyStatus } from '../lib/container/env';
import { EDITOR_CREDENTIALS_WARNING, attachedContainerUri, imageConfigPaths, writeImageConfig } from '../lib/container/editor';
import { Forwarder, TUNNEL_PROBE, forwardPort, parseForwardSpec, parseTunnelProbe } from '../lib/container/forward';
import { ForwardRecord, HELPER_NO_SOCAT, autoForwardIgnore, detachedLogFile, forwarderFor, readForwards, recordIsFor, runAutoForward, spawnDetached, updateForwards } from '../lib/container/autoforward';
import { BridgeRecord, bridgeFor, installMcpConfig, mcpServers, portHint, readBridges, runBridge, updateBridges } from '../lib/container/mcpbridge';
import { describeServices, findServices, serviceNames, servicesOf } from '../lib/container/services';
import { ContainerError } from '../lib/container/errors';
import { readWorkspaceFile, validateWorkspacePath, writeWorkspaceFile } from '../lib/container/files';
import { ContainerNames, LABEL, containerNames, isMain, optionsLabel, repoIdFromUrl } from '../lib/container/names';
import {
  StartError,
  StartResult,
  containerStatus,
  inspectForRemove,
  needsResume,
  removeContainer,
  startContainer,
  stopContainer,
} from '../lib/container/lifecycle';
import { CONTAINER_AGENT_COMMAND_DEFAULT } from '../lib/container/defaults';
import { stripUserinfo } from '../lib/container/seed';
import { BLUEPRINT_PATH, Blueprint, ResolvedBlueprint, ToolValue, parseBlueprint, resolveBlueprint } from '../lib/container/blueprint';
import { inferBlueprint } from '../lib/container/infer';
import { precheckDind } from '../lib/container/dind';
import { ensureSnapshot, planSnapshot, removeSnapshots, snapshotBlueprint, snapshotStatus } from '../lib/container/snapshot';
import { PrunePlan, applyPrune, findOrphans, mergePlans, planPrune, removalCount } from '../lib/container/prune';
import { KunjConfig } from '../types';
import type { ContainerJson, ContainerListJson, FileReadJson, FileWriteJson } from '../lib/json-types';

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
  bundle?: boolean;
  follow?: boolean;
  newWindow?: boolean;
  auto?: boolean;
  detach?: boolean;
  dryRun?: boolean;
}

interface Context {
  config: KunjConfig;
  repo: { root: string; name: string; id: string; originUrl: string };
  backend: ContainerBackend;
  dockerContext?: string;
}

const ACTIONS = ['start', 'shell', 'exec', 'agent', 'attach', 'open', 'forward', 'mcp', 'logs', 'list', 'stop', 'remove', 'prune', 'blueprint', 'file'];
const FILE_ACTIONS = ['read', 'write'];
const BLUEPRINT_ACTIONS = ['init', 'snapshot', 'status', 'remove'];
const WORKSPACE = '/workspace';
const STATUS_TIMEOUT_MS = 2000;
const SHELL = 'exec $(command -v zsh || command -v bash || echo sh) -l';
const PORT_SPEC = /^\d+(:\d+)?$/;
// `postgres:5432`: a service's port (':' cannot be in a branch name, so this is never a branch)
const SERVICE_SPEC = /^([a-z0-9][a-z0-9-]*):(\d+)$/;
const isForwardSpec = (t: string | undefined): t is string => !!t && (PORT_SPEC.test(t) || SERVICE_SPEC.test(t));

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
        { flags: '--no-snapshot', description: "[start] Neither build nor use the blueprint's snapshot (tools and setup run in the container)" },
        { flags: '--keep-on-error', description: '[start] Keep what a failed start created, for debugging' },
        { flags: '--no-hooks', description: "[start|remove|prune] Skip kunj hooks (see 'kunj hooks --help')" },
        { flags: '--no-status', description: '[list] Skip the per-container status exec (faster listing)' },
        { flags: '-a, --all', description: "[list] Show every repository's containers; [prune] prune every repository in ~/.kunj/repos.json" },
        { flags: '-f, --force', description: '[remove|prune] Remove even when the container holds unpushed work (prune: and volumes without a container)' },
        { flags: '--dry-run', description: '[prune] Only list what would be removed (the default without --yes when stdout is not a terminal, or with --json)' },
        { flags: '--keep-volumes', description: "[remove] Keep the workspace and home volumes (and the services' volumes); [start --rebuild] keep the volumes of services no longer declared" },
        { flags: '--follow', description: '[logs] Keep streaming new output' },
        { flags: '-n, --new-window', description: '[open] Open in a new editor window' },
        { flags: '--auto', description: '[forward] Forward every port the container starts listening on (>= 1024, not in container.forward.ignore)' },
        { flags: '--detach', description: '[forward --auto] Run the forwarder in the background; it exits when the container stops' },
        { flags: '--global', description: '[blueprint init] Write the host copy (~/.kunj/<repo>/blueprint.json) instead of .kunj/blueprint.json' },
        { flags: '-y, --yes', description: '[blueprint init] Accept the inferred blueprint and overwrite an existing file; [prune] remove without asking, also from a script or with --json' },
        { flags: '--no-bundle', description: '[blueprint snapshot] Clone from origin in the container instead of a bundle the host fetched (origin must be public)' },
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
        '  open [branch] [--new-window]         attach the editor (worktree.editorCommand), starting it if stopped',
        '  forward [branch] <port>|<host>:<port>...  forward localhost ports into the container',
        '  forward [branch] <service>:<port>    forward a sidecar service\'s port (e.g. postgres:5432)',
        '  forward [branch] --auto [--detach]   forward each port the container listens on, as it appears',
        '  mcp [branch]                         bridge the host MCP servers of container.mcp (foreground)',
        '  logs [branch] [service] [--follow]   output of the container, or of one of its services',
        '  list                                 containers of this repository (the default)',
        '  stop [branch]                        stop, keeping the workspace',
        '  remove [branch]                      remove, refusing while work is unpushed',
        '  prune [--all] [--dry-run]            remove containers of branches gone from origin, orphans and old images',
        '  file read [branch] <path>            print a file of /workspace',
        '  file write [branch] <path>           write stdin to a file of /workspace (content on stdin)',
        '',
        'Blueprint (how a new container is set up: tools, setup and maintain commands):',
        '  blueprint init [--global] [--yes]    infer one from this checkout and write .kunj/blueprint.json',
        '  blueprint snapshot [--base <ref>]    optional: build the snapshot ahead of time (--rebuild forces it)',
        '  blueprint status                     which blueprint, its hash and snapshot, stale or not',
        '  blueprint remove                     delete this repository\'s snapshot images',
        '',
        'The blueprint is read from .kunj/blueprint.json in this working tree, else',
        'origin/<default branch>:.kunj/blueprint.json, else ~/.kunj/<repo>/blueprint.json. A new',
        'container starts from its snapshot; start builds the snapshot first when there is none or the',
        'blueprint changed (the first start runs setup once), and falls back to running setup in the',
        'container if that fails. --no-snapshot skips the snapshot.',
        '',
        'Services (Postgres, Redis, ...) are declared in the blueprint\'s "services", container.services',
        'or the devcontainer\'s compose file; each runs next to the branch container on its own network',
        'and is reached by its name (postgres:5432). They are stopped and removed with the container.',
        '',
        'agent also starts a background forward --auto for the container (container.forward.auto: false',
        'turns that off). Forwards only ever listen on 127.0.0.1. With container.mcp set (host config,',
        'e.g. {"chrome": {}}), agent also bridges a browser MCP server on this machine into the',
        "container's Claude Code: a fixed set of browser tools, no file paths, downloads refused, and",
        "navigation only to the container's forwarded ports (or container.mcp.chrome.allowOrigins).",
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
        // Always an object here (documented for `kunj ct`): the code is the start/hook code, else the error's jsonCode, else 'error'
        const jsonCode = (error as { jsonCode?: unknown } | null)?.jsonCode;
        const code = error instanceof StartError ? error.code : error instanceof HookError ? 'hook' : typeof jsonCode === 'string' ? jsonCode : 'error';
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
      case 'open':
        return this.open(target, options);
      case 'forward': {
        if (options.auto) return this.autoForward(target, rest, options);
        // `forward 3000` names a port, not a branch
        const specs = isForwardSpec(target) ? [target, ...rest] : rest;
        return this.forward(isForwardSpec(target) ? undefined : target, specs, options);
      }
      case 'mcp':
        return this.mcp(target, options);
      case 'logs':
        return this.logs(target, rest[0], options);
      case 'stop':
        return this.stop(target, options);
      case 'remove':
        return this.remove(target, options);
      case 'prune':
        return this.prune(options);
      case 'blueprint':
        return this.blueprint(target, options);
      case 'file':
        return this.file(target, rest, options);
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

  // Ports of the branch container are tunnelled through its network helper (same network
  // namespace, kunj's own code), never by exec-ing into the branch container: without it, nothing is forwarded
  private async requireHelper(ctx: Context, branch: string): Promise<ContainerInfo> {
    const names = this.names(ctx, branch);
    const found = await ctx.backend.list({ [LABEL.repo]: ctx.repo.id, [LABEL.branch]: branch });
    const helper = found.find(c => c.name === names.helper);
    if (helper?.state !== 'running') {
      throw new ContainerError(`The network helper of ${branch} is not running, so no port can be forwarded; run kunj ct start ${branch}`);
    }
    return helper;
  }

  private recordedOptions(info: ContainerInfo): { firewall?: string; user?: string; imageKind?: string; blueprintHash?: string; dind?: string } {
    return optionsLabel(info.labels);
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
    return isMain(c);
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
    const result = await this.startOrResume(ctx, branch, options);

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
    if (result.services?.length) console.log(`  services  ${result.services.join(', ')} (reach them by name from the container)`);
    if (result.dind) console.log(`  docker    ${result.dind} (dockerd inside the container)`);
    console.log('');
    console.log(`Next: kunj ct agent ${branch}`);
    console.log(`      kunj ct shell ${branch}`);
  }

  /** Creates or resumes the branch's container, with the create hooks and the snapshot; `start` and `open` share it. */
  private async startOrResume(ctx: Context, branch: string, options: ContainerOptions): Promise<StartResult> {
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
    // Docker-in-Docker that cannot or must not run here is refused before the hook, the snapshot and the push
    if (willCreate) await precheckDind(ctx.backend, config.container, { imageOverride: options.image });
    if (willCreate) await runActionHook('pre-container-create', { branch, container: names.container, image: '' }, hookOptions);

    // Asked here (the snapshot) and by startContainer (the hash, a devcontainer build): one git call
    let defaultBranchAsked: Promise<string | undefined> | undefined;
    const defaultBranch = () =>
      (defaultBranchAsked ??= detectDefaultBranch(ctx.repo.root).then(b => b?.replace(/^origin\//, '') || undefined));
    const worktreeRoot = await getGitRoot().catch(() => undefined);

    // A new container from a blueprint starts from its snapshot, built here when there is none for the
    // current hash. Resuming never builds; --image never uses a snapshot.
    let blueprint: ResolvedBlueprint | null | undefined;
    let snapshotHandled = false;
    if (willCreate && options.snapshot !== false && !options.image) {
      try {
        blueprint = await resolveBlueprint({ cwd: process.cwd(), repoRoot: worktreeRoot, repoKunjDir: getKunjDir(), defaultBranch: await defaultBranch() });
      } catch {
        blueprint = undefined; // startContainer resolves it again and reports the error as a failed start
      }
      if (blueprint) snapshotHandled = await this.ensureStartSnapshot(ctx, blueprint, await defaultBranch());
    }

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
      keepVolumes: !!options.keepVolumes,
      confirmPush: () => this.confirmPush(branch),
      warn: this.warn,
      defaultBranch,
      noSnapshot: options.snapshot === false,
      snapshotHandled,
      worktreeRoot,
      ...(blueprint !== undefined ? { blueprint } : {}),
    });

    if (result.created) {
      await runActionHook('post-container-create', { branch, container: names.container, image: result.image }, hookOptions);
    }
    return result;
  }

  /** Builds a missing or stale snapshot before a start; true when the start's hints are covered. */
  private async ensureStartSnapshot(ctx: Context, blueprint: ResolvedBlueprint, defaultBranch: string | undefined): Promise<boolean> {
    if (!defaultBranch) {
      this.warn('cannot detect the default branch; the blueprint snapshot is not built');
      return false;
    }
    const ensured = await ensureSnapshot(ctx.backend, {
      ...this.snapshotInput(ctx, defaultBranch, blueprint, this.warn),
      log: m => this.progress(chalk.gray(m)),
      stale: 'rebuild',
    });
    if (ensured.failed) {
      this.warn(
        ensured.stale
          ? `Blueprint snapshot could not be rebuilt (${ensured.failed}); starting from the stale snapshot`
          : `Blueprint snapshot could not be built (${ensured.failed}); running tools and setup in the container instead`
      );
    }
    return true;
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
    if (ctx.config.container?.forward?.auto !== false && ctx.backend.features.localPorts && !forwarderFor(main)) {
      // The same checks as the foreground command: a detached forwarder's failure would go unseen
      const problem = await this.forwarderProblem(ctx, branch);
      if (problem) {
        this.warn(`Not forwarding ports: ${problem}`);
      } else {
        try {
          this.startForwarder(ctx, branch, main);
        } catch (err) {
          this.warn(`Could not start the port forwarder: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    await this.ensureBridge(ctx, branch, main);
    const user = this.userOf(main) || undefined;
    const command = agentCommandLine(ctx.config.container?.agentCommand, args);
    const probe = await ctx.backend.exec(main.id, ['sh', '-c', 'command -v tmux'], { user });
    if (probe.exitCode !== 0) {
      this.warn('tmux is not installed in the container; running the agent directly (it stops when you leave)');
    }
    // tmux runs a single command argument through the shell, so the setting keeps its quoting
    // -u: UTF-8 even when the image has no locale, so box-drawing glyphs render
    // window-size latest: an IDE terminal and a CLI one attached together follow the one used last, not the smaller
    const argv = probe.exitCode === 0
      ? ['tmux', '-u', 'new-session', '-A', '-s', 'agent', command, ';', 'set-option', '-t', 'agent', 'window-size', 'latest']
      : ['sh', '-lc', command];
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

  // ---------------------------------------------------------------------
  // open
  // ---------------------------------------------------------------------

  private async open(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const names = this.names(ctx, branch);
    const found = await ctx.backend.list({ [LABEL.repo]: ctx.repo.id, [LABEL.branch]: branch });
    const main = found.find(c => c.name === names.container);
    if (!main) throw new ContainerError(`No container for ${branch}; run kunj ct start ${branch}`);
    // Only resumed: start's --rebuild, --create, --image and --publish never apply to open. Also when
    // just the helper (or an out-of-date one) or a service is down, so the editor finds it all up.
    if (needsResume(found, names, getVersion())) {
      await this.startOrResume(ctx, branch, { hooks: options.hooks, context: options.context, json: options.json });
    }

    const editor = (ctx.config.worktree?.editorCommand ?? 'code').trim();
    if (!editor) throw new ContainerError('worktree.editorCommand is empty; set it to the editor to open');
    const user = this.userOf(main);
    if (ctx.config.container?.network?.allow?.length) {
      this.warn(
        'Firewall allowlist mode: the editor installs its server and extensions from the VS Code update and ' +
          'marketplace domains; add them to container.network.allow if the editor cannot connect'
      );
    }

    // Lazy: worktree.ts is not needed by the other actions
    const { isVSCodeLike, openWorktree } = await import('../lib/worktree');
    if (!isVSCodeLike(editor)) {
      const execLine = [
        'docker',
        ...(ctx.dockerContext ? ['--context', ctx.dockerContext] : []),
        'exec', '-it',
        ...(user ? ['-u', user] : []),
        '-w', WORKSPACE, main.name, 'sh', '-lc', shellQuote(SHELL),
      ].join(' ');
      if (this.jsonMode) {
        this.outputJSON({ success: true, branch, name: main.name, editor, uri: null, exec: execLine });
        return;
      }
      console.log(`${editor} cannot attach to a container; open a shell in it with:`);
      console.log(`  ${execLine}`);
      return;
    }

    if (ctx.dockerContext) {
      this.warn(`The editor finds the container through its own Docker context, not --context ${ctx.dockerContext}`);
    }
    this.writeEditorImageConfig(editor, main.image, user);
    const uri = attachedContainerUri(main.name, WORKSPACE);
    const opened = await openWorktree(editor, ['--folder-uri', uri], { newWindow: !!options.newWindow });
    if (!opened) throw new ContainerError(`Could not run ${editor}`);

    if (this.jsonMode) {
      this.outputJSON({ success: true, branch, name: main.name, editor, uri, warning: EDITOR_CREDENTIALS_WARNING });
      return;
    }
    this.warn(EDITOR_CREDENTIALS_WARNING);
    console.log(chalk.green(`✓ Opened ${main.name} in ${editor}`));
  }

  // The Dev Containers extension takes the user and folder of an attached container from its image's
  // config. Written for each editor that is installed (its User dir exists), and always for this one.
  private writeEditorImageConfig(editor: string, image: string, user: string): void {
    const dirs = imageConfigPaths(os.homedir(), process.platform);
    const mine = path.basename(editor.split(/\s+/)[0]) === 'cursor' ? 1 : 0;
    dirs.forEach((dir, i) => {
      const userDir = path.dirname(path.dirname(path.dirname(dir)));
      if (i !== mine && !fs.existsSync(userDir)) return;
      try {
        writeImageConfig(dir, image, { ...(user ? { remoteUser: user } : {}), workspaceFolder: WORKSPACE });
      } catch (err) {
        this.warn(`Could not write the editor's container config in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
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
    if (specTexts.length === 0) throw new ContainerError('Usage: kunj ct forward [branch] <port>|<hostPort>:<port>|<service>:<port>...');
    const specs = specTexts.map(text => {
      const svc = PORT_SPEC.test(text) ? null : SERVICE_SPEC.exec(text);
      return svc ? { service: svc[1], ...parseForwardSpec(svc[2]) } : { service: undefined, ...parseForwardSpec(text) };
    });
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const helper = specs.some(s => !s.service) ? await this.requireHelper(ctx, branch) : undefined;
    if (helper && (await ctx.backend.exec(helper.id, ['sh', '-c', 'command -v socat'])).exitCode !== 0) {
      throw new ContainerError(HELPER_NO_SOCAT);
    }

    // A service is tunnelled into through its own container, with whichever of socat, bash or nc it has
    const services = specs.some(s => s.service) ? await findServices(ctx.backend, this.names(ctx, branch), { repoId: ctx.repo.id, branch }) : [];
    const tunnels = new Map<string, { id: string; tool: 'socat' | 'bash' | 'nc' }>();
    for (const name of new Set(specs.map(s => s.service).filter((s): s is string => !!s))) {
      const svc = services.find(c => c.name === serviceNames(this.names(ctx, branch), name).container);
      if (!svc) throw new ContainerError(`${branch} has no service ${name}; services: ${describeServices(services).map(s => s.name).join(', ') || 'none'}`);
      if (svc.state !== 'running') throw new ContainerError(`Service ${name} is not running; run kunj ct start ${branch}`);
      const tool = parseTunnelProbe((await ctx.backend.exec(svc.id, ['sh', '-c', TUNNEL_PROBE])).stdout);
      if (!tool) {
        throw new ContainerError(
          `The ${name} image has none of socat, bash or nc, so its port cannot be tunnelled; ` +
            `reach it from the branch container instead (kunj ct exec ${branch} -- ...), or run a forwarder there`
        );
      }
      tunnels.set(name, { id: svc.id, tool });
    }

    const forwarders: Array<{ container: number; service?: string; forwarder: Forwarder }> = [];
    try {
      for (const spec of specs) {
        const tunnel = spec.service ? tunnels.get(spec.service)! : undefined;
        const forwarder = tunnel
          ? await forwardPort(ctx.backend, tunnel.id, spec, { hasSocat: false, tool: tunnel.tool })
          : await forwardPort(ctx.backend, helper!.id, spec, { hasSocat: true });
        forwarders.push({ container: spec.container, ...(spec.service ? { service: spec.service } : {}), forwarder });
      }
    } catch (error) {
      await Promise.all(forwarders.map(f => f.forwarder.close()));
      throw error;
    }

    const list = forwarders.map(f => ({ container: f.container, host: f.forwarder.hostPort, ...(f.service ? { service: f.service } : {}) }));
    // Registered under this process, as --auto's are, so `list` and the IDE see them
    const pid = process.pid;
    const record = () =>
      updateForwards(rs => [
        ...rs.filter(r => r.pid !== pid),
        ...list.map(f => ({ ...forwarderRecord(pid, main, f.container, f.host), ...(f.service ? { service: f.service } : {}) })),
      ]);
    try {
      record();
    } catch (err) {
      this.warn(`Could not record the forwards: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.jsonMode) {
      this.outputJSON({ forwards: list });
    } else {
      for (const f of list) console.log(`localhost:${f.host} → ${f.service ?? ''}:${f.container}`);
      console.log(chalk.gray('Forwarding; press Ctrl-C to stop'));
    }

    await new Promise<void>(resolve => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        try {
          updateForwards(rs => rs.filter(r => r.pid !== pid));
        } catch {
          // a dead pid's entries are pruned on the next read anyway
        }
        Promise.all(forwarders.map(f => f.forwarder.close())).then(() => resolve(), () => resolve());
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    process.exit(0);
  }

  // Why a forwarder could not work, if it could not: the network helper must run and have socat
  private async forwarderProblem(ctx: Context, branch: string): Promise<string | undefined> {
    try {
      const helper = await this.requireHelper(ctx, branch);
      if ((await ctx.backend.exec(helper.id, ['sh', '-c', 'command -v socat'])).exitCode !== 0) return HELPER_NO_SOCAT;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return undefined;
  }

  // `forward --auto --detach` in a background kunj, registered at once (port 0 marks the forwarder)
  // so a second agent sees it before the child has written anything itself
  private startForwarder(ctx: Context, branch: string, main: ContainerInfo): number {
    const pid = spawnDetached(['ct', 'forward', branch, '--auto', ...(ctx.dockerContext ? ['--context', ctx.dockerContext] : [])], detachedLogFile(main.name, 'forward'));
    updateForwards(rs => [...rs.filter(r => r.pid !== pid), forwarderRecord(pid, main, 0, 0)]);
    return pid;
  }

  private async autoForward(target: string | undefined, rest: string[], options: ContainerOptions): Promise<void> {
    if (rest.length > 0 || isForwardSpec(target)) {
      throw new ContainerError('forward --auto takes no ports; it forwards whatever listens in the container');
    }
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const helper = await this.requireHelper(ctx, branch);

    if (options.detach) {
      const pid = this.startForwarder(ctx, branch, main);
      if (this.jsonMode) {
        this.outputJSON({ success: true, branch, pid });
      } else {
        console.log(chalk.green(`✓ Forwarding ports of ${branch} in the background (pid ${pid})`));
      }
      return;
    }

    const pid = process.pid;
    const others = (rs: ForwardRecord[]) => rs.filter(r => r.pid !== pid);
    const live = new Map<number, number>(); // container port -> host port
    // Ports published with `start -p` are reachable already
    const ignore = autoForwardIgnore(ctx.config.container?.forward?.ignore, main.ports);
    updateForwards(rs => [...others(rs), forwarderRecord(pid, main, 0, 0)]);
    if (!this.jsonMode) console.log(chalk.gray(`Forwarding the ports ${branch} listens on; press Ctrl-C to stop`));

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      await runAutoForward(ctx.backend, { main: main.id, helper: helper.id }, {
        ignore,
        signal: controller.signal,
        onError: this.warn,
        onChange: change => {
          if (change.event === 'add') live.set(change.port, change.hostPort);
          else live.delete(change.port);
          try {
            // All of this forwarder's entries from memory, so each write also repairs an update
            // another forwarder's concurrent write may have lost
            updateForwards(rs => [
              ...others(rs),
              forwarderRecord(pid, main, 0, 0),
              ...[...live].map(([port, hostPort]) => forwarderRecord(pid, main, port, hostPort)),
            ]);
          } catch (err) {
            // the forward itself works; only `list` will not show it
            this.warn(`Could not record the forward: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (this.jsonMode) {
            process.stdout.write(JSON.stringify(change) + '\n');
          } else if (change.event === 'add') {
            console.log(chalk.green(`+ localhost:${change.hostPort} → ${change.port}`));
          } else {
            console.log(chalk.gray(`- localhost:${change.hostPort} → ${change.port} (closed)`));
          }
        },
      });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      updateForwards(others);
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------
  // mcp
  // ---------------------------------------------------------------------

  // The container's Claude Code config first (so the agent sees the entry), then a detached
  // `ct mcp` unless one already runs, registered at once like the forwarder. Nothing without container.mcp.
  private async ensureBridge(ctx: Context, branch: string, main: ContainerInfo): Promise<void> {
    const servers = mcpServers(ctx.config.container?.mcp, this.warn);
    if (servers.length === 0) return;
    try {
      await installMcpConfig(ctx.backend, main.id, this.userOf(main), servers.map(s => s.name));
    } catch (err) {
      this.warn(`Could not add the MCP servers to the container's Claude Code config: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (bridgeFor(main.name)) return;
    try {
      const pid = spawnDetached(['ct', 'mcp', branch, ...(ctx.dockerContext ? ['--context', ctx.dockerContext] : [])], detachedLogFile(main.name, 'mcp'));
      updateBridges(rs => [...rs.filter(r => r.pid !== pid), ...servers.map(s => ({ pid, container: main.name, name: s.name }))]);
    } catch (err) {
      this.warn(`Could not start the MCP bridge: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async mcp(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireRunning(ctx, branch);
    const servers = mcpServers(ctx.config.container?.mcp, this.warn);
    if (servers.length === 0) {
      throw new ContainerError('container.mcp has no server to bridge; set it in the host config, e.g. {"chrome": {}}');
    }
    const pid = process.pid;
    const other = bridgeFor(main.name, undefined, pid);
    if (other) throw new ContainerError(`An MCP bridge for ${branch} is already running (pid ${other})`);

    const user = this.userOf(main);
    try {
      await installMcpConfig(ctx.backend, main.id, user, servers.map(s => s.name));
    } catch (err) {
      this.warn(`Could not add the MCP servers to the container's Claude Code config: ${err instanceof Error ? err.message : String(err)}`);
    }
    const others = (rs: BridgeRecord[]) => rs.filter(r => r.pid !== pid);
    updateBridges(rs => [...others(rs), ...servers.map(s => ({ pid, container: main.name, name: s.name }))]);
    this.progress(chalk.gray(`Bridging ${servers.map(s => s.name).join(', ')} into ${branch} (one session at a time); press Ctrl-C to stop`));

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // A closed terminal too: the bridge stops and its temp profile is removed
    process.on('SIGHUP', stop);
    // The container's forwarded and published ports, read at every check: what the browser may open
    // by default, and what the agent is told when it connects
    const ports = () => [
      ...readForwards().filter(r => r.port > 0 && recordIsFor(r, main)).map(r => ({ port: r.port, hostPort: r.hostPort })),
      ...main.ports.map(p => ({ port: p.container, hostPort: p.host })),
    ];
    try {
      await Promise.all(
        servers.map(s =>
          runBridge(ctx.backend, main.id, s.name, s.cfg, {
            user,
            signal: controller.signal,
            forwardedPorts: () => ports().map(p => p.hostPort),
            instructions: () => portHint(ports()),
            log: m => this.progress(chalk.gray(m)),
          }).catch(err => {
            this.warn(`MCP ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
          })
        )
      );
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      updateBridges(others);
    }
    process.exit(process.exitCode ?? 0);
  }

  // ---------------------------------------------------------------------
  // logs
  // ---------------------------------------------------------------------

  private async logs(target: string | undefined, service: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireMain(ctx, branch);
    let id = main.id;
    if (service) {
      const services = await findServices(ctx.backend, this.names(ctx, branch), { repoId: ctx.repo.id, branch });
      const svc = services.find(c => c.name === serviceNames(this.names(ctx, branch), service).container);
      if (!svc) throw new ContainerError(`${branch} has no service ${service}; services: ${describeServices(services).map(s => s.name).join(', ') || 'none'}`);
      id = svc.id;
    }
    if (this.jsonMode) {
      // One NDJSON object per line; service is null for the branch container itself
      await ctx.backend.logs(id, {
        follow: !!options.follow,
        onLine: (stream, line) => process.stdout.write(JSON.stringify({ service: service ?? null, stream, line }) + '\n'),
      });
      return;
    }
    await ctx.backend.logs(id, { follow: !!options.follow });
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  private async list(options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const commonDir = getRepoCommonDir();
    if (commonDir) recordRepo(commonDir);

    const repoFilter: Record<string, string> = options.all ? {} : { [LABEL.repo]: ctx.repo.id };
    let all = await ctx.backend.list(repoFilter);
    if (options.all) all = all.filter(c => c.labels[LABEL.repo]);
    // Started now, awaited after the status execs: they do not depend on each other
    const leftovers = Promise.all([ctx.backend.listVolumes(repoFilter), ctx.backend.listNetworks(repoFilter)]);
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

    const [volumes, networks] = await leftovers;
    const orphans = findOrphans(all, volumes, networks);
    const forwards = readForwards().filter(r => r.port > 0);
    const bridges = readBridges();
    const containers: ContainerJson[] = mains.map((c, i) => {
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
        dind: recorded.dind || 'off',
        ports: [
          ...c.ports.map(p => ({ container: p.container, host: p.host, kind: 'publish' as const })),
          ...forwards.filter(r => recordIsFor(r, c)).map(r => ({ container: r.port, host: r.hostPort, kind: 'forward' as const, pid: r.pid, ...(r.service ? { service: r.service } : {}) })),
        ],
        agent: { running: s.agentRunning },
        workspace: { head: s.head ? s.head.slice(0, 7) : null, ahead: s.ahead, dirty: s.dirty },
        status: s.status,
        services: describeServices(servicesOf(all, c.name, { repoId: c.labels[LABEL.repo] ?? '', branch: c.labels[LABEL.branch] ?? '' })),
        bridges: bridges.filter(b => b.container === c.name).map(b => ({ name: b.name, pid: b.pid })),
      };
    });

    if (this.jsonMode) {
      this.outputJSON({
        repo: ctx.repo.name,
        backend: { kind: 'docker', context: ctx.dockerContext || 'default' },
        containers,
        orphans,
      } satisfies ContainerListJson);
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
      if (c.dind !== 'off') line += chalk.magenta(`  [dind ${c.dind}]`);
      if (c.agent.running) line += chalk.cyan('  [agent]');
      if (c.workspace.ahead) line += chalk.cyan(`  +${c.workspace.ahead} ahead`);
      if (c.workspace.dirty) line += chalk.yellow('  dirty');
      if (c.status === 'timeout' || c.status === 'error') line += chalk.red(`  status ${c.status}`);
      if (c.bridges.length) line += chalk.cyan(`  [mcp ${c.bridges.map(b => b.name).join(' ')}]`);
      if (c.ports.length) line += '  ' + c.ports.map(p => `${p.host}→${p.container}`).join(' ');
      if (c.services.length) {
        line += '  ' + c.services.map(svc => (svc.state === 'running' ? chalk.cyan(svc.name) : chalk.yellow(`${svc.name} ${svc.state}`))).join(' ');
      }
      const helper = helpers.get(`${mains[i].name}-net-helper`);
      if (running && helper?.state !== 'running') line += chalk.red('  [firewall helper down]');
      console.log(line);
    });
    if (orphans.length) {
      console.log(chalk.yellow(`orphans: ${orphans.length} (${orphans.map(o => o.name).join(', ')}); run kunj ct prune`));
    }
    console.log('');
    console.log(chalk.gray("Tip: Use 'kunj ct start <branch>' to start a container"));
  }

  // ---------------------------------------------------------------------
  // file
  // ---------------------------------------------------------------------

  // `file read <path>` (current branch) or `file read <branch> <path>`; same for write
  private async file(sub: string | undefined, args: string[], options: ContainerOptions): Promise<void> {
    if (sub !== 'read' && sub !== 'write') {
      throw new ContainerError(`Unknown file action '${sub ?? ''}'. Expected one of: ${FILE_ACTIONS.join(', ')}`);
    }
    if (args.length < 1 || args.length > 2) throw new ContainerError(`Usage: kunj ct file ${sub} [branch] <path>`);
    const relPath = validateWorkspacePath(args[args.length - 1]);
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, args.length === 2 ? args[0] : undefined);
    const main = await this.requireRunning(ctx, branch);
    const user = this.userOf(main) || undefined;
    if (sub === 'read') {
      const content = await readWorkspaceFile(ctx.backend, main.id, relPath, user);
      if (this.jsonMode) this.outputJSON({ path: relPath, content } satisfies FileReadJson);
      else process.stdout.write(content);
      return;
    }
    await writeWorkspaceFile(ctx.backend, main.id, relPath, process.stdin, user);
    if (this.jsonMode) this.outputJSON({ success: true, path: relPath } satisfies FileWriteJson);
    else console.log(chalk.green(`✓ wrote ${relPath}`));
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

  // Resolved as a start resolves it: --blueprint, the working tree, origin/<default branch>, the host copy
  private async resolveBlueprint(options: ContainerOptions, defaultBranch: string | undefined): Promise<ResolvedBlueprint | null> {
    const repoRoot = await getGitRoot().catch(() => undefined);
    return resolveBlueprint({ cwd: process.cwd(), repoRoot, repoKunjDir: getKunjDir(), defaultBranch, override: options.blueprint });
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
    const exists = fs.existsSync(file);

    if (exists && !options.yes) {
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

    // Notes are written by hand and never inferred, so an overwrite keeps them
    let notes: string | undefined;
    let hadServices = false;
    if (exists) {
      try {
        const old = parseBlueprint(fs.readFileSync(file, 'utf8'), file);
        notes = old.notes;
        hadServices = !!old.services?.length;
      } catch {
        // an unreadable or invalid file has nothing worth keeping
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
      ...(notes !== undefined ? { notes } : {}),
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
    console.log('');
    console.log(
      options.global
        ? 'Next: kunj ct start <branch> builds the snapshot on first use'
        : `Next: commit ${BLUEPRINT_PATH}; kunj ct start <branch> builds the snapshot on first use`
    );
    if (hadServices || loadConfig().container?.services) {
      console.log(chalk.gray('Migrations against services belong in maintain, safe to run again: setup runs only for the snapshot, against its throwaway services'));
    }
  }

  private async blueprintSnapshot(options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const defaultBranch = (await detectDefaultBranch(ctx.repo.root)) || undefined;
    const branch = (options.base || defaultBranch)?.replace(/^origin\//, '');
    if (!branch) throw new ContainerError('cannot detect the default branch; pass --base');
    // The blueprint a start would use, so the snapshot's hash matches the starts that look for it
    const resolved = await this.resolveBlueprint(options, defaultBranch || branch);
    if (!resolved) {
      throw new ContainerError('No blueprint; run kunj ct blueprint init');
    }

    this.progress(chalk.blue(`Snapshotting the blueprint (${resolved.path}) from ${branch}...`));
    const result = await snapshotBlueprint(ctx.backend, {
      ...this.snapshotInput(ctx, branch, resolved, this.warn),
      rebuild: !!options.rebuild,
      log: m => this.progress(chalk.gray(m)),
      noBundle: options.bundle === false,
    });

    if (this.jsonMode) {
      this.outputJSON(result);
      return;
    }
    const from = (result.ref ? ` from ${result.ref.slice(0, 7)}` : '') + (result.viaBundle ? ' (from a host bundle)' : '');
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
      console.log(`  snapshot  ${chalk.yellow(`stale (${others.map(i => i.tag).join(', ')})`)}; the next kunj ct start rebuilds it`);
    } else {
      console.log(`  snapshot  ${chalk.gray('none')}; the next kunj ct start builds it`);
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
  // prune
  // ---------------------------------------------------------------------

  // Two passes: plan every repository, confirm once, then apply. Each repository is planned and
  // applied from its own directory, because the config, repo name and blueprint come from the cwd.
  // Only --yes (or a confirmation) is consent: --force skips the guard and nothing else.
  private async prune(options: ContainerOptions): Promise<void> {
    const dryRun = !!options.dryRun || (!options.yes && (this.jsonMode || !process.stdout.isTTY));
    const startDir = process.cwd();
    const roots: Array<string | null> = options.all ? listRepos().filter(r => r.exists).map(r => r.root) : [null];
    const runs: Array<{ root: string | null; ctx: Context; plan: PrunePlan }> = [];
    const enter = (root: string | null) => {
      if (!root) return;
      process.chdir(root);
      resetRepoCache();
    };

    try {
      for (const root of roots) {
        enter(root);
        let ctx: Context;
        try {
          ctx = await this.context(options);
        } catch (err) {
          if (!root) throw err;
          this.warn(`Skipping ${root}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        this.progress(chalk.gray(`Planning ${ctx.repo.name}...`));
        const plan = await planPrune(ctx.backend, {
          repoId: ctx.repo.id,
          repoName: ctx.repo.name,
          cwd: ctx.repo.root,
          kunjVersion: getVersion(),
          allowPrivileged: ctx.config.container?.allowPrivileged === true,
          pruneAfterDays: ctx.config.container?.pruneAfterDays,
          force: !!options.force,
          currentBlueprintHash: () => this.currentHash(ctx),
          kunjImages: runs.length === 0,
        });
        runs.push({ root, ctx, plan });
      }

      const merged = mergePlans(runs.map(r => r.plan));
      const count = removalCount(merged);
      if (!this.jsonMode) this.printPrunePlan(runs, dryRun);

      let removed: string[] = [];
      let failed: string[] = [];
      let apply = !dryRun && count > 0;
      // Not a dry run and no --yes: a terminal and no --json, so there is someone to ask
      if (apply && !options.yes) {
        const inquirer = (await import('inquirer')).default;
        const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: `Remove ${count} object${count === 1 ? '' : 's'}?`, default: false }]);
        apply = ok;
        if (!ok) console.log(chalk.gray('Nothing removed'));
      }
      if (apply) {
        for (const run of runs) {
          if (removalCount(run.plan) === 0) continue;
          enter(run.root);
          const hookOptions = { hooks: run.ctx.config.hooks, jsonMode: this.jsonMode, skip: options.hooks === false };
          const result = await applyPrune(run.ctx.backend, run.plan, {
            repoId: run.ctx.repo.id,
            kunjVersion: getVersion(),
            allowPrivileged: run.ctx.config.container?.allowPrivileged === true,
            force: !!options.force,
            hook: async (name, values) => {
              await runActionHook(name, values, hookOptions);
            },
          });
          removed = removed.concat(result.removed);
          failed = failed.concat(result.failed);
        }
      }

      if (this.jsonMode) {
        this.outputJSON({ success: failed.length === 0, dryRun, plan: merged, removed, failed });
        return;
      }
      if (apply) {
        console.log(chalk.green(`✓ Removed ${removed.length} object${removed.length === 1 ? '' : 's'}`));
        for (const f of failed) console.error(chalk.red(`✗ ${f}`));
        if (failed.length) process.exitCode = 1;
      } else if (dryRun && count > 0) {
        const how = options.dryRun ? 'without --dry-run' : 'in a terminal, or with --yes,';
        console.log(chalk.gray(`Dry run: nothing removed. Run kunj ct prune${options.all ? ' --all' : ''} ${how} to remove these.`));
      }
    } finally {
      if (options.all) {
        process.chdir(startDir);
        resetRepoCache();
      }
    }
  }

  private printPrunePlan(runs: Array<{ ctx: Context; plan: PrunePlan }>, dryRun: boolean): void {
    for (const { ctx, plan } of runs) {
      console.log(chalk.blue(`Prune ${ctx.repo.name}${dryRun ? ' (dry run)' : ''}:`));
      for (const w of plan.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
      if (removalCount(plan) === 0 && !plan.containers.length && !plan.orphans.length) console.log(chalk.gray('  nothing to prune'));
      for (const c of plan.containers) {
        const why = c.reason === 'snapshot-leftover' ? 'leftover of a snapshot build' : c.reason === 'branch-gone' ? `branch ${c.branch} is gone from origin` : `stopped, created over ${ctx.config.container?.pruneAfterDays} days ago`;
        if (c.kept) console.log(`  ${chalk.yellow('keep  ')} ${c.names.container}  ${chalk.gray(`${why}, but: ${c.kept}`)}`);
        else console.log(`  ${chalk.red('remove')} ${c.names.container}  ${chalk.gray(why)}`);
      }
      for (const o of plan.orphans) {
        if (o.kept) console.log(`  ${chalk.yellow('keep  ')} ${o.kind} ${o.name}  ${chalk.gray(o.kept)}`);
        else console.log(`  ${chalk.red('remove')} ${o.kind} ${o.name}  ${chalk.gray('orphan: its branch container is gone')}`);
      }
      for (const tag of plan.images) console.log(`  ${chalk.red('remove')} image ${tag}`);
      if (plan.images.length) console.log(chalk.gray(`  images: ${megabytes(plan.bytes)} MB`));
    }
  }

  // ---------------------------------------------------------------------
  // stop / remove
  // ---------------------------------------------------------------------

  private async stop(target: string | undefined, options: ContainerOptions): Promise<void> {
    const ctx = await this.context(options);
    const branch = await this.resolveBranch(ctx, target);
    const main = await this.requireMain(ctx, branch);
    await stopContainer(ctx.backend, this.names(ctx, branch), this.warn);
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
    const removeCtx = { user: this.userOf(main), kunjVersion: getVersion(), allowPrivileged: ctx.config.container?.allowPrivileged === true, warn: this.warn };

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

function forwarderRecord(pid: number, main: ContainerInfo, port: number, hostPort: number): ForwardRecord {
  return { pid, container: main.name, containerId: main.id, port, hostPort, kind: 'forward' };
}
