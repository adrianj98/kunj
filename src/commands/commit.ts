// Commit command - interactive file selection and commit

import chalk from "chalk";
import inquirer from "inquirer";
import { BaseCommand } from "../lib/command";
import {
  checkGitRepo,
  getFileStatuses,
  stageFiles,
  createCommit,
  getRecentCommitMessages,
  getCurrentBranch,
  getCommitsSinceBranch,
  FileStatus,
  getFileDiff,
  getFileDiffWithMain,
  revertFile,
  deleteFile,
} from "../lib/git";
import { generateAICommitMessage, checkAWSCredentials, getAWSConfigInfo, generateWorkLogEntry } from "../lib/ai-commit";
import { updateBranchMetadata } from "../lib/metadata";
import { appendToWorkLog } from "../lib/work-log";
import { formatDiff, formatSideBySideDiff } from "../lib/diff-formatter";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface CommitOptions {
  all?: boolean;
  message?: string;
  amend?: boolean;
  auto?: boolean;
}

export class CommitCommand extends BaseCommand {
  constructor() {
    super({
      name: "commit",
      description: "Interactive commit - select files and commit with message",
      ui: { category: 'action', widget: 'form-only', label: 'Commit', icon: 'check', order: 22 },
      options: [
        {
          flags: "-a, --all",
          description: "Stage all changed files automatically",
        },
        {
          flags: "-m, --message <message>",
          description: "Commit message (skip interactive prompt)",
        },
        { flags: "--amend", description: "Amend the last commit" },
        {
          flags: "--auto",
          description: "Auto mode: use AI for commit message and auto-push",
        },
      ],
    });
  }

