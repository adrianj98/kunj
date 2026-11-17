// kunj machine: the cloud machines of this repository, one per branch session, through a coordinator
// (docs/specs/cloud-machines.md). The coordinator is the remote --remote or container.remote names
// when it runs kunj serve --machines, else the local one kunj starts when machine.provider is set.
//
//   kunj machine list [--all] [--json]
//   kunj machine status [branch] [--json]
//   kunj machine create [branch] [--size <s>] [--json]
//   kunj machine suspend|resume|stop|start [branch] [--json]
//   kunj machine delete [branch] [--yes] [--keep-disks] [--json]
//   kunj machine image [list|build|delete <name>] [--no-snapshot] [--json]
//   kunj machine providers [--json]
//   kunj machine coordinator [status|stop] [--json]
//
// On the fast path (src/commands/fast.ts): keep top-level imports light.

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadResolvedConfig } from '../lib/config';
import { getCurrentBranch } from '../lib/git';
import type { CoordinatorAccess, ResolveOptions } from '../lib/machines/local-coordinator';
import type { MachineJson, MachineListJson, MachineJsonResult, MachineProvidersJson, CoordinatorStatusJson, MachineImageListJson, MachineImageBuildJson } from '../lib/json-types';
import { IMAGE_BUILD_BRANCH, MachineError } from '../lib/machines/provider';

interface MachineOptions {
  json?: boolean;
  remote?: string;
  all?: boolean;
  size?: string;
  yes?: boolean;
  keepDisks?: boolean;
  /** --no-snapshot */
  snapshot?: boolean;
}

export interface MachineCommandDeps {
  /** How the coordinator is reached (default resolveCoordinator) */
  coordinator?: (opts: ResolveOptions) => Promise<CoordinatorAccess>;
  /** The repository (default: this checkout's) */
  repo?: () => { id: string; name: string };
  branch?: () => Promise<string>;
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Builds the blueprint snapshot on the builder machine (default: this kunj's
   * `ct blueprint snapshot --remote <remote> --machine <builder branch>`); resolves to its exit code
   */
  snapshot?: (remote: string, branch: string) => Promise<number>;
  /** ~/.kunj/coordinator (tests) */
  coordinatorDir?: string;
}

const ACTIONS = ['list', 'status', 'create', 'suspend', 'resume', 'stop', 'start', 'delete', 'image', 'providers', 'coordinator'];

const STATE_COLOR: Record<string, (s: string) => string> = {
  running: chalk.green,
  suspended: chalk.blue,
  stopped: chalk.gray,
  provisioning: chalk.yellow,
  suspending: chalk.yellow,
  stopping: chalk.yellow,
};

function line(m: MachineJson): string {
  const state = (STATE_COLOR[m.state] ?? ((s: string) => s))(m.state.padEnd(11));
  return `${state} ${m.branch.padEnd(30)} ${chalk.gray(m.name)}  ${m.size}${m.owner ? chalk.gray(`  by ${m.owner}`) : ''}${m.paired ? '' : chalk.red('  (no token)')}`;
}

export class MachineCommand extends BaseCommand {
  constructor(private readonly deps: MachineCommandDeps = {}) {
    super({
      name: 'machine',
      description: 'Cloud machines that run branch containers, one per branch session',
      arguments: '[action] [branch] [name]',
      options: [
        { flags: '--remote <name>', description: 'The coordinator: a remote running kunj serve --machines (local: the one kunj starts here)' },
        { flags: '--all', description: '[list] Every machine of the coordinator, not only this repository\'s' },
        { flags: '--size <size>', description: '[create] small, medium, large or a provider shape (default machine.size)' },
        { flags: '-y, --yes', description: '[delete] Do not ask' },
        { flags: '--keep-disks', description: '[delete] Keep the machine\'s disks' },
        { flags: '--no-snapshot', description: '[image build] Do not build the blueprint snapshot into the image' },
      ],
      helpText: [
        'Actions:',
        '  list (default)              this repository\'s machines, any state',
        '  status [branch]             the branch\'s machine (the current branch by default)',
        '  create [branch]             make the branch\'s machine and wait until its kunj serve answers',
        '  suspend|resume|stop|start [branch]',
        '  delete [branch]             delete the machine and its disks (the branch is on origin)',
        '  image [list]                this repository\'s golden images; new machines boot the newest',
        '  image build                 bake one: a builder machine installs everything and builds the blueprint',
        '                              snapshot, its disk becomes the image, older images are deleted',
        '  image delete <name>',
        '  providers                   the coordinator\'s provider, its sizes and features',
        '  coordinator [status|stop]   the local coordinator kunj started on this machine',
        '',
        'Machines are created by a coordinator, kunj serve --machines: the remote that --remote or container.remote',
        'names, or a local one kunj starts on its own when machine.provider is set here (machine.gce for Google Cloud).',
        'Design: docs/specs/cloud-machines.md.',
      ].join('\n'),
    });
  }

