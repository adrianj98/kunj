// Stash command - Stash changes with AI-generated messages

import chalk from 'chalk';
import inquirer from 'inquirer';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, getFileStatuses } from '../lib/git';
import { generateStashMessage } from '../lib/ai-commit';

const execAsync = promisify(exec);

interface StashOptions {
  list?: boolean;
  pop?: boolean;
  apply?: number;
  drop?: number;
  message?: string;
  includeUntracked?: boolean;
}

export class StashCommand extends BaseCommand {
  constructor() {
    super({
      name: 'stash',
      description: 'Stash changes with AI-generated messages',
      arguments: '[action]',
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
      ],
    });
  }

  async execute(action?: string, options: StashOptions = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red('Error: Not a git repository'));
      process.exit(1);
    }

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

      // Create the stash
      const includeUntrackedFlag = options.includeUntracked ? ' --include-untracked' : '';
      const { stdout } = await execAsync(
        `git stash push${includeUntrackedFlag} -m "${stashMessage.replace(/"/g, '\\"')}"`
      );

      console.log(chalk.green('\n✓ Changes stashed successfully!'));
      if (stdout.trim()) {
        console.log(chalk.gray(stdout.trim()));
      }

      // Show stash list
      console.log(chalk.cyan('\n📋 Current stashes:'));
      await this.listStashes();
    } catch (error: any) {
      console.error(chalk.red('Failed to create stash:'), error.message);
      process.exit(1);
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

      stashes.forEach((stash) => {
        // Parse stash line: stash@{0}: On branch-name: message
        const match = stash.match(/^(stash@\{(\d+)\}):\s+(.+)$/);
        if (match) {
          const [, stashRef, index, description] = match;
          const color = parseInt(index) === 0 ? chalk.green : chalk.white;
          console.log(color(`  ${stashRef}: ${description}`));
        } else {
          console.log(chalk.gray(`  ${stash}`));
        }
      });

      console.log(chalk.gray('\n💡 Tip: Use "kunj stash pop" to apply the latest stash'));
      console.log(chalk.gray('     Use "kunj stash --apply <index>" to apply a specific stash'));
    } catch (error: any) {
      // If git stash list fails, it means no stashes exist
      if (error.message.includes('No stash entries')) {
        console.log(chalk.gray('No stashes found'));
      } else {
        console.error(chalk.red('Failed to list stashes:'), error.message);
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
      if (error.message.includes('CONFLICT')) {
        console.error(chalk.red('⚠ Merge conflicts occurred while popping stash'));
        console.log(chalk.yellow('Please resolve conflicts manually'));
      } else {
        console.error(chalk.red('Failed to pop stash:'), error.message);
      }
      process.exit(1);
    }
  }

  private async applyStash(index: number): Promise<void> {
    try {
      const stashRef = `stash@{${index}}`;

      // Check if stash exists
      try {
        await execAsync(`git stash show ${stashRef}`);
      } catch {
        console.error(chalk.red(`Error: Stash ${stashRef} does not exist`));
        console.log(chalk.gray('Use "kunj stash --list" to see available stashes'));
        process.exit(1);
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
      if (error.message.includes('CONFLICT')) {
        console.error(chalk.red('⚠ Merge conflicts occurred while applying stash'));
        console.log(chalk.yellow('Please resolve conflicts manually'));
      } else {
        console.error(chalk.red('Failed to apply stash:'), error.message);
      }
      process.exit(1);
    }
  }

  private async dropStash(index: number): Promise<void> {
    try {
      const stashRef = `stash@{${index}}`;

      // Check if stash exists
      try {
        await execAsync(`git stash show ${stashRef}`);
      } catch {
        console.error(chalk.red(`Error: Stash ${stashRef} does not exist`));
        console.log(chalk.gray('Use "kunj stash --list" to see available stashes'));
        process.exit(1);
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
      console.error(chalk.red('Failed to drop stash:'), error.message);
      process.exit(1);
    }
  }
}
