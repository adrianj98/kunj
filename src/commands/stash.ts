// Stash command - Stash changes with AI-generated messages

import chalk from 'chalk';
import inquirer from 'inquirer';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { BaseCommand } from '../lib/command';
import { requireGitRepo, wrapError, getCurrentBranch, getFileStatuses } from '../lib/git';
import { describeError, UserError } from '../lib/errors';
import { generateStashMessage } from '../lib/ai-commit';
import { loadConfig } from '../lib/config';
import { runActionHook } from '../lib/hooks';

const execAsync = promisify(exec);

interface StashOptions {
  list?: boolean;
  pop?: boolean;
  apply?: number;
  drop?: number;
  message?: string;
  includeUntracked?: boolean;
  hooks?: boolean;
}

export class StashCommand extends BaseCommand {
  constructor() {
    super({
      name: 'stash',
      description: 'Stash changes with AI-generated messages',
      arguments: '[action]',
      ui: {
        category: 'data',
        widget: 'table',
        label: 'Stashes',
        icon: 'archive',
        defaultArgs: ['--list'],
        dataKey: 'stashes',
        order: 13,
        columns: [
          { key: 'ref', label: 'Ref' },
          { key: 'description', label: 'Description' },
        ],
      },
      options: [
        {
          flags: '-l, --list',
          description: 'List all stashes',
        },
        {
          flags: '-p, --pop',
          description: 'Pop the latest stash',
        },
        {
          flags: '-a, --apply <index>',
          description: 'Apply a specific stash by index (e.g., stash@{0})',
        },
        {
          flags: '-d, --drop <index>',
          description: 'Drop a specific stash by index',
        },
        {
          flags: '-m, --message <message>',
          description: 'Custom stash message (skips AI generation)',
        },
        {
          flags: '-u, --include-untracked',
          description: 'Include untracked files in stash',
        },
        {
          flags: '--no-hooks',
          description: "Skip kunj hooks (see 'kunj hooks --help')",
        },
      ],
    });
  }

  async execute(action?: string, options: StashOptions = {}): Promise<void> {
    // Check if we're in a git repository
    await requireGitRepo();

    // Handle list flag or "list" action
    if (options.list || action === 'list') {
      await this.listStashes();
      return;
    }

    // Handle pop flag or "pop" action
    if (options.pop || action === 'pop') {
      await this.popStash();
      return;
    }

    // Handle apply flag
    if (options.apply !== undefined) {
      await this.applyStash(options.apply);
      return;
    }

    // Handle drop flag
    if (options.drop !== undefined) {
      await this.dropStash(options.drop);
      return;
    }

    // Default action: create a new stash
    await this.createStash(options);
  }

  private async createStash(options: StashOptions): Promise<void> {
    try {
      // Get changed files
      const statuses = await getFileStatuses();
      const changedFiles = statuses
        .filter((s) => {
          // Include all files except untracked ones (unless includeUntracked is set)
          if (s.status === 'new' && !s.staged) {
            return options.includeUntracked;
          }
          return true;
        })
        .map((s) => s.path);

      if (changedFiles.length === 0) {
        console.log(chalk.yellow('No changes to stash'));
        return;
      }

      console.log(chalk.cyan(`\n📦 Stashing ${changedFiles.length} file(s):\n`));
      changedFiles.slice(0, 10).forEach((file) => {
        console.log(chalk.gray(`  - ${file}`));
      });
      if (changedFiles.length > 10) {
        console.log(chalk.gray(`  ... and ${changedFiles.length - 10} more`));
      }
      console.log();

      let stashMessage: string;

      // Use custom message if provided
      if (options.message) {
        stashMessage = options.message;
        console.log(chalk.gray(`Using custom message: "${stashMessage}"`));
      } else {
        // Generate AI message
        console.log(chalk.blue('🤖 Generating stash message with AI...'));
        const aiMessage = await generateStashMessage(changedFiles);

        if (aiMessage) {
          stashMessage = aiMessage;
          console.log(chalk.green(`✓ Generated: "${stashMessage}"`));
        } else {
          // Fallback to generic message
          stashMessage = `WIP: Changes in ${changedFiles.length} file(s)`;
          console.log(chalk.gray(`Using fallback: "${stashMessage}"`));
        }
      }

      // Ask for confirmation
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Stash these changes?',
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.yellow('Stash cancelled'));
        return;
      }

