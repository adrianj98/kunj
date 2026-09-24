// Delete command - delete a git branch

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, getCurrentBranch, executeGitCommand } from '../lib/git';
import { loadConfig } from '../lib/config';
import { runActionHook } from '../lib/hooks';

interface DeleteOptions {
  force?: boolean;
  hooks?: boolean;
}

export class DeleteCommand extends BaseCommand {
  constructor() {
    super({
      name: 'delete <branch>',
      description: 'Delete a branch',
      ui: { category: 'action', widget: 'form-only', label: 'Delete Branch', icon: 'trash', order: 21 },
      options: [
        { flags: '-f, --force', description: 'Force delete the branch' },
        { flags: '--no-hooks', description: 'Skip the kunj hooks' }
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

    const hookOptions = { hooks: loadConfig().hooks, jsonMode: this.jsonMode, skip: options.hooks === false };
    const hookValues = { branch: branchName };

    // A failing pre hook throws and nothing is deleted
    await runActionHook('pre-branch-delete', hookValues, hookOptions);

    const deleteFlag = options.force ? "-D" : "-d";
    console.log(chalk.blue(`Deleting branch '${branchName}'...`));

    const result = await executeGitCommand(
      `git branch ${deleteFlag} ${branchName}`
    );

    if (result.success) {
      await runActionHook('post-branch-delete', hookValues, hookOptions);

      if (this.jsonMode) {
        this.outputJSON({ success: true, branch: branchName, force: !!options.force });
        return;
      }
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