  private async repo(): Promise<{ id: string; name: string }> {
    if (this.deps.repo) return this.deps.repo();
    const { repoIdentity } = await import('../lib/repo-identity');
    const r = repoIdentity();
    return { id: r.id, name: r.name };
  }

  private async branchOf(target: string | undefined): Promise<string> {
    if (target) return target;
    const current = await (this.deps.branch ?? getCurrentBranch)().catch(() => '');
    if (!current) throw new MachineError('No branch given, and this checkout is not on a branch. Name it: kunj machine <action> <branch>.', 'machine-not-found');
    return current;
  }

  private async confirm(message: string): Promise<boolean> {
    if (this.deps.confirm) return this.deps.confirm(message);
    if (!process.stdin.isTTY) return false;
    const inquirer = (await import('inquirer')).default;
    const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: false }]);
    return ok;
  }

  async execute(action?: any, branch?: any, name?: any, options?: any): Promise<void> {
    const args: unknown[] = [action, branch, name, options];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object');
    const opts = (optIndex === -1 ? {} : args[optIndex]) as MachineOptions;
    const positionals = (optIndex === -1 ? args : args.slice(0, optIndex)).filter((a): a is string => typeof a === 'string');
    if (opts.json) this.jsonMode = true;
    const verb = (positionals[0] || 'list').toLowerCase();
    const target = positionals[1];
    if (!ACTIONS.includes(verb)) throw new MachineError(`Unknown machine action '${verb}'. Use one of: ${ACTIONS.join(', ')} (see kunj machine --help).`, 'machine-not-found');

    if (verb === 'coordinator') return this.coordinatorAction(target ?? 'status');

    const config = await loadResolvedConfig(process.cwd());
    const resolve = this.deps.coordinator ?? (await import('../lib/machines/local-coordinator')).resolveCoordinator;
    const access = await resolve({ remote: opts.remote, config });
    try {
      await this.run(verb, target, positionals.slice(2), opts, access);
    } finally {
      await access.close();
    }
  }

  private async run(verb: string, target: string | undefined, rest: string[], opts: MachineOptions, access: CoordinatorAccess): Promise<void> {
    const { client } = access;
    if (verb === 'providers') {
      const p = await client.providers();
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, ...p } satisfies MachineProvidersJson);
      console.log(`${chalk.bold(p.provider)} via ${access.kind === 'local' ? 'the local coordinator' : `remote ${access.name}`} (${p.network} network)`);
      for (const s of p.sizes) console.log(`  ${s.name.padEnd(7)} ${s.shape}${s.memoryGb ? chalk.gray(`  ${s.vcpus} vCPU, ${s.memoryGb} GB`) : ''}`);
      const on = Object.entries(p.features).filter(([, v]) => v).map(([k]) => k);
      console.log(chalk.gray(`  features: ${on.join(', ') || 'none'}`));
      return;
    }

    const repo = await this.repo();
    if (verb === 'list') {
      const machines = await client.list(opts.all ? {} : { 'kunj.repo': repo.id });
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, repo: opts.all ? undefined : repo.id, machines } satisfies MachineListJson);
      if (machines.length === 0) {
        console.log(chalk.gray(`No machines${opts.all ? '' : ` for ${repo.name}`}. kunj machine create [branch] makes one.`));
        return;
      }
      for (const m of machines) console.log(line(m));
      return;
    }

    if (verb === 'image') return this.image(target ?? 'list', rest[0], opts, access, repo);

    const b = await this.branchOf(target);
    if (verb === 'status' || verb === 'create') {
      const r = await client.locate({ repo: repo.id, repoName: repo.name, branch: b, create: verb === 'create', size: opts.size });
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, machine: r.machine, created: r.created, woke: r.woke } satisfies MachineJsonResult);
      if (verb === 'create' && !r.created) console.log(chalk.gray(`${b} already has a machine.`));
      if (r.created) console.log(chalk.green(`✓ Created ${r.machine.name}`));
      console.log(line(r.machine));
      return;
    }

    const { machine } = await client.locate({ repo: repo.id, repoName: repo.name, branch: b });
    if (verb === 'delete') {
      if (!opts.yes) {
        if (this.jsonMode) throw new MachineError(`Deleting ${machine.name} needs --yes with --json.`, 'machine-not-found');
        const ok = await this.confirm(`Delete machine ${machine.name} (${b})${opts.keepDisks ? '' : ' and its disks'}? Work not pushed to origin is lost.`);
        if (!ok) {
          console.log(chalk.gray('Nothing deleted.'));
          return;
        }
      }
      await client.delete(machine.name, { disks: !opts.keepDisks });
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, deleted: machine.name });
      console.log(chalk.green(`✓ Deleted ${machine.name}`));
      return;
    }
    const after = await client.action(machine.name, verb as 'suspend' | 'resume' | 'stop' | 'start');
    if (this.jsonMode) return this.outputJSON({ coordinator: access.name, machine: after, created: false, woke: verb === 'resume' || verb === 'start' } satisfies MachineJsonResult);
    console.log(line(after));
  }

  /** Runs this kunj's own `ct blueprint snapshot` against the builder machine, its output on stderr. */
  private async buildSnapshot(remote: string, branch: string): Promise<number> {
    if (this.deps.snapshot) return this.deps.snapshot(remote, branch);
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [process.argv[1], 'ct', 'blueprint', 'snapshot', '--remote', remote, '--machine', branch], { stdio: ['ignore', 2, 2] });
      child.on('error', reject);
      child.on('exit', code => resolve(code ?? 1));
    });
  }

  private async image(sub: string, name: string | undefined, opts: MachineOptions, access: CoordinatorAccess, repo: { id: string; name: string }): Promise<void> {
    const { client } = access;
    if (sub === 'list') {
      const images = await client.images(repo.id);
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, repo: repo.id, images } satisfies MachineImageListJson);
      if (images.length === 0) {
        console.log(chalk.gray(`No machine image for ${repo.name}: new machines install everything at boot. kunj machine image build bakes one.`));
        return;
      }
      images.forEach((i, n) => console.log(`${i.name}  ${chalk.gray(i.createdAt)}${i.version ? chalk.gray(`  kunj ${i.version}`) : ''}${n === 0 ? chalk.green('  (new machines boot this)') : ''}`));
      return;
    }
    if (sub === 'delete') {
      if (!name) throw new MachineError('Name the image: kunj machine image delete <name> (kunj machine image lists them).', 'machine-not-found');
      await client.deleteImage(name);
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, deleted: name });
      console.log(chalk.green(`✓ Deleted image ${name}`));
      return;
    }
    if (sub !== 'build') throw new MachineError(`Unknown image action '${sub}'. Use list, build or delete.`, 'machine-not-found');

    const started = Date.now();
    const say = (m: string) => console.error(chalk.gray(m));
    say('Creating the builder machine (a few minutes: it installs Docker, Node and kunj)…');
    const { machine } = await client.locate({ repo: repo.id, repoName: repo.name, branch: IMAGE_BUILD_BRANCH, wake: true, create: true, size: opts.size });
    let image;
    const withSnapshot = opts.snapshot !== false;
    try {
      if (withSnapshot) {
        say(`Building the blueprint snapshot on ${machine.name}…`);
        const code = await this.buildSnapshot(access.kind === 'local' ? 'machines' : access.name, IMAGE_BUILD_BRANCH);
        if (code !== 0) {
          throw new MachineError(`The blueprint snapshot failed on the builder (exit ${code}), so no image was made. Fix it, or bake without one: kunj machine image build --no-snapshot.`, 'machine-create-failed');
        }
      }
      say('Stopping the builder and baking its disk into an image…');
      image = await client.bake(machine.name);
    } finally {
      // The builder is only ever a means: never left running, whatever failed
      await client.delete(machine.name, { disks: true }).catch(err => console.error(chalk.yellow(`could not delete the builder ${machine.name}: ${(err as Error).message}`)));
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (this.jsonMode) return this.outputJSON({ coordinator: access.name, image, builder: machine.name, snapshot: withSnapshot, seconds } satisfies MachineImageBuildJson);
    console.log(chalk.green(`✓ Image ${image.name} (${seconds} s). New machines of ${repo.name} boot from it.`));
  }

  private async coordinatorAction(sub: string): Promise<void> {
    const { coordinatorDir, coordinatorPaths } = await import('../lib/machines/config');
    const { readRecord } = await import('../lib/machines/local-coordinator');
    const paths = coordinatorPaths(this.deps.coordinatorDir ?? coordinatorDir());
    const record = readRecord(paths.record);
    if (sub === 'stop') {
      if (record) process.kill(record.pid, 'SIGTERM');
      if (this.jsonMode) return this.outputJSON({ running: !!record, stopped: !!record, pid: record?.pid } satisfies CoordinatorStatusJson);
      console.log(record ? `Stopped the local coordinator (pid ${record.pid}).` : chalk.gray('No local coordinator is running.'));
      return;
    }
    if (sub !== 'status') throw new MachineError(`Unknown coordinator action '${sub}'. Use status or stop.`, 'machine-not-found');
    if (this.jsonMode) return this.outputJSON({ running: !!record, ...(record ? { pid: record.pid, port: record.port, version: record.version, startedAt: record.startedAt } : {}), log: paths.log } satisfies CoordinatorStatusJson);
    if (!record) {
      console.log(chalk.gray('No local coordinator is running; kunj starts one when a kunj machine command needs it.'));
      return;
    }
    console.log(`Local coordinator: pid ${record.pid}, 127.0.0.1:${record.port}, kunj ${record.version}, since ${record.startedAt}`);
    console.log(chalk.gray(`Log: ${paths.log}`));
  }
}