  async execute(options: CommitOptions = {}): Promise<void> {
    // Handle Ctrl-C gracefully
    const sigintHandler = () => {
      console.log(chalk.yellow("\n\nCommit cancelled"));
      process.exit(0);
    };
    process.on("SIGINT", sigintHandler);

    try {
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
      const stagedFiles = files.filter((f) => f.staged);
      const unstagedFiles = files.filter((f) => !f.staged);

      // If --all flag, stage all files
      let filesToCommit: string[] = [];

        if (options.all) {
        filesToCommit = files.map((f) => f.path);
        console.log(
          chalk.cyan(`Staging all ${filesToCommit.length} changed files...`)
        );
        const stageResult = await stageFiles(filesToCommit);
        if (!stageResult.success) {
          console.error(
            chalk.red(`Failed to stage files: ${stageResult.message}`)
          );
          process.exit(1);
        }
        } else if (unstagedFiles.length > 0) {
        // Interactive file selection
        try {
          filesToCommit = await this.selectFiles(files);

          if (filesToCommit.length === 0) {
            return;
          }

          // Stage selected files
          console.log(
            chalk.cyan(`Staging ${filesToCommit.length} selected files...`)
          );
          const stageResult = await stageFiles(filesToCommit);
          if (!stageResult.success) {
            console.error(
              chalk.red(`Failed to stage files: ${stageResult.message}`)
            );
            process.exit(1);
          }
        } catch (err) {
          // Handle Ctrl-C gracefully
          console.log(chalk.yellow("\nCommit cancelled"));
          return;
        }
        } else if (stagedFiles.length > 0) {
        // Use already staged files
        console.log(chalk.green(`${stagedFiles.length} files already staged`));
        filesToCommit = stagedFiles.map((f) => f.path);
        } else {
        console.log(chalk.yellow("No files to commit"));
        return;
      }

      // Get commit message
      let commitMessage: string;
      let usedAI = false;

      if (options.message) {
        commitMessage = options.message;
        } else if (options.auto) {
        // Auto mode: use AI without prompting
        const branchCommits = await getCommitsSinceBranch();
        const aiResult = await generateAICommitMessage(filesToCommit, branchCommits, currentBranch);
        commitMessage = aiResult.fullMessage || "";
        usedAI = true;

        console.log(chalk.cyan("\n🤖 AI-generated commit message:"));
        console.log(chalk.white(commitMessage));

        // Save branch description if generated
        if (aiResult.branchDescription) {
          updateBranchMetadata(currentBranch, {
            description: aiResult.branchDescription
          });
        }
        } else {
        const result = await this.getCommitMessage(filesToCommit);
        commitMessage = result.message;
        usedAI = result.usedAI;
        if (!commitMessage) {
          console.log(chalk.yellow("Commit cancelled"));
          return;
        }
      }

      // Create the commit
      console.log(chalk.blue("Creating commit..."));
      const commitResult = await createCommit(commitMessage);

      if (commitResult.success) {
        console.log(chalk.green("✓ Commit created successfully"));

        // Generate work log entry if AI was used
        if (usedAI) {
          try {
            console.log(chalk.gray("📝 Generating work log entry..."));
            const workLogEntry = await generateWorkLogEntry(
              filesToCommit,
              commitMessage,
              currentBranch
            );

            if (workLogEntry) {
              appendToWorkLog(workLogEntry);
              const { getTodayLogPath } = require("../lib/work-log");
              const logPath = getTodayLogPath();
              console.log(chalk.green("✓ Work log updated"));
              console.log(chalk.gray(`  Log file: ${logPath}`));
            } else {
              console.log(chalk.yellow("⚠ Work log entry was not generated"));
            }
          } catch (error: any) {
            // Show the actual error for debugging
            console.error(chalk.red("✗ Work log generation failed:"), error.message);
            if (error.stack) {
              console.error(chalk.gray(error.stack));
            }
          }
        }

        // Show commit details
        const commitInfo = commitResult.message.match(/\[([^\]]+)\]\s+(.+)/);
        if (commitInfo) {
          console.log(chalk.gray(`  Branch: ${commitInfo[1]}`));
          console.log(chalk.gray(`  Message: ${commitInfo[2]}`));
        }

        // Show what was committed
        console.log(chalk.cyan(`\nCommitted ${filesToCommit.length} files:`));
        filesToCommit.forEach((file) => {
          console.log(chalk.gray(`  - ${file}`));
        });

        // Ask if user wants to push (or auto-push in auto mode)
        let pushAction = "skip";

        if (options.auto) {
          // Auto mode: always push
          pushAction = "push";
          console.log(chalk.gray("\n[Auto mode: pushing to remote]"));
        } else {
          const answer = await inquirer.prompt([
            {
              type: "list",
              name: "pushAction",
              message: "What would you like to do next?",
              choices: [
                { name: "Push to remote", value: "push" },
                { name: "Push and create PR", value: "pr" },
                { name: "Skip (don't push)", value: "skip" },
              ],
              default: "push",
            },
          ]);
          pushAction = answer.pushAction;
        }

        if (pushAction === "push" || pushAction === "pr") {
          console.log(chalk.blue("\nPushing to remote..."));
          try {
            const { exec } = require("child_process");
            const { promisify } = require("util");
            const execAsync = promisify(exec);

            // First check if we need to set upstream
            const currentBranch = await getCurrentBranch();
            const { stdout: trackingBranch } = await execAsync(
              `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo ""`
            );

            if (!trackingBranch.trim()) {
              // No upstream branch, push with -u
              console.log(chalk.gray(`Setting upstream branch...`));
              const { stderr } = await execAsync(
                `git push -u origin ${currentBranch}`
              );
              if (stderr && !stderr.includes("Everything up-to-date")) {
                console.log(chalk.yellow(stderr));
              }
              console.log(chalk.green("✓ Pushed and set upstream branch"));
            } else {
              // Upstream exists, normal push
              const { stderr } = await execAsync("git push");
              if (stderr && !stderr.includes("Everything up-to-date")) {
                console.log(chalk.yellow(stderr));
              }
              console.log(chalk.green("✓ Pushed to remote"));
            }

            // If user selected "pr", create a pull request
            if (pushAction === "pr") {
              console.log(chalk.blue("\nCreating pull request..."));
              const { PrCommand } = require("./pr");
              const prCommand = new PrCommand();
              await prCommand.execute(undefined, {});
            }
          } catch (error: any) {
            console.error(chalk.red(`✗ Push failed: ${error.message}`));
            console.log(chalk.gray("You can manually push with: git push"));
          }
        }
        } else {
        console.error(chalk.red(`✗ Commit failed: ${commitResult.message}`));
        process.exit(1);
      }
    } finally {
      // Remove SIGINT handler
      process.off("SIGINT", sigintHandler);
    }
  }

  private async selectFiles(files: FileStatus[]): Promise<string[]> {
    // Strip ANSI escape codes for visible length calculation
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

    // Truncate a string with ANSI codes to at most maxLen visible characters
    const truncateAnsi = (str: string, maxLen: number): string => {
      let visible = 0;
      let result = '';
      let i = 0;
      while (i < str.length) {
        if (str[i] === '\x1b' && str[i + 1] === '[') {
          // ANSI escape sequence — copy it whole
          const end = str.indexOf('m', i + 2);
          if (end !== -1) {
            result += str.slice(i, end + 1);
            i = end + 1;
          } else {
            i++;
          }
        } else {
          if (visible >= maxLen) break;
          result += str[i];
          visible++;
          i++;
        }
      }
      return result + '\x1b[0m';
    };

    const termWidth  = () => process.stdout.columns || 120;
    const termHeight = () => process.stdout.rows    || 40;

    // Dimensions — recalculated on each render so resize is handled
    const leftWidth    = () => Math.min(48, Math.floor(termWidth() * 0.38));
    const rightWidth   = () => termWidth() - leftWidth() - 3; // 3 = ' │ '
    const contentLines = () => termHeight() - 4; // 2 header + 2 footer

    let availableFiles = [...files];
    let selected       = new Set<string>(files.filter(f => f.staged).map(f => f.path));
    let cursorIdx      = 0;
    let fileScrollTop  = 0;
    let diffLines: string[] = [];
    let diffScrollTop  = 0;
    let diffLoading    = false;
    let withMain       = false;
    let statusMsg      = '';
    let isDone         = false;
    let cancelled      = false;
    const diffCache    = new Map<string, string[]>(); // key: `${path}:${withMain}`

    const stdin   = process.stdin;
    const wasRaw  = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    // Enter alternate screen buffer, clear, hide cursor
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');

    const render = () => {
      const lw = leftWidth();
      const rw = rightWidth();
      const cl = contentLines();
      const tw = termWidth();
      let buf = '\x1b[H'; // move to top-left without clearing (avoids flicker)

      // ── Header ──────────────────────────────────────────────────────────
      const curFile   = availableFiles[cursorIdx];
      const modeLabel = withMain ? ' [vs main]' : '';
      const lHead = ` Files  ${selected.size}/${availableFiles.length} selected`;
      const rHead = curFile ? ` Diff: ${curFile.path}${modeLabel}` : ' Diff';
      buf += chalk.bgBlue.bold.white(lHead.padEnd(lw).slice(0, lw));
      buf += chalk.bgBlue.white(' │ ');
      buf += chalk.bgBlue.white(rHead.padEnd(rw).slice(0, rw));
      buf += '\x1b[0K\n';
      buf += chalk.gray('─'.repeat(lw) + '─┼─' + '─'.repeat(Math.max(0, rw)));
      buf += '\x1b[0K\n';

      // ── Content rows ─────────────────────────────────────────────────────
      for (let i = 0; i < cl; i++) {
        const fi = fileScrollTop + i;
        const di = diffScrollTop + i;

        // Left pane — file row
        if (fi < availableFiles.length) {
          const file      = availableFiles[fi];
          const isCursor  = fi === cursorIdx;
          const isChecked = selected.has(file.path);
          const checkbox  = isChecked ? chalk.green('◉') : chalk.gray('○');
          const icon      = this.getStatusIcon(file.status);
          const name      = file.oldPath ? `${file.oldPath}→${file.path}` : file.path;

          let stats = '';
          const a = file.additions || 0;
          const d = file.deletions || 0;
          if (a > 0) stats += chalk.green(`+${a}`);
          if (d > 0) stats += chalk.red(` -${d}`);

          const rawEntry = ` ${checkbox} ${icon} ${name}`;
          const pad      = Math.max(0, lw - stripAnsi(rawEntry).length);
          const entry    = truncateAnsi(rawEntry, lw) + ' '.repeat(pad > 0 ? Math.min(pad, lw - stripAnsi(rawEntry).length) : 0);
          const entryPad = (' ' + stripAnsi(rawEntry)).slice(0, lw).padEnd(lw);

          if (isCursor) {
            // High-contrast highlight: cyan background, bright white bold text
            buf += chalk.bgCyan.whiteBright.bold('▶ ' + entryPad.slice(2));
          } else {
            // Re-emit with original ANSI colors but padded
            const colored = truncateAnsi(rawEntry, lw);
            const coloredPad = lw - Math.min(lw, stripAnsi(rawEntry).length);
            buf += colored + ' '.repeat(coloredPad);
          }
        } else {
          buf += ' '.repeat(lw);
        }

        // Divider
        buf += chalk.gray(' │ ');

        // Right pane — diff row
        if (diffLoading && i === 0) {
          buf += chalk.gray('Loading diff…');
        } else if (di < diffLines.length) {
          buf += truncateAnsi(diffLines[di], rw);
        }

        buf += '\x1b[0K\n';
      }

      // ── Footer ───────────────────────────────────────────────────────────
      buf += chalk.gray('─'.repeat(tw)) + '\x1b[0K\n';
      const footerKeys = '[↑↓] Nav  [Spc] Select  [a] All  [m] Toggle main  [j/k] Scroll diff  [r] Revert  [d] Delete  [Enter] Done  [q] Cancel';
      if (statusMsg) {
        buf += chalk.yellow(statusMsg.padEnd(tw).slice(0, tw)) + '\x1b[0K';
      } else {
        buf += chalk.gray(footerKeys.slice(0, tw)) + '\x1b[0K';
      }

      process.stdout.write(buf);
    };

    const loadDiff = async (filePath: string) => {
      const cacheKey = `${filePath}:${withMain}`;
      if (diffCache.has(cacheKey)) {
        diffLines     = diffCache.get(cacheKey)!;
        diffScrollTop = 0;
        render();
        return;
      }
      diffLoading = true;
      diffLines   = [];
      render();
      try {
        const raw       = withMain ? await getFileDiffWithMain(filePath) : await getFileDiff(filePath, false);
        const formatted = formatDiff(raw, { showLineNumbers: true, highlightWords: true, maxWidth: rightWidth() });
        const lines     = formatted.split('\n');
        diffCache.set(cacheKey, lines);
        diffLines = lines;
      } catch {
        diffLines = [chalk.red('Error loading diff')];
      }
      diffLoading   = false;
      diffScrollTop = 0;
      if (!isDone) render();
    };

    // Initial load
    if (availableFiles.length > 0) loadDiff(availableFiles[0].path);
    else render();

    const refreshFiles = async () => {
      availableFiles = await getFileStatuses();
      diffCache.clear();
      if (cursorIdx >= availableFiles.length) cursorIdx = Math.max(0, availableFiles.length - 1);
      selected = new Set(availableFiles.filter(f => f.staged).map(f => f.path));
      if (availableFiles.length > 0) await loadDiff(availableFiles[cursorIdx].path);
      else render();
    };

    await new Promise<void>((resolve) => {
      let processing = false;

      const onKey = async (key: string) => {
        if (isDone || processing) return;
        statusMsg = '';

        // Ctrl-C
        if (key === '\x03') { cancelled = true; isDone = true; resolve(); return; }
        // q
        if (key === 'q') { cancelled = true; isDone = true; resolve(); return; }
        // Enter
        if (key === '\r' || key === '\n') { isDone = true; resolve(); return; }

        // Space — toggle selection
        if (key === ' ') {
          const f = availableFiles[cursorIdx];
          if (f) { if (selected.has(f.path)) selected.delete(f.path); else selected.add(f.path); }
          render(); return;
        }

        // a — toggle all
        if (key === 'a') {
          if (selected.size === availableFiles.length) selected.clear();
          else availableFiles.forEach(f => selected.add(f.path));
          render(); return;
        }

        // ↑ — move cursor up
        if (key === '\x1b[A') {
          if (cursorIdx > 0) {
            cursorIdx--;
            if (cursorIdx < fileScrollTop) fileScrollTop = cursorIdx;
            loadDiff(availableFiles[cursorIdx].path);
            render();
          }
          return;
        }

        // ↓ — move cursor down
        if (key === '\x1b[B') {
          if (cursorIdx < availableFiles.length - 1) {
            cursorIdx++;
            const cl = contentLines();
            if (cursorIdx >= fileScrollTop + cl) fileScrollTop = cursorIdx - cl + 1;
            loadDiff(availableFiles[cursorIdx].path);
            render();
          }
          return;
        }

        // j — scroll diff down
        if (key === 'j' || key === '\x1b[6~') {
          const maxScroll = Math.max(0, diffLines.length - contentLines());
          diffScrollTop   = Math.min(maxScroll, diffScrollTop + Math.floor(contentLines() / 2));
          render(); return;
        }

        // k — scroll diff up
        if (key === 'k' || key === '\x1b[5~') {
          diffScrollTop = Math.max(0, diffScrollTop - Math.floor(contentLines() / 2));
          render(); return;
        }

        // m — toggle diff mode (current vs main)
        if (key === 'm') {
          withMain = !withMain;
          const f  = availableFiles[cursorIdx];
          if (f) await loadDiff(f.path);
          else render();
          return;
        }

        // r — revert file
        if (key === 'r') {
          const f = availableFiles[cursorIdx];
          if (!f || f.status === 'new') { statusMsg = 'Cannot revert new files'; render(); return; }
          processing = true;
          stdin.removeListener('data', onKey);
          process.stdout.write('\x1b[?1049l\x1b[?25h');
          console.log(chalk.yellow(`\nRevert ${f.path}?`));
          try {
            const { Confirm } = require('enquirer');
            const confirmed = await new Confirm({ name: 'confirm', message: 'This cannot be undone. Continue?', initial: false }).run();
            if (confirmed) {
              const res = await revertFile(f.path);
              console.log(res.success ? chalk.green(`✓ ${res.message}`) : chalk.red(`✗ ${res.message}`));
              await new Promise(r => setTimeout(r, 700));
            }
          } catch { /* cancelled */ }
          process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
          await refreshFiles();
          processing = false;
          stdin.on('data', onKey);
          return;
        }

        // d — delete file
        if (key === 'd') {
          const f = availableFiles[cursorIdx];
          if (!f) return;
          processing = true;
          stdin.removeListener('data', onKey);
          process.stdout.write('\x1b[?1049l\x1b[?25h');
          console.log(chalk.red(`\nDelete ${f.path}?`));
          try {
            const { Confirm } = require('enquirer');
            const confirmed = await new Confirm({ name: 'confirm', message: 'This cannot be undone. Continue?', initial: false }).run();
            if (confirmed) {
              const res = await deleteFile(f.path);
              console.log(res.success ? chalk.green(`✓ ${res.message}`) : chalk.red(`✗ ${res.message}`));
              await new Promise(r => setTimeout(r, 700));
            }
          } catch { /* cancelled */ }
          process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
          await refreshFiles();
          processing = false;
          stdin.on('data', onKey);
          return;
        }
      };

      stdin.on('data', onKey);
    });

    // Restore terminal
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
    stdin.pause();

    if (cancelled) {
      console.log(chalk.yellow('\nCommit cancelled'));
      return [];
    }

    if (selected.size === 0) {
      console.log(chalk.yellow('No files selected'));
      return [];
    }

    return Array.from(selected);
  }

  private async showScrollableDiff(filePath: string, withMain: boolean): Promise<void> {
    console.clear();
    console.log(chalk.cyan(`\n📄 ${withMain ? "Diff with main" : "Diff preview"}: ${filePath}`));
    console.log(chalk.gray("─".repeat(Math.min(80, process.stdout.columns || 80))));

    // Get raw diff without colors for custom formatting
    const diff = withMain ? await getFileDiffWithMain(filePath) : await getFileDiff(filePath, false);

    // Format the diff with beautiful syntax highlighting
    const formattedDiff = formatDiff(diff, {
      showLineNumbers: true,
      highlightWords: true,
      maxWidth: process.stdout.columns || 120,
    });

    // Print the diff directly
    console.log(formattedDiff);
    console.log(chalk.gray("─".repeat(Math.min(80, process.stdout.columns || 80))));

    // Use readline to capture Escape key
    console.log(chalk.dim("\n[Press Enter or Escape to go back to file list]"));

    await new Promise<void>((resolve) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;

      // Enable raw mode to capture individual keypresses
      if (stdin.setRawMode) {
        stdin.setRawMode(true);
      }
      stdin.resume();

      const onData = (key: Buffer) => {
        const keyStr = key.toString();

        // Check for Enter (0x0D or 0x0A) or Escape (0x1B)
        if (keyStr === '\r' || keyStr === '\n' || keyStr === '\x1B') {
          // Clean up
          stdin.removeListener('data', onData);
          if (stdin.setRawMode) {
            stdin.setRawMode(wasRaw || false);
          }
          stdin.pause();
          resolve();
        }
      };

      stdin.on('data', onData);
    });
  }

  private async getCommitMessage(files: string[]): Promise<{ message: string; usedAI: boolean }> {
    // Get recent commits for reference
    const recentCommits = await getRecentCommitMessages(5);

    console.log(chalk.cyan("\nRecent commit messages for reference:"));
    recentCommits.forEach((msg, i) => {
      console.log(chalk.gray(`  ${i + 1}. ${msg}`));
    });

    // Suggest a commit type based on files
    const suggestedType = this.suggestCommitType(files);

    const aiAvailable = await checkAWSCredentials();
    const aiInfo = await getAWSConfigInfo();

    const commitTypeChoices = [
      { name: chalk.cyan("🤖 AI: Generate message with AI"), value: "ai" },
      { name: "──────────────────────", value: "", disabled: true },
      { name: "feat: A new feature", value: "feat" },
      { name: "fix: A bug fix", value: "fix" },
      { name: "docs: Documentation changes", value: "docs" },
      { name: "style: Code style changes (formatting, etc)", value: "style" },
      { name: "refactor: Code refactoring", value: "refactor" },
      { name: "test: Adding or updating tests", value: "test" },
      { name: "chore: Maintenance tasks", value: "chore" },
      { name: "build: Build system changes", value: "build" },
      { name: "ci: CI configuration changes", value: "ci" },
      { name: "perf: Performance improvements", value: "perf" },
      { name: "revert: Revert a previous commit", value: "revert" },
      { name: "(none): No prefix", value: "" },
    ];

    // If AI is not available, show a helpful message
    if (!aiAvailable) {
      if (!aiInfo.enabled) {
        commitTypeChoices[0] = {
          name: chalk.gray("🤖 AI: Disabled (enable with: kunj config --set ai.enabled=true)"),
          value: "ai",
          disabled: true,
        };
      } else {
        commitTypeChoices[0] = {
          name: chalk.gray("🤖 AI: Not configured (set AWS credentials)"),
          value: "ai",
          disabled: true,
        };
      }
    }

    // First, only ask for the commit type
    // Default to AI if it's available, otherwise use the suggested type
    const { commitType } = await inquirer.prompt([
      {
        type: "list",
        name: "commitType",
        message: "Select commit type:",
        choices: commitTypeChoices,
        default: aiAvailable ? "ai" : suggestedType,
      },
    ]);

    // Handle AI-generated commit message
    let message: string;

    if (commitType === "ai") {
      // Get branch commits for context
      const branchCommits = await getCommitsSinceBranch();
      const currentBranch = await getCurrentBranch();

      // Generate commit message using AI
      const aiResult = await generateAICommitMessage(files, branchCommits, currentBranch);

      console.log(chalk.cyan("\n🤖 AI-generated commit message:"));
      console.log(chalk.white(aiResult.fullMessage));

      // Save branch description if generated
      if (aiResult.branchDescription) {
        updateBranchMetadata(currentBranch, {
          description: aiResult.branchDescription
        });
        console.log(chalk.cyan(`\nBranch description saved: ${aiResult.branchDescription}`));
      }

      // Use the AI-generated message directly without asking for confirmation
      message = aiResult.fullMessage || "";

      // Return the AI-generated message immediately
      return { message, usedAI: true };
      } else {
      // For non-AI options, ask for message and body
      const manualAnswers = await inquirer.prompt([
        {
          type: "input",
          name: "commitMessage",
          message: "Enter commit message:",
          validate: (input: any) => {
            if (!input.trim()) {
              return "Commit message cannot be empty";
            }
            if (input.length > 100) {
              return "Commit message should be less than 100 characters";
            }
            return true;
          },
        },
        {
          type: "editor",
          name: "commitBody",
          message: "Additional commit details (optional, press Enter to skip):",
          default: "",
        },
      ]);

      // Construct the final commit message manually
      message = manualAnswers.commitMessage;
      if (commitType) {
        message = `${commitType}: ${message}`;
      }
      if (manualAnswers.commitBody && manualAnswers.commitBody.trim()) {
        message += `\n\n${manualAnswers.commitBody.trim()}`;
      }

      // Show preview and confirm for manual commits
      console.log(chalk.cyan("\nCommit message preview:"));
      console.log(chalk.white(message));
      console.log();

      const { confirmed } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmed",
          message: "Proceed with this commit?",
          default: true,
        },
      ]);

      return confirmed ? { message, usedAI: false } : { message: "", usedAI: false };
    }
  }

  private getStatusIcon(status: FileStatus["status"]): string {
    switch (status) {
      case "new":
        return chalk.green("+");
      case "modified":
        return chalk.yellow("M");
      case "deleted":
        return chalk.red("D");
      case "renamed":
        return chalk.blue("R");
      case "copied":
        return chalk.cyan("C");
      case "unmerged":
        return chalk.magenta("U");
      default:
        return chalk.gray("?");
    }
  }

  private suggestCommitType(files: string[]): string {
    // Simple heuristic to suggest commit type based on file paths
    if (files.some((f) => f.includes("test") || f.includes("spec"))) {
      return "test";
    }
    if (files.some((f) => f.includes(".md") || f.includes("README"))) {
      return "docs";
    }
    if (
      files.some((f) => f.includes("package.json") || f.includes("tsconfig"))
    ) {
      return "build";
    }
    if (
      files.some(
        (f) =>
          f.includes(".yml") || f.includes(".yaml") || f.includes(".github")
      )
    ) {
      return "ci";
    }
    if (files.some((f) => f.includes("fix") || f.includes("bug"))) {
      return "fix";
    }

    // Default to feat for new files, refactor for modifications
    const hasNewFiles = files.some(
      (f) => f.endsWith(".ts") || f.endsWith(".js")
    );
    return hasNewFiles ? "feat" : "refactor";
  }
}
