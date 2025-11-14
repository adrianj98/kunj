// List command - list all branches with metadata and stash information

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, getCurrentBranch, getBranchesWithActivity } from '../lib/git';
import { getAllStashesWithBranch } from '../lib/stash';
import { loadBranchMetadata } from '../lib/metadata';
import { loadConfig } from '../lib/config';
import { isBranchWIP, getRelativeTime } from '../lib/utils';
import { BranchInfo } from '../types';

interface ListOptions {
  all?: boolean;
  wip?: boolean;
  configured?: boolean;
  verbose?: boolean;
}

export class ListCommand extends BaseCommand {
  constructor() {
    super({
      name: 'list',
      description: 'List all branches with their metadata and stashed changes',
      options: [
        { flags: '-a, --all', description: 'Show all branches (override filters)' },
        { flags: '-w, --wip', description: 'Show only work-in-progress branches' },
        { flags: '-c, --configured', description: 'Show only configured branches' },
        { flags: '-v, --verbose', description: 'Show detailed information including notes' }
      ]
    });
  }

  async execute(options: ListOptions = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    const config = loadConfig();
    const currentBranch = await getCurrentBranch();
    const branchMetadata = loadBranchMetadata();

    // Get branches sorted by preference
    let branches = await getBranchesWithActivity(config.preferences.branchSort);

    if (branches.length === 0) {
      console.log(chalk.yellow("No branches found"));
      return;
    }

    // Apply filters unless --all is specified
    if (!options.all) {
      branches = await this.applyFilters(branches, config, currentBranch, options);
    }

    if (branches.length === 0) {
      this.showNoResultsMessage(options, config);
      return;
    }

    // Get all stashes with their branch associations
    const allStashes = await getAllStashesWithBranch();

    // Display title based on filters
    const title = this.getTitle(options, config);
    console.log(chalk.blue(title));
    console.log(chalk.gray("─".repeat(70)));

    // Display each branch
    for (const branch of branches) {
      await this.displayBranch(
        branch,
        currentBranch,
        config,
        branchMetadata,
        allStashes,
        options
      );
    }

    // Display total stashes count
    const totalStashes = Array.from(allStashes.values()).reduce(
      (sum, stashes) => sum + stashes.length, 0
    );

    if (totalStashes > 0) {
      console.log(chalk.gray("\n─".repeat(70)));
      console.log(chalk.yellow(`\nTotal stashes: ${totalStashes}`));
    }

    // Display helpful tips
    console.log("");
    console.log(chalk.gray("Tip: Use 'kunj switch <branch>' to switch branches"));
    console.log(chalk.gray("     Use 'kunj branch-desc <branch> <description>' to add descriptions"));
    console.log(chalk.gray("     Use 'kunj branch-tag <branch> <tags...>' to add tags"));

    if (options.verbose) {
      console.log("");
      console.log(chalk.gray("Use 'kunj list' without -v to hide branch notes"));
    } else {
      console.log("");
      console.log(chalk.gray("Use 'kunj list -v' to see branch notes"));
    }
  }

  private async applyFilters(
    branches: BranchInfo[],
    config: any,
    currentBranch: string,
    options: ListOptions
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

  private async displayBranch(
    branch: BranchInfo,
    currentBranch: string,
    config: any,
    branchMetadata: any,
    allStashes: Map<string, any[]>,
    options: ListOptions
  ): Promise<void> {
    const isCurrent = branch.name === currentBranch;
    const metadata = branchMetadata.branches[branch.name] || {};

    // Build branch line with alias if exists
    const branchAlias = config.aliases[branch.name];
    let branchLine = isCurrent
      ? chalk.green(`● ${branch.name}`)
      : `  ${branch.name}`;

    if (branchAlias) {
      branchLine += chalk.magenta(` (${branchAlias})`);
    }

    // Add current indicator and last activity
    if (isCurrent) {
      branchLine += chalk.gray(" [current]");
    }

    if (branch.lastActivity) {
      branchLine += chalk.gray(` - ${branch.lastActivity}`);
    }

    console.log(branchLine);

    // Display metadata details
    if (metadata.description) {
      console.log(chalk.cyan(`  │ ${metadata.description}`));
    }

    if (metadata.tags && metadata.tags.length > 0) {
      const tagStr = metadata.tags.map((tag: string) => `#${tag}`).join(" ");
      console.log(chalk.cyan(`  │ Tags: ${tagStr}`));
    }

    if (options.verbose && metadata.notes) {
      console.log(chalk.yellow(`  │ Note: ${metadata.notes}`));
    }

    // Get and display stashes for this branch
    const branchStashes = allStashes.get(branch.name);
    if (branchStashes && branchStashes.length > 0) {
      branchStashes.forEach((stash, index) => {
        const isLastItem = index === branchStashes.length - 1 &&
                          !metadata.description && !metadata.tags;
        const prefix = isLastItem ? "  └─" : "  ├─";
        const stashLine = `${prefix} 📦 ${stash.message}`;
        const detailsLine = config.preferences.showStashDetails && stash.details
          ? chalk.dim(stash.details)
          : "";
        console.log(chalk.yellow(stashLine) + detailsLine);
      });
    }
  }

  private getTitle(options: ListOptions, config: any): string {
    let title = `Branches`;
    if (!options.all) {
      if (options.configured || config.preferences.showOnlyConfigured) {
        title = `Configured branches`;
      } else if (options.wip || config.preferences.showOnlyWIP) {
        title = config.preferences.personalWIPMode
          ? `Branches you're working on`
          : `Work-in-progress branches`;
      }
    }
    title += ` (sorted by ${config.preferences.branchSort}):`;
    return title;
  }

  private showNoResultsMessage(options: ListOptions, config: any): void {
    if (options.configured || config.preferences.showOnlyConfigured) {
      console.log(chalk.yellow("No configured branches found"));
      console.log(chalk.gray("Tip: Use 'kunj branch-desc <branch>' to configure a branch"));
      console.log(chalk.gray("     Use 'kunj list --all' to see all branches"));
    } else if (options.wip || config.preferences.showOnlyWIP) {
      console.log(chalk.yellow("No work-in-progress branches found"));
      console.log(chalk.gray("Tip: Use 'kunj list --all' to see all branches"));
    } else {
      console.log(chalk.yellow("No branches found"));
    }
  }
}