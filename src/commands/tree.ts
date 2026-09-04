// Tree command - manage git worktrees and "keep" files shared across them

import chalk from 'chalk';
import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { checkGitRepo } from '../lib/git';
import { loadConfig } from '../lib/config';
import {
  WorktreeInfo,
  createWorktree,
  findWorktreeForBranch,
  getCurrentWorktreeRoot,
  getWorktreePathForBranch,
  listWorktrees,
  openWorktree,
  removeWorktree,
  resolveWorktreeDir,
} from '../lib/worktree';
import {
  applyKeptFiles,
  deleteKeptFile,
  getKeepDir,
  keepFile,
  listKeptFiles,
  toRelativeKeepPath,
} from '../lib/keep';

interface TreeOptions {
  newWindow?: boolean;
  path?: boolean;
  all?: boolean;
  force?: boolean;
}


export class TreeCommand extends BaseCommand {
  constructor() {
    super({
      name: 'tree',
      description: 'Create/switch git worktrees and manage keep files (tree <branch> | tree keep ...)',
      arguments: '[action] [args...]',
      options: [
        { flags: '-n, --new-window', description: 'Open the worktree in a new editor window' },
        { flags: '-p, --path', description: 'Print only the worktree path (for shell integration), do not open an editor' },
        { flags: '-a, --all', description: 'With "keep apply": apply keep files to all worktrees' },
        { flags: '-f, --force', description: 'With "remove": remove even if the worktree has changes' },
      ],
    });
  }

  private pathOnly = false;

  // In --path mode stdout must contain only the path, so progress goes to stderr
  protected log(message: string): void {
    if (this.pathOnly) {
      if (!this.jsonMode) process.stderr.write(message + '\n');
      return;
    }
    super.log(message);
  }

