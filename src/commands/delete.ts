// Delete command - delete a git branch

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { requireGitRepo, gitCommandError, getCurrentBranch, executeGitCommand } from '../lib/git';
import { UserError } from '../lib/errors';
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
        { flags: '--no-hooks', description: "Skip kunj hooks (see 'kunj hooks --help')" }
      ]
    });
  }

  async execute(branchName: string, options: DeleteOptions = {}): Promise<void> {
    // Check if we're in a git repository
    await requireGitRepo();

    const currentBranch = await getCurrentBranch();

    // Check if trying to delete current branch
    if (branchName === currentBranch) {
      throw new UserError(
        `${branchName} is the branch you are on, so it cannot be deleted.`,
        'Switch to another branch first (`kunj switch <branch>`).',
      );
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
        throw new UserError(`There is no local branch named ${branchName}.`, 'Run `kunj list` to see the branches.');
      }
      if (result.message.includes("not fully merged")) {
        throw new UserError(
          `${branchName} has commits that are not merged into the current branch.`,
          `Delete it anyway with \`kunj delete ${branchName} --force\` (those commits are lost unless pushed).`,
        );
      }
      throw gitCommandError(`Could not delete ${branchName}`, result.message);
    }
  }
}