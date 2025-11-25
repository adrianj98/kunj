// Git operations for Kunj CLI

import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { GitCommandResult, BranchInfo } from '../types';

const execAsync = promisify(exec);

// Check if current directory is a git repository
export async function checkGitRepo(): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

// Execute a git command with error handling
export async function executeGitCommand(command: string): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execAsync(command);
    return {
      success: true,
      message: stdout || stderr || ''
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Command failed'
    };
  }
}

// Get the current branch name
export async function getCurrentBranch(): Promise<string> {
  try {
    const { stdout } = await execAsync('git branch --show-current');
    return stdout.trim();
  } catch {
    return '';
  }
}

// Get all branches with optional filtering
export async function getAllBranches(includeRemote: boolean = false): Promise<BranchInfo[]> {
  try {
    const command = includeRemote ? 'git branch -a' : 'git branch';
    const { stdout } = await execAsync(command);

    if (!stdout.trim()) return [];

    const branches = stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const name = line.replace(/^\*?\s+/, '').trim();
        if (name.startsWith('remotes/')) {
          return null;
        }
        return { name };
      })
      .filter(branch => branch !== null) as BranchInfo[];

    return branches;
  } catch {
    return [];
  }
}

// Get branches with last activity time
export async function getBranchesWithActivity(sortBy: 'recent' | 'alphabetical' = 'recent'): Promise<BranchInfo[]> {
  try {
    const sortFlag = sortBy === 'recent' ? '-committerdate' : '';
    const command = sortFlag
      ? `git for-each-ref --sort=${sortFlag} --format='%(refname:short)|%(committerdate:relative)' refs/heads/`
      : `git for-each-ref --format='%(refname:short)|%(committerdate:relative)' refs/heads/`;

    const { stdout } = await execAsync(command);

    if (!stdout.trim()) return [];

    const branches = stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, lastActivity] = line.split('|');
        return { name, lastActivity };
      });

    if (sortBy === 'alphabetical') {
      branches.sort((a, b) => a.name.localeCompare(b.name));
    }

    return branches;
  } catch {
    return [];
  }
}

// Check if there are uncommitted changes
export async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain');
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Delete a branch (local or remote)
export async function deleteBranch(branchName: string, force: boolean = false, remote: boolean = false): Promise<GitCommandResult> {
  if (remote) {
    // Parse remote and branch name
    const [remoteName, ...branchParts] = branchName.split('/');
    const remoteBranch = branchParts.join('/');
    return executeGitCommand(`git push ${remoteName} --delete ${remoteBranch}`);
  } else {
    const deleteFlag = force ? '-D' : '-d';
    return executeGitCommand(`git branch ${deleteFlag} ${branchName}`);
  }
}

// File status types
export interface FileStatus {
  path: string;
  status: 'modified' | 'new' | 'deleted' | 'renamed' | 'copied' | 'unmerged';
  staged: boolean;
  oldPath?: string; // For renamed files
  additions?: number; // Lines added
  deletions?: number; // Lines deleted
}

