// Branch metadata commands - manage branch descriptions, tags, and notes

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, getCurrentBranch } from '../lib/git';
import { getBranchMetadataItem, updateBranchMetadata } from '../lib/metadata';

// Branch Note Command
export class BranchNoteCommand extends BaseCommand {
  constructor() {
    super({
      name: 'branch-note',
      description: 'Add or view notes for a branch',
      arguments: '[branch] [note...]',
      options: [
        { flags: '-c, --clear', description: 'Clear the notes for the branch' }
      ]
    });
  }

  async execute(branch?: string, noteArgs?: string[], options: { clear?: boolean } = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    // If no branch specified, use current branch
    if (!branch) {
      branch = await getCurrentBranch();
    }

    const metadata = getBranchMetadataItem(branch);

    // If --clear flag is used, clear the notes
    if (options.clear) {
      updateBranchMetadata(branch, { notes: undefined });
      console.log(chalk.green(`✓ Cleared notes for branch '${branch}'`));
      return;
    }

    // If notes are provided, update them
    if (noteArgs && noteArgs.length > 0) {
      const notes = noteArgs.join(" ");
      updateBranchMetadata(branch, { notes });
      console.log(chalk.green(`✓ Updated notes for branch '${branch}'`));
      console.log(chalk.gray(`Notes: ${notes}`));
    } else {
      // Display existing notes
      if (metadata.notes) {
        console.log(chalk.blue(`Notes for branch '${branch}':`));
        console.log(chalk.yellow(metadata.notes));
      } else {
        console.log(chalk.yellow(`No notes set for branch '${branch}'`));
        console.log(chalk.gray(`Tip: Use 'kunj branch-note ${branch} "your notes"' to add notes`));
      }
    }
  }
}

// Branch Tag Command
export class BranchTagCommand extends BaseCommand {
  constructor() {
    super({
      name: 'branch-tag',
      description: 'Add or view tags for a branch',
      arguments: '[branch] [tags...]',
      options: [
        { flags: '-c, --clear', description: 'Clear all tags for the branch' },
        { flags: '-r, --remove <tag>', description: 'Remove a specific tag' }
      ]
    });
  }

  async execute(branch?: string, tagArgs?: string[], options: { clear?: boolean; remove?: string } = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    // If no branch specified, use current branch
    if (!branch) {
      branch = await getCurrentBranch();
    }

    const metadata = getBranchMetadataItem(branch);

    // If --clear flag is used, clear all tags
    if (options.clear) {
      updateBranchMetadata(branch, { tags: [] });
      console.log(chalk.green(`✓ Cleared all tags for branch '${branch}'`));
      return;
    }

    // If --remove flag is used, remove specific tag
    if (options.remove) {
      const currentTags = metadata.tags || [];
      if (!currentTags.includes(options.remove)) {
        console.log(chalk.yellow(`Tag '${options.remove}' not found on branch '${branch}'`));
        return;
      }
      const newTags = currentTags.filter(tag => tag !== options.remove);
      updateBranchMetadata(branch, { tags: newTags });
      console.log(chalk.green(`✓ Removed tag '${options.remove}' from branch '${branch}'`));
      return;
    }

    // If tags are provided, add them
    if (tagArgs && tagArgs.length > 0) {
      const currentTags = metadata.tags || [];
      const newTags = Array.from(new Set([...currentTags, ...tagArgs]));
      updateBranchMetadata(branch, { tags: newTags });
      console.log(chalk.green(`✓ Updated tags for branch '${branch}'`));
      console.log(chalk.gray(`Tags: ${newTags.join(", ")}`));
    } else {
      // Display existing tags
      if (metadata.tags && metadata.tags.length > 0) {
        console.log(chalk.blue(`Tags for branch '${branch}':`));
        metadata.tags.forEach(tag => {
          console.log(chalk.cyan(`  • ${tag}`));
        });
      } else {
        console.log(chalk.yellow(`No tags set for branch '${branch}'`));
        console.log(chalk.gray(`Tip: Use 'kunj branch-tag ${branch} feature wip' to add tags`));
      }
    }
  }
}

// Branch Description Command
export class BranchDescCommand extends BaseCommand {
  constructor() {
    super({
      name: 'branch-desc',
      description: 'Set or view description for a branch',
      arguments: '[branch] [description...]',
      options: [
        { flags: '-c, --clear', description: 'Clear the description for the branch' }
      ]
    });
  }

  async execute(branch?: string, descArgs?: string[], options: { clear?: boolean } = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    // If no branch specified, use current branch
    if (!branch) {
      branch = await getCurrentBranch();
    }

    const metadata = getBranchMetadataItem(branch);

    // If --clear flag is used, clear the description
    if (options.clear) {
      updateBranchMetadata(branch, { description: undefined });
      console.log(chalk.green(`✓ Cleared description for branch '${branch}'`));
      return;
    }

    // If description is provided, update it
    if (descArgs && descArgs.length > 0) {
      const description = descArgs.join(" ");
      updateBranchMetadata(branch, { description });
      console.log(chalk.green(`✓ Updated description for branch '${branch}'`));
      console.log(chalk.cyan(`Description: ${description}`));
    } else {
      // Display existing description
      if (metadata.description) {
        console.log(chalk.blue(`Description for branch '${branch}':`));
        console.log(chalk.cyan(metadata.description));
      } else {
        console.log(chalk.yellow(`No description set for branch '${branch}'`));
        console.log(chalk.gray(`Tip: Use 'kunj branch-desc ${branch} "your description"' to add one`));
      }
    }
  }
}