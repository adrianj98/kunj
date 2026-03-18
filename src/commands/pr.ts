// PR command - Create pull requests from the CLI

import chalk from "chalk";
import inquirer from "inquirer";
import { exec } from "child_process";
import { promisify } from "util";
import { BaseCommand } from "../lib/command";
import {
  checkGitRepo,
  getCurrentBranch,
  getCommitsSinceBranch,
  getMainBranch,
} from "../lib/git";
import { getBranchMetadataItem } from "../lib/metadata";
import { loadConfig } from "../lib/config";
import { generateAIPRDescription, getPRDiff } from "../lib/ai-pr";
import { checkAWSCredentials, generatePRLogEntry } from "../lib/ai-commit";
import { appendToWorkLog } from "../lib/work-log";

const execAsync = promisify(exec);

interface PrOptions {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  web?: boolean;
  status?: boolean;
  list?: boolean;
  detailed?: boolean;
}

export class PrCommand extends BaseCommand {
  constructor() {
    super({
      name: "pr",
      description: "Create or view pull requests on GitHub",
      arguments: "[prNumber]",
      options: [
        { flags: "-t, --title <title>", description: "PR title" },
        { flags: "-b, --body <body>", description: "PR body/description" },
        { flags: "--base <branch>", description: "Base branch (overrides config setting)" },
        { flags: "-d, --draft", description: "Create as draft PR" },
        { flags: "-w, --web", description: "Open PR in web browser after creation" },
        { flags: "-s, --status", description: "View status of current branch's PR" },
        { flags: "-l, --list", description: "List all open PRs" },
        { flags: "--detailed", description: "Show detailed GitHub Actions steps" },
      ],
    });
  }

