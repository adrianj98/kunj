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
import type { MachinePruneJson, MachineSetupJson, MachineSetupRemoveJson } from '../lib/json-types';
import type { MachineJson, MachineListJson, MachineJsonResult, MachineProvidersJson, CoordinatorStatusJson, MachineImageListJson, MachineImageBuildJson } from '../lib/json-types';
import { IMAGE_BUILD_BRANCH, MachineError, machineName } from '../lib/machines/provider';
import type { KunjConfig } from '../types';

interface MachineOptions {
  json?: boolean;
  remote?: string;
  all?: boolean;
  size?: string;
  yes?: boolean;
  keepDisks?: boolean;
  /** --no-snapshot */
  snapshot?: boolean;
  /** --no-hooks */
  hooks?: boolean;
  force?: boolean;
  dryRun?: boolean;
  project?: string;
  zone?: string;
  network?: string;
  provider?: string;
  /** --no-cache */
  cache?: boolean;
  /** [setup] --remove: delete what setup made */
  remove?: boolean;
  /** [setup --remove] also the cache bucket and every cache in it */
  removeBucket?: boolean;
}

export interface MachineCommandDeps {
  /** How the coordinator is reached (default resolveCoordinator) */
  coordinator?: (opts: ResolveOptions) => Promise<CoordinatorAccess>;
  /** The repository (default: this checkout's) */
  repo?: () => { id: string; name: string };
  branch?: () => Promise<string>;
  /** [prune] Origin's branches, null when unreachable (default: git ls-remote) */
  heads?: () => Promise<string[] | null>;
  /** [prune] Looks inside a running machine (default: its containers and the remove guard, through the coordinator) */
  inspect?: (machine: MachineJson) => Promise<import('../lib/machines/prune').MachineInside>;
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Builds the blueprint snapshot on the builder machine (default: this kunj's
   * `ct blueprint snapshot --remote <remote> --machine <builder branch>`); resolves to its exit code
   */
  snapshot?: (remote: string, branch: string) => Promise<number | { code: number; hash?: string }>;
  /** ~/.kunj/coordinator (tests) */
  coordinatorDir?: string;
  /** [setup] How the cloud CLI runs (tests) */
  run?: import('../lib/machines/cli').CliRunner;
  /** [setup] Writes one global setting (default: this kunj's `config --set-json … --global`) */
  setConfig?: (key: string, value: unknown) => Promise<void>;
}

