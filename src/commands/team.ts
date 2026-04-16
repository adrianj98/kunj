// Team command - Fetch open PRs, save diffs, and generate team activity report

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { BaseCommand } from "../lib/command";
import { checkGitRepo } from "../lib/git";
import { getKunjDir, loadConfig } from "../lib/config";
import { checkAWSCredentials, getBedrockClient } from "../lib/ai-commit";
import { getTodayDate } from "../lib/work-log";

const execAsync = promisify(exec);

interface TeamOptions {
  ai?: boolean;
  limit?: string;
  force?: boolean;
}

interface PRCacheEntry {
  updatedAt: string;
  diffFile: string;
  activity?: { comments: PRComment[]; reviews: PRReview[] };
}

interface PRCache {
  lastActivityFetch?: string;
  prs: { [prNumber: string]: PRCacheEntry };
}

interface PRData {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
  labels: Array<{ name: string }>;
  url: string;
}

interface PRComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

interface PRReview {
  author: { login: string };
  body: string;
  state: string;
  submittedAt: string;
}

interface PRActivity {
  comments: PRComment[];
  reviews: PRReview[];
}

export class TeamCommand extends BaseCommand {
  constructor() {
    super({
      name: "team",
      description:
        "Fetch open PRs, save diffs, and generate a team activity report",
      options: [
        {
          flags: "--no-ai",
          description: "Skip AI summary, generate structured report only",
        },
        {
          flags: "-l, --limit <n>",
          description: "Max PRs to fetch (default: 50)",
          defaultValue: "50",
        },
        {
          flags: "-f, --force",
          description: "Force re-fetch all diffs, ignoring cache",
        },
      ],
    });
  }

