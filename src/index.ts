#!/usr/bin/env node

import { Command } from "commander";
import { exec } from "child_process";
import { promisify } from "util";
import inquirer from "inquirer";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

const program = new Command();

// Configuration and metadata interfaces
interface KunjConfig {
  preferences: {
    autoStash: boolean;
    branchSort: "recent" | "alphabetical";
    showStashDetails: boolean;
    pageSize: number;
    showOnlyWIP: boolean;
    wipTags: string[];
    doneTags: string[];
  };
  aliases: Record<string, string>;
}

interface BranchMetadata {
  description?: string;
  tags?: string[];
  notes?: string;
  relatedIssues?: string[];
  lastSwitched?: string;
}

interface BranchesMetadata {
  branches: Record<string, BranchMetadata>;
}

// Default configuration
const defaultConfig: KunjConfig = {
  preferences: {
    autoStash: true,
    branchSort: "recent",
    showStashDetails: true,
    pageSize: 15,
    showOnlyWIP: false,
    wipTags: ["wip", "in-progress", "working", "draft"],
    doneTags: ["done", "completed", "merged", "ready"]
  },
  aliases: {}
};

// Helper function to get .kunj directory path
function getKunjDir(): string {
  return path.join(process.cwd(), ".kunj");
}

// Helper function to get config file path
function getConfigPath(): string {
  return path.join(getKunjDir(), "config.json");
}

// Helper function to get branches metadata file path
function getBranchesPath(): string {
  return path.join(getKunjDir(), "branches.json");
}

// Initialize .kunj directory if it doesn't exist
function initKunjDirectory(): void {
  const kunjDir = getKunjDir();
  if (!fs.existsSync(kunjDir)) {
    fs.mkdirSync(kunjDir, { recursive: true });
  }
}

// Load configuration
function loadConfig(): KunjConfig {
  try {
    initKunjDirectory();
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, "utf8");
      const savedConfig = JSON.parse(configData);

      // Deep merge with default config to ensure all fields exist
      return {
        preferences: {
          ...defaultConfig.preferences,
          ...savedConfig.preferences
        },
        aliases: {
          ...defaultConfig.aliases,
          ...savedConfig.aliases
        }
      };
    }
  } catch (error) {
    // Return default config if there's an error
  }
  return defaultConfig;
}

// Save configuration
function saveConfig(config: KunjConfig): void {
  try {
    initKunjDirectory();
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(chalk.yellow("Warning: Could not save configuration"));
  }
}