// Get the status of all changed files
export async function getFileStatuses(): Promise<FileStatus[]> {
  try {
    const { stdout } = await execAsync('git status --porcelain=v1');
    if (!stdout.trim()) return [];

    const files: FileStatus[] = [];
    const lines = stdout.split('\n').filter(line => line.trim());

    for (const line of lines) {
      if (line.length < 3) continue;

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      let filePath = line.substring(3);

      // Parse the status codes
      let status: FileStatus['status'] = 'modified';
      let staged = false;
      let oldPath: string | undefined;

      // Check for renamed files
      if (filePath.includes(' -> ')) {
        const [old, newPath] = filePath.split(' -> ');
        files.push({
          path: newPath,
          status: 'renamed',
          staged: indexStatus === 'R',
          oldPath: old
        });
        continue;
      }

      // Check if this is an untracked directory (ends with /)
      if (filePath.endsWith('/') && indexStatus === '?' && workTreeStatus === '?') {
        // Get all untracked files in this directory
        try {
          const { stdout: filesInDir } = await execAsync(`git ls-files --others --exclude-standard "${filePath}*"`);
          if (filesInDir.trim()) {
            const dirFiles = filesInDir.split('\n').filter(f => f.trim());
            for (const file of dirFiles) {
              files.push({
                path: file,
                status: 'new',
                staged: false
              });
            }
          }
        } catch (err) {
          // If command fails, just add the directory as is
          files.push({
            path: filePath.replace(/\/$/, ''), // Remove trailing slash
            status: 'new',
            staged: false
          });
        }
        continue;
      }

      // Determine status based on git status codes
      if (indexStatus === 'A' || workTreeStatus === 'A') {
        status = 'new';
        staged = indexStatus === 'A';
      } else if (indexStatus === 'D' || workTreeStatus === 'D') {
        status = 'deleted';
        staged = indexStatus === 'D';
      } else if (indexStatus === 'M' || workTreeStatus === 'M') {
        status = 'modified';
        staged = indexStatus === 'M';
      } else if (indexStatus === 'C' || workTreeStatus === 'C') {
        status = 'copied';
        staged = indexStatus === 'C';
      } else if (indexStatus === 'U' || workTreeStatus === 'U') {
        status = 'unmerged';
      } else if (indexStatus === '?' && workTreeStatus === '?') {
        status = 'new';
        staged = false;
      }

      files.push({
        path: filePath,
        status,
        staged
      });
    }

    // Get line stats for all files efficiently
    // Get stats for staged files
    const stagedStatsMap = new Map<string, { additions: number; deletions: number }>();
    try {
      const { stdout: stagedStats } = await execAsync('git diff --numstat --cached');
      if (stagedStats.trim()) {
        stagedStats.split('\n').filter(l => l.trim()).forEach(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const additions = parseInt(parts[0]) || 0;
            const deletions = parseInt(parts[1]) || 0;
            const path = parts.slice(2).join(' ');
            stagedStatsMap.set(path, { additions, deletions });
          }
        });
      }
    } catch (err) {
      // Ignore errors
    }

    // Get stats for unstaged files
    const unstagedStatsMap = new Map<string, { additions: number; deletions: number }>();
    try {
      const { stdout: unstagedStats } = await execAsync('git diff --numstat');
      if (unstagedStats.trim()) {
        unstagedStats.split('\n').filter(l => l.trim()).forEach(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const additions = parseInt(parts[0]) || 0;
            const deletions = parseInt(parts[1]) || 0;
            const path = parts.slice(2).join(' ');
            unstagedStatsMap.set(path, { additions, deletions });
          }
        });
      }
    } catch (err) {
      // Ignore errors
    }

    // Apply stats to files
    for (const file of files) {
      const stats = file.staged ? stagedStatsMap.get(file.path) : unstagedStatsMap.get(file.path);

      if (stats) {
        file.additions = stats.additions;
        file.deletions = stats.deletions;
      } else if (file.status === 'new') {
        // For new files, count lines
        try {
          const { stdout: content } = await execAsync(`wc -l < "${file.path}" 2>/dev/null || echo "0"`);
          file.additions = parseInt(content.trim()) || 0;
          file.deletions = 0;
        } catch {
          file.additions = 0;
          file.deletions = 0;
        }
      } else {
        file.additions = 0;
        file.deletions = 0;
      }
    }

    return files;
  } catch {
    return [];
  }
}

// Stage files for commit
export async function stageFiles(filePaths: string[]): Promise<GitCommandResult> {
  if (filePaths.length === 0) {
    return { success: false, message: 'No files to stage' };
  }

  // Escape file paths for shell
  const escapedPaths = filePaths.map(path => `"${path}"`).join(' ');
  return executeGitCommand(`git add ${escapedPaths}`);
}