  async execute(prNumber?: string, options: PrOptions = {}): Promise<void> {
    // Check if we're in a git repository
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    // Check if gh CLI is installed
    const ghAvailable = await this.checkGhCli();
    if (!ghAvailable) {
      console.error(chalk.red("Error: GitHub CLI (gh) is not installed"));
      console.log(chalk.yellow("\nTo install GitHub CLI:"));
      console.log(chalk.gray("  macOS: brew install gh"));
      console.log(chalk.gray("  Linux: See https://github.com/cli/cli#installation"));
      console.log(chalk.gray("  Windows: See https://github.com/cli/cli#installation"));
      console.log(chalk.yellow("\nThen authenticate with: gh auth login"));
      process.exit(1);
    }

    // If PR number is provided, show that specific PR's status
    if (prNumber) {
      // Strip # if present (support both "123" and "#123")
      const cleanNumber = prNumber.replace(/^#/, '');

      // Validate it's a number
      if (!/^\d+$/.test(cleanNumber)) {
        console.error(chalk.red(`Error: Invalid PR number '${prNumber}'`));
        console.log(chalk.yellow("Usage: kunj pr #123  or  kunj pr 123"));
        process.exit(1);
      }

      await this.showPrStatus(options.detailed, cleanNumber);
      return;
    }

    // Handle status flag
    if (options.status) {
      await this.showPrStatus(options.detailed);
      return;
    }

    // Handle list flag
    if (options.list) {
      await this.listPrs();
      return;
    }

    const currentBranch = await getCurrentBranch();

    // Determine base branch: CLI option > config setting > auto-detect
    let baseBranch = options.base;

    if (!baseBranch) {
      const config = await loadConfig();
      const configuredBase = config.preferences?.defaultBaseBranch;

      if (configuredBase && configuredBase.trim() !== '') {
        baseBranch = configuredBase.trim();
      } else {
        // Auto-detect or prompt if multiple candidates
        baseBranch = await this.selectBaseBranch();
      }
    }

    if (currentBranch === baseBranch) {
      console.error(chalk.red(`Error: Cannot create PR from ${baseBranch} branch`));
      console.log(chalk.yellow("Please switch to a feature branch first"));
      process.exit(1);
    }

    // Get branch metadata
    const branchMetadata = getBranchMetadataItem(currentBranch);
    const branchDescription = branchMetadata?.description || "";

    // Check if PR already exists for this branch (via metadata or gh CLI)
    const existingPrFromMetadata = branchMetadata?.prUrl;
    const existingPrFromGh = await this.checkExistingPr(currentBranch);

    if (existingPrFromMetadata || existingPrFromGh) {
      console.log(chalk.blue(`Found existing PR for branch ${currentBranch}`));
      if (existingPrFromMetadata) {
        console.log(chalk.gray(`  ${existingPrFromMetadata}`));
      }
      await this.showPrStatus(options.detailed);
      return;
    }

    console.log(chalk.blue(`Creating PR from ${currentBranch} to ${baseBranch}`));

    // Get commits for PR description (using the correct base branch)
    const commits = await getCommitsSinceBranch(baseBranch);

    // Prepare PR details
    let title = options.title;
    let body = options.body;

    if (!title || !body) {
      // Interactive mode
      const config = loadConfig();
      let suggestions;

      // Try AI generation if enabled and autoGeneratePRDescription is true
      const shouldUseAI = config.ai?.enabled && (config.ai?.autoGeneratePRDescription !== false);

      if (shouldUseAI) {
        try {
          // Check if AWS credentials are available
          const hasCredentials = await checkAWSCredentials();

          if (hasCredentials) {
            // Get the diff for AI context
            const diff = await getPRDiff(baseBranch);

            // Generate with AI
            suggestions = await generateAIPRDescription(
              currentBranch,
              baseBranch,
              branchMetadata,
              commits,
              diff
            );
            console.log(chalk.green("✓ Generated PR description with AI"));
          } else {
            console.log(chalk.yellow("⚠ AWS credentials not configured, using heuristic generation"));
            suggestions = await this.generatePrSuggestions(
              currentBranch,
              branchDescription,
              commits,
              branchMetadata
            );
          }
        } catch (error: any) {
          console.log(chalk.yellow(`⚠ AI generation failed: ${error.message}`));
          console.log(chalk.gray("  Falling back to heuristic generation"));
          suggestions = await this.generatePrSuggestions(
            currentBranch,
            branchDescription,
            commits,
            branchMetadata
          );
        }
      } else {
        // AI disabled, use heuristic generation
        suggestions = await this.generatePrSuggestions(
          currentBranch,
          branchDescription,
          commits,
          branchMetadata
        );
      }

      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "title",
          message: "PR title:",
          default: title || suggestions.title,
          validate: (input) => {
            if (!input.trim()) {
              return "PR title cannot be empty";
            }
            return true;
          },
        },
        {
          type: "editor",
          name: "body",
          message: "PR description (press Enter to open editor):",
          default: body || suggestions.body,
        },
      ]);

