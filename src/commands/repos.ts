// Repos command - the repositories kunj knows about (src/lib/repos.ts).
//
//   kunj repos                  list known repositories
//   kunj repos add [path]       add a repository (default: the current one)
//   kunj repos remove <path>    hide a repository from the list
//   kunj repos prune            forget repositories whose directory is gone
//   kunj repos github           GitHub repositories you can clone (through gh)
//   kunj repos clone <repo>     clone one into repos.cloneDir and add it
//
// The macOS menu bar app reads `kunj repos --json` to know what to show.

import chalk from 'chalk';
import type { GitHubReposJson, RepoCloneJson, ReposJson } from '../lib/json-types';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getGitCommonDir } from '../lib/worktree';
import { addRepo, hideRepo, listRepos, pruneRepos, getReposPath } from '../lib/repos';
import type { KnownRepoInfo } from '../lib/repos';
import { kunjDirName } from '../lib/repo-identity';
import { cloneRepo, expandCloneDir, githubRepoKey, listGitHubRepos, localReposByRemote } from '../lib/github-repos';
import { loadConfig } from '../lib/config';
import { defaultWorktreePathFor } from '../lib/worktree';

interface ReposOptions {
  all?: boolean;
  owner?: string;
  dir?: string;
  bare?: boolean;
}

const ACTIONS = ['list', 'add', 'remove', 'prune', 'github', 'clone'];

export class ReposCommand extends BaseCommand {
  constructor() {
    super({
      name: 'repos',
      description: 'List the repositories kunj has been used in, and clone more from GitHub',
      arguments: '[action] [path]',
      options: [
        { flags: '-a, --all', description: '[list] Include hidden repositories; [github] include archived ones' },
        { flags: '--owner <login>', description: '[github] Only repositories of this user or organisation' },
        { flags: '--dir <path>', description: '[clone] Clone into this directory instead of repos.cloneDir' },
        { flags: '--bare', description: '[clone] Bare clone with a worktree for the default branch' },
        { flags: '--no-bare', description: '[clone] Normal clone, whatever repos.cloneBare says' },
      ],
      helpText: () =>
        [
          'Actions:',
          '  list (default)   Known repositories, most recently used first',
          '  add [path]       Add the repository containing path (default: current directory)',
          '  remove <path>    Hide a repository; it stays hidden until added again',
          '  prune            Forget repositories whose directory no longer exists',
          '  github           GitHub repositories you can clone (via gh), marking those already here',
          '  clone <repo>     Clone owner/name (or a URL) into repos.cloneDir and add it',
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
      case 'github':
        return this.github(options);
      case 'clone':
        return this.clone(target, options);
    }
  }

  private list(options: ReposOptions): void {
    const repos = listRepos({ includeHidden: options.all });
    if (this.jsonMode) {
      this.outputJSON(reposJson(repos));
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

  private async github(options: ReposOptions): Promise<void> {
    const local = localReposByRemote(listRepos({ includeHidden: true }));
    const owner = options.owner?.toLowerCase();
    const repos = (await listGitHubRepos())
      .filter(r => options.all || !r.archived)
      .filter(r => !owner || r.owner.toLowerCase() === owner)
      .map(r => ({ ...r, local: local.get(githubRepoKey(r) ?? '') ?? null }));
    if (this.jsonMode) {
      this.outputJSON({ repos } satisfies GitHubReposJson);
      return;
    }
    if (repos.length === 0) {
      console.log(chalk.gray('No GitHub repositories found.'));
      return;
    }
    for (const r of repos) {
      let line = r.local ? chalk.green(r.fullName) : chalk.white(r.fullName);
      if (r.private) line += chalk.gray(' [private]');
      if (r.fork) line += chalk.gray(' [fork]');
      if (r.archived) line += chalk.yellow(' [archived]');
      if (r.local) line += chalk.gray(` ✓ ${r.local}`);
      if (r.description) line += `\n  ${chalk.gray(r.description)}`;
      console.log(line);
    }
    console.log(chalk.gray(`\n${repos.length} repositories; clone one with 'kunj repos clone <owner/name>'`));
  }

  private async clone(target: string | undefined, options: ReposOptions): Promise<void> {
    if (!target) {
      throw new Error('Usage: kunj repos clone <owner/name | url> [--dir <path>] [--bare | --no-bare]');
    }
    const config = loadConfig();
    const bare = options.bare ?? config.repos?.cloneBare ?? false;
    if (!this.jsonMode) console.log(chalk.gray(`Cloning ${target}…`));
    const result = await cloneRepo(target, {
      cloneDir: options.dir ? path.resolve(options.dir) : expandCloneDir(config.repos?.cloneDir),
      bare,
      worktreePathFor: (branch, commonDir) => defaultWorktreePathFor(branch, config.worktree?.baseDir, commonDir),
    });
    const repo = addRepo(result.commonDir);
    if (this.jsonMode) {
      const json: RepoCloneJson = {
        success: true,
        repo: { ...repo, exists: true, kunjName: kunjDirName(repo) },
        path: result.path,
        bare: result.bare,
        worktree: result.worktree,
      };
      this.outputJSON(json);
      return;
    }
    console.log(chalk.green(`✓ Cloned ${repo.name} to ${result.path}`));
    if (result.worktree) console.log(chalk.gray(`  ${result.worktree}`));
  }
}

export function reposJson(repos: KnownRepoInfo[]): ReposJson {
  return { repos: repos.map(r => ({ ...r, kunjName: kunjDirName(r) })) };
}
