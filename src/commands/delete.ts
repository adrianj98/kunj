// Delete command - delete a git branch

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, getCurrentBranch, executeGitCommand } from '../lib/git';

interface DeleteOptions {
  force?: boolean;
}

export class DeleteCommand extends BaseCommand {
  constructor() {
    super({
      name: 'delete <branch>',
      description: 'Delete a branch',
      options: [
        { flags: '-f, --force', description: 'Force delete the branch' }
      ]
    });
  }

  async execute(branchName: string, options: DeleteOptions = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    const currentBranch = await getCurrentBranch();

    // Check if trying to delete current branch
    if (branchName === currentBranch) {
      console.error(
        chalk.red(`✗ Cannot delete the current branch '${branchName}'`)
      );
      console.log(chalk.yellow("Tip: Switch to another branch first"));
      process.exit(1);
    }

    const deleteFlag = options.force ? "-D" : "-d";
    console.log(chalk.blue(`Deleting branch '${branchName}'...`));

    const result = await executeGitCommand(
      `git branch ${deleteFlag} ${branchName}`
    );

    if (result.success) {
      console.log(
        chalk.green(`✓ Successfully deleted branch '${branchName}'`)
      );
    } else {
      if (result.message.includes("not found")) {
        console.error(chalk.red(`✗ Branch '${branchName}' does not exist`));
      } else if (result.message.includes("not fully merged")) {
        console.error(
          chalk.red(`✗ Branch '${branchName}' is not fully merged`)
        );
        console.log(chalk.yellow("Tip: Use --force flag to force delete"));
      } else {
        console.error(
          chalk.red(`✗ Failed to delete branch: ${result.message}`)
        );
      }
      process.exit(1);
    }
  }
}