  async execute(action?: string, args: string[] = [], options: TreeOptions = {}): Promise<void> {
    this.pathOnly = options.path === true;
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red('Error: Not a git repository'));
      process.exit(1);
    }

    switch (action) {
      case undefined:
        await this.interactiveWorktrees(options);
        return;
      case 'keep':
        await this.handleKeep(args, options);
        return;
      case 'list':
      case 'ls':
        await this.listWorktrees();
        return;
      case 'remove':
      case 'rm':
        await this.removeWorktree(args[0], options);
        return;
      default:
        await this.openOrCreate(action, options);
    }
  }

  // ---------------------------------------------------------------------------
  // Worktrees
  // ---------------------------------------------------------------------------

  private async openOrCreate(branch: string, options: TreeOptions): Promise<void> {
    const config = loadConfig();
    const existing = await findWorktreeForBranch(branch);

    let targetPath: string;
    let created = false;
    let createdBranch = false;
    let baseBranch: string | undefined;
    let applied: string[] = [];

    if (existing) {
      targetPath = existing.path;
      this.log(chalk.gray(`Worktree for ${chalk.cyan(branch)} already exists`));
    } else {
      targetPath = getWorktreePathForBranch(branch, config);
      this.log(chalk.blue(`Creating worktree for ${chalk.cyan(branch)} at ${chalk.gray(targetPath)}...`));
      const result = await createWorktree(branch, targetPath);
      created = true;
      createdBranch = result.createdBranch;
      baseBranch = result.baseBranch;
      if (createdBranch) {
        this.log(chalk.green(`✓ Created branch ${branch} from ${baseBranch}`));
      }
      this.log(chalk.green('✓ Worktree created'));

      applied = applyKeptFiles(targetPath);
      if (applied.length > 0) {
        this.log(chalk.green(`✓ Applied ${applied.length} keep file(s):`));
        applied.forEach(f => this.log(chalk.gray(`  - ${f}`)));
      }
    }

    if (options.path) {
      process.stdout.write(targetPath + '\n');
      return;
    }

    let opened = false;
    const openCommand = config.worktree?.openCommand ?? 'code';
    if (openCommand.trim()) {
      opened = await openWorktree(openCommand, targetPath, {
        newWindow: options.newWindow,
        existing: !created,
      });
      if (!opened && !this.jsonMode) {
        console.error(chalk.yellow(`Could not run "${openCommand}" – set worktree.openCommand to a valid editor command`));
      }
    }

    if (this.jsonMode) {
      this.outputJSON({ branch, path: targetPath, created, createdBranch, baseBranch, keepFilesApplied: applied, opened });
      return;
    }

    if (opened) {
      const where = options.newWindow ? 'a new window' : created ? 'this window' : 'its window';
      this.log(chalk.green(`✓ Opened ${chalk.cyan(branch)} in ${where}`));
    }
    this.log(chalk.gray(`\n  cd ${targetPath}`));
    this.log(chalk.gray(`  (tip: kt() { cd "$(kunj tree -p "$1")"; }  →  kt ${branch})`));
  }

  private async listWorktrees(): Promise<void> {
    const worktrees = await listWorktrees();
    if (this.jsonMode) {
      this.outputJSON({ worktrees });
      return;
    }
    const current = await getCurrentWorktreeRoot();
    this.printWorktrees(worktrees, current);
  }

  private printWorktrees(worktrees: WorktreeInfo[], current: string): void {
    if (worktrees.length === 0) {
      this.log(chalk.gray('No worktrees found'));
      return;
    }
    this.log(chalk.cyan(`\n🌳 Worktrees (${worktrees.length}):\n`));
    for (const w of worktrees) {
      const marker = w.path === current ? chalk.green('*') : ' ';
      const name = w.branch ? chalk.white(w.branch) : chalk.gray(`(detached ${w.head.slice(0, 7)})`);
      const flags = [w.locked ? chalk.yellow('locked') : '', w.prunable ? chalk.red('prunable') : ''].filter(Boolean).join(' ');
      this.log(`${marker} ${name}  ${chalk.gray(w.path)} ${flags}`);
    }
    this.log('');
  }

  private async interactiveWorktrees(options: TreeOptions): Promise<void> {
    const worktrees = await listWorktrees();
    if (this.jsonMode) {
      this.outputJSON({ worktrees });
      return;
    }
    const current = await getCurrentWorktreeRoot();
    const config = loadConfig();

    const choices: any[] = worktrees.map(w => ({
      name: `${w.path === current ? chalk.green('* ') : '  '}${w.branch ?? chalk.gray('(detached)')}  ${chalk.gray(w.path)}`,
      value: { type: 'open', worktree: w },
      short: w.branch ?? w.path,
    }));
    choices.push(new inquirer.Separator());
    choices.push({ name: chalk.green('+ Create a new worktree'), value: { type: 'create' } });
    choices.push({ name: chalk.red('- Remove a worktree'), value: { type: 'remove' } });
    choices.push({ name: chalk.gray('Cancel'), value: { type: 'cancel' } });

    const { choice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'choice',
        message: `Worktrees (base: ${resolveWorktreeDir(config)})`,
        choices,
        pageSize: config.preferences.pageSize,
      },
    ]);

    switch (choice.type) {
      case 'open':
        await this.openOrCreate(choice.worktree.branch ?? choice.worktree.path, options);
        return;
      case 'create': {
        const { branch } = await inquirer.prompt([
          {
            type: 'input',
            name: 'branch',
            message: 'Branch name for the new worktree:',
            validate: (input: string) => (input.trim() ? true : 'Branch name is required'),
          },
        ]);
        await this.openOrCreate(branch.trim(), options);
        return;
      }
      case 'remove': {
        const removable = worktrees.filter(w => w.path !== current);
        if (removable.length === 0) {
          this.log(chalk.yellow('No other worktrees to remove'));
          return;
        }
        const { target } = await inquirer.prompt([
          {
            type: 'list',
            name: 'target',
            message: 'Remove which worktree?',
            choices: [
              ...removable.map(w => ({ name: `${w.branch ?? '(detached)'}  ${chalk.gray(w.path)}`, value: w })),
              { name: chalk.gray('Cancel'), value: null },
            ],
          },
        ]);
        if (target) {
          await this.removeWorktree(target.branch ?? target.path, options);
        }
        return;
      }
      default:
        return;
    }
  }

  private async removeWorktree(target: string | undefined, options: TreeOptions): Promise<void> {
    if (!target) {
      console.error(chalk.red('Error: specify a branch or path to remove'));
      process.exit(1);
    }
    const worktrees = await listWorktrees();
    const worktree =
      worktrees.find(w => w.branch === target) ?? worktrees.find(w => path.resolve(w.path) === path.resolve(target));
    if (!worktree) {
      console.error(chalk.red(`Error: no worktree found for "${target}"`));
      process.exit(1);
    }
    const current = await getCurrentWorktreeRoot();
    if (path.resolve(worktree.path) === path.resolve(current)) {
      console.error(chalk.red('Error: cannot remove the worktree you are currently in'));
      process.exit(1);
    }

    if (!this.jsonMode) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Remove worktree ${worktree.branch ?? ''} at ${worktree.path}? (the branch is kept)`,
          default: false,
        },
      ]);
      if (!confirm) {
        this.log(chalk.yellow('Cancelled'));
        return;
      }
    }

    await removeWorktree(worktree.path, options.force);
    if (this.jsonMode) {
      this.outputJSON({ removed: worktree });
      return;
    }
    this.log(chalk.green(`✓ Removed worktree ${worktree.path}`));
  }

  // ---------------------------------------------------------------------------
  // Keep files
  // ---------------------------------------------------------------------------

  private async handleKeep(args: string[], options: TreeOptions): Promise<void> {
    const [sub, ...rest] = args;

    if (sub === undefined) {
      await this.keepMenu(options);
      return;
    }

    switch (sub) {
      case 'apply':
      case 'restore':
        await this.keepApply(options.all === true);
        return;
      case 'delete':
      case 'rm':
      case 'remove':
        await this.keepDelete(rest);
        return;
      case 'list':
      case 'ls':
        this.keepList();
        return;
      default:
        await this.keepAdd([sub, ...rest]);
    }
  }

  private keepList(): void {
    const files = listKeptFiles();
    if (this.jsonMode) {
      this.outputJSON({ keepDir: getKeepDir(), files });
      return;
    }
    if (files.length === 0) {
      this.log(chalk.gray(`No keep files (store: ${getKeepDir()})`));
      return;
    }
    this.log(chalk.cyan(`\n📌 Keep files (${files.length}) in ${chalk.gray(getKeepDir())}:\n`));
    files.forEach(f => this.log(`  ${f}`));
    this.log('');
  }

  private async keepAdd(files: string[]): Promise<void> {
    const root = await getCurrentWorktreeRoot();
    const saved: string[] = [];
    for (const file of files) {
      const relative = toRelativeKeepPath(file, root);
      const dest = keepFile(relative, root);
      saved.push(relative);
      this.log(chalk.green(`✓ Kept ${relative}`) + chalk.gray(`  → ${dest}`));
    }
    if (this.jsonMode) {
      this.outputJSON({ kept: saved, keepDir: getKeepDir() });
    }
  }

  private async keepApply(all: boolean): Promise<void> {
    const files = listKeptFiles();
    if (files.length === 0) {
      this.log(chalk.yellow('No keep files to apply'));
      if (this.jsonMode) this.outputJSON({ applied: {} });
      return;
    }

    const targets = all ? (await listWorktrees()).map(w => w.path) : [await getCurrentWorktreeRoot()];
    const summary: Record<string, string[]> = {};
    for (const target of targets) {
      if (!fs.existsSync(target)) {
        this.log(chalk.yellow(`Skipping missing worktree ${target}`));
        continue;
      }
      const applied = applyKeptFiles(target);
      summary[target] = applied;
      this.log(chalk.green(`✓ Applied ${applied.length} keep file(s) to ${chalk.gray(target)}`));
      applied.forEach(f => this.log(chalk.gray(`  - ${f}`)));
    }
    if (this.jsonMode) {
      this.outputJSON({ applied: summary });
    }
  }

  private async keepDelete(files: string[]): Promise<void> {
    if (files.length === 0) {
      console.error(chalk.red('Error: specify a file to delete from keep'));
      process.exit(1);
    }
    const root = await getCurrentWorktreeRoot();
    const deleted: string[] = [];
    for (const file of files) {
      // Accept either the stored relative path or a path on disk
      let relative = file.replace(/\\/g, '/');
      try {
        relative = toRelativeKeepPath(file, root);
      } catch {
        // not inside the worktree; treat as a keep-relative path
      }
      if (deleteKeptFile(relative)) {
        deleted.push(relative);
        this.log(chalk.green(`✓ Removed ${relative} from keep`));
      } else {
        this.log(chalk.yellow(`Not in keep: ${relative}`));
      }
    }
    if (this.jsonMode) {
      this.outputJSON({ deleted });
    }
  }

  private async keepMenu(options: TreeOptions): Promise<void> {
    if (this.jsonMode) {
      this.keepList();
      return;
    }
    // Loop until the user cancels
    while (true) {
      const files = listKeptFiles();
      this.log(chalk.cyan(`\n📌 Keep files: ${files.length}  ${chalk.gray(getKeepDir())}`));
      files.slice(0, 15).forEach(f => this.log(chalk.gray(`  - ${f}`)));
      if (files.length > 15) this.log(chalk.gray(`  ... and ${files.length - 15} more`));

      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: 'Add a file to keep', value: 'add' },
            { name: 'Apply keep files to this worktree', value: 'apply' },
            { name: 'Apply keep files to all worktrees', value: 'applyAll' },
            { name: 'Delete a keep file', value: 'delete' },
            { name: 'Show keep files', value: 'list' },
            { name: chalk.gray('Done'), value: 'done' },
          ],
        },
      ]);

      switch (action) {
        case 'add': {
          const { file } = await inquirer.prompt([
            {
              type: 'input',
              name: 'file',
              message: 'File path (relative to the worktree root):',
              validate: (input: string) => (input.trim() ? true : 'A file path is required'),
            },
          ]);
          try {
            await this.keepAdd([file.trim()]);
          } catch (error: any) {
            console.error(chalk.red(error.message));
          }
          break;
        }
        case 'apply':
          await this.keepApply(false);
          break;
        case 'applyAll':
          await this.keepApply(true);
          break;
        case 'delete': {
          if (files.length === 0) {
            this.log(chalk.yellow('Nothing to delete'));
            break;
          }
          const { selected } = await inquirer.prompt([
            {
              type: 'checkbox',
              name: 'selected',
              message: 'Select keep files to delete:',
              choices: files.map(f => ({ name: f, value: f })),
            },
          ]);
          if (selected.length > 0) {
            const { confirm } = await inquirer.prompt([
              { type: 'confirm', name: 'confirm', message: `Delete ${selected.length} keep file(s)?`, default: false },
            ]);
            if (confirm) {
              await this.keepDelete(selected);
            }
          }
          break;
        }
        case 'list':
          this.keepList();
          break;
        default:
          return;
      }
    }
  }
}

