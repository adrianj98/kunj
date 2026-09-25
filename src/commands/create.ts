// Create command - creates a new branch and switches to it

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { checkGitRepo, executeGitCommand, getCurrentBranch } from '../lib/git';
import { createStash } from '../lib/stash';
import { updateBranchMetadata } from '../lib/metadata';
import { loadConfig } from '../lib/config';
import { BranchMetadata } from '../types';
import { extractJiraKey, getIssue } from '../lib/jira';
import { runActionHook } from '../lib/hooks';
import { resolveBaseRef, describeBase } from '../lib/base-branch';

interface CreateOptions {
  stash?: boolean;
  desc?: string;
  tag?: string[];
  hooks?: boolean;
  base?: string;
  origin?: boolean;
}

export class CreateCommand extends BaseCommand {
  constructor() {
    super({
      name: 'create <branch>',
      description: 'Create a new branch and switch to it',
      ui: { category: 'action', widget: 'form-only', label: 'Create Branch', icon: 'plus', order: 20 },
      options: [
        { flags: '--no-stash', description: 'Disable automatic stashing of changes' },
        { flags: '-d, --desc <description>', description: 'Set a description for the new branch' },
        { flags: '-t, --tag <tags...>', description: 'Add tags to the new branch' },
        { flags: '--base <branch>', description: 'Branch to create from (default: preferences.defaultBaseBranch, else the repo default)' },
        { flags: '--no-origin', description: 'Create from the local base branch instead of fetching origin/<base>' },
        { flags: '--no-hooks', description: "Skip kunj hooks (see 'kunj hooks --help')" }
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

    // Get current branch before creating new one
    const currentBranch = await getCurrentBranch();

    const hookOptions = { hooks: config.hooks, jsonMode: this.jsonMode, skip: options.hooks === false };
    const hookValues = { branch: branchName, 'previous-branch': currentBranch };

    // A failing pre hook throws and nothing is created
    await runActionHook('pre-branch-create', hookValues, hookOptions);

    // Resolved before stashing so a missing base leaves the working tree alone
    const base = await resolveBaseRef({
      base: options.base,
      defaultBase: config.preferences.defaultBaseBranch,
      fromOrigin: options.origin !== false && config.preferences.baseFromOrigin !== false,
    });
    if (base?.warning) {
      console.log(chalk.yellow(`  ${base.warning}`));
    }

    console.log(
      chalk.blue(`Creating branch '${branchName}'${describeBase(base)} and switching to it...`)
    );

    // Use config autoStash preference unless explicitly overridden
    const shouldStash = options.stash !== false && config.preferences.autoStash;
    if (shouldStash) {
      await createStash(currentBranch, hookOptions);
    }

    // Create and checkout the branch
    // --no-track: the new branch should not treat its base as its upstream
    const result = await executeGitCommand(
      base ? `git switch --no-track -c ${branchName} ${base.ref}` : `git switch -c ${branchName}`
    );

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

      // Auto-link Jira ticket if key found in branch name
      const jiraKey = extractJiraKey(branchName);
      if (jiraKey && config.jira?.enabled) {
        try {
          const issue = await getIssue(jiraKey);
          const jiraMetadata = {
            jiraIssueKey: jiraKey,
            jiraIssueTitle: issue.fields.summary,
            jiraIssueStatus: issue.fields.status.name,
            jiraIssueType: issue.fields.issuetype.name
          };
          updateBranchMetadata(branchName, jiraMetadata);
          console.log(chalk.cyan(`  Linked to Jira: ${jiraKey} - ${issue.fields.summary}`));
        } catch (error) {
          // Silently ignore if Jira lookup fails
        }
      }

      // Update last switched time for previous branch
      if (currentBranch) {
        updateBranchMetadata(currentBranch, {
          lastSwitched: new Date().toISOString()
        });
      }

      await runActionHook('post-branch-create', hookValues, hookOptions);

      if (this.jsonMode) {
        this.outputJSON({
          success: true,
          branch: branchName,
          previousBranch: currentBranch,
          base: base?.ref || null,
          description: metadata.description || null,
          tags: metadata.tags || [],
        });
        return;
      }

      console.log(chalk.gray("\nTip: Add notes with 'kunj branch-note'"));
    } else {
      console.error(chalk.red(`✗ Failed to create branch: ${result.message}`));
      process.exit(1);
    }
  }
}