// Switch command - switch between branches with optional interactive mode

import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, executeGitCommand, getCurrentBranch, getBranchesWithActivity } from '../lib/git';
import { createStash, popStashForBranch, getAllStashesWithBranch } from '../lib/stash';
import { loadBranchMetadata, updateBranchMetadata } from '../lib/metadata';
import { loadConfig } from '../lib/config';
import { isBranchWIP } from '../lib/utils';
import { BranchInfo } from '../types';

interface SwitchOptions {
  stash?: boolean;
  all?: boolean;
  wip?: boolean;
  configured?: boolean;
  create?: boolean;
  desc?: string;
  tag?: string[];
}

export class SwitchCommand extends BaseCommand {
  constructor() {
    super({
      name: 'switch',
      description: 'Switch to a branch (interactive if no branch specified)',
      arguments: '[branch]',
      options: [
        { flags: '--no-stash', description: 'Disable automatic stashing of changes' },
        { flags: '-a, --all', description: 'Show all branches (override filters)' },
        { flags: '-w, --wip', description: 'Show only work-in-progress branches' },
        { flags: '-c, --create', description: 'Create new branch if it doesn\'t exist' },
        { flags: '-d, --desc <description>', description: 'Set description when creating branch' },
        { flags: '-t, --tag <tags...>', description: 'Add tags when creating branch' },
        { flags: '--configured', description: 'Show only configured branches' }
      ]
    });
  }

  async execute(targetBranch?: string, options: SwitchOptions = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    const currentBranch = await getCurrentBranch();

    // If branch specified, switch directly (or create if -c flag is used)
    if (targetBranch) {
      await this.switchToBranch(targetBranch, currentBranch, options);
    } else if (options.create) {
      // If -c flag is used without branch name, prompt for new branch name
      const { branchName } = await inquirer.prompt([{
        type: 'input',
        name: 'branchName',
        message: 'Enter new branch name:',
        validate: (input: string) => {
          if (!input.trim()) {
            return 'Branch name is required';
          }
          return true;
        }
      }]);

      await this.createAndSwitchToBranch(branchName, currentBranch, options);
    } else {
      // Interactive mode
      await this.interactiveSwitch(currentBranch, options);
    }
  }

  private async switchToBranch(
    targetBranch: string,
    currentBranch: string,
    options: SwitchOptions
  ): Promise<void> {
    if (currentBranch === targetBranch) {
      console.log(chalk.yellow(`Already on branch '${targetBranch}'`));
      return;
    }

    // Check if branch exists
    const checkResult = await executeGitCommand(`git show-ref --verify --quiet refs/heads/${targetBranch}`);
    const branchExists = checkResult.success;

    if (!branchExists && options.create) {
      // Branch doesn't exist and -c flag was used, create it
      await this.createAndSwitchToBranch(targetBranch, currentBranch, options);
      return;
    } else if (!branchExists) {
      // Branch doesn't exist and no -c flag
      console.error(chalk.red(`✗ Branch '${targetBranch}' does not exist`));
      console.log(chalk.gray(`Tip: Use -c flag to create and switch: kunj switch -c ${targetBranch}`));
      process.exit(1);
    }

    const config = loadConfig();
    console.log(chalk.blue(`Switching to branch '${targetBranch}'...`));

    // Use config autoStash preference unless explicitly overridden
    const shouldStash = options.stash !== false && config.preferences.autoStash;
    if (shouldStash && currentBranch) {
      await createStash(currentBranch);
    }

    // Switch to the target branch
    const result = await executeGitCommand(`git switch ${targetBranch}`);

    if (result.success) {
      console.log(
        chalk.green(`✓ Successfully switched to branch '${targetBranch}'`)
      );

      // Update metadata for both branches
      updateBranchMetadata(targetBranch, {
        lastSwitched: new Date().toISOString()
      });

      if (currentBranch) {
        updateBranchMetadata(currentBranch, {
          lastSwitched: new Date().toISOString()
        });
      }

      // Try to pop stash for the target branch
      if (shouldStash) {
        await popStashForBranch(targetBranch);
      }
    } else {
      console.error(chalk.red(`✗ Failed to switch: ${result.message}`));
      process.exit(1);
    }
  }

