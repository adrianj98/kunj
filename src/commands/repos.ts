// Repos command - the repositories kunj knows about (src/lib/repos.ts).
//
//   kunj repos                  list known repositories
//   kunj repos add [path]       add a repository (default: the current one)
//   kunj repos remove <path>    hide a repository from the list
//   kunj repos prune            forget repositories whose directory is gone
//
// The macOS menu bar app reads `kunj repos --json` to know what to show.

import chalk from 'chalk';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getGitCommonDir } from '../lib/worktree';
import { addRepo, hideRepo, listRepos, pruneRepos, getReposPath } from '../lib/repos';

interface ReposOptions {
  all?: boolean;
}

const ACTIONS = ['list', 'add', 'remove', 'prune'];

export class ReposCommand extends BaseCommand {
  constructor() {
    super({
      name: 'repos',
      description: 'List the repositories kunj has been used in',
      arguments: '[action] [path]',
      options: [{ flags: '-a, --all', description: '[list] Include hidden repositories' }],
      helpText: () =>
        [
          'Actions:',
          '  list (default)   Known repositories, most recently used first',
          '  add [path]       Add the repository containing path (default: current directory)',
          '  remove <path>    Hide a repository; it stays hidden until added again',
          '  prune            Forget repositories whose directory no longer exists',
          '',
          `Repositories are recorded as kunj runs in them, in ${getReposPath()}`,
        ].join('\n'),
    });
  }

  async execute(action?: string, target?: string, options: ReposOptions = {}): Promise<void> {
    // Commander passes (action, path, options, command); with fewer
    // positionals the options object shifts left
    const args = [action, target];
    const optIndex = args.findIndex(a => a !== undefined && typeof a === 'object');
    if (optIndex !== -1) {
      options = args[optIndex] as unknown as ReposOptions;
      args.splice(optIndex);
    }
    [action, target] = args as [string?, string?];

    const verb = (action || 'list').toLowerCase();
    if (!ACTIONS.includes(verb)) {
      throw new Error(`Unknown repos action '${action}'. Expected one of: ${ACTIONS.join(', ')}`);
    }

    switch (verb) {
      case 'list':
        return this.list(options);
      case 'add':
        return this.add(target);
      case 'remove':
        return this.remove(target);
      case 'prune':
        return this.prune();
    }
  }

  private list(options: ReposOptions): void {
    const repos = listRepos({ includeHidden: options.all });
    if (this.jsonMode) {
      this.outputJSON({ repos });
      return;
    }
    if (repos.length === 0) {
      console.log(chalk.gray("No repositories yet. Run kunj inside one, or 'kunj repos add <path>'."));
      return;
    }
    for (const repo of repos) {
      let line = `${chalk.white(repo.name)} ${chalk.gray(repo.root)}`;
      if (repo.bare) line += chalk.gray(' [bare]');
      if (repo.hidden) line += chalk.yellow(' [hidden]');
      if (!repo.exists) line += chalk.red(' [missing]');
      console.log(line);
    }
  }

  private async add(target?: string): Promise<void> {
    const dir = path.resolve(target || process.cwd());
    let commonDir: string;
    try {
      commonDir = await getGitCommonDir(dir);
    } catch {
      throw new Error(`Not a git repository: ${dir}`);
    }
    const repo = addRepo(commonDir);
    if (this.jsonMode) {
      this.outputJSON({ success: true, repo });
      return;
    }
    console.log(chalk.green(`✓ Added ${repo.name} (${repo.root})`));
  }

  private remove(target?: string): void {
    if (!target) {
      throw new Error('Usage: kunj repos remove <path>');
    }
    const repo = hideRepo(path.resolve(target));
    if (!repo) {
      throw new Error(`Not a known repository: ${target}`);
    }
    if (this.jsonMode) {
      this.outputJSON({ success: true, repo });
      return;
    }
    console.log(chalk.green(`✓ Hid ${repo.name}; 'kunj repos add ${repo.root}' brings it back`));
  }

  private prune(): void {
    const removed = pruneRepos();
    if (this.jsonMode) {
      this.outputJSON({ success: true, removed });
      return;
    }
    console.log(removed.length ? chalk.green(`✓ Forgot ${removed.length} missing repositor${removed.length === 1 ? 'y' : 'ies'}`) : chalk.gray('Nothing to prune'));
  }
}
