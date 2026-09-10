// Hooks command - inspect, scaffold and test kunj hooks (see src/lib/hooks.ts)
//
//   kunj hooks                         list known hooks and what is installed for each
//   kunj hooks add <hook> [--global]   create an executable hook script from a template
//   kunj hooks run <hook> [target]     run a hook by hand against a worktree (default: current)
//   kunj hooks path [--global]         print the hooks directory

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadConfig } from '../lib/config';
import { repoVariables } from '../lib/config-vars';
import {
  HOOKS,
  HookName,
  HookRunResult,
  HookScope,
  createHookScript,
  getHooksDir,
  isHookName,
  listHookSources,
  runHook,
  worktreeHookContext,
} from '../lib/hooks';
import { findWorktreeIn, listWorktreesDetailed } from '../lib/worktree';

interface HooksOptions {
  global?: boolean;
  force?: boolean;
}

const ACTIONS = ['list', 'add', 'run', 'path'];

export class HooksCommand extends BaseCommand {
  constructor() {
    super({
      name: 'hooks',
      description: 'Manage hook scripts that run around kunj operations (like git hooks)',
      arguments: '[action] [hook] [target]',
      options: [
        { flags: '-g, --global', description: '[add|path] Use the global hooks directory (~/.kunj/hooks)' },
        { flags: '-f, --force', description: '[add] Overwrite an existing hook script' },
      ],
    });
  }

  async execute(action?: string, hook?: string, target?: string, options: HooksOptions = {}): Promise<void> {
    // Commander shifts the options object left when fewer positionals are given
    const args = [action, hook, target];
    const optIndex = args.findIndex(a => a !== undefined && typeof a === 'object');
    if (optIndex !== -1) {
      options = args[optIndex] as unknown as HooksOptions;
      args.splice(optIndex);
    }
    [action, hook, target] = args as [string?, string?, string?];

    const verb = (action || 'list').toLowerCase();
    if (!ACTIONS.includes(verb)) {
      throw new Error(`Unknown hooks action '${action}'. Expected one of: ${ACTIONS.join(', ')}`);
    }
    const scope: HookScope = options.global ? 'global' : 'repo';

    switch (verb) {
      case 'list':
        return this.list();
      case 'add':
        return this.add(this.requireHook(hook, 'kunj hooks add <hook> [--global]'), scope, !!options.force);
      case 'run':
        return this.run(this.requireHook(hook, 'kunj hooks run <hook> [worktree]'), target);
      case 'path':
        return this.path(scope);
    }
  }

  private requireHook(name: string | undefined, usage: string): HookName {
    if (!name) {
      throw new Error(`Usage: ${usage}\nHooks: ${HOOKS.map(h => h.name).join(', ')}`);
    }
    if (!isHookName(name)) {
      throw new Error(`Unknown hook '${name}'. Known hooks: ${HOOKS.map(h => h.name).join(', ')}`);
    }
    return name;
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  private list(): void {
    const config = loadConfig();
    const hooks = HOOKS.map(definition => ({
      name: definition.name,
      description: definition.description,
      abortsOnFailure: definition.abortsOnFailure,
      args: definition.args,
      sources: listHookSources(definition.name, config.hooks),
    }));

    if (this.jsonMode) {
      this.outputJSON({
        hooksDir: { global: getHooksDir('global'), repo: getHooksDir('repo') },
        hooks,
      });
      return;
    }

    console.log(chalk.blue('Kunj hooks'));
    console.log(chalk.gray('─'.repeat(70)));
    for (const hook of hooks) {
      const installed = hook.sources.length > 0;
      console.log(`${installed ? chalk.green('●') : chalk.gray('○')} ${chalk.bold(hook.name)}${hook.abortsOnFailure ? chalk.gray('  (a non-zero exit aborts)') : ''}`);
      console.log(chalk.gray(`  │ ${hook.description}`));
      for (const source of hook.sources) {
        const label = source.kind === 'config' ? 'config' : source.scope;
        const warn = source.executable ? '' : chalk.yellow('  (not executable, ignored)');
        console.log(`  │ ${chalk.cyan(label.padEnd(6))} ${source.target}${warn}`);
      }
    }
    console.log('');
    console.log(chalk.gray(`Repo hooks:   ${getHooksDir('repo')}`));
    console.log(chalk.gray(`Global hooks: ${getHooksDir('global')}`));
    console.log(chalk.gray("Tip: 'kunj hooks add post-worktree-create' creates a script to edit,"));
    console.log(chalk.gray("     or set a command with 'kunj config --set hooks.post-worktree-create=\"npm install\"'"));
  }

  // ---------------------------------------------------------------------
  // add / path
  // ---------------------------------------------------------------------

  private add(hook: HookName, scope: HookScope, force: boolean): void {
    const file = createHookScript(hook, scope, force);
    if (this.jsonMode) {
      this.outputJSON({ success: true, hook, scope, path: file });
      return;
    }
    console.log(chalk.green(`✓ Created ${scope} ${hook} hook`));
    console.log(chalk.gray(`  ${file}`));
    console.log(chalk.gray('Edit the script to make it do something useful.'));
  }

  private path(scope: HookScope): void {
    const dir = getHooksDir(scope);
    if (this.jsonMode) {
      this.outputJSON({ scope, path: dir });
      return;
    }
    process.stdout.write(dir + '\n');
  }

  // ---------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------

  private async run(hook: HookName, target?: string): Promise<void> {
    const listing = await listWorktreesDetailed({ includeStatus: false, includePullRequests: false });
    const wt = target
      ? findWorktreeIn(listing.worktrees, target)
      : listing.worktrees.find(w => w.isCurrent) || listing.worktrees.find(w => w.isMain) || null;
    if (!wt) {
      throw new Error(`No worktree found for '${target}'`);
    }

    const context = worktreeHookContext(repoVariables(listing.gitCommonDir), wt.path, wt.branch);
    this.log(chalk.blue(`Running ${hook} for ${wt.name} (${wt.path})...`));

    const result: HookRunResult = await runHook(hook, context, { hooks: loadConfig().hooks, jsonMode: this.jsonMode });

    if (this.jsonMode) {
      this.outputJSON({ success: result.ok, worktree: { path: wt.path, branch: wt.branch }, result });
      return;
    }
    if (result.executions.length === 0) {
      console.log(chalk.yellow(`Nothing is installed for ${hook}`));
      return;
    }
    for (const execution of result.executions) {
      const mark = execution.status === 'ok' ? chalk.green('✓') : execution.status === 'failed' ? chalk.red('✗') : chalk.yellow('-');
      const detail =
        execution.status === 'ok'
          ? chalk.gray(`${execution.durationMs}ms`)
          : execution.status === 'failed'
            ? chalk.red(execution.signal ? `killed by ${execution.signal}` : execution.exitCode !== null ? `exit ${execution.exitCode}` : execution.reason || 'failed')
            : chalk.yellow(execution.reason || 'skipped');
      console.log(`${mark} ${execution.source} ${detail}`);
    }
  }
}
