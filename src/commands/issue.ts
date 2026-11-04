// Issue command - Create GitHub issues from the CLI

import chalk from "chalk";
import inquirer from "inquirer";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { BaseCommand } from "../lib/command";
import { requireGitRepo, wrapError, getCurrentBranch, createTag } from "../lib/git";
import { UserError } from "../lib/errors";
import { requireGhCli } from "../lib/pr-providers";
import { updateBranchMetadata } from "../lib/metadata";

const execAsync = promisify(exec);

interface IssueOptions {
  title?: string;
  bodyFile?: string;
  label?: string;
  tag?: string | false;
  web?: boolean | false;
}

export class IssueCommand extends BaseCommand {
  constructor() {
    super({
      name: "issue",
      description: "Create a GitHub issue",
      ui: { category: 'action', widget: 'form-only', label: 'Create Issue', icon: 'tag', order: 23 },
      options: [
        { flags: "-t, --title <title>", description: "Issue title" },
        { flags: "-f, --body-file <path>", description: "Read description from a file" },
        { flags: "-l, --label <label>", description: "Pre-select a label" },
        { flags: "--tag <tagName>", description: "Git tag to create after issue is made" },
        { flags: "--no-tag", description: "Skip git tag creation" },
        { flags: "-w, --web", description: "Open issue in browser after creation" },
        { flags: "--no-web", description: "Skip the open-in-browser prompt" },
      ],
    });
  }

  async execute(options: IssueOptions = {}): Promise<void> {
    await requireGitRepo();
    await requireGhCli();

    // --- Title ---
    let title = options.title;
    if (!title) {
      const answer = await inquirer.prompt([
        {
          type: "input",
          name: "title",
          message: "Issue title:",
          validate: (input: string) => input.trim() ? true : "Title cannot be empty",
        },
      ]);
      title = answer.title.trim();
    }

    // --- Body ---
    let body = "";
    if (options.bodyFile) {
      if (!fs.existsSync(options.bodyFile)) {
        throw new UserError(`The description file ${options.bodyFile} does not exist.`, "Check the path given to --body-file.");
      }
      body = fs.readFileSync(options.bodyFile, "utf-8");
      console.log(chalk.gray(`Using description from ${options.bodyFile}`));
    } else {
      const answer = await inquirer.prompt([
        {
          type: "editor",
          name: "body",
          message: "Issue description (press Enter to open editor, leave empty to skip):",
          default: "",
        },
      ]);
      body = answer.body || "";
    }

    // --- Labels ---
    const selectedLabels = await this.selectLabels(options.label);

    // --- Create the issue ---
    console.log(chalk.blue("\nCreating issue..."));

    let ghCommand = `gh issue create --title ${JSON.stringify(title)}`;

    if (body.trim()) {
      ghCommand += ` --body ${JSON.stringify(body)}`;
    } else {
      ghCommand += ` --body ""`;
    }

    for (const label of selectedLabels) {
      ghCommand += ` --label ${JSON.stringify(label)}`;
    }

    let issueUrl = "";
    let issueNumber: string | null = null;

    try {
      const { stdout } = await execAsync(ghCommand);
      issueUrl = stdout.trim();

      const match = issueUrl.match(/\/issues\/(\d+)/);
      issueNumber = match ? match[1] : null;

      if (this.jsonMode) {
        this.outputJSON({
          success: true,
          url: issueUrl,
          number: issueNumber ? parseInt(issueNumber) : null,
          title,
          labels: selectedLabels,
        });
        return;
      }

      console.log(chalk.green("\n✓ Issue created successfully!"));
      console.log(chalk.cyan(`Issue URL: ${issueUrl}`));
      if (issueNumber) {
        console.log(chalk.gray(`Issue #${issueNumber}`));
      }
    } catch (error: any) {
      throw wrapError("Could not create the issue", error);
    }

    // --- Save to branch metadata ---
    try {
      const currentBranch = await getCurrentBranch();
      updateBranchMetadata(currentBranch, {
        relatedIssues: [issueUrl],
      });
    } catch {
      // Non-fatal — branch metadata is optional
    }

    // --- Git tag ---
    if (options.tag !== false) {
      const defaultTagName = issueNumber ? `issue-${issueNumber}` : "";

      const { createGitTag } = await inquirer.prompt([
        {
          type: "confirm",
          name: "createGitTag",
          message: "Create a git tag for this issue?",
          default: false,
        },
      ]);

      if (createGitTag) {
        const { tagName } = await inquirer.prompt([
          {
            type: "input",
            name: "tagName",
            message: "Tag name:",
            default: options.tag || defaultTagName,
            validate: (input: string) => input.trim() ? true : "Tag name cannot be empty",
          },
        ]);

        const result = await createTag(tagName.trim(), `GitHub issue #${issueNumber || title}`);
        if (result.success) {
          console.log(chalk.green(`✓ ${result.message}`));
        } else {
          console.log(chalk.yellow(`⚠ ${result.message}`));
        }
      }
    } else if (typeof options.tag === "string" && options.tag) {
      // --tag was explicitly passed, create without prompting
      const result = await createTag(options.tag, `GitHub issue #${issueNumber || title}`);
      if (result.success) {
        console.log(chalk.green(`✓ ${result.message}`));
      } else {
        console.log(chalk.yellow(`⚠ ${result.message}`));
      }
    }

    // --- Open in browser ---
    if (options.web === false) {
      // --no-web: skip prompt entirely
    } else if (options.web) {
      await execAsync(`gh issue view ${issueNumber || ""} --web`);
    } else {
      const { openInBrowser } = await inquirer.prompt([
        {
          type: "confirm",
          name: "openInBrowser",
          message: "Open issue in browser?",
          default: false,
        },
      ]);
      if (openInBrowser) {
        await execAsync(`gh issue view ${issueNumber || ""} --web`);
      }
    }
  }

  private async selectLabels(preselected?: string): Promise<string[]> {
    // If a label was explicitly passed via --label, use it directly without prompting
    if (preselected) {
      return [preselected];
    }

    let availableLabels: Array<{ name: string; color: string; description: string }> = [];

    try {
      const { stdout } = await execAsync("gh label list --json name,color,description --limit 100");
      availableLabels = JSON.parse(stdout || "[]");
    } catch {
      console.log(chalk.yellow("⚠ Could not fetch labels from GitHub"));
      return [];
    }

    if (availableLabels.length === 0) {
      console.log(chalk.gray("No labels found in this repository"));
      return [];
    }

    const choices = availableLabels.map((l) => ({
      name: `${chalk.hex("#" + l.color)("■")} ${l.name}${l.description ? chalk.dim("  " + l.description) : ""}`,
      value: l.name,
    }));

    const { labels } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "labels",
        message: "Select labels:",
        choices,
        pageSize: 15,
      },
    ]);

    return labels as string[];
  }
}
