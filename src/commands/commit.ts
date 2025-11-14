// Commit command - interactive file selection and commit

import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../lib/command';
import {
  checkGitRepo,
  getFileStatuses,
  stageFiles,
  createCommit,
  getRecentCommitMessages,
  getCurrentBranch,
  FileStatus
} from '../lib/git';
import { generateAICommitMessage, checkAWSCredentials, getAICommitConfig } from '../lib/ai-commit';

interface CommitOptions {
  all?: boolean;
  message?: string;
  amend?: boolean;
}

export class CommitCommand extends BaseCommand {
  constructor() {
    super({
      name: 'commit',
      description: 'Interactive commit - select files and commit with message',
      options: [
        { flags: '-a, --all', description: 'Stage all changed files automatically' },
        { flags: '-m, --message <message>', description: 'Commit message (skip interactive prompt)' },
        { flags: '--amend', description: 'Amend the last commit' }
      ]
    });
  }

  async execute(options: CommitOptions = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    const currentBranch = await getCurrentBranch();
    console.log(chalk.blue(`On branch: ${currentBranch}`));

    // Get all file statuses
    const files = await getFileStatuses();

    if (files.length === 0) {
      console.log(chalk.yellow("No changes to commit"));
      console.log(chalk.gray("Working tree is clean"));
      return;
    }

    // Separate staged and unstaged files
    const stagedFiles = files.filter(f => f.staged);
    const unstagedFiles = files.filter(f => !f.staged);

    // If --all flag, stage all files
    let filesToCommit: string[] = [];

    if (options.all) {
      filesToCommit = files.map(f => f.path);
      console.log(chalk.cyan(`Staging all ${filesToCommit.length} changed files...`));
      const stageResult = await stageFiles(filesToCommit);
      if (!stageResult.success) {
        console.error(chalk.red(`Failed to stage files: ${stageResult.message}`));
        process.exit(1);
      }
    } else if (unstagedFiles.length > 0) {
      // Interactive file selection
      filesToCommit = await this.selectFiles(files);

      if (filesToCommit.length === 0) {
        console.log(chalk.yellow("No files selected"));
        return;
      }

      // Stage selected files
      console.log(chalk.cyan(`Staging ${filesToCommit.length} selected files...`));
      const stageResult = await stageFiles(filesToCommit);
      if (!stageResult.success) {
        console.error(chalk.red(`Failed to stage files: ${stageResult.message}`));
        process.exit(1);
      }
    } else if (stagedFiles.length > 0) {
      // Use already staged files
      console.log(chalk.green(`${stagedFiles.length} files already staged`));
      filesToCommit = stagedFiles.map(f => f.path);
    } else {
      console.log(chalk.yellow("No files to commit"));
      return;
    }

    // Get commit message
    let commitMessage: string;

    if (options.message) {
      commitMessage = options.message;
    } else {
      commitMessage = await this.getCommitMessage(filesToCommit);
      if (!commitMessage) {
        console.log(chalk.yellow("Commit cancelled"));
        return;
      }
    }

    // Create the commit
    const commitOptions = options.amend ? '--amend' : '';
    const escapedMessage = commitMessage.replace(/"/g, '\\"');
    const commitCommand = options.amend
      ? `git commit --amend -m "${escapedMessage}"`
      : `git commit -m "${escapedMessage}"`;

    console.log(chalk.blue("Creating commit..."));
    const result = await createCommit(commitMessage);

    if (result.success) {
      console.log(chalk.green("✓ Commit created successfully"));

      // Show commit details
      const commitInfo = result.message.match(/\[([^\]]+)\]\s+(.+)/);
      if (commitInfo) {
        console.log(chalk.gray(`  Branch: ${commitInfo[1]}`));
        console.log(chalk.gray(`  Message: ${commitInfo[2]}`));
      }

      // Show what was committed
      console.log(chalk.cyan(`\nCommitted ${filesToCommit.length} files:`));
      filesToCommit.forEach(file => {
        console.log(chalk.gray(`  - ${file}`));
      });
    } else {
      console.error(chalk.red(`✗ Commit failed: ${result.message}`));
      process.exit(1);
    }
  }