const ACTIONS = ['setup', 'list', 'status', 'create', 'suspend', 'resume', 'stop', 'start', 'delete', 'prune', 'image', 'providers', 'coordinator'];

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
        { flags: '--all', description: '[list] Every machine of the coordinator, not only this repository\'s; [prune] every repository\'s unused golden images' },
        { flags: '--size <size>', description: '[create] small, medium, large or a provider shape (default machine.size)' },
        { flags: '-y, --yes', description: '[delete] Do not ask' },
        { flags: '--keep-disks', description: '[delete] Keep the machine\'s disks' },
        { flags: '--project <id>', description: '[setup] The cloud project (default: the one in machine.gce, else gcloud\'s)' },
        { flags: '--zone <zone>', description: '[setup] Where machines run (default: the one in machine.gce, else us-central1-a)' },
        { flags: '--network <name>', description: '[setup] The VPC network (default: default)' },
        { flags: '--no-cache', description: '[setup] Do not make a cache bucket' },
        { flags: '--remove', description: '[setup] Delete what setup made (refused while kunj machines or golden images exist)' },
        { flags: '--remove-bucket', description: '[setup --remove] Also delete the cache bucket and every cache in it' },
        { flags: '--force', description: '[prune] Also delete machines that are asleep or hold work origin does not have' },
        { flags: '--dry-run', description: '[prune] Only show what would be deleted' },
        { flags: '--no-hooks', description: '[create, delete] Skip the machine hooks' },
        { flags: '--no-snapshot', description: '[image build] Do not build the blueprint snapshot into the image' },
      ],
      helpText: [
        'Actions:',
        '  setup                       prepare a cloud project for machines: shows what is missing and what it costs, then makes it',
        '  setup --remove              delete what setup made (NAT, router, firewall rule, account, role); the bucket only',
        '                              with --remove-bucket or when asked separately',
        '  list (default)              this repository\'s machines, any state',
        '  status [branch]             the branch\'s machine (the current branch by default)',
        '  create [branch]             make the branch\'s machine and wait until its kunj serve answers',
        '  suspend|resume|stop|start [branch]',
        '  delete [branch]             delete the machine and its disks (the branch is on origin)',
        '  prune                       delete machines whose branch is gone from origin, and ones left without a container,',
        '                              and golden images older than 14 days of a repository with no machine (--all: every repository)',
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

  /**
   * `kunj machine setup`: everything a cloud project needs before its first machine. Each step says
   * whether it is already there; what is missing is listed with its cost and made after a yes.
   */
  private async setup(opts: MachineOptions, config: KunjConfig): Promise<void> {
    const provider = opts.provider || (typeof config.machine?.provider === 'string' && config.machine.provider) || 'gce';
    if (provider !== 'gce') throw new MachineError(`kunj machine setup knows Google Cloud (gce) only; ${provider} is set up by hand (see the docs).`, 'machine-provider');
    const { execRunner } = await import('../lib/machines/cli');
    const run = this.deps.run ?? execRunner;
    const existing = (config.machine?.gce && typeof config.machine.gce === 'object' ? config.machine.gce : {}) as Record<string, unknown>;
    let project = opts.project || (typeof existing.project === 'string' ? existing.project : '');
    if (!project) {
      const r = await run('gcloud', ['config', 'get-value', 'project', '--quiet']);
      project = r.code === 0 ? r.stdout.trim() : '';
      if (!project || project === '(unset)') throw new MachineError('Which project? Give it: kunj machine setup --project <id> (gcloud projects list shows yours; gcloud auth login first if it shows none).', 'bad-machine-config');
    }
    const zone = opts.zone || (typeof existing.zone === 'string' ? existing.zone : '') || 'us-central1-a';
    const { gceSetup } = await import('../lib/machines/setup/gce');
    // The network machines are created on (machine.gce.network) is the one that needs the NAT and the rule
    const network = opts.network || (typeof existing.network === 'string' ? existing.network : '') || undefined;
    if (opts.remove) return this.removeSetup(opts, { project, zone, network }, run);
    const plan = gceSetup({ project, zone, network, cache: opts.cache !== false, existing }, run);

    const say = (line: string) => (this.jsonMode ? console.error(line) : console.log(line));
    say(chalk.blue(`Checking ${plan.target}…`));
    const states: Array<{ title: string; cost?: string; state: 'present' | 'planned' | 'created' | 'failed'; message?: string }> = [];
    for (const step of plan.steps) {
      const present = await step.exists();
      states.push({ title: step.title, ...(step.cost ? { cost: step.cost } : {}), state: present ? 'present' : 'planned' });
      say(present ? chalk.gray(`  ✓ ${step.title}`) : `  + ${step.title}${step.cost ? chalk.yellow(`  (${step.cost})`) : ''}`);
    }
    const missing = states.filter(s => s.state === 'planned').length;
    const dryRun = !!opts.dryRun || (missing > 0 && !opts.yes && (this.jsonMode || !process.stdin.isTTY));
    let apply = !dryRun;
    if (apply && missing > 0 && !opts.yes) {
      apply = await this.confirm(`Create the ${missing} thing${missing === 1 ? '' : 's'} marked + in ${project}?`);
      if (!apply) say(chalk.gray('Nothing created.'));
    }
    if (apply) {
      for (let i = 0; i < plan.steps.length; i++) {
        if (states[i].state !== 'planned') continue;
        try {
          await plan.steps[i].apply();
          states[i].state = 'created';
          say(chalk.green(`  ✓ created: ${plan.steps[i].title}`));
        } catch (err) {
          states[i].state = 'failed';
          states[i].message = (err as Error).message;
          say(chalk.red(`  ✗ ${plan.steps[i].title}: ${(err as Error).message}`));
          break; // later steps build on earlier ones
        }
      }
    }
    const failed = states.some(s => s.state === 'failed');
    const done = apply && !failed;
    if (done) {
      const set = this.deps.setConfig ?? ((key: string, value: unknown) => this.setGlobal(key, value));
      for (const [key, value] of Object.entries(plan.config)) await set(key, value);
    }
    if (this.jsonMode) {
      this.outputJSON({ provider: plan.provider, target: plan.target, dryRun: !apply, success: !failed, steps: states, config: done ? plan.config : {} } satisfies MachineSetupJson);
    } else if (done) {
      console.log(chalk.green('✓ Ready.') + ' Start a branch on its own machine:');
      console.log('  kunj ct start <branch> --remote machines');
      console.log(chalk.gray('  kunj machine image build bakes an image so new machines start in about 2 minutes instead of 10.'));
    } else if (!apply && missing > 0 && dryRun) {
      console.log(chalk.gray('Nothing created. Run kunj machine setup in a terminal, or with --yes.'));
    }
    if (failed) process.exitCode = 1;
  }

  /**
   * `kunj machine setup --remove`: deletes what setup made, refused while the project still has kunj
   * machines or golden images (they need the account, the rule and the NAT). The cache bucket is a
   * question of its own, since every cache in it goes too: --remove-bucket, or a separate yes.
   */
  private async removeSetup(opts: MachineOptions, where: { project: string; zone: string; network?: string }, run: import('../lib/machines/cli').CliRunner): Promise<void> {
    const { gceRemove } = await import('../lib/machines/setup/gce');
    const plan = gceRemove(where, run);
    const say = (line: string) => (this.jsonMode ? console.error(line) : console.log(line));
    say(chalk.blue(`Checking ${plan.target}…`));
    const inUse = await plan.inUse();
    if (inUse.machines.length || inUse.images.length) {
      const lines = [
        ...(inUse.machines.length ? [`machines: ${inUse.machines.join(', ')} (kunj machine delete <branch>, or kunj machine prune)`] : []),
        ...(inUse.images.length ? [`golden images: ${inUse.images.join(', ')} (kunj machine image delete <name>)`] : []),
      ];
      throw new MachineError(`${where.project} still has kunj ${lines.map(l => l.split(':')[0]).join(' and ')}, which need what setup made. Delete them first:\n  ${lines.join('\n  ')}`, 'machine-exists');
    }
    type State = 'present' | 'absent' | 'removed' | 'failed' | 'kept';
    const states: Array<{ title: string; cost?: string; state: State; message?: string }> = [];
    for (const step of plan.steps) {
      const present = await step.exists();
      states.push({ title: step.title, ...(step.cost ? { cost: step.cost } : {}), state: present ? 'present' : 'absent' });
      say(present ? `  - ${step.title}${step.cost ? chalk.green(`  (${step.cost})`) : ''}` : chalk.gray(`  ✓ gone: ${step.title}`));
    }
    const bucketThere = await plan.bucket.exists();
    let bucketState: State = bucketThere ? 'present' : 'absent';
    if (bucketThere) say(opts.removeBucket ? `  - ${plan.bucket.name} and every cache in it` : chalk.yellow(`  ? ${plan.bucket.name} holds the caches: kept unless --remove-bucket`));
    const present = states.filter(s => s.state === 'present').length;
    const interactive = !this.jsonMode && !!process.stdin.isTTY;
    const dryRun = !!opts.dryRun || (present + (bucketThere && opts.removeBucket ? 1 : 0) > 0 && !opts.yes && !interactive);
    let apply = !dryRun;
    if (apply && present > 0 && !opts.yes) {
      apply = await this.confirm(`Delete the ${present} thing${present === 1 ? '' : 's'} marked - in ${where.project}?`);
      if (!apply) say(chalk.gray('Nothing deleted.'));
    }
    let failed = false;
    if (apply) {
      for (let i = 0; i < plan.steps.length; i++) {
        if (states[i].state !== 'present') continue;
        try {
          await plan.steps[i].apply();
          states[i].state = 'removed';
          say(chalk.green(`  ✓ deleted: ${plan.steps[i].title}`));
        } catch (err) {
          states[i].state = 'failed';
          states[i].message = (err as Error).message;
          say(chalk.red(`  ✗ ${plan.steps[i].title}: ${(err as Error).message}`));
          failed = true;
          break; // the account is not deleted while its role binding stays, the router while its NAT does
        }
      }
      // The bucket: --remove-bucket, or its own question (never a yes given for the rest)
      if (!failed && bucketThere) {
        const remove = opts.removeBucket || (!opts.yes && interactive && (await this.confirm(`Also delete ${plan.bucket.name} and every cache in it? They cannot be recovered.`)));
        if (remove) {
          try {
            await plan.bucket.remove();
            bucketState = 'removed';
            say(chalk.green(`  ✓ deleted: ${plan.bucket.name}`));
          } catch (err) {
            bucketState = 'failed';
            failed = true;
            say(chalk.red(`  ✗ ${plan.bucket.name}: ${(err as Error).message}`));
          }
        } else {
          bucketState = 'kept';
          say(chalk.gray(`  kept ${plan.bucket.name}; kunj machine setup --remove --remove-bucket deletes it with its caches`));
        }
      }
    }
    if (this.jsonMode) {
      this.outputJSON({ provider: plan.provider, target: plan.target, remove: true, dryRun: !apply, success: !failed, steps: states, bucket: { name: plan.bucket.name, state: bucketState } } satisfies MachineSetupRemoveJson);
    } else if (apply && !failed) {
      console.log(chalk.green('✓ Removed.') + chalk.gray(' The Compute Engine and IAP APIs stay on. machine.* settings are unchanged: kunj config --unset machine.provider --global stops kunj starting a coordinator.'));
    } else if (!apply && dryRun) {
      console.log(chalk.gray('Nothing deleted. Run kunj machine setup --remove in a terminal, or with --yes.'));
    }
    if (failed) process.exitCode = 1;
  }

  /** One global setting, written by this kunj's own `config --set-json`, so it is checked like any other. */
  private async setGlobal(key: string, value: unknown): Promise<void> {
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, [process.argv[1], 'config', '--set-json', `${key}=${JSON.stringify(value)}`, '--global'], (err, _out, errOut) =>
        err ? reject(new MachineError(`could not save ${key}: ${String(errOut).trim() || err.message}`, 'bad-machine-config')) : resolve()));
  }

  /** The branch's container on a running machine and what the remove guard finds in it, through the coordinator. */
  private async inspectMachine(m: MachineJson, access: CoordinatorAccess, repo: { id: string; name: string }): Promise<import('../lib/machines/prune').MachineInside> {
    const { RemoteKunjBackend } = await import('../lib/container/remote');
    const { containerNames, LABEL, optionsLabel } = await import('../lib/container/names');
    const { inspectForRemove } = await import('../lib/container/lifecycle');
    const { describeGuard } = await import('../lib/container/env');
    const o = access.client.opts;
    const backend = new RemoteKunjBackend({ baseUrl: o.baseUrl, token: o.token, name: `${o.name}/${m.name}`, basePath: `/v1/machines/${m.name}/serve` });
    await backend.ready();
    const names = containerNames(repo.name, repo.id, m.branch);
    const main = (await backend.list({ [LABEL.repo]: repo.id, [LABEL.branch]: m.branch })).find(c => c.name === names.container);
    if (!main) return { container: false, problems: [] };
    const guard = await inspectForRemove(backend, names, { user: optionsLabel(main.labels).user ?? '', kunjVersion: '', allowPrivileged: false, warn: () => {} });
    return { container: true, problems: describeGuard(guard) };
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
    if (verb === 'setup') return this.setup(opts, config);
    const resolve = this.deps.coordinator ?? (await import('../lib/machines/local-coordinator')).resolveCoordinator;
    const access = await resolve({ remote: opts.remote, config });
    try {
      const { machineSettings } = await import('../lib/machines/config');
      const settings = machineSettings(config);
      await this.run(verb, target, positionals.slice(2), opts, access, config.hooks, settings.deleteAfterDays, settings.defaults.image ?? '');
    } finally {
      await access.close();
    }
  }

  private async run(verb: string, target: string | undefined, rest: string[], opts: MachineOptions, access: CoordinatorAccess, hooks?: KunjConfig['hooks'], deleteAfterDays = 0, pinnedImage = ''): Promise<void> {
    const { client } = access;
    // The machine hooks run here, on the client, where the user's config is
    const hook = async (name: 'pre-machine-create' | 'post-machine-create' | 'pre-machine-delete' | 'post-machine-delete', branch: string, machine: string) => {
      if (opts.hooks === false || !hooks) return;
      const { runActionHook } = await import('../lib/hooks');
      const provider = await client.providers().then(p => p.provider, () => '');
      await runActionHook(name, { branch, machine, provider }, { hooks, jsonMode: this.jsonMode });
    };
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

    if (verb === 'prune') {
      const { planMachinePrune, machineRemovals, planImagePrune, IMAGE_UNUSED_AFTER_DAYS } = await import('../lib/machines/prune');
      const heads = await (this.deps.heads ?? (async () => (await import('../lib/container/prune')).lsRemoteHeads(process.cwd())))();
      const inspect = this.deps.inspect ?? ((m: MachineJson) => this.inspectMachine(m, access, repo));
      const plan = await planMachinePrune({ machines: await client.list({ 'kunj.repo': repo.id }), heads, force: !!opts.force, inspect, deleteAfterDays });
      const removals = machineRemovals(plan);
      // Golden images of a repository with no machine left: this repository's, every one's with --all.
      // Every machine of the coordinator counts, since a machine of any repository may boot any image
      const [allMachines, images] = await Promise.all([client.list({}), client.images(opts.all ? '' : repo.id)]);
      const imagePlan = planImagePrune({ images, machines: allMachines, pinned: pinnedImage, repo: repo.id });
      const imageRemovals = imagePlan.filter(i => !i.kept);
      const dryRun = !!opts.dryRun || (!opts.yes && (this.jsonMode || !process.stdin.isTTY));
      const why = { 'branch-gone': 'its branch is gone from origin', 'no-container': 'it holds no container', 'image-builder': 'an image build left it behind', 'asleep-long': `it has slept longer than machine.deleteAfterDays (${deleteAfterDays})` };
      if (!this.jsonMode) {
        for (const w of plan.warnings) console.error(chalk.yellow(w));
        for (const m of plan.machines) {
          console.log(m.kept ? chalk.yellow(`keep    ${m.name}  (${m.branch}): ${why[m.reason]}, but ${m.kept}`) : `${dryRun ? 'would delete' : 'delete'}  ${m.name}  (${m.branch}): ${why[m.reason]}`);
        }
        for (const i of imagePlan) {
          const why = `${opts.all ? `${i.repo} has` : 'this repository has'} no machine and it is older than ${IMAGE_UNUSED_AFTER_DAYS} days (${i.createdAt.slice(0, 10)})`;
          console.log(i.kept ? chalk.yellow(`keep    image ${i.name}: ${why}, but ${i.kept}`) : `${dryRun ? 'would delete' : 'delete'}  image ${i.name}: ${why}`);
        }
        if (plan.machines.length === 0 && imagePlan.length === 0) console.log(chalk.gray('Nothing to prune.'));
      }
      const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
      let apply = !dryRun && removals.length + imageRemovals.length > 0;
      if (apply && !opts.yes) {
        const what = [removals.length ? `${count(removals.length, 'machine')} and their disks` : '', imageRemovals.length ? count(imageRemovals.length, 'golden image') : ''].filter(Boolean).join(' and ');
        apply = await this.confirm(`Delete ${what}?`);
        if (!apply) console.log(chalk.gray('Nothing deleted.'));
      }
      const removed: string[] = [];
      const failed: string[] = [];
      const removedImages: string[] = [];
      const failedImages: string[] = [];
      if (apply) {
        for (const m of removals) {
          try {
            await hook('pre-machine-delete', m.branch, m.name);
            await client.delete(m.name, { disks: true });
            removed.push(m.name);
            await hook('post-machine-delete', m.branch, m.name);
          } catch (err) {
            failed.push(m.name);
            console.error(chalk.yellow(`could not delete ${m.name}: ${(err as Error).message}`));
          }
        }
        for (const i of imageRemovals) {
          try {
            await client.deleteImage(i.name);
            removedImages.push(i.name);
          } catch (err) {
            failedImages.push(i.name);
            console.error(chalk.yellow(`could not delete image ${i.name}: ${(err as Error).message}`));
          }
        }
      }
      const ok = failed.length === 0 && failedImages.length === 0;
      if (this.jsonMode) {
        return this.outputJSON({ coordinator: access.name, success: ok, dryRun, plan: { ...plan, images: imagePlan }, removed, failed, removedImages, failedImages } satisfies MachinePruneJson);
      }
      if (apply) console.log(chalk.green(`✓ Deleted ${count(removed.length, 'machine')}${imageRemovals.length ? ` and ${count(removedImages.length, 'golden image')}` : ''}`));
      else if (dryRun && removals.length + imageRemovals.length) console.log(chalk.gray('Dry run: kunj machine prune --yes deletes them.'));
      if (!ok) process.exitCode = 1;
      return;
    }

    const b = await this.branchOf(target);
    if (verb === 'status' || verb === 'create') {
      const find = (create: boolean) => client.locate({ repo: repo.id, repoName: repo.name, branch: b, create, size: opts.size });
      let r: Awaited<ReturnType<typeof find>>;
      if (verb === 'create') {
        const existing = await find(false).catch(err => {
          if (err instanceof MachineError && err.code === 'machine-not-found') return undefined;
          throw err;
        });
        if (existing) r = existing;
        else {
          await hook('pre-machine-create', b, machineName(repo.name, repo.id, b));
          r = await find(true);
          if (r.created) await hook('post-machine-create', b, r.machine.name);
        }
      } else r = await find(false);
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
      await hook('pre-machine-delete', b, machine.name);
      await client.delete(machine.name, { disks: !opts.keepDisks });
      await hook('post-machine-delete', b, machine.name);
      if (this.jsonMode) return this.outputJSON({ coordinator: access.name, deleted: machine.name });
      console.log(chalk.green(`✓ Deleted ${machine.name}`));
      return;
    }
    const after = await client.action(machine.name, verb as 'suspend' | 'resume' | 'stop' | 'start');
    if (this.jsonMode) return this.outputJSON({ coordinator: access.name, machine: after, created: false, woke: verb === 'resume' || verb === 'start' } satisfies MachineJsonResult);
    console.log(line(after));
  }

  /** Runs this kunj's own `ct blueprint snapshot` against the builder machine, its output on stderr. */
  /** Builds the snapshot on the builder; `hash` is the blueprint hash it was built for (the image's kunj.blueprint label). */
  private async buildSnapshot(remote: string, branch: string): Promise<{ code: number; hash?: string }> {
    if (this.deps.snapshot) {
      const r = await this.deps.snapshot(remote, branch);
      return typeof r === 'number' ? { code: r } : r;
    }
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      // --json: progress goes to stderr (shown), the result to stdout (read for the hash)
      const child = spawn(process.execPath, [process.argv[1], 'ct', 'blueprint', 'snapshot', '--remote', remote, '--machine', branch, '--json'], { stdio: ['ignore', 'pipe', 2] });
      const out: Buffer[] = [];
      child.stdout!.on('data', (d: Buffer) => out.push(d));
      child.on('error', reject);
      child.on('exit', code => {
        let hash: string | undefined;
        try {
          const parsed = JSON.parse(Buffer.concat(out).toString());
          if (typeof parsed?.hash === 'string' && /^[0-9a-f]{1,64}$/.test(parsed.hash)) hash = parsed.hash;
        } catch {
          // no result: the exit code says why
        }
        resolve({ code: code ?? 1, ...(hash ? { hash } : {}) });
      });
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
    const builder = { repo: repo.id, repoName: repo.name, branch: IMAGE_BUILD_BRANCH, wake: true, create: true, size: opts.size };
    // A builder that already exists is another build in progress, or one left by an interrupted
    // build with a disk in an unknown state: neither is baked, and only the user knows which it is
    const existing = await client.locate({ ...builder, wake: false, create: false }).catch(err => {
      if (err instanceof MachineError && err.code === 'machine-not-found') return null;
      throw err;
    });
    if (existing) {
      throw new MachineError(
        `An image builder already exists (${existing.machine.name}, ${existing.machine.state}): another build is running, or one was interrupted. When no build is running, delete it and build again: kunj machine delete '${IMAGE_BUILD_BRANCH}' --yes`,
        'machine-exists',
      );
    }
    // Ctrl-C skips finally: the builder would stay, running and billed. From before the create,
    // which takes minutes, so the builder is found by its branch
    const onSignal = () => {
      console.error(chalk.yellow('\nInterrupted: deleting the builder…'));
      void client
        .locate({ ...builder, wake: false, create: false })
        .then(r => client.delete(r.machine.name, { disks: true }))
        .catch(() => undefined)
        .then(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let machine: MachineJson | undefined;
    let image;
    const withSnapshot = opts.snapshot !== false;
    let blueprint: string | undefined;
    try {
      ({ machine } = await client.locate(builder));
      if (withSnapshot) {
        say(`Building the blueprint snapshot on ${machine.name}…`);
        const built = await this.buildSnapshot(access.kind === 'local' ? 'machines' : access.name, IMAGE_BUILD_BRANCH);
        const code = built.code;
        blueprint = built.hash;
        if (code !== 0) {
          throw new MachineError(`The blueprint snapshot failed on the builder (exit ${code}), so no image was made. Fix it, or bake without one: kunj machine image build --no-snapshot.`, 'machine-create-failed');
        }
      }
      say('Stopping the builder and baking its disk into an image…');
      image = await client.bake(machine.name, blueprint ? { blueprint } : {});
    } finally {
      // The builder is only ever a means: never left running, whatever failed
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      // A create that failed after the VM existed returned no machine: found by its branch
      const name = machine?.name ?? (await client.locate({ ...builder, wake: false, create: false }).then(r => r.machine.name, () => undefined));
      if (name) await client.delete(name, { disks: true }).catch(err => console.error(chalk.yellow(`could not delete the builder ${name}: ${(err as Error).message}`)));
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