// Load branch metadata
function loadBranchMetadata(): BranchesMetadata {
  try {
    initKunjDirectory();
    const branchesPath = getBranchesPath();
    if (fs.existsSync(branchesPath)) {
      const data = fs.readFileSync(branchesPath, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    // Return empty metadata if there's an error
  }
  return { branches: {} };
}

// Save branch metadata
function saveBranchMetadata(metadata: BranchesMetadata): void {
  try {
    initKunjDirectory();
    const branchesPath = getBranchesPath();
    fs.writeFileSync(branchesPath, JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.error(chalk.yellow("Warning: Could not save branch metadata"));
  }
}

// Get metadata for a specific branch
function getBranchMetadataItem(branch: string): BranchMetadata {
  const metadata = loadBranchMetadata();
  return metadata.branches[branch] || {};
}

// Update metadata for a specific branch
function updateBranchMetadata(branch: string, updates: Partial<BranchMetadata>): void {
  const metadata = loadBranchMetadata();
  if (!metadata.branches[branch]) {
    metadata.branches[branch] = {};
  }
  metadata.branches[branch] = { ...metadata.branches[branch], ...updates };
  saveBranchMetadata(metadata);
}

// Check if a branch is work in progress
function isBranchWIP(branch: string, config: KunjConfig): boolean {
  const metadata = getBranchMetadataItem(branch);

  // If no tags, consider it WIP by default (active development)
  if (!metadata.tags || metadata.tags.length === 0) {
    return true;
  }

  // Check if branch has any done tags (not WIP)
  const hasDoneTags = metadata.tags.some(tag =>
    config.preferences.doneTags.some(doneTag =>
      tag.toLowerCase() === doneTag.toLowerCase()
    )
  );

  if (hasDoneTags) {
    return false;
  }

  // Check if branch has any WIP tags
  const hasWipTags = metadata.tags.some(tag =>
    config.preferences.wipTags.some(wipTag =>
      tag.toLowerCase() === wipTag.toLowerCase()
    )
  );

  // If it has WIP tags or no done tags, consider it WIP
  return hasWipTags || !hasDoneTags;
}

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

// Helper function to get branches sorted by most recent activity
async function getBranchesSortedByRecent(): Promise<{ name: string; lastActivity: string }[]> {
  try {
    // Get branches sorted by committerdate (most recent first)
    const { stdout } = await execAsync(
      `git for-each-ref --sort=-committerdate --format='%(refname:short)|%(committerdate:relative)' refs/heads/`
    );

    if (!stdout.trim()) {
      return [];
    }

    const branches = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [name, lastActivity] = line.split("|");
        return { name, lastActivity };
      });

    return branches;
  } catch (error) {
    throw new Error("Failed to get branches sorted by recent activity");
  }
}

// Helper function to get detailed stash info
async function getStashDetails(stashRef: string): Promise<{ files: number; additions: number; deletions: number } | null> {
  try {
    // Get diff stat for the stash
    const { stdout } = await execAsync(`git diff ${stashRef}^..${stashRef} --stat --stat-width=1000`);

    if (!stdout.trim()) return null;

    const lines = stdout.trim().split("\n");
    const summaryLine = lines[lines.length - 1];

    // Parse the summary line (e.g., "3 files changed, 10 insertions(+), 5 deletions(-)")
    const filesMatch = summaryLine.match(/(\d+) file/);
    const insertionsMatch = summaryLine.match(/(\d+) insertion/);
    const deletionsMatch = summaryLine.match(/(\d+) deletion/);

    return {
      files: filesMatch ? parseInt(filesMatch[1]) : 0,
      additions: insertionsMatch ? parseInt(insertionsMatch[1]) : 0,
      deletions: deletionsMatch ? parseInt(deletionsMatch[1]) : 0
    };
  } catch {
    return null;
  }
}

// Helper function to get relative time
function getRelativeTime(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  const intervals = [
    { label: "year", seconds: 31536000 },
    { label: "month", seconds: 2592000 },
    { label: "day", seconds: 86400 },
    { label: "hour", seconds: 3600 },
    { label: "minute", seconds: 60 },
    { label: "second", seconds: 1 }
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return count === 1 ? `${count} ${interval.label} ago` : `${count} ${interval.label}s ago`;
    }
  }

  return "just now";
}

