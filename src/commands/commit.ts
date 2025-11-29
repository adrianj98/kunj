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
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const execAsync = promisify(exec);

interface CommitOptions {
  all?: boolean;
  message?: string;
  amend?: boolean;
}

export class CommitCommand extends BaseCommand {
  constructor() {
    super({
      name: "commit",
      description: "Interactive commit - select files and commit with message",
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

        // Ask if user wants to push
        const { pushAction } = await inquirer.prompt([
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
    const enquirer = require("enquirer");
    const { MultiSelect } = enquirer;

    let availableFiles = [...files];
    let needsRefresh = false;

    while (true) {
      if (needsRefresh) {
        availableFiles = await getFileStatuses();
        needsRefresh = false;
        if (availableFiles.length === 0) {
          console.log(chalk.yellow("No files available to commit"));
          return [];
        }
      }

      // Format file choices with status indicators and line stats
      const choices = availableFiles.map((file) => {
        const statusIcon = this.getStatusIcon(file.status);
        const stagedIndicator = file.staged ? chalk.green("[staged]") : "        ";
        const fileName = file.oldPath
          ? `${file.oldPath} → ${file.path}`
          : file.path;

        // Format line changes
        let lineStats = "";
        if (file.additions !== undefined || file.deletions !== undefined) {
          const additions = file.additions || 0;
          const deletions = file.deletions || 0;

          if (additions > 0 && deletions > 0) {
            lineStats = `${chalk.green("+" + additions)} ${chalk.red("-" + deletions)}`;
          } else if (additions > 0) {
            lineStats = chalk.green("+" + additions);
          } else if (deletions > 0) {
            lineStats = chalk.red("-" + deletions);
          }
        }

        return {
          name: file.path,
          message: `${statusIcon} ${fileName.padEnd(50)} ${stagedIndicator} ${lineStats}`,
          enabled: file.staged, // Pre-select staged files
        };
      });

      const prompt = new MultiSelect({
        name: "files",
        message: "Select files to commit",
        choices,
        result(names: string[]) {
          return names;
        },
        footer() {
          return chalk.gray(
            "\n[↑↓] Navigate  [space] Toggle  [a] Toggle all  [enter] Continue\n" +
            "[→] View diff  [m] Diff w/main  [r] Revert  [d] Delete  [q] Cancel"
          );
        },
      });

      let promptClosed = false;

      // Custom key handlers
      prompt.on("keypress", async (input: string, key: any) => {
        if (promptClosed) return;

        const currentIndex = prompt.index;
        const currentFile = availableFiles[currentIndex];

        if (!currentFile) return;

        // Right arrow - show diff
        if (key.name === "right") {
          promptClosed = true;
          try {
            prompt.close();
          } catch (err) {
            // Ignore close errors
          }
          await this.showScrollableDiff(currentFile.path, false);
          needsRefresh = false;
          return;
        }

        // 'm' - show diff with main
        if (input === "m") {
          promptClosed = true;
          try {
            prompt.close();
          } catch (err) {
            // Ignore close errors
          }
          await this.showScrollableDiff(currentFile.path, true);
          needsRefresh = false;
          return;
        }

        // 'r' - revert file
        if (input === "r" && currentFile.status !== "new") {
          promptClosed = true;
          try {
            prompt.close();
          } catch (err) {
            // Ignore close errors
          }
          console.log(chalk.yellow(`\nRevert ${currentFile.path}?`));
          const { Confirm } = require("enquirer");
          const confirmPrompt = new Confirm({
            name: "confirm",
            message: "This cannot be undone. Continue?",
            initial: false,
          });

          try {
            const confirmed = await confirmPrompt.run();
            if (confirmed) {
              const result = await revertFile(currentFile.path);
              if (result.success) {
                console.log(chalk.green(`✓ ${result.message}`));
                needsRefresh = true;
              } else {
                console.log(chalk.red(`✗ ${result.message}`));
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (err) {
            // User cancelled
          }
          return;
        }

        // 'd' - delete file
        if (input === "d") {
          promptClosed = true;
          try {
            prompt.close();
          } catch (err) {
            // Ignore close errors
          }
          console.log(chalk.red(`\nDelete ${currentFile.path}?`));
          const { Confirm } = require("enquirer");
          const confirmPrompt = new Confirm({
            name: "confirm",
            message: "This cannot be undone. Continue?",
            initial: false,
          });

          try {
            const confirmed = await confirmPrompt.run();
            if (confirmed) {
              const result = await deleteFile(currentFile.path);
              if (result.success) {
                console.log(chalk.green(`✓ ${result.message}`));
                needsRefresh = true;
              } else {
                console.log(chalk.red(`✗ ${result.message}`));
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (err) {
            // User cancelled
          }
          return;
        }

        // 'q' - cancel/quit
        if (input === "q") {
          promptClosed = true;
          try {
            prompt.close();
          } catch (err) {
            // Ignore close errors
          }
          throw new Error("cancelled");
        }
      });

      try {
        const selected = await prompt.run();

        if (!selected || selected.length === 0) {
          console.log(chalk.yellow("No files selected"));
          return [];
        }

        return selected;
      } catch (err: any) {
        // Handle cancellation (Ctrl-C or 'q')
        // Also handle readline errors
        if (
          err.message === "cancelled" ||
          err.message === "" ||
          err.code === "ERR_USE_AFTER_CLOSE" ||
          !needsRefresh
        ) {
          console.log(chalk.yellow("\nCommit cancelled"));
          return [];
        }
        // If needsRefresh is true, continue the loop
      }
    }
  }

  private async showScrollableDiff(filePath: string, withMain: boolean): Promise<void> {
    console.log(chalk.cyan(`\n📄 ${withMain ? "Diff with main" : "Diff preview"}: ${filePath}`));
    console.log(chalk.gray("Loading...\n"));

    const diff = withMain ? await getFileDiffWithMain(filePath) : await getFileDiff(filePath);

    try {
      // Use less for scrollable viewing with colors
      const tempFile = `/tmp/kunj-diff-${Date.now()}.txt`;

      // Write diff to temp file
      fs.writeFileSync(tempFile, diff);

      // Use spawn to properly handle interactive less
      await new Promise<void>((resolve, reject) => {
        const lessProcess = spawn("less", ["-R", "-F", "-X", tempFile], {
          stdio: "inherit",
        });

        lessProcess.on("close", (code) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
          } catch (e) {
            // Ignore cleanup errors
          }

          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`less exited with code ${code}`));
          }
        });

        lessProcess.on("error", (err) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
          } catch (e) {
            // Ignore cleanup errors
          }
          reject(err);
        });
      });
    } catch (error) {
      // Fallback: just print the diff and wait for user
      console.clear();
      console.log(chalk.cyan(`\n📄 ${withMain ? "Diff with main" : "Diff preview"}: ${filePath}`));
      console.log(chalk.gray("─".repeat(60)));
      console.log(diff);
      console.log(chalk.gray("─".repeat(60)));
      console.log(chalk.gray("\nPress Enter to continue..."));
      await inquirer.prompt([
        {
          type: "input",
          name: "continue",
          message: "",
        },
      ]);
    }
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