  async execute(options: TeamOptions = {}): Promise<void> {
    const isGitRepo = await checkGitRepo();
    if (!isGitRepo) {
      console.error(chalk.red("Error: Not a git repository"));
      process.exit(1);
    }

    const ghAvailable = await this.checkGhCli();
    if (!ghAvailable) {
      console.error(chalk.red("Error: GitHub CLI (gh) is not installed"));
      console.log(chalk.yellow("\nTo install: brew install gh"));
      console.log(chalk.yellow("Then authenticate: gh auth login"));
      process.exit(1);
    }

    const limit = parseInt(options.limit || "50", 10);

    // Fetch open PRs
    console.log(chalk.blue("Fetching open pull requests..."));
    const prs = await this.fetchOpenPRs(limit);

    if (prs.length === 0) {
      console.log(chalk.yellow("No open pull requests found."));
      return;
    }

    console.log(chalk.green(`Found ${prs.length} open PR(s)`));

    // Create output directories
    const teamDir = path.join(getKunjDir(), "team");
    const diffsDir = path.join(teamDir, "diffs");
    const activityDir = path.join(teamDir, "activity");
    fs.mkdirSync(diffsDir, { recursive: true });
    fs.mkdirSync(activityDir, { recursive: true });

    // Load cache of previously fetched PRs
    const cachePath = path.join(teamDir, "cache.json");
    const cache: PRCache = this.loadCache(cachePath);
    const newCache: PRCache = { prs: {} };

    // Fetch and save diffs (skip unchanged PRs)
    console.log(chalk.blue("\nSaving diffs..."));
    const diffs: Map<number, string> = new Map();
    let skipped = 0;

    for (const pr of prs) {
      const slug = pr.headRefName
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .substring(0, 60);
      const filename = `pr-${pr.number}-${slug}.diff`;
      const filepath = path.join(diffsDir, filename);

      const cached = cache.prs[pr.number];
      const unchanged =
        !options.force &&
        cached &&
        cached.updatedAt === pr.updatedAt &&
        fs.existsSync(filepath);

      if (unchanged) {
        // Reuse cached diff
        const diff = fs.readFileSync(filepath, "utf8");
        diffs.set(pr.number, diff);
        newCache.prs[pr.number] = { ...cached };
        skipped++;
        console.log(chalk.gray(`  Skipped ${filename} (unchanged)`));
      } else {
        const diff = await this.fetchPRDiff(pr.number);
        fs.writeFileSync(filepath, diff, "utf8");
        diffs.set(pr.number, diff);
        newCache.prs[pr.number] = {
          updatedAt: pr.updatedAt,
          diffFile: filename,
        };
        console.log(chalk.gray(`  Saved ${filename}`));
      }
    }

    if (skipped > 0) {
      console.log(
        chalk.gray(`\n  ${skipped} PR(s) unchanged since last fetch`)
      );
    }

    // Fetch recent activity using checkpoint
    const now = new Date().toISOString();
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();
    const lastFetch = cache.lastActivityFetch;
    // Fetch since last checkpoint, but never older than 24h
    const fetchSince =
      !options.force && lastFetch && lastFetch > twentyFourHoursAgo
        ? lastFetch
        : twentyFourHoursAgo;

    console.log(chalk.blue("\nFetching recent activity..."));
    if (fetchSince > twentyFourHoursAgo) {
      console.log(
        chalk.gray(
          `  Using checkpoint from ${new Date(fetchSince).toLocaleTimeString()}`
        )
      );
    }

    const recentActivity = new Map<number, PRActivity>();
    for (const pr of prs) {
      const freshActivity = await this.fetchPRActivity(pr.number, fetchSince);

      // Merge with cached activity, then prune anything older than 24h
      const cachedEntry = cache.prs[pr.number];
      const cachedActivity = cachedEntry?.activity;
      const merged = this.mergeActivity(
        cachedActivity,
        freshActivity,
        twentyFourHoursAgo
      );

      recentActivity.set(pr.number, merged);
      newCache.prs[pr.number] = {
        ...newCache.prs[pr.number],
        activity: merged,
      };

      // Save activity to disk
      if (merged.comments.length > 0 || merged.reviews.length > 0) {
        const slug = pr.headRefName
          .replace(/[^a-zA-Z0-9-]/g, "-")
          .substring(0, 60);
        const activityFile = path.join(
          activityDir,
          `pr-${pr.number}-${slug}.json`
        );
        fs.writeFileSync(
          activityFile,
          JSON.stringify(
            {
              prNumber: pr.number,
              title: pr.title,
              author: pr.author.login,
              branch: pr.headRefName,
              fetchedAt: now,
              comments: merged.comments,
              reviews: merged.reviews,
            },
            null,
            2
          ),
          "utf8"
        );
      }
    }

    newCache.lastActivityFetch = now;

    // Save updated cache
    fs.writeFileSync(cachePath, JSON.stringify(newCache, null, 2), "utf8");

    // Generate report
    const config = loadConfig();
    const useAI = options.ai !== false && config.ai?.enabled;
    let reportContent: string;

    if (useAI) {
      console.log(chalk.blue("\nGenerating AI-powered team report..."));
      const hasCredentials = await checkAWSCredentials();
      if (hasCredentials) {
        try {
          reportContent = await this.generateAIReport(
            prs,
            diffs,
            recentActivity
          );
        } catch (error: any) {
          console.log(
            chalk.yellow(
              `AI generation failed: ${error.message}. Falling back to structured report.`
            )
          );
          reportContent = this.generateStructuredReport(
            prs,
            diffs,
            recentActivity
          );
        }
      } else {
        console.log(
          chalk.yellow(
            "AWS credentials not configured. Generating structured report."
          )
        );
        reportContent = this.generateStructuredReport(
          prs,
          diffs,
          recentActivity
        );
      }
    } else {
      console.log(chalk.blue("\nGenerating team report..."));
      reportContent = this.generateStructuredReport(
        prs,
        diffs,
        recentActivity
      );
    }

    const authors = new Set(prs.map((pr) => pr.author.login));

    // Save report
    const date = getTodayDate();
    const reportPath = path.join(teamDir, `report-${date}.md`);
    fs.writeFileSync(reportPath, reportContent, "utf8");

    // Print summary
    console.log(chalk.green(`\nTeam report saved to ${reportPath}`));
    console.log(
      chalk.gray(
        `${prs.length} open PRs across ${authors.size} author(s) | Diffs saved to ${diffsDir}`
      )
    );
  }

  private loadCache(cachePath: string): PRCache {
    try {
      if (fs.existsSync(cachePath)) {
        const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        // Handle old format (flat object without .prs key)
        if (raw.prs) return raw;
        // Migrate old format
        const { lastActivityFetch, ...prs } = raw;
        return { prs };
      }
    } catch {
      // Corrupted cache, start fresh
    }
    return { prs: {} };
  }

  private async checkGhCli(): Promise<boolean> {
    try {
      await execAsync("gh auth status");
      return true;
    } catch {
      return false;
    }
  }

