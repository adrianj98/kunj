// Create command - creates a new branch and switches to it

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, executeGitCommand, getCurrentBranch } from '../lib/git';
import { createStash } from '../lib/stash';
import { updateBranchMetadata } from '../lib/metadata';
import { loadConfig } from '../lib/config';
import { BranchMetadata } from '../types';

interface CreateOptions {
  stash?: boolean;
  desc?: string;
  tag?: string[];
}

export class CreateCommand extends BaseCommand {
  constructor() {
    super({
      name: 'create <branch>',
      description: 'Create a new branch and switch to it',
      options: [
        { flags: '--no-stash', description: 'Disable automatic stashing of changes' },
        { flags: '-d, --desc <description>', description: 'Set a description for the new branch' },
        { flags: '-t, --tag <tags...>', description: 'Add tags to the new branch' }
      ]
    });
  }

  async execute(branchName: string, options: CreateOptions): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    // Load configuration
    const config = loadConfig();

    console.log(
      chalk.blue(`Creating branch '${branchName}' and switching to it...`)
    );

    // Get current branch before creating new one
    const currentBranch = await getCurrentBranch();

    // Use config autoStash preference unless explicitly overridden
    const shouldStash = options.stash !== false && config.preferences.autoStash;
    if (shouldStash) {
      await createStash(currentBranch);
    }

    // Create and checkout the branch
    const result = await executeGitCommand(`git switch -c ${branchName}`);

    if (result.success) {
      console.log(
        chalk.green(
          `✓ Successfully created and switched to branch '${branchName}'`
        )
      );

      // Save metadata for the new branch if provided
      const metadata: Partial<BranchMetadata> = {
        lastSwitched: new Date().toISOString()
      };

      if (options.desc) {
        metadata.description = options.desc;
        console.log(chalk.cyan(`  Description: ${options.desc}`));
      }

      if (options.tag && options.tag.length > 0) {
        metadata.tags = options.tag;
        console.log(chalk.cyan(`  Tags: ${options.tag.join(', ')}`));
      }

      updateBranchMetadata(branchName, metadata);

      // Update last switched time for previous branch
      if (currentBranch) {
        updateBranchMetadata(currentBranch, {
          lastSwitched: new Date().toISOString()
        });
      }

      console.log(chalk.gray("\nTip: Add notes with 'kunj branch-note'"));
    } else {
      console.error(chalk.red(`✗ Failed to create branch: ${result.message}`));
      process.exit(1);
    }
  }
}