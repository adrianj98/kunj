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