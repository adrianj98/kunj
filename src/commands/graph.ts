// Graph command - visualize git commit history in subway map style

import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseCommand } from '../lib/command';
import { executeGitCommand, getGitRoot } from '../lib/git';
import { loadConfig } from '../lib/config';

const execAsync = promisify(exec);

interface GraphOptions {
  all?: boolean;
  limit?: string;
  oneline?: boolean;
  author?: string;
  since?: string;
  until?: string;
  unicode?: boolean;
  style?: 'default' | 'light' | 'dark';
}

interface ColorScheme {
  hash: string;
  date: string;
  author: string;
  refs: string;
  message: string;
}

export class GraphCommand extends BaseCommand {
  constructor() {
    super({
      name: 'graph',
      description: 'Visualize git commit history with subway map style graph',
      ui: {
        category: 'data',
        widget: 'timeline',
        label: 'Commit Graph',
        icon: 'graph',
        dataKey: 'commits',
        order: 11,
      },
      options: [
        {
          flags: '-a, --all',
          description: 'Show all branches (default: current branch only)',
        },
        {
          flags: '-n, --limit <number>',
          description: 'Limit number of commits to show (default: 20)',
        },
        {
          flags: '-o, --oneline',
          description: 'Compact one-line format',
        },
        {
          flags: '-u, --unicode',
          description: 'Use Unicode box-drawing characters for prettier graph',
        },
        {
          flags: '--style <style>',
          description: 'Color style: default, light, or dark (default: default)',
        },
        {
          flags: '--author <name>',
          description: 'Filter commits by author',
        },
        {
          flags: '--since <date>',
          description: 'Show commits since date (e.g., "2 weeks ago", "2024-01-01")',
        },
        {
          flags: '--until <date>',
          description: 'Show commits until date',
        },
      ],
    });
  }

  async execute(options: GraphOptions = {}): Promise<void> {
    try {
      // Load config and apply defaults
      const config = await loadConfig();
      const useUnicode = options.unicode ?? config.preferences?.graphUnicode ?? false;
      const style = options.style || config.preferences?.graphStyle || 'default';
      const limit = options.limit || '20';

      const terminalWidth = this.getTerminalWidth();
      const colorScheme = this.getColorScheme(style);
      const format = this.getFormat(options.oneline || false, terminalWidth, colorScheme);

      // Build git log command
      const args = [
        'git log',
        '--graph',
        '--color=always',
        `--format="${format}"`,
        `-n ${limit}`,
      ];

      // Add branch scope
      if (options.all) {
        args.push('--all');
      }

      // Add filters
      if (options.author) {
        args.push(`--author="${options.author}"`);
      }
      if (options.since) {
        args.push(`--since="${options.since}"`);
      }
      if (options.until) {
        args.push(`--until="${options.until}"`);
      }

      const gitCommand = args.join(' ');

      // Execute git log from git root
      const gitRoot = await getGitRoot();
      const { stdout, stderr } = await execAsync(gitCommand, { cwd: gitRoot });

      if (stderr && !stdout) {
        console.error(chalk.red('\n❌ Error generating commit graph'));
        console.error(chalk.gray(stderr));
        process.exit(1);
      }

      if (!stdout.trim()) {
        if (this.jsonMode) {
          this.outputJSON({ commits: [] });
          return;
        }
        console.log(chalk.yellow('\nNo commits found matching the criteria'));
        return;
      }

      if (this.jsonMode) {
        // Re-run with parseable format for JSON
        const jsonArgs = [
          'git log',
          `--format=%H%x00%an%x00%aI%x00%D%x00%s`,
          `-n ${limit}`,
        ];
        if (options.all) jsonArgs.push('--all');
        if (options.author) jsonArgs.push(`--author="${options.author}"`);
        if (options.since) jsonArgs.push(`--since="${options.since}"`);
        if (options.until) jsonArgs.push(`--until="${options.until}"`);
        const { stdout: jsonOut } = await execAsync(jsonArgs.join(' '), { cwd: gitRoot });
        const commits = jsonOut.trim().split('\n').filter(Boolean).map((line: string) => {
          const [hash, author, date, refs, message] = line.split('\x00');
          return { hash, author, date, refs: refs || null, message };
        });
        this.outputJSON({ commits });
        return;
      }

      // Convert to Unicode if requested
      let output = stdout;
      if (useUnicode) {
        output = this.convertToUnicode(output);
      }

      // Display the graph
      console.log();
      this.formatOutput(output, terminalWidth);
      console.log();

      // Show helpful tips
      this.showTips(options, useUnicode);
    } catch (error: any) {
      console.error(chalk.red('\n❌ Error generating commit graph'));
      console.error(chalk.gray(error.message));
      process.exit(1);
    }
  }

  private getTerminalWidth(): number {
    // Get terminal width, default to 80 if not available
    return process.stdout.columns || 80;
  }

  private getColorScheme(style: string): ColorScheme {
    const schemes: Record<string, ColorScheme> = {
      default: {
        hash: 'yellow',
        date: 'green',
        author: 'blue',
        refs: 'auto',
        message: 'white',
      },
      light: {
        hash: '#d7875f',       // Orange for light backgrounds
        date: '#5f8700',       // Dark green for light backgrounds
        author: '#005f87',     // Dark blue for light backgrounds
        refs: 'auto',
        message: 'black',
      },
      dark: {
        hash: '#ffaf00',       // Bright yellow for dark backgrounds
        date: '#87d700',       // Bright green for dark backgrounds
        author: '#5fafd7',     // Light blue for dark backgrounds
        refs: 'auto',
        message: 'white',
      },
    };

    return schemes[style] || schemes.default;
  }

