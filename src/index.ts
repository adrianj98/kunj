#!/usr/bin/env node

import { Command } from "commander";
import { exec } from "child_process";
import { promisify } from "util";
import inquirer from "inquirer";
import chalk from "chalk";

const execAsync = promisify(exec);

const program = new Command();

// Helper function to check if we're in a git repository
async function checkGitRepo(): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

// Helper function to get current branch
async function getCurrentBranch(): Promise<string> {
  try {
    const { stdout } = await execAsync("git branch --show-current");
    return stdout.trim();
  } catch (error) {
    throw new Error("Failed to get current branch");
  }
}

// Helper function to get all branches
async function getAllBranches(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git branch -a");
    const branches = stdout
      .split("\n")
      .filter((branch) => branch.trim())
      .map((branch) => branch.replace(/^\*?\s+/, "").trim())
      .filter((branch) => !branch.startsWith("remotes/"));
    return branches;
  } catch (error) {
    throw new Error("Failed to get branches");
  }
}

// Helper function to execute git commands with error handling
async function executeGitCommand(
  command: string
): Promise<{ success: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execAsync(command);
    return {
      success: true,
      message: stdout || stderr || "Command executed successfully",
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || "Command failed",
    };
  }
}

// Helper function to check if there are uncommitted changes
async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git status --porcelain");
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Helper function to create a stash for a branch
async function createStash(branchName: string): Promise<boolean> {
  try {
    const hasChanges = await hasUncommittedChanges();
    if (!hasChanges) {
      return false; // No changes to stash
    }

    const stashMessage = `kunj-auto-stash-${branchName}-${Date.now()}`;
    const result = await executeGitCommand(
      `git stash push -m "${stashMessage}"`
    );

    if (result.success) {
      console.log(
        chalk.yellow(`📦 Stashed changes from branch '${branchName}'`)
      );
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Helper function to find and pop a stash for a branch
async function popStashForBranch(branchName: string): Promise<boolean> {
  try {
    // Get list of stashes
    const { stdout } = await execAsync("git stash list");
    if (!stdout.trim()) {
      return false; // No stashes available
    }

    // Find the most recent kunj auto-stash for this branch
    const stashes = stdout.trim().split("\n");
    const branchStashPattern = `kunj-auto-stash-${branchName}-`;

    for (let i = 0; i < stashes.length; i++) {
      if (stashes[i].includes(branchStashPattern)) {
        // Found a stash for this branch, pop it
        const stashIndex = stashes[i].match(/stash@{(\d+)}/)?.[1];
        if (stashIndex !== undefined) {
          const result = await executeGitCommand(
            `git stash pop stash@{${stashIndex}}`
          );
          if (result.success) {
            console.log(
              chalk.yellow(
                `📤 Restored stashed changes for branch '${branchName}'`
              )
            );
            return true;
          } else if (result.message.includes("conflict")) {
            console.log(
              chalk.yellow(
                `⚠️  Stash applied with conflicts. Please resolve them manually.`
              )
            );
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Helper function to clean up old kunj stashes (optional cleanup)
async function cleanupOldStashes(): Promise<void> {
  try {
    const { stdout } = await execAsync("git stash list");
    if (!stdout.trim()) return;

    const stashes = stdout.trim().split("\n");
    const kunjStashes = stashes.filter((stash) =>
      stash.includes("kunj-auto-stash-")
    );

    // Keep only the most recent stash per branch
    const branchStashes = new Map<
      string,
      { index: number; timestamp: number }
    >();

    kunjStashes.forEach((stash) => {
      const match = stash.match(/stash@{(\d+)}.*kunj-auto-stash-(.+?)-(\d+)/);
      if (match) {
        const [, index, branch, timestamp] = match;
        const existing = branchStashes.get(branch);
        if (!existing || parseInt(timestamp) > existing.timestamp) {
          branchStashes.set(branch, {
            index: parseInt(index),
            timestamp: parseInt(timestamp),
          });
        }
      }
    });
  } catch {
    // Silently fail cleanup
  }
}

program
  .name("kunj")
  .description("A CLI tool for working with git branches")
  .version("1.0.0");

// Create command: kunj create <branch>
program
  .command("create <branch>")
  .description("Create a new branch and switch to it")
  .option("--no-stash", "Disable automatic stashing of changes")
  .action(async (branchName: string, options?: { stash?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      console.log(
        chalk.blue(`Creating branch '${branchName}' and switching to it...`)
      );

      // Get current branch before creating new one
      const currentBranch = await getCurrentBranch();

      // Stash changes if auto-stash is enabled (default)
      const shouldStash = options?.stash !== false;
      if (shouldStash) {
        await createStash(currentBranch);
      }

      // Create and checkout the branch
      const result = await executeGitCommand(`git checkout -b ${branchName}`);

      if (result.success) {
        console.log(
          chalk.green(
            `✓ Successfully created and switched to branch '${branchName}'`
          )
        );
      } else {
        // Check if branch already exists
        if (result.message.includes("already exists")) {
          console.error(chalk.red(`✗ Branch '${branchName}' already exists`));
          console.log(
            chalk.yellow(`Tip: Use 'kunj switch ${branchName}' to switch to it`)
          );
        } else {
          console.error(
            chalk.red(`✗ Failed to create branch: ${result.message}`)
          );
        }
        process.exit(1);
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Switch command: kunj switch [branch]
program
  .command("switch [branch]")
  .description("Switch to a branch (interactive if no branch specified)")
  .option("--no-stash", "Disable automatic stashing of changes")
  .action(async (branchName?: string, options?: { stash?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      // If branch name is provided, switch directly
      if (branchName) {
        const currentBranch = await getCurrentBranch();

        // Check if we're already on the target branch
        if (currentBranch === branchName) {
          console.log(chalk.yellow(`Already on branch '${branchName}'`));
          process.exit(0);
        }

        console.log(chalk.blue(`Switching to branch '${branchName}'...`));

        // Stash changes if auto-stash is enabled (default)
        const shouldStash = options?.stash !== false;
        if (shouldStash) {
          await createStash(currentBranch);
        }

        const result = await executeGitCommand(`git checkout ${branchName}`);

        if (result.success) {
          console.log(
            chalk.green(`✓ Successfully switched to branch '${branchName}'`)
          );

          // Try to pop any existing stash for this branch
          if (shouldStash) {
            await popStashForBranch(branchName);
          }
        } else {
          if (result.message.includes("did not match any file")) {
            console.error(chalk.red(`✗ Branch '${branchName}' does not exist`));

            // Get available branches and suggest
            const branches = await getAllBranches();
            if (branches.length > 0) {
              console.log(chalk.yellow("\nAvailable branches:"));
              branches.forEach((branch) => {
                console.log(chalk.gray(`  - ${branch}`));
              });
            }
          } else {
            console.error(
              chalk.red(`✗ Failed to switch branch: ${result.message}`)
            );
          }
          process.exit(1);
        }
      } else {
        // Interactive branch selection
        const currentBranch = await getCurrentBranch();
        const branches = await getAllBranches();

        if (branches.length === 0) {
          console.log(chalk.yellow("No branches found"));
          process.exit(0);
        }

        // Sort branches with current branch first
        const sortedBranches = branches.sort((a, b) => {
          if (a === currentBranch) return -1;
          if (b === currentBranch) return 1;
          return a.localeCompare(b);
        });

        // Add indicators to branch names
        const branchChoices = sortedBranches.map((branch) => ({
          name:
            branch === currentBranch
              ? `${chalk.green("●")} ${branch} ${chalk.gray("(current)")}`
              : `  ${branch}`,
          value: branch,
          short: branch,
        }));

        // Prompt user to select a branch
        const { selectedBranch } = await inquirer.prompt([
          {
            type: "list",
            name: "selectedBranch",
            message: "Select a branch to switch to:",
            choices: branchChoices,
            pageSize: 15,
          },
        ]);

        if (selectedBranch === currentBranch) {
          console.log(chalk.yellow("Already on this branch"));
          process.exit(0);
        }

        console.log(chalk.blue(`Switching to branch '${selectedBranch}'...`));

        // Stash changes if auto-stash is enabled (default)
        const shouldStash = options?.stash !== false;
        if (shouldStash) {
          await createStash(currentBranch);
        }

        const result = await executeGitCommand(
          `git checkout ${selectedBranch}`
        );

        if (result.success) {
          console.log(
            chalk.green(`✓ Successfully switched to branch '${selectedBranch}'`)
          );

          // Try to pop any existing stash for this branch
          if (shouldStash) {
            await popStashForBranch(selectedBranch);
          }
        } else {
          console.error(
            chalk.red(`✗ Failed to switch branch: ${result.message}`)
          );
          process.exit(1);
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// List command: kunj list (bonus feature)
program
  .command("list")
  .description("List all branches")
  .action(async () => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      const currentBranch = await getCurrentBranch();
      const branches = await getAllBranches();

      if (branches.length === 0) {
        console.log(chalk.yellow("No branches found"));
        process.exit(0);
      }

      console.log(chalk.blue("Branches:"));
      branches.forEach((branch) => {
        if (branch === currentBranch) {
          console.log(chalk.green(`  ● ${branch} (current)`));
        } else {
          console.log(`    ${branch}`);
        }
      });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Delete command: kunj delete <branch> (bonus feature)
program
  .command("delete <branch>")
  .description("Delete a branch")
  .option("-f, --force", "Force delete the branch")
  .action(async (branchName: string, options: { force?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      const currentBranch = await getCurrentBranch();

      if (branchName === currentBranch) {
        console.error(
          chalk.red(`✗ Cannot delete the current branch '${branchName}'`)
        );
        console.log(chalk.yellow("Tip: Switch to another branch first"));
        process.exit(1);
      }

      const deleteFlag = options.force ? "-D" : "-d";
      console.log(chalk.blue(`Deleting branch '${branchName}'...`));

      const result = await executeGitCommand(
        `git branch ${deleteFlag} ${branchName}`
      );

      if (result.success) {
        console.log(
          chalk.green(`✓ Successfully deleted branch '${branchName}'`)
        );
      } else {
        if (result.message.includes("not found")) {
          console.error(chalk.red(`✗ Branch '${branchName}' does not exist`));
        } else if (result.message.includes("not fully merged")) {
          console.error(
            chalk.red(`✗ Branch '${branchName}' is not fully merged`)
          );
          console.log(chalk.yellow("Tip: Use --force flag to force delete"));
        } else {
          console.error(
            chalk.red(`✗ Failed to delete branch: ${result.message}`)
          );
        }
        process.exit(1);
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();