  private async interactiveSwitch(
    currentBranch: string,
    options: SwitchOptions
  ): Promise<void> {
    const config = loadConfig();
    const branchMetadata = loadBranchMetadata();

    // Get branches sorted by preference
    let branches = await getBranchesWithActivity(config.preferences.branchSort);

    if (branches.length === 0) {
      console.log(chalk.yellow("No branches found"));
      process.exit(0);
    }

    // Apply filters unless --all is specified
    if (!options.all) {
      branches = await this.applyFilters(branches, config, currentBranch, options);
    }

    if (branches.length === 0) {
      this.showNoResultsMessage(options, config);
      process.exit(0);
    }

    // Get all stashes with their branch associations
    const allStashes = await getAllStashesWithBranch();

    // Build branch choices for interactive menu
    const branchChoices = await this.buildBranchChoices(
      branches,
      currentBranch,
      config,
      branchMetadata,
      allStashes
    );

    // Prompt user to select a branch
    const { selectedBranch } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedBranch',
        message: 'Select a branch to switch to:',
        choices: branchChoices,
        pageSize: config.preferences.pageSize
      }
    ]);

    // Switch to selected branch
    await this.switchToBranch(selectedBranch, currentBranch, options);
  }

  private async applyFilters(
    branches: BranchInfo[],
    config: any,
    currentBranch: string,
    options: SwitchOptions
  ): Promise<BranchInfo[]> {
    const branchMetadata = loadBranchMetadata();

    // Apply configured filter
    if (options.configured || config.preferences.showOnlyConfigured) {
      branches = branches.filter(branch =>
        branchMetadata.branches[branch.name] !== undefined
      );
    }

    // Apply WIP filter
    if (options.wip || config.preferences.showOnlyWIP) {
      const filteredBranches = [];
      for (const branch of branches) {
        if (await isBranchWIP(branch.name, config, currentBranch)) {
          filteredBranches.push(branch);
        }
      }
      branches = filteredBranches;
    }

    return branches;
  }

  private async buildBranchChoices(
    branches: BranchInfo[],
    currentBranch: string,
    config: any,
    branchMetadata: any,
    allStashes: Map<string, any[]>
  ): Promise<any[]> {
    return branches.map((branch) => {
      const isCurrent = branch.name === currentBranch;
      const branchStashes = allStashes.get(branch.name);
      const metadata = branchMetadata.branches[branch.name] || {};

      // Build branch display name with metadata
      let displayName = isCurrent
        ? `${chalk.green("●")} ${branch.name} ${chalk.gray("(current)")}`
        : `  ${branch.name}`;

      // Add alias if exists
      const branchAlias = config.aliases[branch.name];
      if (branchAlias) {
        displayName += chalk.magenta(` [${branchAlias}]`);
      }

      // Add description if exists
      if (metadata.description) {
        displayName += chalk.cyan(` - ${metadata.description}`);
      } else if (branch.lastActivity) {
        displayName += chalk.dim(` - ${branch.lastActivity}`);
      }

      // Add tags if exist
      if (metadata.tags && metadata.tags.length > 0) {
        const tagStr = metadata.tags.map((tag: string) => `#${tag}`).join(" ");
        displayName += chalk.cyan(` ${tagStr}`);
      }

      // Add stash indicator if there are stashes
      if (branchStashes && branchStashes.length > 0) {
        const stashInfo = branchStashes.map(s => {
          const details = s.details.replace(/[()]/g, '').trim();
          return details || 'stashed changes';
        }).join(', ');
        displayName += chalk.yellow(` 📦 [${stashInfo}]`);
      }

      return {
        name: displayName,
        value: branch.name,
        short: branch.name,
      };
    });
  }

  private showNoResultsMessage(options: SwitchOptions, config: any): void {
    if (options.configured || config.preferences.showOnlyConfigured) {
      console.log(chalk.yellow("No configured branches found"));
      console.log(chalk.gray("Tip: Use 'kunj branch-desc <branch>' to configure a branch"));
      console.log(chalk.gray("     Use 'kunj switch --all' to see all branches"));
    } else if (options.wip || config.preferences.showOnlyWIP) {
      console.log(chalk.yellow("No work-in-progress branches found"));
      console.log(chalk.gray("Tip: Use 'kunj switch --all' to see all branches"));
    } else {
      console.log(chalk.yellow("No branches found"));
    }
  }

  private async createAndSwitchToBranch(
    branchName: string,
    currentBranch: string,
    options: SwitchOptions
  ): Promise<void> {
    const config = loadConfig();

    console.log(chalk.blue(`Creating branch '${branchName}' and switching to it...`));

    // Use config autoStash preference unless explicitly overridden
    const shouldStash = options.stash !== false && config.preferences.autoStash;
    if (shouldStash && currentBranch) {
      await createStash(currentBranch);
    }

    // Create and checkout the branch
    const result = await executeGitCommand(`git switch -c ${branchName}`);

    if (result.success) {
      console.log(
        chalk.green(`✓ Successfully created and switched to branch '${branchName}'`)
      );

      // Save metadata for the new branch
      const metadata: any = {
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

      // Try to pop stash for the new branch (if any exists from before)
      if (shouldStash) {
        await popStashForBranch(branchName);
      }

      console.log(chalk.gray("\nTip: Add notes with 'kunj branch-note'"));
    } else {
      console.error(chalk.red(`✗ Failed to create branch: ${result.message}`));
      process.exit(1);
    }
  }
}