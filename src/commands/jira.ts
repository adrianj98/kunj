// Jira integration command

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadConfig } from '../lib/config';
import { getCurrentBranch, getMainBranch } from '../lib/git';
import { updateBranchMetadata, getBranchMetadataItem } from '../lib/metadata';
import {
  getJiraClient,
  checkJiraCredentials,
  listMyIssues,
  getIssue,
  createIssue,
  getCurrentSprint,
  addIssueToSprint,
  generateBranchName,
  extractJiraKey,
  getBoardId,
} from '../lib/jira';
import { generateAIJiraTicket } from '../lib/ai-pr';
import { checkAWSCredentials } from '../lib/ai-commit';

export class JiraCommand extends BaseCommand {
  constructor() {
    super({
      name: 'jira',
      description: 'Jira integration commands',
      options: []
    });
  }

  public register(program: Command): void {
    const jiraCmd = program
      .command('jira')
      .description(this.config.description);

    // jira list - List assigned tickets
    jiraCmd
      .command('list')
      .description('List tickets assigned to you')
      .option('--sprint', 'Show only tickets in active sprint')
      .option('--all', 'Show all assigned tickets')
      .action(async (options) => {
        await this.listTickets(options);
      });

    // jira view - View ticket details
    jiraCmd
      .command('view')
      .description('View ticket details (auto-detects from current branch if no key provided)')
      .argument('[key]', 'Jira issue key (e.g., PROJ-123) - optional if branch is linked')
      .action(async (key) => {
        await this.viewTicket(key);
      });

    // jira link - Link branch to ticket
    jiraCmd
      .command('link')
      .description('Link current branch to a Jira ticket')
      .argument('<key>', 'Jira issue key (e.g., PROJ-123)')
      .action(async (key) => {
        await this.linkTicket(key);
      });

    // jira create - Create new ticket
    jiraCmd
      .command('create')
      .description('Create a new Jira ticket')
      .option('-s, --summary <text>', 'Ticket summary')
      .option('-t, --type <type>', 'Issue type (Story/Bug/Task/Epic)')
      .option('--assign', 'Assign to myself')
      .option('--sprint', 'Add to current sprint')
      .option('-d, --description <text>', 'Issue description')
      .option('--ai', 'Use AI to generate ticket from branch commits')
      .option('--no-ai', 'Disable AI generation (manual input)')
      .action(async (options) => {
        await this.createTicket(options);
      });
  }

  public async execute(): Promise<void> {
    // Not used - subcommands handle execution
  }

  private async listTickets(options: any): Promise<void> {
    try {
      console.log(chalk.blue.bold('\nJira Tickets\n'));

      // Check configuration
      const config = loadConfig();
      if (!config.jira?.enabled) {
        console.log(chalk.yellow('Jira integration is not enabled.'));
        console.log(chalk.gray('Run "kunj setup" to configure Jira.\n'));
        return;
      }

      // Validate credentials
      const isValid = await checkJiraCredentials();
      if (!isValid) {
        return;
      }

      let jql: string;
      let label: string;

      if (options.sprint) {
        // Sprint mode
        const boardId = getBoardId();
        if (!boardId) {
          console.log(chalk.yellow('Board ID not configured.'));
          console.log(chalk.gray('Run "kunj config set jira.boardId <id>" to configure.\n'));
          return;
        }

        const sprint = await getCurrentSprint(boardId);
        if (!sprint) {
          console.log(chalk.yellow('No active sprint found. Showing all tickets instead.\n'));
          // Fall back to all tickets
          jql = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
          label = 'All Assigned Tickets';
        } else {
          jql = `assignee = currentUser() AND sprint = ${sprint.id} ORDER BY priority DESC`;
          label = `Sprint: ${sprint.name}`;
        }
      } else if (options.all) {
        // All tickets mode (including resolved)
        jql = 'assignee = currentUser() ORDER BY updated DESC';
        label = 'All Tickets (Including Resolved)';
      } else {
        // Default: unresolved tickets
        jql = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
        label = 'My Assigned Tickets';
      }

      const issues = await listMyIssues({ jql, maxResults: 50 });

      if (issues.length === 0) {
        console.log(chalk.gray('No tickets found.\n'));
        return;
      }

      console.log(chalk.cyan(label));
      console.log(chalk.gray('─'.repeat(80)));

      // Display table
      for (const issue of issues) {
        const key = chalk.bold.blue(issue.key);
        const type = chalk.gray(`[${issue.fields.issuetype.name}]`);
        const status = this.getStatusColor(issue.fields.status.name);
        const summary = issue.fields.summary;

        console.log(`${key} ${type} ${status} ${summary}`);
      }

      console.log(chalk.gray('─'.repeat(80)));
      console.log(chalk.gray(`Total: ${issues.length} tickets\n`));
    } catch (error) {
      console.error(chalk.red('\nError listing tickets:'));
      if (error instanceof Error) {
        console.error(chalk.gray(error.message));
        if (error.stack) {
          console.error(chalk.dim('\nStack trace:'));
          console.error(chalk.dim(error.stack));
        }
      } else {
        console.error(chalk.gray(String(error)));
      }
      console.log();
    }
  }