  private getFormat(oneline: boolean, terminalWidth: number, colors: ColorScheme): string {
    // Calculate available space for commit message
    // Graph chars (~10-15), hash (7), separators (3-5), date (~15), author (~20 if shown)
    // Reserve extra space for branch/tag names
    const graphOverhead = oneline ? 45 : 60;
    const messageWidth = Math.max(30, terminalWidth - graphOverhead);

    if (oneline) {
      // Compact format: hash + refs + message (truncated) + date
      return `%C(${colors.hash})%h%C(reset) %C(${colors.refs})%d%C(reset) %<(${messageWidth},trunc)%s %C(${colors.date})(%ar)%C(reset)`;
    } else {
      // Detailed format: hash + refs + message (truncated) + date + author
      // Use %<(N,trunc) for message and %<(N,trunc) for author to maintain column alignment
      return `%C(${colors.hash})%h%C(reset) %C(${colors.refs})%d%C(reset) %<(${messageWidth},trunc)%s %C(${colors.date})%ar%C(reset) %C(${colors.author})%<(18,trunc)%an%C(reset)`;
    }
  }

  private convertToUnicode(output: string): string {
    // Convert ASCII graph characters to Unicode box-drawing characters
    // This provides a more polished, continuous look for the graph
    return output
      .replace(/\*/g, '●')      // Bullet point for commits
      .replace(/\|/g, '│')      // Vertical line
      .replace(/\//g, '╱')      // Forward slash (diagonal)
      .replace(/\\/g, '╲')      // Backslash (diagonal)
      .replace(/─/g, '─')       // Horizontal line (already Unicode)
      .replace(/_/g, '─');      // Underscore to horizontal line
  }

  private formatOutput(output: string, terminalWidth: number): void {
    const lines = output.split('\n');

    // First pass: determine the maximum graph width
    let maxGraphWidth = 0;
    const parsedLines: Array<{ graph: string; content: string; graphWidth: number; raw: string }> = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const parsed = this.parseGraphLine(line);
      if (parsed) {
        maxGraphWidth = Math.max(maxGraphWidth, parsed.graphWidth);
        parsedLines.push(parsed);
      }
    }

    // Use a reasonable maximum for graph column (don't let it get too wide)
    const graphColumnWidth = Math.min(maxGraphWidth + 2, 20);

    // Second pass: align and print
    for (const parsed of parsedLines) {
      const paddingNeeded = graphColumnWidth - parsed.graphWidth;
      const padding = ' '.repeat(Math.max(0, paddingNeeded));
      const alignedLine = parsed.graph + padding + parsed.content;

      // Truncate if needed
      const strippedLine = alignedLine.replace(/\x1b\[[0-9;]*m/g, '');

      if (strippedLine.length > terminalWidth) {
        const truncated = this.truncateLine(alignedLine, terminalWidth);
        console.log(truncated);
      } else {
        console.log(alignedLine);
      }
    }
  }

  private parseGraphLine(line: string): { graph: string; content: string; graphWidth: number; raw: string } | null {
    // Find where the graph ends and the commit info begins
    // Graph characters are typically: * | / \ and Unicode equivalents ● │ ╱ ╲
    // The graph ends when we hit the first letter/number that's part of the hash

    let graphEnd = 0;
    let inAnsiCode = false;
    let visibleChars = 0;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      // Track ANSI codes
      if (char === '\x1b') {
        inAnsiCode = true;
      } else if (inAnsiCode && char === 'm') {
        inAnsiCode = false;
        continue;
      }

      if (!inAnsiCode) {
        // Check if this is still part of the graph
        // Graph characters: * | / \ _ - and Unicode: ● │ ╱ ╲ ─ and spaces
        const isGraphChar = /[*|/\\_\-\s●│╱╲─]/.test(char);

        if (!isGraphChar) {
          // Found the start of commit info
          graphEnd = i;
          break;
        }

        visibleChars++;
      }
    }

    if (graphEnd === 0) {
      // No commit info found, might be an empty line
      return null;
    }

    return {
      graph: line.substring(0, graphEnd),
      content: line.substring(graphEnd),
      graphWidth: visibleChars,
      raw: line
    };
  }

  private truncateLine(line: string, maxWidth: number): string {
    let visibleChars = 0;
    let outputLine = '';
    let inAnsiCode = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      // Check for ANSI escape sequence start
      if (char === '\x1b') {
        inAnsiCode = true;
      }

      // Add character to output
      outputLine += char;

      // Count visible characters only
      if (!inAnsiCode) {
        visibleChars++;
        if (visibleChars >= maxWidth - 1) {
          break;
        }
      }

      // Check for ANSI escape sequence end
      if (inAnsiCode && char === 'm') {
        inAnsiCode = false;
      }
    }

    return outputLine;
  }

  private showTips(options: GraphOptions, useUnicode: boolean): void {
    const tips: string[] = [];

    if (!options.all) {
      tips.push('Use --all to see all branches');
    }
    if (!options.limit || options.limit === '20') {
      tips.push('Use --limit <n> to show more commits');
    }
    if (!options.oneline) {
      tips.push('Use --oneline for a compact view');
    }
    if (!useUnicode) {
      tips.push('Use --unicode for prettier box-drawing characters');
    }
    if (!options.style) {
      tips.push('Use --style light/dark to adjust colors for your terminal');
    }

    if (tips.length > 0) {
      console.log(chalk.dim('💡 Tips:'));
      tips.forEach(tip => console.log(chalk.dim(`   ${tip}`)));
    }
  }
}
