// Log command - view daily work logs

import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../lib/command';
import {
  readTodayWorkLog,
  readWorkLog,
  getAllWorkLogs,
  getYesterdayDate,
  getTodayDate,
  formatDateHeader,
} from '../lib/work-log';

interface LogOptions {
  yesterday?: boolean;
  date?: string;
  list?: boolean;
}

export class LogCommand extends BaseCommand {
  constructor() {
    super({
      name: 'log',
      description: 'View daily work logs',
      options: [
        {
          flags: '-y, --yesterday',
          description: "View yesterday's work log",
        },
        {
          flags: '-d, --date <date>',
          description: 'View work log for specific date (YYYY-MM-DD)',
        },
        {
          flags: '-l, --list',
          description: 'List all available work logs',
        },
      ],
    });
  }

  async execute(options: LogOptions = {}): Promise<void> {
    // List all logs
    if (options.list) {
      const logs = getAllWorkLogs();

      if (logs.length === 0) {
        console.log(chalk.yellow('No work logs found'));
        console.log(chalk.gray('Work logs are created automatically when you commit with AI'));
        return;
      }

      console.log(chalk.cyan('\n📚 Available Work Logs:\n'));
      logs.forEach((date) => {
        const formatted = formatDateHeader(date);
        const indicator = date === getTodayDate() ? chalk.green(' (today)') : '';
        console.log(chalk.white(`  ${date} - ${formatted}${indicator}`));
      });

      console.log(chalk.gray('\nUse: kunj log --date <YYYY-MM-DD> to view a specific log'));
      console.log(chalk.gray('Use: kunj log to view today\'s log'));
      console.log(chalk.gray('Use: kunj log --yesterday to view yesterday\'s log'));
      return;
    }

    let logDate: string;
    let logContent: string | null;

    // Determine which log to show
    if (options.date) {
      logDate = options.date;
      logContent = readWorkLog(logDate);
    } else if (options.yesterday) {
      logDate = getYesterdayDate();
      logContent = readWorkLog(logDate);
    } else {
      logDate = getTodayDate();
      logContent = readTodayWorkLog();
    }

    // Show the log
    if (!logContent) {
      const dateLabel = options.yesterday ? 'yesterday' :
                       options.date ? logDate : 'today';
      console.log(chalk.yellow(`No work log found for ${dateLabel}`));
      console.log(chalk.gray('Work logs are created automatically when you commit with AI'));

      // Suggest viewing available logs
      const logs = getAllWorkLogs();
      if (logs.length > 0) {
        console.log(chalk.gray('\nAvailable logs:'));
        logs.slice(0, 5).forEach((date) => {
          console.log(chalk.gray(`  - ${date}`));
        });
        if (logs.length > 5) {
          console.log(chalk.gray(`  ... and ${logs.length - 5} more`));
        }
        console.log(chalk.gray('\nUse: kunj log --list to see all available logs'));
      }
      return;
    }

    // Display the log
    console.log(chalk.cyan('\n' + '='.repeat(60)));
    console.log(logContent);
    console.log(chalk.cyan('='.repeat(60) + '\n'));
  }
}
