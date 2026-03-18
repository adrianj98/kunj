// Pull Request Provider abstraction for Git Flow

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PRProvider {
  name: string;
  createPR(sourceBranch: string, targetBranch: string, title: string, body?: string): Promise<{ success: boolean; prUrl?: string; message: string }>;
  mergePR(sourceBranch: string, targetBranch: string): Promise<{ success: boolean; message: string }>;
  checkCLIAvailable(): Promise<boolean>;
}

// GitHub PR Provider using gh CLI
export class GitHubProvider implements PRProvider {
  name = 'github';

  async checkCLIAvailable(): Promise<boolean> {
    try {
      await execAsync('gh --version');
      return true;
    } catch {
      return false;
    }
  }

  async createPR(sourceBranch: string, targetBranch: string, title: string, body?: string): Promise<{ success: boolean; prUrl?: string; message: string }> {
    try {
      // Check if gh CLI is available
      const available = await this.checkCLIAvailable();
      if (!available) {
        return {
          success: false,
          message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/'
        };
      }

      // Build command
      let command = `gh pr create --base ${targetBranch} --head ${sourceBranch} --title "${title}"`;
      if (body) {
        const escapedBody = body.replace(/"/g, '\\"');
        command += ` --body "${escapedBody}"`;
      }

      const { stdout, stderr } = await execAsync(command);
      const prUrl = stdout.trim();

      return {
        success: true,
        prUrl,
        message: `Created PR: ${prUrl}`
      };
    } catch (error: any) {
      // Include both stderr and the error message for better debugging
      const errorMsg = error.stderr || error.message || 'Failed to create GitHub PR';
      return {
        success: false,
        message: errorMsg
      };
    }
  }

  async mergePR(sourceBranch: string, targetBranch: string): Promise<{ success: boolean; message: string }> {
    try {
      // Check if gh CLI is available
      const available = await this.checkCLIAvailable();
      if (!available) {
        return {
          success: false,
          message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/'
        };
      }

      // Find PR for this branch
      const { stdout: prList } = await execAsync(`gh pr list --head ${sourceBranch} --base ${targetBranch} --json number --jq '.[0].number'`);
      const prNumber = prList.trim();

      if (!prNumber) {
        return {
          success: false,
          message: `No open PR found for ${sourceBranch} -> ${targetBranch}`
        };
      }

      // Merge the PR
      await execAsync(`gh pr merge ${prNumber} --merge --delete-branch`);

      return {
        success: true,
        message: `Merged PR #${prNumber}`
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Failed to merge GitHub PR'
      };
    }
  }
}

// GitLab PR Provider using glab CLI
export class GitLabProvider implements PRProvider {
  name = 'gitlab';

  async checkCLIAvailable(): Promise<boolean> {
    try {
      await execAsync('glab --version');
      return true;
    } catch {
      return false;
    }
  }

  async createPR(sourceBranch: string, targetBranch: string, title: string, body?: string): Promise<{ success: boolean; prUrl?: string; message: string }> {
    try {
      // Check if glab CLI is available
      const available = await this.checkCLIAvailable();
      if (!available) {
        return {
          success: false,
          message: 'GitLab CLI (glab) is not installed. Install it from https://gitlab.com/gitlab-org/cli'
        };
      }

      // Build command
      let command = `glab mr create --source-branch ${sourceBranch} --target-branch ${targetBranch} --title "${title}"`;
      if (body) {
        const escapedBody = body.replace(/"/g, '\\"');
        command += ` --description "${escapedBody}"`;
      }

      const { stdout, stderr } = await execAsync(command);
      const mrUrl = stdout.trim().split('\n').find(line => line.includes('https://')) || stdout.trim();

      return {
        success: true,
        prUrl: mrUrl,
        message: `Created MR: ${mrUrl}`
      };
    } catch (error: any) {
      // Include both stderr and the error message for better debugging
      const errorMsg = error.stderr || error.message || 'Failed to create GitLab MR';
      return {
        success: false,
        message: errorMsg
      };
    }
  }

  async mergePR(sourceBranch: string, targetBranch: string): Promise<{ success: boolean; message: string }> {
    try {
      // Check if glab CLI is available
      const available = await this.checkCLIAvailable();
      if (!available) {
        return {
          success: false,
          message: 'GitLab CLI (glab) is not installed. Install it from https://gitlab.com/gitlab-org/cli'
        };
      }

      // Find MR for this branch
      const { stdout: mrList } = await execAsync(`glab mr list --source-branch ${sourceBranch} --target-branch ${targetBranch}`);

      // Parse MR number from output (format: !123)
      const mrMatch = mrList.match(/!(\d+)/);
      if (!mrMatch) {
        return {
          success: false,
          message: `No open MR found for ${sourceBranch} -> ${targetBranch}`
        };
      }

      const mrNumber = mrMatch[1];

      // Merge the MR
      await execAsync(`glab mr merge ${mrNumber} --yes`);

      return {
        success: true,
        message: `Merged MR !${mrNumber}`
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Failed to merge GitLab MR'
      };
    }
  }
}

// Factory function to get the appropriate provider
export function getPRProvider(providerName: 'github' | 'gitlab'): PRProvider {
  switch (providerName) {
    case 'github':
      return new GitHubProvider();
    case 'gitlab':
      return new GitLabProvider();
    default:
      return new GitHubProvider();
  }
}