  private async fetchOpenPRs(limit: number): Promise<PRData[]> {
    try {
      const { stdout } = await execAsync(
        `gh pr list --json number,title,author,headRefName,baseRefName,isDraft,additions,deletions,createdAt,updatedAt,labels,url --state open --limit ${limit}`
      );
      return JSON.parse(stdout || "[]");
    } catch (error: any) {
      console.error(chalk.red("Failed to fetch PRs:"), error.message);
      process.exit(1);
    }
  }

  private async fetchPRActivity(
    prNumber: number,
    since: string
  ): Promise<PRActivity> {
    let comments: PRComment[] = [];
    let reviews: PRReview[] = [];

    try {
      const { stdout: commentsJson } = await execAsync(
        `gh pr view ${prNumber} --json comments --jq '.comments'`
      );
      const allComments: PRComment[] = JSON.parse(commentsJson || "[]");
      comments = allComments.filter((c) => c.createdAt >= since);
    } catch {
      // ignore
    }

    try {
      const { stdout: reviewsJson } = await execAsync(
        `gh pr view ${prNumber} --json reviews --jq '.reviews'`
      );
      const allReviews: PRReview[] = JSON.parse(reviewsJson || "[]");
      reviews = allReviews.filter(
        (r) => r.submittedAt >= since && r.body.trim()
      );
    } catch {
      // ignore
    }

    return { comments, reviews };
  }

  private mergeActivity(
    cached: PRActivity | undefined,
    fresh: PRActivity,
    cutoff: string
  ): PRActivity {
    if (!cached) return fresh;

    // Combine cached + fresh, deduplicate by timestamp+author, prune older than cutoff
    const allComments = [...cached.comments, ...fresh.comments];
    const allReviews = [...cached.reviews, ...fresh.reviews];

    const uniqueComments = this.deduplicateBy(
      allComments.filter((c) => c.createdAt >= cutoff),
      (c) => `${c.author.login}:${c.createdAt}`
    );

    const uniqueReviews = this.deduplicateBy(
      allReviews.filter((r) => r.submittedAt >= cutoff),
      (r) => `${r.author.login}:${r.submittedAt}`
    );

    return { comments: uniqueComments, reviews: uniqueReviews };
  }

  private getLastUpdated(prList: PRData[]): string {
    const latest = prList.reduce((max, pr) =>
      pr.updatedAt > max ? pr.updatedAt : max, prList[0].updatedAt
    );
    return this.formatTimestamp(latest);
  }