      title = answers.title;
      body = answers.body;
    }

    // Create the PR
    try {
      console.log(chalk.blue("\nCreating pull request..."));

      // First, ensure we're pushed to remote
      await this.ensurePushed(currentBranch);

      // Build gh command
      let ghCommand = `gh pr create --title "${title!.replace(/"/g, '\\"')}" --body "${body!.replace(/"/g, '\\"')}" --base ${baseBranch}`;

      if (options.draft) {
        ghCommand += " --draft";
      }

      if (options.web) {
        ghCommand += " --web";
      }

      const { stdout, stderr } = await execAsync(ghCommand);

      if (stderr && !stderr.includes("Opening")) {
        console.error(chalk.yellow(stderr));
      }

      if (stdout) {
        const prUrl = stdout.trim();
        console.log(chalk.green("\n✓ Pull request created successfully!"));
        console.log(chalk.cyan(`PR URL: ${prUrl}`));

        // Save PR URL to branch metadata
        const { updateBranchMetadata } = await import('../lib/metadata');
        await updateBranchMetadata(currentBranch, { prUrl });

        // Extract PR number from URL (e.g., https://github.com/user/repo/pull/123)
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
        const prNumber = prNumberMatch ? prNumberMatch[1] : null;

        // Generate work log entry for the PR
        try {
          console.log(chalk.gray("📝 Generating work log entry..."));
          const prLogEntry = await generatePRLogEntry(
            title!,
            body!,
            commits,
            currentBranch,
            baseBranch
          );

          if (prLogEntry && prNumber) {
            // Replace "PR: #" with actual PR number
            const logEntryWithNumber = prLogEntry.replace(/PR:\s*#?\s*$/, `PR: #${prNumber}`);
            appendToWorkLog(logEntryWithNumber);
            console.log(chalk.green("✓ Work log entry added"));
          }
        } catch (error: any) {
          // Don't fail the PR creation if work log fails
          console.log(chalk.yellow("⚠ Failed to generate work log entry"));
          console.log(chalk.gray(`  ${error.message}`));
        }

        // Show initial PR status
        console.log(chalk.blue("\nFetching PR status..."));
        await this.showPrStatus(options.detailed);

        // Ask if user wants to open in browser
        if (!options.web) {
          const { openInBrowser } = await inquirer.prompt([
            {
              type: "confirm",
              name: "openInBrowser",
              message: "Open PR in browser?",
              default: true,
            },
          ]);

          if (openInBrowser) {
            await execAsync(`gh pr view --web`);
          }
        }
      }
    } catch (error: any) {
      console.error(chalk.red("Failed to create PR:"), error.message);

      // Check if it's because PR already exists
      if (error.message.includes("already exists")) {
        console.log(chalk.yellow("\nA PR already exists for this branch"));
        const { viewExisting } = await inquirer.prompt([
          {
            type: "confirm",
            name: "viewExisting",
            message: "View existing PR?",
            default: true,
          },
        ]);

        if (viewExisting) {
          await execAsync(`gh pr view --web`);
        }
      }
      process.exit(1);
    }
  }

  private async checkGhCli(): Promise<boolean> {
    try {
      await execAsync("gh --version");
      // Check if authenticated
      await execAsync("gh auth status");
      return true;
    } catch {
      return false;
    }
  }

  private async ensurePushed(branch: string): Promise<void> {
    try {
      // Check if branch has upstream
      const { stdout: upstream } = await execAsync(
        `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo ""`
      );

      if (!upstream.trim()) {
        // No upstream, push with -u
        console.log(chalk.gray("Setting upstream branch..."));
        await execAsync(`git push -u origin ${branch}`);
        console.log(chalk.green("✓ Pushed to remote"));
      } else {
        // Check if we have unpushed commits
        const { stdout: unpushed } = await execAsync(
          `git rev-list --count @{u}..HEAD`
        );

        if (parseInt(unpushed.trim()) > 0) {
          console.log(chalk.gray("Pushing latest commits..."));
          await execAsync("git push");
          console.log(chalk.green("✓ Pushed to remote"));
        }
      }
    } catch (error: any) {
      console.error(chalk.red("Failed to push:"), error.message);
      throw error;
    }
  }

  private async generatePrSuggestions(
    branch: string,
    description: string,
    commits: string[],
    branchMetadata?: any
  ): Promise<{ title: string; body: string }> {
    // Generate a suggested title
    let title = branch
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());

    // If we have a branch description, use it
    if (description) {
      title = description;
    } else if (commits.length === 1) {
      // If only one commit, use it as title
      title = commits[0];
    }

    // Add Jira context to title if available
    const config = loadConfig();
    const jiraKey = branchMetadata?.jiraIssueKey;
    if (jiraKey) {
      const jiraTitle = branchMetadata.jiraIssueTitle;
      title = `${jiraKey}: ${jiraTitle || title}`;
    }

    // Generate suggested body
    let body = "";

    // Add Jira section if available
    if (jiraKey && config.jira?.baseUrl) {
      const jiraUrl = `${config.jira.baseUrl}/browse/${jiraKey}`;
      const jiraTitle = branchMetadata.jiraIssueTitle || "";
      body += "## Jira Ticket\n\n";
      body += `[${jiraKey}](${jiraUrl}) - ${jiraTitle}\n\n`;
    }

    body += "## Summary\n\n";

    if (description) {
      body += `${description}\n\n`;
    }

    if (commits.length > 0) {
      body += "## Changes\n\n";
      commits.forEach((commit) => {
        body += `- ${commit}\n`;
      });
      body += "\n";
    }

    body += "## Testing\n\n";
    body += "- [ ] Tests pass\n";
    body += "- [ ] Manual testing completed\n\n";

    body += "## Checklist\n\n";
    body += "- [ ] Code follows project style guidelines\n";
    body += "- [ ] Self-review completed\n";
    body += "- [ ] Documentation updated if needed\n";

    return { title, body };
  }

  private async selectBaseBranch(): Promise<string> {
    try {
      // Get all branches (local and remote)
      const { stdout } = await execAsync(
        `git branch -a --format='%(refname:short)' 2>/dev/null`
      );

      const allBranches = stdout
        .split('\n')
        .map(b => b.trim())
        .filter(b => b && !b.startsWith('remotes/'));

      // Common base branch candidates
      const candidates = ['main', 'master', 'develop', 'development', 'dev'];
      const availableCandidates = candidates.filter(c => allBranches.includes(c));

      // If only one candidate found, use it
      if (availableCandidates.length === 1) {
        console.log(chalk.gray(`Using base branch: ${availableCandidates[0]}`));
        return availableCandidates[0];
      }

      // If multiple candidates, prompt user
      if (availableCandidates.length > 1) {
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'baseBranch',
            message: 'Select base branch for PR:',
            choices: availableCandidates.map(b => ({
              name: b,
              value: b
            })),
            default: availableCandidates[0]
          }
        ]);

        return answer.baseBranch;
      }

      // Fallback to getMainBranch
      return await getMainBranch();
    } catch (error) {
      // If anything fails, use getMainBranch as fallback
      return await getMainBranch();
    }
  }

  private async checkExistingPr(branch: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `gh pr list --head ${branch} --json number --jq '.[0].number' 2>/dev/null || echo ""`
      );
      return stdout.trim() !== "";
    } catch {
      return false;
    }
  }

  private async showPrStatus(detailed: boolean = false, prNumber?: string): Promise<void> {
    try {
      let branchInfo = "";
      let ghCommand = "gh pr view";

      if (prNumber) {
        // Viewing a specific PR by number
        branchInfo = `PR #${prNumber}`;
        ghCommand = `gh pr view ${prNumber}`;
      } else {
        // Viewing PR for current branch
        const currentBranch = await getCurrentBranch();
        branchInfo = `branch: ${currentBranch}`;
      }

      console.log(chalk.blue(`\n📋 PR Status for ${branchInfo}\n`));

      // Get PR details
      const { stdout: prJson } = await execAsync(
        `${ghCommand} --json number,title,state,url,isDraft,mergeable,reviews,statusCheckRollup,additions,deletions,author,headRefName 2>/dev/null || echo "{}"`
      );

      const pr = JSON.parse(prJson || "{}");

      if (!pr.number) {
        console.log(chalk.yellow("No PR found for the current branch"));
        console.log(chalk.gray("Create one with: kunj pr"));
        return;
      }

      // Basic PR info
      console.log(chalk.cyan("📌 PR Info:"));
      console.log(`  Number: #${pr.number}`);
      console.log(`  Title: ${pr.title}`);
      console.log(`  Author: ${pr.author?.login || "unknown"}`);
      console.log(`  State: ${this.formatState(pr.state, pr.isDraft)}`);
      console.log(`  URL: ${chalk.blue(pr.url)}`);
      console.log(`  Changes: ${chalk.green(`+${pr.additions}`)} ${chalk.red(`-${pr.deletions}`)}`);

      // Mergeable status
      const mergeableIcon = pr.mergeable === "MERGEABLE" ? "✅" : pr.mergeable === "CONFLICTING" ? "❌" : "⏳";
      console.log(`  Mergeable: ${mergeableIcon} ${pr.mergeable || "unknown"}`);

      // Reviews/Approvals
      console.log(chalk.cyan("\n✅ Reviews:"));
      if (pr.reviews && pr.reviews.length > 0) {
        const approvals = pr.reviews.filter((r: any) => r.state === "APPROVED");
        const changesRequested = pr.reviews.filter((r: any) => r.state === "CHANGES_REQUESTED");
        const pending = pr.reviews.filter((r: any) => r.state === "PENDING");

        console.log(`  Approvals: ${chalk.green(approvals.length)} ✅`);
        if (approvals.length > 0) {
          approvals.forEach((r: any) => {
            console.log(chalk.gray(`    - ${r.author.login}`));
          });
        }

        if (changesRequested.length > 0) {
          console.log(`  Changes Requested: ${chalk.red(changesRequested.length)} 🔄`);
          changesRequested.forEach((r: any) => {
            console.log(chalk.gray(`    - ${r.author.login}`));
          });
        }

        if (pending.length > 0) {
          console.log(`  Pending: ${chalk.yellow(pending.length)} ⏳`);
        }
      } else {
        console.log(chalk.gray("  No reviews yet"));
      }

      // GitHub Actions / Status Checks
      console.log(chalk.cyan("\n🚀 Status Checks:"));
      if (pr.statusCheckRollup && pr.statusCheckRollup.length > 0) {
        const checks = pr.statusCheckRollup;
        const passed = checks.filter((c: any) => c.conclusion === "SUCCESS" || c.status === "COMPLETED");
        const failed = checks.filter((c: any) => c.conclusion === "FAILURE");
        const pending = checks.filter((c: any) => c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING");

        console.log(`  Total: ${checks.length} checks`);
        console.log(`  Passed: ${chalk.green(passed.length)} ✅`);
        console.log(`  Failed: ${chalk.red(failed.length)} ❌`);
        console.log(`  Running: ${chalk.yellow(pending.length)} 🔄`);

        // Show individual check status
        console.log(chalk.gray("\n  Details:"));
        checks.forEach((check: any) => {
          const icon = this.getCheckIcon(check.conclusion || check.status);
          const name = check.name || check.context || "Unknown check";
          const status = check.conclusion || check.status || "unknown";
          console.log(`    ${icon} ${name}: ${status}`);
        });

        // Show detailed GitHub Actions steps if requested
        if (detailed) {
          console.log(chalk.cyan("\n📝 GitHub Actions Detailed Steps:"));

          try {
            // Get the workflow runs for this PR - use headRefName from PR data
            const branch = pr.headRefName;
            const { stdout: runsJson } = await execAsync(
              `gh run list --branch=${branch} --json databaseId,name,status,conclusion,workflowName --limit=5`
            );
            const runs = JSON.parse(runsJson || "[]");

            if (runs.length > 0) {
              for (const run of runs.slice(0, 3)) { // Show up to 3 recent runs
                console.log(chalk.yellow(`\n  Workflow: ${run.workflowName}`));
                console.log(`    Run ID: ${run.databaseId}`);
                console.log(`    Status: ${this.getCheckIcon(run.conclusion || run.status)} ${run.conclusion || run.status}`);

                // Get detailed jobs and steps for each run
                try {
                  const { stdout: jobsJson } = await execAsync(
                    `gh run view ${run.databaseId} --json jobs`
                  );
                  const jobsData = JSON.parse(jobsJson || "{}");

                  if (jobsData.jobs && jobsData.jobs.length > 0) {
                    console.log(chalk.gray("    Jobs:"));

                    for (const job of jobsData.jobs) {
                      const jobIcon = this.getCheckIcon(job.conclusion || job.status);
                      console.log(`      ${jobIcon} ${job.name}`);

                      if (job.steps && job.steps.length > 0) {
                        console.log(chalk.gray("        Steps:"));
                        for (const step of job.steps) {
                          const stepIcon = this.getCheckIcon(step.conclusion || step.status);
                          const duration = step.completedAt && step.startedAt
                            ? this.formatDuration(new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime())
                            : "";
                          console.log(`          ${stepIcon} ${step.name} ${duration ? chalk.gray(`(${duration})`) : ""}`);
                        }
                      }
                    }
                  }
                } catch (error) {
                  // If we can't get detailed job info, just continue
                  console.log(chalk.gray("    (Detailed steps not available)"));
                }
              }
            } else {
              console.log(chalk.gray("  No workflow runs found for this branch"));
            }
          } catch (error) {
            console.log(chalk.gray("  Unable to fetch detailed workflow information"));
          }
        }
      } else {
        console.log(chalk.gray("  No status checks configured"));
      }

      // Quick actions
      console.log(chalk.cyan("\n🔧 Quick Actions:"));
      console.log(chalk.gray("  View in browser: gh pr view --web"));
      console.log(chalk.gray("  Merge PR: gh pr merge"));
      console.log(chalk.gray("  Close PR: gh pr close"));

    } catch (error: any) {
      console.error(chalk.red("Failed to get PR status:"), error.message);
      process.exit(1);
    }
  }

  private async listPrs(): Promise<void> {
    try {
      console.log(chalk.blue("\n📋 Open Pull Requests:\n"));

      const { stdout } = await execAsync(
        `gh pr list --json number,title,author,isDraft,headRefName,reviews,statusCheckRollup --limit 20`
      );

      const prs = JSON.parse(stdout || "[]");

      if (prs.length === 0) {
        console.log(chalk.gray("No open pull requests"));
        return;
      }

      prs.forEach((pr: any) => {
        const approvals = pr.reviews?.filter((r: any) => r.state === "APPROVED").length || 0;
        const checks = pr.statusCheckRollup || [];
        const failedChecks = checks.filter((c: any) => c.conclusion === "FAILURE").length;
        const pendingChecks = checks.filter((c: any) =>
          c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING"
        ).length;

        const checkStatus = failedChecks > 0 ? chalk.red("❌") :
                          pendingChecks > 0 ? chalk.yellow("🔄") :
                          checks.length > 0 ? chalk.green("✅") : "";

        const approvalStatus = approvals > 0 ? chalk.green(`✅ ${approvals}`) : chalk.gray("0");
        const draftStatus = pr.isDraft ? chalk.gray("[DRAFT]") : "";

        console.log(
          `#${chalk.cyan(pr.number)} ${checkStatus} ${approvalStatus} ${draftStatus} ${pr.title}`
        );
        console.log(
          chalk.gray(`     Branch: ${pr.headRefName} | Author: ${pr.author.login}`)
        );
        console.log();
      });

      console.log(chalk.gray("\nView details: kunj pr --status"));
    } catch (error: any) {
      console.error(chalk.red("Failed to list PRs:"), error.message);
      process.exit(1);
    }
  }

  private formatState(state: string, isDraft: boolean): string {
    if (isDraft) return chalk.gray("DRAFT");
    switch (state) {
      case "OPEN":
        return chalk.green("OPEN");
      case "CLOSED":
        return chalk.red("CLOSED");
      case "MERGED":
        return chalk.magenta("MERGED");
      default:
        return state;
    }
  }

  private getCheckIcon(status: string): string {
    switch (status) {
      case "SUCCESS":
      case "COMPLETED":
        return chalk.green("✅");
      case "FAILURE":
        return chalk.red("❌");
      case "IN_PROGRESS":
      case "QUEUED":
      case "PENDING":
        return chalk.yellow("🔄");
      case "CANCELLED":
      case "SKIPPED":
        return chalk.gray("⏭️");
      default:
        return chalk.gray("❓");
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
}