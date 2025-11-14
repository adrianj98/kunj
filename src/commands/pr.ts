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

const execAsync = promisify(exec);

interface PrOptions {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  web?: boolean;
}

export class PrCommand extends BaseCommand {
  constructor() {
    super({
      name: "pr",
      description: "Create a pull request on GitHub",
      options: [
        { flags: "-t, --title <title>", description: "PR title" },
        { flags: "-b, --body <body>", description: "PR body/description" },
        { flags: "--base <branch>", description: "Base branch (default: main/master)" },
        { flags: "-d, --draft", description: "Create as draft PR" },
        { flags: "-w, --web", description: "Open PR in web browser after creation" },
      ],
    });
  }

  async execute(options: PrOptions = {}): Promise<void> {
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

    const currentBranch = await getCurrentBranch();
    const mainBranch = options.base || (await getMainBranch());

    if (currentBranch === mainBranch) {
      console.error(chalk.red(`Error: Cannot create PR from ${mainBranch} branch`));
      console.log(chalk.yellow("Please switch to a feature branch first"));
      process.exit(1);
    }

    console.log(chalk.blue(`Creating PR from ${currentBranch} to ${mainBranch}`));

    // Get branch metadata
    const branchMetadata = getBranchMetadataItem(currentBranch);
    const branchDescription = branchMetadata?.description || "";

    // Get commits for PR description
    const commits = await getCommitsSinceBranch();

    // Prepare PR details
    let title = options.title;
    let body = options.body;

    if (!title || !body) {
      // Interactive mode
      const suggestions = await this.generatePrSuggestions(
        currentBranch,
        branchDescription,
        commits
      );

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
      let ghCommand = `gh pr create --title "${title!.replace(/"/g, '\\"')}" --body "${body!.replace(/"/g, '\\"')}" --base ${mainBranch}`;

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
    commits: string[]
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

    // Generate suggested body
    let body = "## Summary\n\n";

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
}