  private formatTimestamp(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  private deduplicateBy<T>(items: T[], keyFn: (item: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async fetchPRDiff(prNumber: number): Promise<string> {
    try {
      const { stdout } = await execAsync(`gh pr diff ${prNumber}`, {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout || "";
    } catch (error: any) {
      console.error(
        chalk.yellow(`Warning: Could not fetch diff for PR #${prNumber}`)
      );
      return "";
    }
  }

  private buildPRContext(
    prs: PRData[],
    diffs: Map<number, string>,
    recentActivity: Map<number, PRActivity>
  ): string {
    const maxDiffPerPR = Math.floor(8000 / Math.max(prs.length, 1));
    let context = "";

    for (const pr of prs) {
      const diff = diffs.get(pr.number) || "";
      const truncatedDiff =
        diff.length > maxDiffPerPR
          ? diff.substring(0, maxDiffPerPR) + "...[truncated]"
          : diff;
      const labels = pr.labels.map((l) => l.name).join(", ");
      const activity = recentActivity.get(pr.number);

      context += `\n### PR #${pr.number}: ${pr.title}
Author: @${pr.author.login}
Branch: ${pr.headRefName} → ${pr.baseRefName}
${pr.isDraft ? "Status: DRAFT\n" : ""}Created: ${pr.createdAt} | Updated: ${pr.updatedAt}
+${pr.additions} -${pr.deletions}${labels ? ` | Labels: ${labels}` : ""}`;

      // Add recent discussion
      if (activity) {
        const hasActivity =
          activity.comments.length > 0 || activity.reviews.length > 0;
        if (hasActivity) {
          context += `\nRecent discussion (last 24h):`;
          for (const review of activity.reviews) {
            context += `\n  Review by @${review.author.login} (${review.state}): ${review.body.substring(0, 200)}`;
          }
          for (const comment of activity.comments) {
            context += `\n  Comment by @${comment.author.login}: ${comment.body.substring(0, 200)}`;
          }
        }
      }

      context += `\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
    }

    return context;
  }

  private async generateAIReport(
    prs: PRData[],
    diffs: Map<number, string>,
    recentActivity: Map<number, PRActivity>
  ): Promise<string> {
    const client = await getBedrockClient();
    const prContext = this.buildPRContext(prs, diffs, recentActivity);
    const authors = new Set(prs.map((pr) => pr.author.login));

    const prompt = `You are analyzing open pull requests for a team activity report. Your job is to identify the distinct projects or efforts the team is working on, group PRs by those projects, and summarize team status.

Here are all open PRs with their diffs and recent discussion:
${prContext}

Analyze these PRs and generate a report structured as follows:

1. TEAM_SUMMARY: 2-3 sentences about what the team is collectively focused on right now. Mention the major efforts and overall momentum.

2. For each project/effort you identify, a PROJECT section. Group related PRs together under a project name that you infer from the code, branch names, labels, and PR titles. A "project" might be a feature area, a bug fix campaign, infrastructure work, etc. Include a RECENT_ACTIVITY line summarizing what happened in the last 24 hours for that project — discussions, decisions, reviews, progress. If there was no activity, say "No recent activity".

Format your response exactly like this:
TEAM_SUMMARY: <overall team summary>
PROJECT: <Project Name>
STATUS: <one-line status: active/in review/blocked/wrapping up>
SUMMARY: <what this effort is about and current state>
RECENT_ACTIVITY: <what happened in the last 24h for this project — discussions, reviews, decisions, progress>
PRS:
- PR #N by @author: <what this PR contributes to the effort>
PROJECT: <Another Project>
STATUS: <status>
SUMMARY: <summary>
RECENT_ACTIVITY: <last 24h activity for this project>
PRS:
- PR #N by @author: <contribution>

Rules:
- Every PR must appear under exactly one project
- If a PR doesn't fit any group, put it under a "Other" project
- Focus on WHAT and WHY, not implementation details
- Be concise`;

    const response = await client.invoke([{ role: "user", content: prompt }]);
    const content = response.content?.toString() || "";

    // Parse AI response into markdown report
    const date = getTodayDate();

    const teamSummaryMatch = content.match(
      /TEAM_SUMMARY:\s*([^\n]*(?:\n(?!PROJECT:).*)*)/i
    );

    let report = `# Team Activity Report - ${date}\n\n`;
    report += `## Team Summary\n\n`;
    report += `${teamSummaryMatch ? teamSummaryMatch[1].trim() : `${prs.length} open PRs across ${authors.size} team members.`}\n\n`;

    // Parse project sections (with RECENT_ACTIVITY)
    const projectRegex =
      /PROJECT:\s*(.+?)\nSTATUS:\s*(.+?)\nSUMMARY:\s*([^\n]*(?:\n(?!RECENT_ACTIVITY:|PRS:|PROJECT:).*)*)\nRECENT_ACTIVITY:\s*([^\n]*(?:\n(?!PRS:|PROJECT:).*)*)\nPRS:\s*\n((?:- PR #\d+.*(?:\n|$))*)/gi;
    let match;
    const mentionedPRs = new Set<number>();

    report += `## Projects & Efforts\n\n`;

    while ((match = projectRegex.exec(content)) !== null) {
      const projectName = match[1].trim();
      const status = match[2].trim();
      const summary = match[3].trim();
      const recentActivityText = match[4].trim();
      const prLines = match[5].trim();

      // Track which PRs were mentioned
      const prNums = prLines.match(/#(\d+)/g);
      const projectPRNumbers: number[] = [];
      if (prNums) {
        prNums.forEach((n) => {
          const num = parseInt(n.slice(1));
          mentionedPRs.add(num);
          projectPRNumbers.push(num);
        });
      }

      // Find last updated across this project's PRs
      const projectPRs = prs.filter((pr) =>
        projectPRNumbers.includes(pr.number)
      );
      const lastUpdated =
        projectPRs.length > 0 ? this.getLastUpdated(projectPRs) : "unknown";

      report += `### ${projectName}\n\n`;
      report += `**Status:** ${status} | **Last updated:** ${lastUpdated}\n\n`;
      report += `${summary}\n\n`;
      if (recentActivityText && recentActivityText.toLowerCase() !== "no recent activity") {
        report += `**Recent activity:** ${recentActivityText}\n\n`;
      }
      report += `${prLines}\n\n`;
    }

    // Add any PRs the AI missed under "Other"
    const missedPRs = prs.filter((pr) => !mentionedPRs.has(pr.number));
    if (missedPRs.length > 0) {
      const lastUpdated = this.getLastUpdated(missedPRs);
      report += `### Other\n\n`;
      report += `**Status:** active | **Last updated:** ${lastUpdated}\n\n`;
      // Add activity for missed PRs
      const activityLines = this.formatActivityForPRs(missedPRs, recentActivity);
      if (activityLines) {
        report += `**Recent activity:** ${activityLines}\n\n`;
      }
      for (const pr of missedPRs) {
        report += `- PR #${pr.number} by @${pr.author.login}: ${pr.title}\n`;
      }
      report += "\n";
    }

    report += `---\n_Generated by kunj team | ${prs.length} open PRs across ${authors.size} author(s)_\n`;

    return report;
  }

  private formatActivityForPRs(
    prList: PRData[],
    recentActivity: Map<number, PRActivity>
  ): string {
    const items: string[] = [];

    for (const pr of prList) {
      const activity = recentActivity.get(pr.number);
      if (!activity) continue;

      for (const review of activity.reviews) {
        items.push(
          `@${review.author.login} reviewed PR #${pr.number} (${review.state})${review.body ? `: ${review.body.substring(0, 100)}` : ""}`
        );
      }
      for (const comment of activity.comments) {
        items.push(
          `@${comment.author.login} on PR #${pr.number}: ${comment.body.substring(0, 100)}`
        );
      }
    }

    return items.length > 0 ? items.join("; ") : "";
  }

  private generateStructuredReport(
    prs: PRData[],
    diffs: Map<number, string>,
    recentActivity: Map<number, PRActivity>
  ): string {
    const date = getTodayDate();
    const authors = new Set(prs.map((pr) => pr.author.login));

    let report = `# Team Activity Report - ${date}\n\n`;
    report += `## Overview\n\n`;
    report += `${prs.length} open pull request(s) across ${authors.size} author(s).\n\n`;

    // Group by label as a rough proxy for project (best we can do without AI)
    const byLabel = new Map<string, PRData[]>();
    const unlabeled: PRData[] = [];

    for (const pr of prs) {
      if (pr.labels.length > 0) {
        const primaryLabel = pr.labels[0].name;
        if (!byLabel.has(primaryLabel)) {
          byLabel.set(primaryLabel, []);
        }
        byLabel.get(primaryLabel)!.push(pr);
      } else {
        unlabeled.push(pr);
      }
    }

    report += `## PRs by Area\n\n`;

    for (const [label, labelPRs] of byLabel) {
      const lastUpdated = this.getLastUpdated(labelPRs);
      report += `### ${label} (${labelPRs.length} PR${labelPRs.length !== 1 ? "s" : ""}) | Last updated: ${lastUpdated}\n\n`;
      const activityLines = this.formatActivityForPRs(labelPRs, recentActivity);
      if (activityLines) {
        report += `**Recent activity:** ${activityLines}\n\n`;
      }
      for (const pr of labelPRs) {
        const draft = pr.isDraft ? " `DRAFT`" : "";
        const diff = diffs.get(pr.number) || "";
        const fileCount = (diff.match(/^diff --git/gm) || []).length;
        report += `- **PR #${pr.number}**: ${pr.title}${draft} — @${pr.author.login}\n`;
        report += `  - Branch: \`${pr.headRefName}\` → \`${pr.baseRefName}\` | +${pr.additions} -${pr.deletions} across ${fileCount} file(s)\n`;
        report += `  - [View PR](${pr.url})\n`;
      }
      report += "\n";
    }

    if (unlabeled.length > 0) {
      const lastUpdated = this.getLastUpdated(unlabeled);
      report += `### Unlabeled (${unlabeled.length} PR${unlabeled.length !== 1 ? "s" : ""}) | Last updated: ${lastUpdated}\n\n`;
      const activityLines = this.formatActivityForPRs(unlabeled, recentActivity);
      if (activityLines) {
        report += `**Recent activity:** ${activityLines}\n\n`;
      }
      for (const pr of unlabeled) {
        const draft = pr.isDraft ? " `DRAFT`" : "";
        const diff = diffs.get(pr.number) || "";
        const fileCount = (diff.match(/^diff --git/gm) || []).length;
        report += `- **PR #${pr.number}**: ${pr.title}${draft} — @${pr.author.login}\n`;
        report += `  - Branch: \`${pr.headRefName}\` → \`${pr.baseRefName}\` | +${pr.additions} -${pr.deletions} across ${fileCount} file(s)\n`;
        report += `  - [View PR](${pr.url})\n`;
      }
      report += "\n";
    }

    report += `---\n_Generated by kunj team | ${date}_\n`;

    return report;
  }
}