  private async viewTicket(key?: string): Promise<void> {
    try {
      // Check configuration
      const config = loadConfig();
      if (!config.jira?.enabled) {
        console.log(chalk.yellow('Jira integration is not enabled.'));
        console.log(chalk.gray('Run "kunj setup" to configure Jira.\n'));
        return;
      }

      // Auto-detect ticket from current branch if no key provided
      if (!key) {
        const currentBranch = await getCurrentBranch();
        const branchMetadata = getBranchMetadataItem(currentBranch);

        if (branchMetadata?.jiraIssueKey) {
          key = branchMetadata.jiraIssueKey;
          console.log(chalk.gray(`Auto-detected ticket ${key} from branch ${currentBranch}\n`));
        } else {
          // Try to extract from branch name
          const extractedKey = extractJiraKey(currentBranch);
          if (extractedKey) {
            key = extractedKey;
            console.log(chalk.gray(`Extracted ticket ${key} from branch name\n`));
          } else {
            console.log(chalk.yellow('No Jira ticket linked to current branch.'));
            console.log(chalk.gray('Usage: kunj jira view <key> or link a ticket with: kunj jira link <key>\n'));
            return;
          }
        }
      }

      console.log(chalk.blue.bold(`\nJira Ticket: ${key}\n`));

      // Validate credentials
      const isValid = await checkJiraCredentials();
      if (!isValid) {
        return;
      }

      const issue = await getIssue(key);

      // Display ticket details
      console.log(chalk.bold('Key:      ') + chalk.blue(issue.key));
      console.log(chalk.bold('Title:    ') + issue.fields.summary);
      console.log(chalk.bold('Type:     ') + issue.fields.issuetype.name);
      console.log(chalk.bold('Status:   ') + this.getStatusColor(issue.fields.status.name));

      if (issue.fields.priority) {
        console.log(chalk.bold('Priority: ') + issue.fields.priority.name);
      }

      if (issue.fields.assignee) {
        console.log(chalk.bold('Assignee: ') + issue.fields.assignee.displayName);
      }

      if (issue.fields.reporter) {
        console.log(chalk.bold('Reporter: ') + issue.fields.reporter.displayName);
      }

      if (issue.fields.description) {
        console.log(chalk.bold('\nDescription:'));
        // Extract text from Atlassian Document Format
        const descriptionText = this.extractDescriptionText(issue.fields.description);
        console.log(chalk.gray(descriptionText));
      }

      console.log(chalk.bold('\nURL:      ') + chalk.cyan(`${config.jira.baseUrl}/browse/${issue.key}`));
      console.log();
    } catch (error) {
      console.error(chalk.red('Error viewing ticket:'));
      console.error(chalk.gray(error instanceof Error ? error.message : String(error)));
    }
  }

  private async linkTicket(key: string): Promise<void> {
    try {
      // Check configuration
      const config = loadConfig();
      if (!config.jira?.enabled) {
        console.log(chalk.yellow('Jira integration is not enabled.'));
        console.log(chalk.gray('Run "kunj setup" to configure Jira.\n'));
        return;
      }

      // Validate credentials
      const isValid = await checkJiraCredentials();
      if (!isValid) {
        return;
      }

      // Get current branch
      const currentBranch = await getCurrentBranch();

      // Validate issue exists
      const issue = await getIssue(key);

      // Update branch metadata
      const jiraMetadata = {
        jiraIssueKey: issue.key,
        jiraIssueTitle: issue.fields.summary,
        jiraIssueStatus: issue.fields.status.name,
        jiraIssueType: issue.fields.issuetype.name,
      };

      updateBranchMetadata(currentBranch, jiraMetadata);

      console.log(chalk.green('\n✓ Branch linked to Jira ticket'));
      console.log(chalk.cyan(`  ${issue.key}: ${issue.fields.summary}`));
      console.log(chalk.gray(`  Status: ${issue.fields.status.name}\n`));
    } catch (error) {
      console.error(chalk.red('Error linking ticket:'));
      console.error(chalk.gray(error instanceof Error ? error.message : String(error)));
    }
  }

