// Diff formatting utilities for beautiful git diff output

import chalk from 'chalk';

interface DiffLine {
  lineNumber?: number;
  type: 'context' | 'add' | 'remove' | 'header' | 'hunk';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface DiffFormatOptions {
  showLineNumbers?: boolean;
  highlightWords?: boolean;
  compactMode?: boolean;
  maxWidth?: number;
}

/**
 * Format a git diff with beautiful syntax highlighting
 * - Red background for removed lines (-)
 * - Green background for added lines (+)
 * - Line numbers for context
 * - Word-level highlighting for changes
 */
export function formatDiff(diffText: string, options: DiffFormatOptions = {}): string {
  const {
    showLineNumbers = true,
    highlightWords = true,
    compactMode = false,
    maxWidth = process.stdout.columns || 120,
  } = options;

  const lines = diffText.split('\n');
  const parsedLines = parseDiffLines(lines);
  const formatted: string[] = [];

  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of parsedLines) {
    switch (line.type) {
      case 'header':
        // File header (diff --git a/file b/file)
        formatted.push(chalk.bold.cyan(line.content));
        break;

      case 'hunk':
        // Hunk header (@@ -214,1 +214,1 @@)
        formatted.push(chalk.bold.blue(line.content));
        // Reset line numbers from hunk header
        const hunkMatch = line.content.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1], 10);
          newLineNum = parseInt(hunkMatch[2], 10);
        }
        break;

      case 'remove':
        formatted.push(formatRemoveLine(line.content, oldLineNum, showLineNumbers, maxWidth));
        oldLineNum++;
        break;

      case 'add':
        formatted.push(formatAddLine(line.content, newLineNum, showLineNumbers, maxWidth));
        newLineNum++;
        break;

      case 'context':
        formatted.push(formatContextLine(line.content, oldLineNum, newLineNum, showLineNumbers, maxWidth));
        oldLineNum++;
        newLineNum++;
        break;
    }
  }

  return formatted.join('\n');
}

/**
 * Format diff in side-by-side mode showing old and new versions
 */
export function formatSideBySideDiff(diffText: string, options: DiffFormatOptions = {}): string {
  const {
    maxWidth = process.stdout.columns || 120,
  } = options;

  const lines = diffText.split('\n');
  const parsedLines = parseDiffLines(lines);
  const formatted: string[] = [];

  const halfWidth = Math.floor((maxWidth - 10) / 2);
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of parsedLines) {
    if (line.type === 'header' || line.type === 'hunk') {
      formatted.push(chalk.bold.cyan(line.content));

      // Parse hunk header to reset line numbers
      if (line.type === 'hunk') {
        const hunkMatch = line.content.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          oldLineNum = parseInt(hunkMatch[1], 10);
          newLineNum = parseInt(hunkMatch[2], 10);
        }
      }
      continue;
    }

    // Format side by side
    if (line.type === 'remove') {
      const nextLine = parsedLines[parsedLines.indexOf(line) + 1];
      if (nextLine && nextLine.type === 'add') {
        // Show both old and new on same row
        formatted.push(formatSideBySideChange(
          line.content,
          nextLine.content,
          oldLineNum,
          newLineNum,
          halfWidth
        ));
        oldLineNum++;
        newLineNum++;
        // Skip the next line as we've already processed it
        parsedLines.splice(parsedLines.indexOf(line) + 1, 1);
      } else {
        // Only removal
        formatted.push(formatSideBySideRemove(line.content, oldLineNum, halfWidth));
        oldLineNum++;
      }
    } else if (line.type === 'add') {
      // Only addition
      formatted.push(formatSideBySideAdd(line.content, newLineNum, halfWidth));
      newLineNum++;
    } else if (line.type === 'context') {
      formatted.push(formatSideBySideContext(line.content, oldLineNum, newLineNum, halfWidth));
      oldLineNum++;
      newLineNum++;
    }
  }

  return formatted.join('\n');
}

function parseDiffLines(lines: string[]): DiffLine[] {
  const parsed: DiffLine[] = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith('diff --git') || line.startsWith('index ') ||
        line.startsWith('---') || line.startsWith('+++')) {
      parsed.push({ type: 'header', content: line });
    } else if (line.startsWith('@@')) {
      parsed.push({ type: 'hunk', content: line });
    } else if (line.startsWith('-')) {
      parsed.push({ type: 'remove', content: line.substring(1) });
    } else if (line.startsWith('+')) {
      parsed.push({ type: 'add', content: line.substring(1) });
    } else if (line.startsWith(' ')) {
      parsed.push({ type: 'context', content: line.substring(1) });
    } else {
      parsed.push({ type: 'context', content: line });
    }
  }

  return parsed;
}

