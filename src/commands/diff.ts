// Diff command - view file changes with beautiful formatting

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { getFileDiff, getFileStatuses, checkGitRepo } from '../lib/git';
import { formatDiff, formatSideBySideDiff, formatDiffSummary } from '../lib/diff-formatter';
import inquirer from 'inquirer';

interface DiffOptions {
  file?: string;
  sideBySide?: boolean;
  summary?: boolean;
  staged?: boolean;
}

export class DiffCommand extends BaseCommand {
  constructor() {
    super({
      name: 'diff',
      description: 'View file changes with beautiful syntax highlighting',
      ui: {
        category: 'dashboard',
        widget: 'table',
        label: 'Changes',
        icon: 'file-diff',
        refreshInterval: 15,
        dataKey: 'files',
        order: 3,
        columns: [
          { key: 'path', label: 'File' },
          { key: 'status', label: 'Status', format: 'badge' },
          { key: 'staged', label: 'Staged' },
          { key: 'additions', label: '+' },
          { key: 'deletions', label: '-' },
        ],
      },
      options: [
        {
          flags: '-f, --file <path>',
          description: 'Show diff for specific file',
        },
        {
          flags: '-s, --side-by-side',
          description: 'Show diff in side-by-side format',
        },
        {
          flags: '--summary',
          description: 'Show summary of changed files only',
        },
        {
          flags: '--staged',
          description: 'Show only staged changes',
        },
      ],
    });
  }

  async execute(options: DiffOptions = {}): Promise<void> {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red('❌ Not in a git repository'));
        process.exit(1);
      }

      // Get changed files
      const files = await getFileStatuses();

      if (files.length === 0) {
        console.log(chalk.yellow('No changes to show'));
        console.log(chalk.gray('Working tree is clean'));
        return;
      }

      // Filter files based on options
      let filesToShow = files;
      if (options.staged) {
        filesToShow = files.filter(f => f.staged);
        if (filesToShow.length === 0) {
          console.log(chalk.yellow('No staged changes'));
          return;
        }
      }

      // JSON output
      if (this.jsonMode) {
        this.outputJSON({
          files: filesToShow.map((f) => ({
            path: f.path,
            status: f.status,
            staged: f.staged,
            additions: f.additions || 0,
            deletions: f.deletions || 0,
          })),
          summary: {
            total: filesToShow.length,
            staged: filesToShow.filter((f) => f.staged).length,
            unstaged: filesToShow.filter((f) => !f.staged).length,
          },
        });
        return;
      }

      // If specific file requested
      if (options.file) {
        await this.showFileDiff(options.file, options.sideBySide || false);
        return;
      }

      // If summary requested
      if (options.summary) {
        await this.showSummary(filesToShow);
        return;
      }

      // Interactive file selection with navigation loop
      await this.interactiveMode(filesToShow, options.sideBySide || false);
    } catch (error: any) {
      console.error(chalk.red('\n❌ Error showing diff'));
      console.error(chalk.gray(error.message));
      process.exit(1);
    }
  }

  private async interactiveMode(files: any[], sideBySide: boolean): Promise<void> {
    let continueViewing = true;

    while (continueViewing) {
      // Select a file
      const selectedFile = await this.selectFile(files);
      if (!selectedFile) {
        // User cancelled
        return;
      }

      // Show the diff
      await this.showFileDiff(selectedFile, sideBySide);

      // Ask if they want to view another file
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: chalk.cyan('← View another file'), value: 'continue' },
            { name: chalk.gray('Exit'), value: 'exit' },
          ],
        },
      ]);

      continueViewing = answer.action === 'continue';
    }
  }

  private async selectFile(files: any[]): Promise<string | null> {
    const choices: any[] = files.map(f => ({
      name: `${this.getStatusIcon(f)} ${f.path} ${chalk.dim(f.status)}`,
      value: f.path,
    }));

    choices.push(new inquirer.Separator());
    choices.push({ name: chalk.gray('← Cancel'), value: null });

    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'file',
        message: 'Select file to view diff:',
        choices,
        pageSize: 15,
      },
    ]);

    return answer.file;
  }

  private async showFileDiff(filePath: string, sideBySide: boolean): Promise<void> {
    console.log(chalk.cyan(`\n📄 Diff: ${filePath}`));
    console.log(chalk.gray('─'.repeat(Math.min(80, process.stdout.columns || 80))));

    // Get raw diff without git's colors so we can apply our own formatting
    const diff = await getFileDiff(filePath, false);

    if (!diff || diff.trim() === '' || diff === 'No changes to display') {
      console.log(chalk.yellow('No changes in this file'));
      return;
    }

    // Format the diff based on mode
    const formatted = sideBySide
      ? formatSideBySideDiff(diff, { maxWidth: process.stdout.columns })
      : formatDiff(diff, {
          showLineNumbers: true,
          maxWidth: process.stdout.columns,
        });

    console.log(formatted);
    console.log(chalk.gray('─'.repeat(Math.min(80, process.stdout.columns || 80))));
  }

  private async showSummary(files: any[]): Promise<void> {
    console.log(chalk.bold.cyan('\n📊 Diff Summary\n'));

    for (const file of files) {
      const diff = await getFileDiff(file.path, false);
      const summary = formatDiffSummary(diff);
      console.log(summary);
    }
  }

  private getStatusIcon(file: any): string {
    const icons: Record<string, string> = {
      M: chalk.yellow('●'),
      A: chalk.green('✚'),
      D: chalk.red('✖'),
      R: chalk.blue('→'),
      C: chalk.cyan('⎘'),
      U: chalk.magenta('⚠'),
    };

    return icons[file.status] || chalk.gray('○');
  }
}