// Create a commit with message
export async function createCommit(message: string): Promise<GitCommandResult> {
  // Escape the message for shell
  const escapedMessage = message.replace(/"/g, '\\"');
  return executeGitCommand(`git commit -m "${escapedMessage}"`);
}

// Get recent commit messages for reference
export async function getRecentCommitMessages(limit: number = 10): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git log --oneline -n ${limit}`);
    if (!stdout.trim()) return [];

    return stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        // Remove the commit hash and return just the message
        const match = line.match(/^[a-f0-9]+\s+(.+)$/);
        return match ? match[1] : line;
      });
  } catch {
    return [];
  }
}

// Get the main/master branch name
export async function getMainBranch(): Promise<string> {
  try {
    // Check if main exists
    const { stdout: mainExists } = await execAsync('git rev-parse --verify main 2>/dev/null || echo ""');
    if (mainExists.trim()) return 'main';

    // Check if master exists
    const { stdout: masterExists } = await execAsync('git rev-parse --verify master 2>/dev/null || echo ""');
    if (masterExists.trim()) return 'master';

    // Try to get from remote
    const { stdout: remotes } = await execAsync('git branch -r');
    if (remotes.includes('origin/main')) return 'main';
    if (remotes.includes('origin/master')) return 'master';

    return 'main'; // Default fallback
  } catch {
    return 'main';
  }
}

// Get commits since branch diverged from main/master
export async function getCommitsSinceBranch(): Promise<string[]> {
  try {
    const currentBranch = await getCurrentBranch();
    const mainBranch = await getMainBranch();

    // If we're on the main branch, just return recent commits
    if (currentBranch === mainBranch) {
      return getRecentCommitMessages(5);
    }

    // Find the merge-base (common ancestor)
    const { stdout: mergeBase } = await execAsync(`git merge-base ${mainBranch} HEAD 2>/dev/null || echo ""`);

    if (!mergeBase.trim()) {
      // If no merge-base found, just return recent commits
      return getRecentCommitMessages(5);
    }

    // Get commits from merge-base to HEAD
    const { stdout } = await execAsync(`git log --oneline ${mergeBase.trim()}..HEAD`);
    if (!stdout.trim()) return [];

    return stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        // Remove the commit hash and return just the message
        const match = line.match(/^[a-f0-9]+\s+(.+)$/);
        return match ? match[1] : line;
      });
  } catch {
    // Fallback to recent commits if something goes wrong
    return getRecentCommitMessages(5);
  }
}

// Get colored diff for a file
export async function getFileDiff(filePath: string): Promise<string> {
  try {
    // Try to get diff for staged changes first
    const { stdout: stagedDiff } = await execAsync(`git diff --cached --color=always -- "${filePath}" 2>/dev/null || echo ""`);

    if (stagedDiff.trim()) {
      return stagedDiff;
    }

    // If no staged changes, get unstaged diff
    const { stdout: unstagedDiff } = await execAsync(`git diff --color=always -- "${filePath}" 2>/dev/null || echo ""`);

    if (unstagedDiff.trim()) {
      return unstagedDiff;
    }

    // If it's a new file, show the entire content
    const { stdout: status } = await execAsync(`git status --porcelain "${filePath}"`);
    if (status.trim().startsWith('??') || status.trim().startsWith('A')) {
      const { stdout: content } = await execAsync(`cat "${filePath}" 2>/dev/null || echo ""`);
      // Format as a diff with all lines as additions
      const lines = content.split('\n');
      return chalk.green(lines.map(line => `+ ${line}`).join('\n'));
    }

    return chalk.gray('No changes to display');
  } catch (error: any) {
    return chalk.red(`Error getting diff: ${error.message}`);
  }
}

// Get colored diff for a file comparing with main/master branch
export async function getFileDiffWithMain(filePath: string): Promise<string> {
  try {
    const mainBranch = await getMainBranch();
    const currentBranch = await getCurrentBranch();

    if (currentBranch === mainBranch) {
      return chalk.yellow(`Already on ${mainBranch} branch. Showing working tree changes:\n\n`) + await getFileDiff(filePath);
    }

    // Get diff comparing with main branch
    const { stdout: diff } = await execAsync(`git diff --color=always ${mainBranch}...HEAD -- "${filePath}" 2>/dev/null || echo ""`);

    if (diff.trim()) {
      return diff;
    }

    // If no diff with main, check if file exists in main
    const { stdout: fileInMain } = await execAsync(`git ls-tree -r ${mainBranch} --name-only "${filePath}" 2>/dev/null || echo ""`);

    if (!fileInMain.trim()) {
      return chalk.green(`File is new in this branch (not in ${mainBranch})`);
    }

    return chalk.gray(`No differences with ${mainBranch}`);
  } catch (error: any) {
    return chalk.red(`Error getting diff with main: ${error.message}`);
  }
}

// Revert changes to a file
export async function revertFile(filePath: string): Promise<GitCommandResult> {
  try {
    // Check if file is staged
    const { stdout: status } = await execAsync(`git status --porcelain "${filePath}"`);
    const isStaged = status.trim()[0] !== ' ' && status.trim()[0] !== '?';

    if (isStaged) {
      // Unstage the file first
      await execAsync(`git reset HEAD "${filePath}"`);
    }

    // Check if it's an untracked file
    if (status.trim().startsWith('??')) {
      return {
        success: false,
        message: 'Cannot revert untracked file. Use delete instead.'
      };
    }

    // Revert the file
    await execAsync(`git checkout -- "${filePath}"`);

    return {
      success: true,
      message: `Reverted ${filePath}`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to revert file'
    };
  }
}

// Delete a file
export async function deleteFile(filePath: string): Promise<GitCommandResult> {
  try {
    // Remove the file from filesystem
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    await execAsync(`rm "${filePath}"`);

    // Stage the deletion if it was tracked
    const { stdout: status } = await execAsync(`git status --porcelain "${filePath}" 2>/dev/null || echo ""`);
    if (status && !status.trim().startsWith('??')) {
      await execAsync(`git add "${filePath}"`);
    }

    return {
      success: true,
      message: `Deleted ${filePath}`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to delete file'
    };
  }
}

// Get line change statistics for a file
export async function getFileStats(filePath: string, staged: boolean = false): Promise<{ additions: number; deletions: number }> {
  try {
    const command = staged
      ? `git diff --numstat --cached -- "${filePath}"`
      : `git diff --numstat -- "${filePath}"`;

    const { stdout } = await execAsync(command);

    if (!stdout.trim()) {
      // If no diff output, might be a new file or deleted file
      const { stdout: status } = await execAsync(`git status --porcelain "${filePath}"`);

      if (status.trim().startsWith('??') || status.trim().startsWith('A')) {
        // New file - count all lines as additions
        try {
          const { stdout: content } = await execAsync(`wc -l < "${filePath}" 2>/dev/null || echo "0"`);
          const lines = parseInt(content.trim()) || 0;
          return { additions: lines, deletions: 0 };
        } catch {
          return { additions: 0, deletions: 0 };
        }
      } else if (status.trim().startsWith('D')) {
        // Deleted file - try to count lines from HEAD
        try {
          const { stdout: content } = await execAsync(`git show HEAD:"${filePath}" | wc -l`);
          const lines = parseInt(content.trim()) || 0;
          return { additions: 0, deletions: lines };
        } catch {
          return { additions: 0, deletions: 0 };
        }
      }

      return { additions: 0, deletions: 0 };
    }

    // Parse numstat output: "additions deletions filename"
    const parts = stdout.trim().split(/\s+/);
    const additions = parseInt(parts[0]) || 0;
    const deletions = parseInt(parts[1]) || 0;

    return { additions, deletions };
  } catch (error) {
    return { additions: 0, deletions: 0 };
  }
}