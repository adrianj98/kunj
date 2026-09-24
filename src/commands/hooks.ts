// Hooks command - inspect, scaffold and test kunj hooks (see src/lib/hooks.ts)
//
//   kunj hooks                         list known hooks and what is installed for each
//   kunj hooks add <hook> [--global]   create an executable hook script from a template
//   kunj hooks run <hook> [target]     run a hook by hand: target is a worktree for the worktree
//                                      hooks, a branch for the others (default: current)
//   kunj hooks path [--global]         print the hooks directory

import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { loadConfig } from '../lib/config';
import { repoVariables, resolveConfigVariables } from '../lib/config-vars';
import { getCurrentBranch } from '../lib/git';
import {
  HOOKS,
  HookDefinition,
  HookContext,
  HookName,
  HookRunResult,
  HookScope,
  createHookScript,
  getHooksDir,
  isHookName,
  actionHookContext,
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

// "$1 branch, $2 previous-branch"
function describeArgs(hook: HookDefinition): string {
  return hook.args.map((a, i) => `$${i + 1} ${a}`).join(', ');
}

// Word-wrap text to `width` columns, indenting continuation lines
function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

// Long --help text, built from HOOKS so it never drifts from the definitions
function hooksHelp(): string {
  const width = Math.max(...HOOKS.map(h => h.name.length)) + 2;
  const indent = ' '.repeat(width + 2);
  const hookLines = HOOKS.map(h => {
    const aborts = h.abortsOnFailure ? ' Can abort.' : '';
    const description = h.description.replace(/ A non-zero exit aborts[^.]*\./, '') + aborts;
    return [`  ${h.name.padEnd(width)}${wrap(description, 92 - indent.length, indent)}`, `${indent}args: ${describeArgs(h)}`].join('\n');
  }).join('\n');

  return `Hooks are your own scripts or commands that kunj runs before and after its actions, like
git hooks, but around kunj commands (create, switch, commit, pr, ...) rather than git itself.

Actions:
  list (default)          Show every hook, what it receives and what is installed for it
  add <hook> [-g] [-f]    Create an executable script for <hook> from a commented template,
                          in this repo's hooks directory (or the global one with -g)
  run <hook> [target]     Run a hook now, to test it. [target] is a worktree for the worktree
                          hooks and a branch for the others (default: the current one)
  path [-g]               Print the repo (or global) hooks directory

Hooks:
${hookLines}

Where hooks come from (all of them run, in this order):
  1. ~/.kunj/hooks/<hook>            global, every repository
  2. ~/.kunj/<repo>/hooks/<hook>     this repository only
     Either may also be a directory <hook>.d/ whose scripts run in name order.
     Scripts must be executable (chmod +x); *.sample files and dotfiles are ignored.
  3. The hooks.<hook> config setting: a shell command, or a JSON array of commands

What a hook receives:
  Arguments      as listed above, as $1, $2, ...
  Environment    each argument as KUNJ_<ARG> (KUNJ_BRANCH, KUNJ_PREVIOUS_BRANCH, KUNJ_PR_URL, ...),
                 plus KUNJ_HOOK, KUNJ_REPO_ROOT, KUNJ_REPO_CONFIG and KUNJ_REPO_NAME
  Config vars    config commands can use each argument as a camelCase \${...} variable
                 (\${branch}, \${previousBranch}, \${prUrl}, \${worktree}) and \${repoRoot}, \${repoName}, ...
  Directory      the worktree for post-worktree-create and pre-worktree-delete, the main
                 worktree for the other worktree hooks, otherwise where kunj was run

Exit status:
  A pre-* or commit-msg hook that exits non-zero stops the action and later hooks do not run.
  A post-* hook cannot undo anything; a failure is shown as a warning.
  commit-msg may rewrite the message file ($1); kunj commits whatever the file holds afterwards.
  Pass --no-hooks to create, switch, delete, commit, pr, stash or worktree to skip hooks once.
  With --json, hook output goes to stderr so the JSON on stdout stays clean.

Examples:
  kunj hooks                                   list hooks and what is installed
  kunj hooks add post-branch-switch            scaffold ~/.kunj/<repo>/hooks/post-branch-switch
  kunj hooks add pre-commit -g                 scaffold a global pre-commit hook
  kunj hooks run commit-msg                    try commit-msg against a sample message
  kunj config --set hooks.post-worktree-create="npm install"
  kunj config --set hooks.pre-pr-create="npm run lint && npm test"
  kunj commit --no-hooks                       commit without running kunj hooks`;
}

export class HooksCommand extends BaseCommand {
  constructor() {
    super({
      name: 'hooks',
      description: 'Manage hooks: your scripts that run before and after kunj actions (like git hooks)',
      arguments: '[action] [hook] [target]',
      helpText: hooksHelp,
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
        return this.run(this.requireHook(hook, 'kunj hooks run <hook> [worktree|branch]'), target);
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
      env: definition.env,
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
      console.log(chalk.gray(`  │ args: ${describeArgs(hook)}`));
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
    const { context, label, subject, cleanup } = hook.includes('-worktree-')
      ? await this.worktreeRunContext(target)
      : await this.actionRunContext(hook, target);
    this.log(chalk.blue(`Running ${hook} for ${label}...`));

    let result: HookRunResult;
    try {
      result = await runHook(hook, context, { hooks: loadConfig().hooks, jsonMode: this.jsonMode });
    } finally {
      cleanup();
    }

    if (this.jsonMode) {
      this.outputJSON({ success: result.ok, ...subject, result });
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

  private async worktreeRunContext(target?: string) {
    const listing = await listWorktreesDetailed({ includeStatus: false, includePullRequests: false });
    const wt = target
      ? findWorktreeIn(listing.worktrees, target)
      : listing.worktrees.find(w => w.isCurrent) || listing.worktrees.find(w => w.isMain) || null;
    if (!wt) {
      throw new Error(`No worktree found for '${target}'`);
    }
    return {
      context: worktreeHookContext(repoVariables(listing.gitCommonDir), wt.path, wt.branch),
      label: `${wt.name} (${wt.path})`,
      subject: { worktree: { path: wt.path, branch: wt.branch } },
      cleanup: () => {},
    };
  }

  // The branch hooks get the target branch (default: current) and sample
  // values for the rest; commit-msg gets a throwaway message file
  private async actionRunContext(hook: HookName, target?: string) {
    const current = await getCurrentBranch();
    const branch = target || current;
    let dir: string | null = null;
    const values: Record<string, string> = {
      branch,
      'previous-branch': current,
      'base-branch': 'main',
      title: 'kunj hooks run',
      message: 'kunj hooks run',
      'pr-url': '',
    };
    if (hook === 'commit-msg') {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-hooks-run-'));
      values['message-file'] = path.join(dir, 'COMMIT_EDITMSG');
      fs.writeFileSync(values['message-file'], 'kunj hooks run test message\n');
    }
    const context: HookContext = actionHookContext(hook, await resolveConfigVariables(), process.cwd(), values);
    return {
      context,
      label: `branch ${branch}`,
      subject: { branch },
      cleanup: () => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }
}