// Helper function to get all stashes with branch association
async function getAllStashesWithBranch(): Promise<Map<string, Array<{ message: string; details: string; ref: string }>>> {
  const branchStashes = new Map<string, Array<{ message: string; details: string; ref: string }>>();

  try {
    const { stdout } = await execAsync("git stash list");
    if (!stdout.trim()) return branchStashes;

    const stashes = stdout.trim().split("\n");

    for (const stash of stashes) {
      // Parse stash entry: stash@{0}: On branch-name: message
      const stashMatch = stash.match(/^(stash@{\d+}): (.+)$/);
      if (!stashMatch) continue;

      const [, stashRef, stashInfo] = stashMatch;

      // Try to extract branch name from stash info
      let branchName = "unknown";
      let message = stashInfo;

      // Check if it's a Kunj auto-stash
      const kunjMatch = stashInfo.match(/kunj-auto-stash-(.+?)-(\d+)/);
      if (kunjMatch) {
        branchName = kunjMatch[1];
        const timestamp = new Date(parseInt(kunjMatch[2]));
        message = `Auto-stashed ${getRelativeTime(timestamp)}`;
      } else {
        // Try to extract branch from "On branch-name:" format
        const onBranchMatch = stashInfo.match(/On (.+?):/);
        if (onBranchMatch) {
          branchName = onBranchMatch[1];
          // Extract the actual message after "On branch:"
          const msgMatch = stashInfo.match(/On .+?: (.+)$/);
          message = msgMatch ? msgMatch[1] : "Stashed changes";
        } else if (stashInfo.includes("WIP on ")) {
          // Handle "WIP on branch-name:" format
          const wipMatch = stashInfo.match(/WIP on (.+?):/);
          if (wipMatch) {
            branchName = wipMatch[1];
            message = "Work in progress";
          }
        }
      }

      // Get detailed stats for this stash
      const details = await getStashDetails(stashRef);
      let detailsStr = "";
      if (details) {
        const parts = [];
        if (details.files > 0) parts.push(`${details.files} file${details.files > 1 ? 's' : ''}`);
        if (details.additions > 0) parts.push(`+${details.additions}`);
        if (details.deletions > 0) parts.push(`-${details.deletions}`);
        if (parts.length > 0) detailsStr = ` (${parts.join(', ')})`;
      }

      // Add to map
      if (!branchStashes.has(branchName)) {
        branchStashes.set(branchName, []);
      }
      branchStashes.get(branchName)!.push({
        message,
        details: detailsStr,
        ref: stashRef
      });
    }

    return branchStashes;
  } catch {
    return branchStashes;
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
      `git stash push --include-untracked -m "${stashMessage}"`
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
  .option("-d, --desc <description>", "Set a description for the new branch")
  .option("-t, --tag <tags...>", "Add tags to the new branch")
  .action(async (branchName: string, options?: { stash?: boolean; desc?: string; tag?: string[] }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      // Load configuration
      const config = loadConfig();

      console.log(
        chalk.blue(`Creating branch '${branchName}' and switching to it...`)
      );

      // Get current branch before creating new one
      const currentBranch = await getCurrentBranch();

      // Use config autoStash preference unless explicitly overridden
      const shouldStash = options?.stash !== false && config.preferences.autoStash;
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

        // Save metadata for the new branch if provided
        const metadata: Partial<BranchMetadata> = {
          lastSwitched: new Date().toISOString()
        };

        if (options?.desc) {
          metadata.description = options.desc;
          console.log(chalk.gray(`  Description: ${options.desc}`));
        }

        if (options?.tag && options.tag.length > 0) {
          metadata.tags = options.tag;
          console.log(chalk.cyan(`  Tags: ${options.tag.join(", ")}`));
        }

        if (Object.keys(metadata).length > 0) {
          updateBranchMetadata(branchName, metadata);
        }
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
  .option("-w, --wip", "Show only work-in-progress branches in selection")
  .option("-a, --all", "Show all branches (override showOnlyWIP config)")
  .action(async (branchName?: string, options?: { stash?: boolean; wip?: boolean; all?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      // Load configuration
      const config = loadConfig();

      // If branch name is provided, switch directly
      if (branchName) {
        const currentBranch = await getCurrentBranch();

        // Check if we're already on the target branch
        if (currentBranch === branchName) {
          console.log(chalk.yellow(`Already on branch '${branchName}'`));
          process.exit(0);
        }

        console.log(chalk.blue(`Switching to branch '${branchName}'...`));

        // Use config autoStash preference unless explicitly overridden
        const shouldStash = options?.stash !== false && config.preferences.autoStash;
        if (shouldStash) {
          await createStash(currentBranch);
        }

        const result = await executeGitCommand(`git checkout ${branchName}`);

        if (result.success) {
          console.log(
            chalk.green(`✓ Successfully switched to branch '${branchName}'`)
          );

          // Update lastSwitched metadata
          updateBranchMetadata(branchName, { lastSwitched: new Date().toISOString() });

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
        let branches = config.preferences.branchSort === "recent"
          ? await getBranchesSortedByRecent()
          : (await getAllBranches()).map(name => ({ name, lastActivity: "" }));

        // Determine WIP filter mode
        const shouldShowOnlyWIP = options?.wip ||
          (config.preferences.showOnlyWIP && !options?.all);

        // Filter branches if WIP mode is active
        if (shouldShowOnlyWIP) {
          branches = branches.filter(branch => isBranchWIP(branch.name, config));
        }

        if (branches.length === 0) {
          if (shouldShowOnlyWIP) {
            console.log(chalk.yellow("No work-in-progress branches found"));
            console.log(chalk.gray("Tip: Use 'kunj switch --all' to see all branches"));
          } else {
            console.log(chalk.yellow("No branches found"));
          }
          process.exit(0);
        }

        // Get all stashes with their branch associations
        const allStashes = await getAllStashesWithBranch();

        // Load branch metadata
        const branchMetadata = loadBranchMetadata();

        // Add indicators and stash info to branch names
        const branchChoices = branches.map((branch) => {
          const isCurrent = branch.name === currentBranch;
          const branchStashes = allStashes.get(branch.name);
          const metadata = branchMetadata.branches[branch.name] || {};

          // Build branch display name with metadata
          let displayName = isCurrent
            ? `${chalk.green("●")} ${branch.name} ${chalk.gray("(current)")}`
            : `  ${branch.name}`;

          // Add alias if exists
          const branchAlias = config.aliases[branch.name];
          if (branchAlias) {
            displayName += chalk.magenta(` [${branchAlias}]`);
          }

          // Add description if exists
          if (metadata.description) {
            displayName += chalk.gray(` - ${metadata.description}`);
          } else if (branch.lastActivity) {
            displayName += chalk.gray(` - ${branch.lastActivity}`);
          }

          // Add tags if exist
          if (metadata.tags && metadata.tags.length > 0) {
            const tagStr = metadata.tags.map(tag => `#${tag}`).join(" ");
            displayName += chalk.cyan(` ${tagStr}`);
          }

          // Add stash indicator if there are stashes
          if (branchStashes && branchStashes.length > 0) {
            const stashInfo = branchStashes.map(s => {
              const details = s.details.replace(/[()]/g, '').trim();
              return details || 'stashed changes';
            }).join(', ');
            displayName += chalk.yellow(` 📦 [${stashInfo}]`);
          }

          return {
            name: displayName,
            value: branch.name,
            short: branch.name,
          };
        });

        // Prompt user to select a branch
        const promptMessage = shouldShowOnlyWIP
          ? "Select a work-in-progress branch to switch to:"
          : "Select a branch to switch to:";

        const { selectedBranch } = await inquirer.prompt([
          {
            type: "list",
            name: "selectedBranch",
            message: promptMessage,
            choices: branchChoices,
            pageSize: config.preferences.pageSize,
          },
        ]);

        if (selectedBranch === currentBranch) {
          console.log(chalk.yellow("Already on this branch"));
          process.exit(0);
        }

        console.log(chalk.blue(`Switching to branch '${selectedBranch}'...`));

        // Use config autoStash preference unless explicitly overridden
        const shouldStash = options?.stash !== false && config.preferences.autoStash;
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

          // Update lastSwitched metadata
          updateBranchMetadata(selectedBranch, { lastSwitched: new Date().toISOString() });

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
  .description("List all branches with their metadata and stashed changes")
  .option("-v, --verbose", "Show detailed information including notes")
  .option("-w, --wip", "Show only work-in-progress branches")
  .option("-a, --all", "Show all branches (override showOnlyWIP config)")
  .action(async (options: { verbose?: boolean; wip?: boolean; all?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      const config = loadConfig();
      const currentBranch = await getCurrentBranch();
      let branches = config.preferences.branchSort === "recent"
        ? await getBranchesSortedByRecent()
        : (await getAllBranches()).map(name => ({ name, lastActivity: "" }));

      // Determine WIP filter mode
      const shouldShowOnlyWIP = options.wip ||
        (config.preferences.showOnlyWIP && !options.all);

      // Filter branches if WIP mode is active
      if (shouldShowOnlyWIP) {
        branches = branches.filter(branch => isBranchWIP(branch.name, config));
      }

      if (branches.length === 0) {
        if (shouldShowOnlyWIP) {
          console.log(chalk.yellow("No work-in-progress branches found"));
          console.log(chalk.gray("Tip: Use 'kunj list --all' to see all branches"));
        } else {
          console.log(chalk.yellow("No branches found"));
        }
        process.exit(0);
      }

      // Get all stashes with their branch associations
      const allStashes = await getAllStashesWithBranch();

      // Load branch metadata
      const branchMetadata = loadBranchMetadata();

      const title = shouldShowOnlyWIP
        ? `Work-in-progress branches (sorted by ${config.preferences.branchSort}):`
        : `Branches (sorted by ${config.preferences.branchSort}):`;
      console.log(chalk.blue(title));
      console.log(chalk.gray("─".repeat(70)));

      for (const branch of branches) {
        // Branch name and status
        const isCurrent = branch.name === currentBranch;
        const metadata = branchMetadata.branches[branch.name] || {};

        // Build branch line with alias if exists
        const branchAlias = config.aliases[branch.name];
        let branchLine = isCurrent
          ? chalk.green(`● ${branch.name}`)
          : `  ${branch.name}`;

        if (branchAlias) {
          branchLine += chalk.magenta(` (${branchAlias})`);
        }

        if (isCurrent) {
          branchLine += chalk.cyan(" [current]");
        }

        // Show last activity if available
        if (branch.lastActivity) {
          branchLine += chalk.gray(` - ${branch.lastActivity}`);
        }

        console.log(branchLine);

        // Show description if exists
        if (metadata.description) {
          console.log(chalk.gray(`  │ ${metadata.description}`));
        }

        // Show tags if exist
        if (metadata.tags && metadata.tags.length > 0) {
          const tagLine = metadata.tags.map(tag => chalk.cyan(`#${tag}`)).join(" ");
          console.log(`  │ Tags: ${tagLine}`);
        }

        // Show notes if verbose and exists
        if (options.verbose && metadata.notes) {
          console.log(chalk.yellow(`  │ Note: ${metadata.notes}`));
        }

        // Get and display stashes for this branch
        const branchStashes = allStashes.get(branch.name);
        if (branchStashes && branchStashes.length > 0) {
          branchStashes.forEach((stash, index) => {
            const isLastItem = index === branchStashes.length - 1 && !metadata.description && !metadata.tags;
            const prefix = isLastItem ? "  └─" : "  ├─";
            const stashLine = `${prefix} 📦 ${stash.message}`;
            const detailsLine = config.preferences.showStashDetails && stash.details
              ? chalk.dim(stash.details)
              : "";
            console.log(chalk.yellow(stashLine) + detailsLine);
          });
        }
      }

      // Check for stashes on unknown/deleted branches
      const unknownStashes = allStashes.get("unknown");
      if (unknownStashes && unknownStashes.length > 0) {
        console.log(chalk.gray("\n─".repeat(70)));
        console.log(chalk.yellow("⚠ Stashes from unknown/deleted branches:"));
        unknownStashes.forEach((stash) => {
          const stashLine = `  📦 ${stash.message}`;
          const detailsLine = config.preferences.showStashDetails && stash.details
            ? chalk.dim(stash.details)
            : "";
          console.log(chalk.yellow(stashLine) + detailsLine);
        });
      }

      console.log(chalk.gray("─".repeat(70)));

      // Show total stash count
      let totalStashes = 0;
      allStashes.forEach((stashes) => {
        totalStashes += stashes.length;
      });
      if (totalStashes > 0) {
        console.log(chalk.cyan(`\nTotal stashes: ${totalStashes}`));
      }

      console.log(chalk.cyan("\nTip: Use 'kunj switch <branch>' to switch branches"));
      console.log(chalk.cyan("     Use 'kunj branch-desc <branch> <description>' to add descriptions"));
      console.log(chalk.cyan("     Use 'kunj branch-tag <branch> <tags...>' to add tags"));

      if (!options.verbose) {
        console.log(chalk.gray("\nUse 'kunj list -v' to see branch notes"));
      }
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

// Config command: kunj config
program
  .command("config")
  .description("View or edit configuration")
  .option("-s, --set <key=value>", "Set a configuration value")
  .option("-g, --get <key>", "Get a configuration value")
  .option("-l, --list", "List all configuration")
  .option("-r, --reset", "Reset to default configuration")
  .action((options: { set?: string; get?: string; list?: boolean; reset?: boolean }) => {
    try {
      const config = loadConfig();

      if (options.reset) {
        saveConfig(defaultConfig);
        console.log(chalk.green("✓ Configuration reset to defaults"));
        return;
      }

      if (options.list || (!options.set && !options.get)) {
        console.log(chalk.blue("Current Configuration:"));
        console.log(chalk.gray("─".repeat(70)));

        // Display preferences with descriptions
        console.log(chalk.cyan("\nPreferences:"));
        console.log(`  autoStash: ${config.preferences.autoStash} ${chalk.gray("- Auto-stash changes when switching branches")}`);
        console.log(`  branchSort: "${config.preferences.branchSort}" ${chalk.gray("- Sort branches by (recent/alphabetical)")}`);
        console.log(`  showStashDetails: ${config.preferences.showStashDetails} ${chalk.gray("- Show file counts and line changes in stashes")}`);
        console.log(`  pageSize: ${config.preferences.pageSize} ${chalk.gray("- Number of items per page in interactive menus")}`);
        console.log(`  showOnlyWIP: ${config.preferences.showOnlyWIP} ${chalk.gray("- Show only work-in-progress branches by default")}`);
        console.log(`  wipTags: [${config.preferences.wipTags.join(", ")}] ${chalk.gray("- Tags that mark a branch as WIP")}`);
        console.log(`  doneTags: [${config.preferences.doneTags.join(", ")}] ${chalk.gray("- Tags that mark a branch as done/completed")}`);

        // Display aliases
        console.log(chalk.cyan("\nAliases:"));
        if (Object.keys(config.aliases).length > 0) {
          Object.entries(config.aliases).forEach(([branch, alias]) => {
            console.log(`  ${branch}: "${alias}"`);
          });
        } else {
          console.log(chalk.gray("  (none configured)"));
        }

        console.log(chalk.gray("\n─".repeat(70)));
        console.log(chalk.cyan("\nConfig file: " + getConfigPath()));
        console.log(chalk.gray("\nExamples:"));
        console.log(chalk.gray("  Set a value:    kunj config --set preferences.showOnlyWIP=true"));
        console.log(chalk.gray("  Get a value:    kunj config --get preferences.autoStash"));
        console.log(chalk.gray("  Set an alias:   kunj config --set 'aliases.main=Production Branch'"));
        console.log(chalk.gray("  Reset all:      kunj config --reset"));
        return;
      }

      if (options.get) {
        const keys = options.get.split(".");
        let value: any = config;
        for (const key of keys) {
          value = value[key];
          if (value === undefined) {
            console.error(chalk.red(`✗ Configuration key '${options.get}' not found`));
            process.exit(1);
          }
        }
        console.log(value);
        return;
      }

      if (options.set) {
        const [keyPath, rawValue] = options.set.split("=");
        if (!rawValue) {
          console.error(chalk.red("✗ Invalid format. Use: --set key=value"));
          process.exit(1);
        }

        const keys = keyPath.split(".");
        let current: any = config;

        // Navigate to the parent of the key to set
        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]]) {
            current[keys[i]] = {};
          }
          current = current[keys[i]];
        }

        // Parse the value
        const lastKey = keys[keys.length - 1];
        let value: any = rawValue;

        // Try to parse as JSON first (for booleans, numbers)
        try {
          value = JSON.parse(rawValue);
        } catch {
          // Keep as string
        }

        current[lastKey] = value;
        saveConfig(config);
        console.log(chalk.green(`✓ Set ${keyPath} = ${value}`));
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Branch-note command: kunj branch-note
program
  .command("branch-note [branch] [note...]")
  .description("Add or view notes for a branch")
  .option("-c, --clear", "Clear the note for the branch")
  .action(async (branch?: string, noteArgs?: string[], options?: { clear?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      // If no branch specified, use current branch
      if (!branch) {
        branch = await getCurrentBranch();
      }

      const metadata = getBranchMetadataItem(branch);

      if (options?.clear) {
        updateBranchMetadata(branch, { notes: undefined });
        console.log(chalk.green(`✓ Cleared note for branch '${branch}'`));
        return;
      }

      // If note is provided, update it
      if (noteArgs && noteArgs.length > 0) {
        const note = noteArgs.join(" ");
        updateBranchMetadata(branch, { notes: note });
        console.log(chalk.green(`✓ Updated note for branch '${branch}'`));
        console.log(chalk.gray(`Note: ${note}`));
      } else {
        // Display existing note
        if (metadata.notes) {
          console.log(chalk.blue(`Note for branch '${branch}':`));
          console.log(metadata.notes);
        } else {
          console.log(chalk.yellow(`No note set for branch '${branch}'`));
          console.log(chalk.gray(`Tip: Use 'kunj branch-note ${branch} "your note"' to add one`));
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Branch-tag command: kunj branch-tag
program
  .command("branch-tag [branch] [tags...]")
  .description("Add or view tags for a branch")
  .option("-c, --clear", "Clear all tags for the branch")
  .option("-r, --remove <tag>", "Remove a specific tag")
  .action(async (branch?: string, tagArgs?: string[], options?: { clear?: boolean; remove?: string }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      // If no branch specified, use current branch
      if (!branch) {
        branch = await getCurrentBranch();
      }

      const metadata = getBranchMetadataItem(branch);

      if (options?.clear) {
        updateBranchMetadata(branch, { tags: [] });
        console.log(chalk.green(`✓ Cleared all tags for branch '${branch}'`));
        return;
      }

      if (options?.remove) {
        const currentTags = metadata.tags || [];
        const newTags = currentTags.filter(tag => tag !== options.remove);
        updateBranchMetadata(branch, { tags: newTags });
        console.log(chalk.green(`✓ Removed tag '${options.remove}' from branch '${branch}'`));
        return;
      }

      // If tags are provided, add them
      if (tagArgs && tagArgs.length > 0) {
        const currentTags = metadata.tags || [];
        const newTags = Array.from(new Set([...currentTags, ...tagArgs]));
        updateBranchMetadata(branch, { tags: newTags });
        console.log(chalk.green(`✓ Updated tags for branch '${branch}'`));
        console.log(chalk.gray(`Tags: ${newTags.join(", ")}`));
      } else {
        // Display existing tags
        if (metadata.tags && metadata.tags.length > 0) {
          console.log(chalk.blue(`Tags for branch '${branch}':`));
          metadata.tags.forEach(tag => {
            console.log(chalk.cyan(`  • ${tag}`));
          });
        } else {
          console.log(chalk.yellow(`No tags set for branch '${branch}'`));
          console.log(chalk.gray(`Tip: Use 'kunj branch-tag ${branch} feature wip' to add tags`));
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Branch-desc command: kunj branch-desc
program
  .command("branch-desc [branch] [description...]")
  .description("Set or view description for a branch")
  .option("-c, --clear", "Clear the description for the branch")
  .action(async (branch?: string, descArgs?: string[], options?: { clear?: boolean }) => {
    try {
      // Check if we're in a git repository
      const isGitRepo = await checkGitRepo();
      if (!isGitRepo) {
        console.error(chalk.red("Error: Not a git repository"));
        process.exit(1);
      }

      // If no branch specified, use current branch
      if (!branch) {
        branch = await getCurrentBranch();
      }

      const metadata = getBranchMetadataItem(branch);

      if (options?.clear) {
        updateBranchMetadata(branch, { description: undefined });
        console.log(chalk.green(`✓ Cleared description for branch '${branch}'`));
        return;
      }

      // If description is provided, update it
      if (descArgs && descArgs.length > 0) {
        const description = descArgs.join(" ");
        updateBranchMetadata(branch, { description });
        console.log(chalk.green(`✓ Updated description for branch '${branch}'`));
        console.log(chalk.gray(`Description: ${description}`));
      } else {
        // Display existing description
        if (metadata.description) {
          console.log(chalk.blue(`Description for branch '${branch}':`));
          console.log(metadata.description);
        } else {
          console.log(chalk.yellow(`No description set for branch '${branch}'`));
          console.log(chalk.gray(`Tip: Use 'kunj branch-desc ${branch} "your description"' to add one`));
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();
