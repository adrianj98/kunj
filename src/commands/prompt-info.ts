import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseCommand } from '../lib/command';
import { getBranchMetadataItem } from '../lib/metadata';

const execAsync = promisify(exec);

interface PromptInfoOptions {
  format?: 'simple' | 'detailed' | 'json';
  showBranch?: boolean;
  showStatus?: boolean;
}

export class PromptInfoCommand extends BaseCommand {
  constructor() {
    super({
      name: 'prompt-info',
      description: 'Output PR info for shell prompt integration',
      options: [
        {
          flags: '--format <type>',
          description: 'Output format: simple (default), detailed, json',
          defaultValue: 'simple',
        },
        { flags: '--show-branch', description: 'Include branch name in output' },
        { flags: '--show-status', description: 'Include PR status (OPEN/MERGED/CLOSED)' },
      ],
    });
  }

  async execute(options: PromptInfoOptions = {}): Promise<void> {
    try {
      const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD 2>/dev/null');
      const currentBranch = branch.trim();

      if (!currentBranch || currentBranch === 'HEAD') return;

      const prNumber = await this.getPrNumber(currentBranch);
      if (!prNumber) return;

      const format = options.format || 'simple';

      if (format === 'json') {
        const result: Record<string, string> = { branch: currentBranch, prNumber };
        if (options.showStatus) {
          const status = await this.getPrStatus(prNumber);
          if (status) result.prStatus = status;
        }
        process.stdout.write(JSON.stringify(result));
        return;
      }

      if (format === 'detailed') {
        const parts: string[] = [];
        if (options.showBranch) parts.push(currentBranch);
        parts.push(`PR#${prNumber}`);
        if (options.showStatus) {
          const status = await this.getPrStatus(prNumber);
          if (status) parts.push(`[${status}]`);
        }
        process.stdout.write(parts.join(' '));
        return;
      }

      // simple (default)
      process.stdout.write(`#${prNumber}`);
    } catch {
      // Silently fail — this runs in shell prompts
    }
  }

  private async getPrNumber(branch: string): Promise<string | null> {
    // Check metadata cache first
    try {
      const branchMeta = getBranchMetadataItem(branch);
      if (branchMeta?.prUrl) {
        const match = branchMeta.prUrl.match(/\/pull\/(\d+)/);
        if (match) return match[1];
      }
    } catch {
      // fall through to gh CLI
    }

    // Fall back to gh CLI
    try {
      const { stdout } = await execAsync(
        `gh pr list --head ${branch} --json number --jq '.[0].number' 2>/dev/null`
      );
      const num = stdout.trim();
      return num || null;
    } catch {
      return null;
    }
  }

  private async getPrStatus(prNumber: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --json state --jq '.state' 2>/dev/null`
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