  private async selectFiles(files: FileStatus[]): Promise<string[]> {
    // Format file choices with status indicators
    const fileChoices = files.map(file => {
      const statusIcon = this.getStatusIcon(file.status);
      const stagedIndicator = file.staged ? chalk.green('[staged]') : '';
      const fileName = file.oldPath
        ? `${file.oldPath} → ${file.path}`
        : file.path;

      return {
        name: `${statusIcon} ${fileName} ${stagedIndicator}`,
        value: file.path,
        checked: file.staged // Pre-select staged files
      };
    });

    console.log(chalk.cyan("\nSelect files to include in commit:"));
    console.log(chalk.gray("(Use arrow keys to move, space to select, enter to confirm)"));

    const { selectedFiles } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedFiles',
        message: 'Files to commit:',
        choices: fileChoices,
        pageSize: 15,
        validate: (input: any) => {
          if (input.length === 0) {
            return 'You must select at least one file';
          }
          return true;
        }
      }
    ]);

    return selectedFiles;
  }

  private async getCommitMessage(files: string[]): Promise<string> {
    // Get recent commits for reference
    const recentCommits = await getRecentCommitMessages(5);

    console.log(chalk.cyan("\nRecent commit messages for reference:"));
    recentCommits.forEach((msg, i) => {
      console.log(chalk.gray(`  ${i + 1}. ${msg}`));
    });

    // Suggest a commit type based on files
    const suggestedType = this.suggestCommitType(files);

    // Check if AI is available
    const aiConfig = getAICommitConfig();
    const aiAvailable = aiConfig.configured && await checkAWSCredentials();

    const commitTypeChoices = [
      { name: chalk.cyan('🤖 AI: Generate message with AI'), value: 'ai' },
      { name: '──────────────────────', value: '', disabled: true },
      { name: 'feat: A new feature', value: 'feat' },
      { name: 'fix: A bug fix', value: 'fix' },
      { name: 'docs: Documentation changes', value: 'docs' },
      { name: 'style: Code style changes (formatting, etc)', value: 'style' },
      { name: 'refactor: Code refactoring', value: 'refactor' },
      { name: 'test: Adding or updating tests', value: 'test' },
      { name: 'chore: Maintenance tasks', value: 'chore' },
      { name: 'build: Build system changes', value: 'build' },
      { name: 'ci: CI configuration changes', value: 'ci' },
      { name: 'perf: Performance improvements', value: 'perf' },
      { name: 'revert: Revert a previous commit', value: 'revert' },
      { name: '(none): No prefix', value: '' }
    ];

    // If AI is not available, show a different message
    if (!aiAvailable) {
      commitTypeChoices[0] = {
        name: chalk.gray('🤖 AI: Not configured (set AWS credentials)'),
        value: 'ai',
        disabled: true
      };
    }

    const questions = [
      {
        type: 'list',
        name: 'commitType',
        message: 'Select commit type:',
        choices: commitTypeChoices,
        default: suggestedType
      },
      {
        type: 'input',
        name: 'commitMessage',
        message: 'Enter commit message:',
        validate: (input: any) => {
          if (!input.trim()) {
            return 'Commit message cannot be empty';
          }
          if (input.length > 100) {
            return 'Commit message should be less than 100 characters';
          }
          return true;
        }
      },
      {
        type: 'editor',
        name: 'commitBody',
        message: 'Additional commit details (optional, press Enter to skip):',
        default: ''
      }
    ];

    const answers = await inquirer.prompt(questions);

    // Handle AI-generated commit message
    let message: string;

    if (answers.commitType === 'ai') {
      // Generate commit message using AI
      const aiResult = await generateAICommitMessage(files);

      console.log(chalk.cyan("\n🤖 AI-generated commit message:"));
      console.log(chalk.white(aiResult.fullMessage));

      // Ask for confirmation or editing
      const { useAI, editMessage } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'useAI',
          message: 'Use this AI-generated message?',
          default: true
        },
        {
          type: 'input',
          name: 'editMessage',
          message: 'Edit the message (or press Enter to use as-is):',
          default: aiResult.fullMessage,
          when: (answers) => answers.useAI
        }
      ]);

      if (!useAI) {
        // Fall back to manual entry
        const manualAnswers = await inquirer.prompt([
          {
            type: 'list',
            name: 'commitType',
            message: 'Select commit type manually:',
            choices: commitTypeChoices.filter(c => c.value !== 'ai' && c.value !== ''),
            default: aiResult.type
          },
          {
            type: 'input',
            name: 'commitMessage',
            message: 'Enter commit message:',
            default: aiResult.message,
            validate: (input: any) => {
              if (!input.trim()) {
                return 'Commit message cannot be empty';
              }
              if (input.length > 100) {
                return 'Commit message should be less than 100 characters';
              }
              return true;
            }
          }
        ]);

        message = manualAnswers.commitType
          ? `${manualAnswers.commitType}: ${manualAnswers.commitMessage}`
          : manualAnswers.commitMessage;
      } else {
        message = editMessage || aiResult.fullMessage || '';
      }
    } else {
      // Construct the final commit message manually
      message = answers.commitMessage;
      if (answers.commitType) {
        message = `${answers.commitType}: ${message}`;
      }
      if (answers.commitBody && answers.commitBody.trim()) {
        message += `\n\n${answers.commitBody.trim()}`;
      }
    }

    // Show preview and confirm
    console.log(chalk.cyan("\nCommit message preview:"));
    console.log(chalk.white(message));
    console.log();

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Proceed with this commit?',
        default: true
      }
    ]);

    return confirmed ? message : '';
  }

  private getStatusIcon(status: FileStatus['status']): string {
    switch (status) {
      case 'new':
        return chalk.green('+');
      case 'modified':
        return chalk.yellow('M');
      case 'deleted':
        return chalk.red('D');
      case 'renamed':
        return chalk.blue('R');
      case 'copied':
        return chalk.cyan('C');
      case 'unmerged':
        return chalk.magenta('U');
      default:
        return chalk.gray('?');
    }
  }

  private suggestCommitType(files: string[]): string {
    // Simple heuristic to suggest commit type based on file paths
    if (files.some(f => f.includes('test') || f.includes('spec'))) {
      return 'test';
    }
    if (files.some(f => f.includes('.md') || f.includes('README'))) {
      return 'docs';
    }
    if (files.some(f => f.includes('package.json') || f.includes('tsconfig'))) {
      return 'build';
    }
    if (files.some(f => f.includes('.yml') || f.includes('.yaml') || f.includes('.github'))) {
      return 'ci';
    }
    if (files.some(f => f.includes('fix') || f.includes('bug'))) {
      return 'fix';
    }

    // Default to feat for new files, refactor for modifications
    const hasNewFiles = files.some(f => f.endsWith('.ts') || f.endsWith('.js'));
    return hasNewFiles ? 'feat' : 'refactor';
  }
}