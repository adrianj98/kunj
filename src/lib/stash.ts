// Stash operations for Kunj CLI

import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { BranchStash } from '../types';
import { getBranchMetadataItem, updateBranchMetadata } from './metadata';
import { executeGitCommand, hasUncommittedChanges } from './git';

const execAsync = promisify(exec);

// Create a stash for a branch with metadata tracking
export async function createStash(branchName: string): Promise<boolean> {
  try {
    const hasChanges = await hasUncommittedChanges();
    if (!hasChanges) {
      return false; // Nothing to stash
    }

    // Get diff stats before stashing
    let files = 0, additions = 0, deletions = 0;
    try {
      const { stdout } = await execAsync('git diff --stat');
      const lines = stdout.split('\n').filter(line => line.trim());
      const summaryLine = lines[lines.length - 1];

      const filesMatch = summaryLine.match(/(\d+)\s+file/);
      const insertionsMatch = summaryLine.match(/(\d+)\s+insertion/);
      const deletionsMatch = summaryLine.match(/(\d+)\s+deletion/);

      files = filesMatch ? parseInt(filesMatch[1]) : 0;
      additions = insertionsMatch ? parseInt(insertionsMatch[1]) : 0;
      deletions = deletionsMatch ? parseInt(deletionsMatch[1]) : 0;
    } catch {
      // If we can't get stats, continue with defaults
    }

    const timestamp = Date.now();
    const stashMessage = `kunj-auto-stash-${branchName}-${timestamp}`;

    const result = await executeGitCommand(
      `git stash push --include-untracked -m "${stashMessage}"`
    );

    if (result.success) {
      // Save stash info to branch metadata
      const stashInfo: BranchStash = {
        ref: "stash@{0}",
        message: stashMessage,
        timestamp: new Date().toISOString(),
        files,
        additions,
        deletions
      };

      const metadata = getBranchMetadataItem(branchName);
      const stashes = metadata.stashes || [];
      stashes.unshift(stashInfo); // Add to beginning
      updateBranchMetadata(branchName, { stashes });

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

// Pop a stash for a branch using metadata
export async function popStashForBranch(branchName: string): Promise<boolean> {
  try {
    // Get branch metadata to find stashes
    const metadata = getBranchMetadataItem(branchName);
    if (!metadata.stashes || metadata.stashes.length === 0) {
      return false; // No stashes for this branch
    }

    // Get the most recent stash (first in array)
    const stashInfo = metadata.stashes[0];

    // Try to pop the stash using the message to find it
    const { stdout } = await execAsync("git stash list");
    if (!stdout.trim()) {
      // No stashes in git, but we have metadata - clean it up
      updateBranchMetadata(branchName, { stashes: [] });
      return false;
    }

    // Find the stash by message
    const stashes = stdout.trim().split("\n");
    let stashIndex = -1;

    for (let i = 0; i < stashes.length; i++) {
      if (stashes[i].includes(stashInfo.message)) {
        const match = stashes[i].match(/stash@{(\d+)}/);
        if (match) {
          stashIndex = parseInt(match[1]);
          break;
        }
      }
    }

    if (stashIndex === -1) {
      // Stash not found in git, remove from metadata
      const updatedStashes = metadata.stashes.slice(1);
      updateBranchMetadata(branchName, { stashes: updatedStashes });
      return false;
    }

    // Pop the stash
    const result = await executeGitCommand(
      `git stash pop stash@{${stashIndex}}`
    );

    if (result.success || result.message.includes("conflict")) {
      // Remove from metadata even if there are conflicts
      const updatedStashes = metadata.stashes.slice(1);
      updateBranchMetadata(branchName, { stashes: updatedStashes });

      if (result.success) {
        console.log(
          chalk.yellow(
            `📤 Restored stashed changes for branch '${branchName}'`
          )
        );
      } else {
        console.log(
          chalk.yellow(
            `⚠️  Stash applied with conflicts. Please resolve them manually.`
          )
        );
      }
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// Get all stashes from metadata organized by branch
export async function getAllStashesWithBranch(): Promise<Map<string, Array<{ message: string; details: string; ref: string }>>> {
  const { loadBranchMetadata } = await import('./metadata');
  const branchStashes = new Map<string, Array<{ message: string; details: string; ref: string }>>();

  try {
    const metadata = loadBranchMetadata();

    // Go through each branch and get its stashes
    for (const [branchName, branchData] of Object.entries(metadata.branches)) {
      if (branchData.stashes && branchData.stashes.length > 0) {
        const stashesForBranch: Array<{ message: string; details: string; ref: string }> = [];

        for (const stash of branchData.stashes) {
          // Format the message with relative time
          const timestamp = new Date(stash.timestamp);
          const message = `Auto-stashed ${getRelativeTime(timestamp)}`;

          // Build details string
          let detailsStr = "";
          if (stash.files || stash.additions || stash.deletions) {
            const parts = [];
            if (stash.files && stash.files > 0) {
              parts.push(`${stash.files} file${stash.files > 1 ? 's' : ''}`);
            }
            if (stash.additions && stash.additions > 0) {
              parts.push(`+${stash.additions}`);
            }
            if (stash.deletions && stash.deletions > 0) {
              parts.push(`-${stash.deletions}`);
            }
            if (parts.length > 0) {
              detailsStr = ` (${parts.join(', ')})`;
            }
          }

          stashesForBranch.push({
            message,
            details: detailsStr,
            ref: stash.ref
          });
        }

        if (stashesForBranch.length > 0) {
          branchStashes.set(branchName, stashesForBranch);
        }
      }
    }
  } catch {
    // Return empty map on error
  }

  return branchStashes;
}

// Helper function to format relative time
function getRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  }
  if (seconds > 0) {
    return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
  }

  return "just now";
}