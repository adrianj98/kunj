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
  parseWorkLogEntries,
  formatAsStandupBullets,
} from '../lib/work-log';
import { generateStandupBullets } from '../lib/ai-commit';

interface LogOptions {
  yesterday?: boolean;
  date?: string;
  list?: boolean;
  standup?: boolean;
  ai?: boolean;
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
        {
          flags: '-s, --standup',
          description: 'Format as standup bullets (concise one-liners)',
        },
        {
          flags: '--ai',
          description: 'Use AI to generate super concise standup bullets (5-8 words each)',
        },
      ],
    });
  }

  async execute(options: LogOptions = {}): Promise<void> {
    // Standup format - show today and yesterday
    if (options.standup) {
      await this.showStandup(options);
      return;
    }

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
      console.log(chalk.gray('Use: kunj log --standup to view standup format'));
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

  private async showStandup(options: LogOptions): Promise<void> {
    const today = getTodayDate();
    const yesterday = getYesterdayDate();

    console.log(chalk.cyan('\n🎤 Daily Standup Summary\n'));

    if (options.ai) {
      console.log(chalk.gray('🤖 Generating AI-powered standup bullets...\n'));
    }

    // Show yesterday's work
    const yesterdayLog = readWorkLog(yesterday);
    if (yesterdayLog) {
      console.log(chalk.yellow('Yesterday:'));

      let yesterdayBullets: string[];

      if (options.ai) {
        // Use AI to generate super concise bullets
        const aiBullets = await generateStandupBullets(yesterdayLog, 'yesterday');
        yesterdayBullets = aiBullets || formatAsStandupBullets(parseWorkLogEntries(yesterdayLog));
      } else {
        // Use simple first-sentence extraction
        const yesterdayEntries = parseWorkLogEntries(yesterdayLog);
        yesterdayBullets = formatAsStandupBullets(yesterdayEntries);
      }

      if (yesterdayBullets.length > 0) {
        yesterdayBullets.forEach((bullet) => {
          console.log(chalk.white(`  • ${bullet}`));
        });
      } else {
        console.log(chalk.gray('  No entries'));
      }
      console.log();
    } else {
      console.log(chalk.yellow('Yesterday:'));
      console.log(chalk.gray('  No work log'));
      console.log();
    }

    // Show today's work
    const todayLog = readTodayWorkLog();
    if (todayLog) {
      console.log(chalk.green('Today:'));

      let todayBullets: string[];

      if (options.ai) {
        // Use AI to generate super concise bullets
        const aiBullets = await generateStandupBullets(todayLog, 'today');
        todayBullets = aiBullets || formatAsStandupBullets(parseWorkLogEntries(todayLog));
      } else {
        // Use simple first-sentence extraction
        const todayEntries = parseWorkLogEntries(todayLog);
        todayBullets = formatAsStandupBullets(todayEntries);
      }

      if (todayBullets.length > 0) {
        todayBullets.forEach((bullet) => {
          console.log(chalk.white(`  • ${bullet}`));
        });
      } else {
        console.log(chalk.gray('  No entries yet'));
      }
      console.log();
    } else {
      console.log(chalk.green('Today:'));
      console.log(chalk.gray('  No work log yet'));
      console.log();
    }

    // Show helpful tip
    const aiTip = options.ai ? ' Use --ai for super concise bullets.' : '';
    console.log(chalk.gray(`💡 Tip: Work logs are created automatically when you commit with AI.${aiTip}`));
  }
}