      const hookOptions = { hooks: loadConfig().hooks, jsonMode: this.jsonMode, skip: options.hooks === false };
      const hookValues = { branch: await getCurrentBranch(), message: stashMessage };

      // A failing pre hook throws and nothing is stashed
      await runActionHook('pre-stash', hookValues, hookOptions);

      // Create the stash
      const includeUntrackedFlag = options.includeUntracked ? ' --include-untracked' : '';
      const { stdout } = await execAsync(
        `git stash push${includeUntrackedFlag} -m "${stashMessage.replace(/"/g, '\\"')}"`
      );

      console.log(chalk.green('\n✓ Changes stashed successfully!'));
      if (stdout.trim()) {
        console.log(chalk.gray(stdout.trim()));
      }

      await runActionHook('post-stash', hookValues, hookOptions);

      // Show stash list; the stash is made, so a failing listing is only a warning
      console.log(chalk.cyan('\n📋 Current stashes:'));
      try {
        await this.listStashes();
      } catch (error) {
        console.error(chalk.yellow(`⚠ The changes are stashed, but listing the stashes failed: ${describeError(error).message}`));
      }
    } catch (error: any) {
      throw wrapError('Could not stash the changes', error);
    }
  }

  private async listStashes(): Promise<void> {
    try {
      const { stdout } = await execAsync('git stash list');

      if (!stdout.trim()) {
        console.log(chalk.gray('No stashes found'));
        return;
      }

      const stashes = stdout.trim().split('\n');

      if (this.jsonMode) {
        const parsed = stashes.map((stash) => {
          const match = stash.match(/^(stash@\{(\d+)\}):\s+(.+)$/);
          if (match) {
            return { ref: match[1], index: parseInt(match[2]), description: match[3] };
          }
          return { ref: stash, index: -1, description: stash };
        });
        this.outputJSON({ stashes: parsed });
        return;
      }

      // Create choices for interactive selection
      const choices = stashes.map((stash) => {
        // Parse stash line: stash@{0}: On branch-name: message
        const match = stash.match(/^(stash@\{(\d+)\}):\s+(.+)$/);
        if (match) {
          const [, stashRef, index, description] = match;
          return {
            name: `${stashRef}: ${description}`,
            value: parseInt(index),
            short: stashRef,
          };
        }
        return {
          name: stash,
          value: -1,
          short: stash,
        };
      });

      // Add cancel option
      choices.push({
        name: chalk.gray('Cancel'),
        value: -999,
        short: 'Cancel',
      });

      // Interactive selection
      const { selectedStash } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedStash',
          message: 'Select a stash:',
          choices,
          pageSize: 15,
        },
      ]);

      if (selectedStash === -999) {
        return;
      }

      // Show actions for selected stash
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: 'Pop (apply and remove)', value: 'pop' },
            { name: 'Apply (keep in stash list)', value: 'apply' },
            { name: 'Show diff', value: 'show' },
            { name: 'Drop (delete)', value: 'drop' },
            { name: chalk.gray('Cancel'), value: 'cancel' },
          ],
        },
      ]);

      switch (action) {
        case 'pop':
          await this.popStashByIndex(selectedStash);
          break;
        case 'apply':
          await this.applyStash(selectedStash);
          break;
        case 'show':
          await this.showStashDiff(selectedStash);
          // After showing, ask if they want to do something else
          const { followUp } = await inquirer.prompt([
            {
              type: 'list',
              name: 'followUp',
              message: 'What next?',
              choices: [
                { name: 'Pop this stash', value: 'pop' },
                { name: 'Apply this stash', value: 'apply' },
                { name: 'Drop this stash', value: 'drop' },
                { name: chalk.gray('Nothing'), value: 'nothing' },
              ],
            },
          ]);
          if (followUp === 'pop') {
            await this.popStashByIndex(selectedStash);
          } else if (followUp === 'apply') {
            await this.applyStash(selectedStash);
          } else if (followUp === 'drop') {
            await this.dropStash(selectedStash);
          }
          break;
        case 'drop':
          await this.dropStash(selectedStash);
          break;
        case 'cancel':
          break;
      }
    } catch (error: any) {
      // If git stash list fails, it means no stashes exist
      if (error.message.includes('No stash entries')) {
        console.log(chalk.gray('No stashes found'));
      } else {
        throw wrapError('Could not list the stashes', error);
      }
    }
  }

  private async popStash(): Promise<void> {
    try {
      // Check if there are any stashes
      const { stdout: listOutput } = await execAsync('git stash list');
      if (!listOutput.trim()) {
        console.log(chalk.yellow('No stashes to pop'));
        return;
      }

      console.log(chalk.blue('Popping latest stash...'));
      const { stdout } = await execAsync('git stash pop');

      console.log(chalk.green('✓ Stash popped successfully!'));
      if (stdout.trim()) {
        console.log(chalk.gray(stdout.trim()));
      }
    } catch (error: any) {
      throw stashFailure('Could not pop the stash', error);
    }
  }

  private async popStashByIndex(index: number): Promise<void> {
    try {
      const stashRef = `stash@{${index}}`;

      // Check if stash exists
      try {
        await execAsync(`git stash show ${stashRef}`);
      } catch {
        throw noStash(stashRef);
      }

      console.log(chalk.blue(`Popping stash ${stashRef}...`));
      const { stdout } = await execAsync(`git stash pop ${stashRef}`);

      console.log(chalk.green(`✓ Stash ${stashRef} popped successfully!`));
      if (stdout.trim()) {
        console.log(chalk.gray(stdout.trim()));
      }
    } catch (error: any) {
      throw stashFailure('Could not pop the stash', error);
    }
  }

  private async showStashDiff(index: number): Promise<void> {
    try {
      const stashRef = `stash@{${index}}`;

      // Check if stash exists
      try {
        await execAsync(`git stash show ${stashRef}`);
      } catch {
        throw noStash(stashRef);
      }

      console.log(chalk.cyan(`\n📋 Stash ${stashRef} diff:\n`));

      // Show the diff with less for scrolling
      const less = spawn('less', ['-R', '-F', '-X'], {
        stdio: ['pipe', process.stdout, process.stderr],
      });

      const { stdout: diff } = await execAsync(`git stash show -p --color=always ${stashRef}`);
      less.stdin.write(diff);
      less.stdin.end();

      await new Promise<void>((resolve, reject) => {
        less.on('close', (code: number) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`less exited with code ${code}`));
          }
        });
        less.on('error', reject);
      });

      console.log(); // Add newline after less exits
    } catch (error: any) {
      throw wrapError('Could not show the stash', error);
    }
  }

  private async applyStash(index: number): Promise<void> {
    try {
      const stashRef = `stash@{${index}}`;

      // Check if stash exists
      try {
        await execAsync(`git stash show ${stashRef}`);
      } catch {
        throw noStash(stashRef);
      }

      console.log(chalk.blue(`Applying stash ${stashRef}...`));
      const { stdout } = await execAsync(`git stash apply ${stashRef}`);

      console.log(chalk.green(`✓ Stash ${stashRef} applied successfully!`));
      if (stdout.trim()) {
        console.log(chalk.gray(stdout.trim()));
      }
      console.log(chalk.gray(`\nNote: Stash ${stashRef} is still in the stash list`));
      console.log(chalk.gray(`Use "kunj stash --drop ${index}" to remove it`));
    } catch (error: any) {
      throw stashFailure('Could not apply the stash', error);
    }
  }

  private async dropStash(index: number): Promise<void> {
    try {
      const stashRef = `stash@{${index}}`;

      // Check if stash exists
      try {
        await execAsync(`git stash show ${stashRef}`);
      } catch {
        throw noStash(stashRef);
      }

      // Get stash description
      const { stdout: stashInfo } = await execAsync(`git stash list | grep "${stashRef}"`);

      // Confirm deletion
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Drop ${stashRef}?\n  ${chalk.gray(stashInfo.trim())}\n `,
          default: false,
        },
      ]);

      if (!confirm) {
        console.log(chalk.yellow('Drop cancelled'));
        return;
      }

      await execAsync(`git stash drop ${stashRef}`);

      console.log(chalk.green(`✓ Stash ${stashRef} dropped`));
    } catch (error: any) {
      throw wrapError('Could not drop the stash', error);
    }
  }
}

function noStash(stashRef: string): UserError {
  return new UserError(`There is no stash ${stashRef}.`, 'Run `kunj stash --list` to see the stashes.');
}

// A pop or apply that stopped on conflicts has still changed the working tree: say so
function stashFailure(what: string, error: any): Error {
  const output = `${error?.stdout ?? ''}${error?.message ?? ''}`;
  if (output.includes('CONFLICT')) {
    return new UserError(
      'The stash was applied with merge conflicts; it is still in the stash list.',
      'Resolve the conflicts and `git add` the files, then drop the stash with `kunj stash --drop <index>`.',
    );
  }
  return wrapError(what, error);
}
