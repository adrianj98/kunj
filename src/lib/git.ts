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