  private async createTicket(options: any): Promise<void> {
    try {
      console.log(chalk.blue.bold('\nCreate Jira Ticket\n'));

      // Check configuration
      const config = loadConfig();
      if (!config.jira?.enabled) {
        console.log(chalk.yellow('Jira integration is not enabled.'));
        console.log(chalk.gray('Run "kunj setup" to configure Jira.\n'));
        return;
      }

      // Validate credentials
      const isValid = await checkJiraCredentials();
      if (!isValid) {
        return;
      }

      // Get project key from config
      const defaultProjectKey = config.jira?.projectKey || '';
      if (!defaultProjectKey) {
        console.log(chalk.yellow('No default project key configured.'));
        console.log(chalk.gray('Run "kunj config set jira.projectKey <key>" to set a default.\n'));
        return;
      }

      // Get current branch to check if it's a default branch
      const currentBranch = await getCurrentBranch();
      const mainBranch = await getMainBranch();

      // Check if on a default branch (main, master, develop, etc.)
      const defaultBranches = ['main', 'master', 'develop', 'dev', 'trunk'];

      // Also check configured branches from flow config
      if (config.flow?.mainBranch) {
        defaultBranches.push(config.flow.mainBranch.toLowerCase());
      }
      if (config.flow?.developBranch) {
        defaultBranches.push(config.flow.developBranch.toLowerCase());
      }

      const isDefaultBranch = defaultBranches.includes(currentBranch.toLowerCase());

      // Try to generate ticket with AI if enabled
      let aiSummary = '';
      let aiDescription = '';
      let aiBranchName = '';
      // Use AI if: --ai flag OR (no --no-ai flag AND config enabled)
      const aiEnabled = options.ai === true || (options.ai !== false && config.jira?.aiGeneration !== false);
      const shouldUseAI = aiEnabled && config.ai?.enabled && !isDefaultBranch;

      if (isDefaultBranch && aiEnabled && !options.summary && !options.description) {
        console.log(chalk.yellow(`⚠ Cannot use AI on default branch "${currentBranch}"`));
        console.log(chalk.gray('  AI needs commits to analyze. Create a feature branch first.\n'));
      }

      if (shouldUseAI && !options.summary && !options.description) {
        try {
          // Check AWS credentials
          const hasAWSCreds = await checkAWSCredentials();
          if (hasAWSCreds) {
            // Get branch metadata
            const branchMetadata = getBranchMetadataItem(currentBranch);

            // Generate ticket with AI
            const aiTicket = await generateAIJiraTicket({
              baseBranch: mainBranch,
              branchMetadata,
            });

            aiSummary = aiTicket.summary;
            aiDescription = aiTicket.description;
            aiBranchName = aiTicket.branchName || '';

            console.log(chalk.green('\n✓ AI generated ticket content'));
            console.log(chalk.gray('You can review and edit before creating\n'));
          }
        } catch (error) {
          console.log(chalk.yellow('⚠ AI generation failed, using manual input'));
          console.log(chalk.gray(`  ${error instanceof Error ? error.message : String(error)}\n`));
        }
      }

      // Prompt for missing information
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'summary',
          message: aiSummary ? 'Ticket summary (AI generated, edit if needed):' : 'Ticket summary:',
          when: !options.summary,
          default: aiSummary || undefined,
          validate: (input: string) => {
            if (!input.trim()) return 'Summary is required';
            return true;
          }
        },
        {
          type: 'list',
          name: 'type',
          message: 'Issue type:',
          when: !options.type,
          choices: ['Story', 'Bug', 'Task', 'Epic'],
          default: config.jira?.defaultIssueType || 'Task'
        },
        {
          type: 'editor',
          name: 'description',
          message: aiDescription ? 'Description (AI generated, edit if needed):' : 'Description (optional):',
          when: !options.description,
          default: aiDescription || ''
        },
        {
          type: 'confirm',
          name: 'assign',
          message: 'Assign to yourself?',
          when: options.assign === undefined,
          default: true
        },
        {
          type: 'confirm',
          name: 'sprint',
          message: 'Add to current sprint?',
          when: options.sprint === undefined && !!getBoardId(),
          default: false
        }
      ]);

      // Merge options with answers
      const params = {
        summary: options.summary || answers.summary,
        type: options.type || answers.type,
        description: options.description || answers.description,
        assign: options.assign !== undefined ? options.assign : answers.assign,
        sprint: options.sprint !== undefined ? options.sprint : answers.sprint,
      };

      // Create issue
      console.log(chalk.gray('\nCreating ticket...'));

      const issue = await createIssue({
        projectKey: defaultProjectKey,
        summary: params.summary,
        issueType: params.type,
        description: params.description,
        assignToMe: params.assign,
      });

      // Add to sprint if requested
      if (params.sprint && getBoardId()) {
        const boardId = getBoardId()!;
        const sprint = await getCurrentSprint(boardId);
        if (sprint) {
          await addIssueToSprint(issue.key, sprint.id);
          console.log(chalk.gray(`Added to sprint: ${sprint.name}`));
        }
      }

      console.log(chalk.green('\n✓ Ticket created successfully'));
      console.log(chalk.cyan(`  ${issue.key}: ${params.summary}`));
      console.log(chalk.gray(`  ${config.jira.baseUrl}/browse/${issue.key}\n`));

      // If on a non-default branch, link the ticket to the current branch
      if (!isDefaultBranch) {
        const jiraMetadata = {
          jiraIssueKey: issue.key,
          jiraIssueTitle: issue.fields.summary,
          jiraIssueStatus: issue.fields.status.name,
          jiraIssueType: issue.fields.issuetype.name,
        };
        updateBranchMetadata(currentBranch, jiraMetadata);
        console.log(chalk.green(`✓ Linked ticket to branch "${currentBranch}"`));
        console.log(chalk.gray(`  Run "kunj jira view" to see ticket details\n`));
      } else {
        // On default branch - ask if user wants to create a new branch
        const branchAnswer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'createBranch',
            message: 'Create a new branch for this ticket?',
            default: true
          }
        ]);

        if (branchAnswer.createBranch) {
          // Generate branch name: feature/{KEY}-{ai-name} or feature/{KEY}
          let suggestedName = '';
          if (aiBranchName) {
            suggestedName = `feature/${issue.key}-${aiBranchName}`;
          } else {
            suggestedName = `feature/${issue.key}`;
          }

          const nameAnswer = await inquirer.prompt([
            {
              type: 'input',
              name: 'branchName',
              message: 'Branch name:',
              default: suggestedName,
            }
          ]);

          const finalBranchName = nameAnswer.branchName;

          try {
            // Import CreateCommand dynamically to avoid circular dependencies
            const { CreateCommand } = require('./create');
            const createCmd = new CreateCommand();

            // Create and switch to the new branch
            await createCmd.execute(finalBranchName, {});

            // Link the ticket to the new branch
            const jiraMetadata = {
              jiraIssueKey: issue.key,
              jiraIssueTitle: issue.fields.summary,
              jiraIssueStatus: issue.fields.status.name,
              jiraIssueType: issue.fields.issuetype.name,
            };
            updateBranchMetadata(finalBranchName, jiraMetadata);

            console.log(chalk.green(`\n✓ Created and switched to branch "${finalBranchName}"`));
            console.log(chalk.green(`✓ Linked ticket ${issue.key} to branch`));
            console.log(chalk.gray(`  Run "kunj jira view" to see ticket details\n`));
          } catch (error) {
            console.log(chalk.yellow(`\n⚠ Could not create branch automatically`));
            console.log(chalk.gray(`  Run: kunj create ${finalBranchName}\n`));
          }
        }
      }
    } catch (error) {
      console.error(chalk.red('Error creating ticket:'));
      console.error(chalk.gray(error instanceof Error ? error.message : String(error)));
    }
  }

  private getStatusColor(status: string): string {
    const statusLower = status.toLowerCase();
    if (statusLower.includes('done') || statusLower.includes('closed')) {
      return chalk.green(`[${status}]`);
    } else if (statusLower.includes('progress') || statusLower.includes('review')) {
      return chalk.yellow(`[${status}]`);
    } else {
      return chalk.gray(`[${status}]`);
    }
  }

  private extractDescriptionText(description: any): string {
    if (!description || !description.content) {
      return '';
    }

    let text = '';
    for (const block of description.content) {
      if (block.type === 'paragraph' && block.content) {
        for (const content of block.content) {
          if (content.type === 'text') {
            text += content.text + ' ';
          }
        }
        text += '\n';
      }
    }

    return text.trim();
  }
}