function formatRemoveLine(content: string, lineNum: number, showLineNumbers: boolean, maxWidth: number): string {
  const lineNumStr = showLineNumbers ? chalk.dim(lineNum.toString().padStart(6)) : '';
  const marker = chalk.red.bold(' - ');
  const contentStr = truncate(content, maxWidth - 10);

  // Red background for removed lines
  return lineNumStr + marker + chalk.bgRed.white(contentStr);
}

function formatAddLine(content: string, lineNum: number, showLineNumbers: boolean, maxWidth: number): string {
  const lineNumStr = showLineNumbers ? chalk.dim(lineNum.toString().padStart(6)) : '';
  const marker = chalk.green.bold(' + ');
  const contentStr = truncate(content, maxWidth - 10);

  // Green background for added lines
  return lineNumStr + marker + chalk.bgGreen.black(contentStr);
}

function formatContextLine(content: string, oldLineNum: number, newLineNum: number, showLineNumbers: boolean, maxWidth: number): string {
  const lineNumStr = showLineNumbers ? chalk.dim(oldLineNum.toString().padStart(6)) : '';
  const marker = '   ';
  const contentStr = truncate(content, maxWidth - 10);

  return lineNumStr + marker + chalk.gray(contentStr);
}

function formatSideBySideChange(
  oldContent: string,
  newContent: string,
  oldLineNum: number,
  newLineNum: number,
  halfWidth: number
): string {
  const oldNum = chalk.dim(oldLineNum.toString().padStart(4));
  const newNum = chalk.dim(newLineNum.toString().padStart(4));

  const oldStr = truncate(oldContent, halfWidth);
  const newStr = truncate(newContent, halfWidth);

  const oldFormatted = chalk.bgRed.white(oldStr.padEnd(halfWidth));
  const newFormatted = chalk.bgGreen.black(newStr.padEnd(halfWidth));

  return `${oldNum} ${chalk.red('-')} ${oldFormatted} │ ${newNum} ${chalk.green('+')} ${newFormatted}`;
}

function formatSideBySideRemove(content: string, lineNum: number, halfWidth: number): string {
  const num = chalk.dim(lineNum.toString().padStart(4));
  const str = truncate(content, halfWidth);
  const formatted = chalk.bgRed.white(str.padEnd(halfWidth));
  const empty = ' '.repeat(halfWidth);

  return `${num} ${chalk.red('-')} ${formatted} │      ${empty}`;
}

function formatSideBySideAdd(content: string, lineNum: number, halfWidth: number): string {
  const num = chalk.dim(lineNum.toString().padStart(4));
  const str = truncate(content, halfWidth);
  const formatted = chalk.bgGreen.black(str.padEnd(halfWidth));
  const empty = ' '.repeat(halfWidth);

  return `      ${empty} │ ${num} ${chalk.green('+')} ${formatted}`;
}

function formatSideBySideContext(content: string, oldLineNum: number, newLineNum: number, halfWidth: number): string {
  const oldNum = chalk.dim(oldLineNum.toString().padStart(4));
  const newNum = chalk.dim(newLineNum.toString().padStart(4));
  const str = truncate(content, halfWidth);

  return `${oldNum}   ${chalk.gray(str.padEnd(halfWidth))} │ ${newNum}   ${chalk.gray(str.padEnd(halfWidth))}`;
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 2) + '..';
}

/**
 * Format a compact diff summary showing just the changed files
 */
export function formatDiffSummary(diffText: string): string {
  const lines = diffText.split('\n');
  const files: Array<{ name: string; additions: number; deletions: number }> = [];

  let currentFile = '';
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        files.push({ name: currentFile, additions, deletions });
        additions = 0;
        deletions = 0;
      }
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : '';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  if (currentFile) {
    files.push({ name: currentFile, additions, deletions });
  }

  const formatted: string[] = [];
  formatted.push(chalk.bold('\nChanged files:'));

  for (const file of files) {
    const addStr = file.additions > 0 ? chalk.green(`+${file.additions}`) : '';
    const delStr = file.deletions > 0 ? chalk.red(`-${file.deletions}`) : '';
    const stats = [addStr, delStr].filter(s => s).join(' ');
    formatted.push(`  ${chalk.cyan(file.name)} ${stats}`);
  }

  return formatted.join('\n');
}
