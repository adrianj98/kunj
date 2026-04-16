// Team command - Fetch open PRs, save diffs, and generate team activity report

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { BaseCommand } from "../lib/command";
import { checkGitRepo } from "../lib/git";
import { getKunjDir, loadConfig } from "../lib/config";
import {
  checkAWSCredentials,
  getBedrockClient,
  getDefaultModelId,
  getAWSRegion,
} from "../lib/ai-commit";
import { getTodayDate } from "../lib/work-log";
import { searchIssues, checkJiraCredentials } from "../lib/jira";

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
  aiSummary?: string;
}

interface PRSummary {
  prNumber: number;
  author: string;
  title: string;
  summary: string;
  area: string;
  recentDiscussion: string;
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

interface JiraIssueData {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string;
  updated: string;
}

export class TeamCommand extends BaseCommand {
  constructor() {
    super({
      name: "team",
      description:
        "Fetch open PRs, save diffs, and generate a team activity report",
      ui: {
        category: 'dashboard',
        widget: 'markdown',
        label: 'Team Report',
        icon: 'users',
        defaultArgs: ['--no-ai'],
        dataKey: 'report',
        order: 5,
      },
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

    // Fetch Jira activity (recently updated issues)
    const config = loadConfig();
    let jiraIssues: JiraIssueData[] = [];

    if (config.jira?.enabled) {
      console.log(chalk.blue("\nFetching Jira activity..."));
      try {
        const hasJiraCreds = await checkJiraCredentials();
        if (hasJiraCreds) {
          jiraIssues = await this.fetchJiraActivity(config.jira.projectKey);
          const jiraDir = path.join(teamDir, "jira");
          fs.mkdirSync(jiraDir, { recursive: true });
          // Save Jira activity to disk
          const jiraFile = path.join(jiraDir, `issues-${getTodayDate()}.json`);
          fs.writeFileSync(
            jiraFile,
            JSON.stringify(
              { fetchedAt: now, issues: jiraIssues },
              null,
              2
            ),
            "utf8"
          );
          console.log(
            chalk.green(
              `  Found ${jiraIssues.length} recently updated issue(s)`
            )
          );
        } else {
          console.log(
            chalk.yellow("  Jira credentials invalid, skipping.")
          );
        }
      } catch (error: any) {
        console.log(
          chalk.yellow(`  Could not fetch Jira activity: ${error.message}`)
        );
      }
    }

    // Generate report
    const useAI = options.ai !== false && config.ai?.enabled;
    let reportContent: string;
    let summaries: PRSummary[] | null = null;

    if (useAI) {
      const hasCredentials = await checkAWSCredentials();
      if (hasCredentials) {
        try {
          // Map phase: summarize each PR individually
          console.log(chalk.blue("\nSummarizing PRs..."));
          summaries = await this.mapSummarizePRs(
            prs,
            diffs,
            recentActivity,
            newCache,
            !!options.force
          );

          // Save summaries to disk
          const summariesDir = path.join(teamDir, "summaries");
          fs.mkdirSync(summariesDir, { recursive: true });
          const summariesFile = path.join(
            summariesDir,
            `summaries-${getTodayDate()}.json`
          );
          fs.writeFileSync(
            summariesFile,
            JSON.stringify(
              { fetchedAt: new Date().toISOString(), summaries },
              null,
              2
            ),
            "utf8"
          );

          // Reduce phase: group and synthesize
          console.log(chalk.blue("\nGenerating team report..."));
          reportContent = await this.reduceGenerateReport(
            prs,
            summaries,
            recentActivity,
            jiraIssues
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
            recentActivity,
            jiraIssues
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
          recentActivity,
          jiraIssues
        );
      }
    } else {
      console.log(chalk.blue("\nGenerating team report..."));
      reportContent = this.generateStructuredReport(
        prs,
        diffs,
        recentActivity,
        jiraIssues
      );
    }

    // Save updated cache (after AI map phase may have added summaries)
    fs.writeFileSync(cachePath, JSON.stringify(newCache, null, 2), "utf8");

    const authors = new Set(prs.map((pr) => pr.author.login));

    // Save report
    const date = getTodayDate();
    const reportPath = path.join(teamDir, `report-${date}.md`);
    fs.writeFileSync(reportPath, reportContent, "utf8");

    // JSON output
    if (this.jsonMode) {
      const activity: Record<string, PRActivity> = {};
      for (const [num, act] of recentActivity) {
        activity[num] = act;
      }
      this.outputJSON({
        pullRequests: prs,
        summaries: typeof summaries !== "undefined" ? summaries : null,
        jiraIssues,
        activity,
        report: reportContent,
        reportPath,
      });
      return;
    }

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

  private async fetchJiraActivity(
    projectKey?: string
  ): Promise<JiraIssueData[]> {
    // Fetch issues updated in the last 24h
    const jql = projectKey
      ? `project = ${projectKey} AND updated >= -24h ORDER BY updated DESC`
      : `updated >= -24h ORDER BY updated DESC`;

    const issues = await searchIssues(jql, 50);

    return issues.map((issue: any) => ({
      key: issue.key,
      summary: issue.fields?.summary || "",
      status: issue.fields?.status?.name || "Unknown",
      issueType: issue.fields?.issuetype?.name || "Unknown",
      priority: issue.fields?.priority?.name || "None",
      assignee: issue.fields?.assignee?.displayName || "Unassigned",
      updated: issue.fields?.updated || "",
    }));
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

  private async getSmallClient(): Promise<any> {
    const { ChatBedrockConverse } = require("@langchain/aws");
    const { defaultProvider } = require("@aws-sdk/credential-provider-node");
    const config = loadConfig();
    // Use modelSmall if set, otherwise fall back to the same model selection as everything else
    const modelId =
      config.ai?.modelSmall ||
      process.env.BEDROCK_MODEL_SMALL ||
      getDefaultModelId();
    const region = await getAWSRegion();

    return new ChatBedrockConverse({
      model: modelId,
      region,
      credentials: defaultProvider(),
      temperature: 0.3,
      maxTokens: 500,
    });
  }

  private buildMapPrompt(
    pr: PRData,
    diff: string,
    activity: PRActivity | undefined
  ): string {
    const truncatedDiff =
      diff.length > 50000
        ? diff.substring(0, 50000) + "\n...[truncated]"
        : diff;

    let activityContext = "";
    if (activity) {
      for (const review of activity.reviews) {
        activityContext += `\nReview by @${review.author.login} (${review.state}): ${review.body.substring(0, 300)}`;
      }
      for (const comment of activity.comments) {
        activityContext += `\nComment by @${comment.author.login}: ${comment.body.substring(0, 300)}`;
      }
    }

    const labels = pr.labels.map((l) => l.name).join(", ");
    return `Summarize this pull request concisely.

PR #${pr.number}: ${pr.title}
Author: @${pr.author.login}
Branch: ${pr.headRefName} → ${pr.baseRefName}
${pr.isDraft ? "DRAFT " : ""}+${pr.additions} -${pr.deletions}${labels ? ` | Labels: ${labels}` : ""}
${activityContext ? `\nRecent discussion:${activityContext}` : ""}

Diff:
\`\`\`
${truncatedDiff}
\`\`\`

Respond in exactly this format:
AREA: <feature area or component this PR relates to, 2-5 words>
SUMMARY: <what this PR does and why, 2-3 sentences>
DISCUSSION: <summary of recent discussion if any, or "None">`;
  }

  private parseSummaryResponse(
    pr: PRData,
    content: string
  ): PRSummary {
    const areaMatch = content.match(/AREA:\s*(.+)/i);
    const summaryMatch = content.match(
      /SUMMARY:\s*([^\n]*(?:\n(?!DISCUSSION:).*)*)/i
    );
    const discussionMatch = content.match(/DISCUSSION:\s*(.*)/i);

    return {
      prNumber: pr.number,
      author: pr.author.login,
      title: pr.title,
      area: areaMatch ? areaMatch[1].trim() : "General",
      summary: summaryMatch ? summaryMatch[1].trim() : pr.title,
      recentDiscussion: discussionMatch
        ? discussionMatch[1].trim()
        : "None",
    };
  }

  // Map phase: summarize each PR individually with its full diff (parallel)
  private async mapSummarizePRs(
    prs: PRData[],
    diffs: Map<number, string>,
    recentActivity: Map<number, PRActivity>,
    cache: PRCache,
    force: boolean
  ): Promise<PRSummary[]> {
    const CONCURRENCY = 5;
    const results: Map<number, PRSummary> = new Map();
    let cached = 0;

    // Separate cached vs needs-summarizing
    const toSummarize: PRData[] = [];

    for (const pr of prs) {
      const cacheEntry = cache.prs[pr.number];
      if (
        !force &&
        cacheEntry?.aiSummary &&
        cacheEntry.updatedAt === pr.updatedAt
      ) {
        results.set(pr.number, JSON.parse(cacheEntry.aiSummary));
        cached++;
        console.log(chalk.gray(`  PR #${pr.number} — cached`));
      } else {
        toSummarize.push(pr);
      }
    }

    if (toSummarize.length > 0) {
      console.log(
        chalk.gray(
          `  Summarizing ${toSummarize.length} PR(s) in parallel (concurrency: ${CONCURRENCY})...`
        )
      );

      const client = await this.getSmallClient();

      // Process in batches
      for (let i = 0; i < toSummarize.length; i += CONCURRENCY) {
        const batch = toSummarize.slice(i, i + CONCURRENCY);
        const batchNum = Math.floor(i / CONCURRENCY) + 1;
        const totalBatches = Math.ceil(toSummarize.length / CONCURRENCY);
        console.log(
          chalk.gray(
            `  Batch ${batchNum}/${totalBatches}: PRs ${batch.map((p) => `#${p.number}`).join(", ")}`
          )
        );

        const batchResults = await Promise.allSettled(
          batch.map(async (pr) => {
            const diff = diffs.get(pr.number) || "";
            const activity = recentActivity.get(pr.number);
            const prompt = this.buildMapPrompt(pr, diff, activity);

            const response = await client.invoke([
              { role: "user", content: prompt },
            ]);
            const content = response.content?.toString() || "";
            return { pr, summary: this.parseSummaryResponse(pr, content) };
          })
        );

        for (const result of batchResults) {
          if (result.status === "fulfilled") {
            const { pr, summary } = result.value;
            results.set(pr.number, summary);
            if (cache.prs[pr.number]) {
              cache.prs[pr.number].aiSummary = JSON.stringify(summary);
            }
          } else {
            // Find which PR failed — use the batch order
            const idx = batchResults.indexOf(result);
            const pr = batch[idx];
            const fallback: PRSummary = {
              prNumber: pr.number,
              author: pr.author.login,
              title: pr.title,
              area: "General",
              summary: pr.title,
              recentDiscussion: "None",
            };
            results.set(pr.number, fallback);
            console.log(
              chalk.yellow(
                `    Warning: PR #${pr.number} failed: ${result.reason?.message || "unknown error"}`
              )
            );
          }
        }
      }
    }

    console.log(
      chalk.gray(
        `  ${prs.length} PRs processed (${cached} cached, ${toSummarize.length} summarized)`
      )
    );

    // Return in original PR order
    return prs.map((pr) => results.get(pr.number)!);
  }

  // Reduce phase: group summaries into projects and generate final report
  private async reduceGenerateReport(
    prs: PRData[],
    summaries: PRSummary[],
    recentActivity: Map<number, PRActivity>,
    jiraIssues: JiraIssueData[]
  ): Promise<string> {
    const client = await getBedrockClient();
    const authors = new Set(prs.map((pr) => pr.author.login));

    // Build compact context from summaries (not raw diffs)
    let prContext = "";
    for (const s of summaries) {
      prContext += `- PR #${s.prNumber} by @${s.author}: ${s.title}\n  Area: ${s.area}\n  Summary: ${s.summary}\n  Discussion: ${s.recentDiscussion}\n`;
    }

    let jiraContext = "";
    if (jiraIssues.length > 0) {
      jiraContext = `\nJira Issues (updated in last 24h):\n`;
      for (const issue of jiraIssues) {
        jiraContext += `- ${issue.key}: ${issue.summary} [${issue.status}] (${issue.issueType}) — ${issue.assignee}\n`;
      }
    }

    const contextSize = prContext.length + jiraContext.length;
    console.log(
      chalk.gray(
        `  Context: ${contextSize.toLocaleString()} chars (${summaries.length} PR summaries${jiraIssues.length > 0 ? ` + ${jiraIssues.length} Jira issues` : ""})`
      )
    );

    const prompt = `You are analyzing summarized pull requests and Jira issues for a team activity report. Group them by project/effort and synthesize.

PR Summaries:
${prContext}${jiraContext}

Generate a report:

1. TEAM_SUMMARY: Quick bullet points of what each person is doing. One bullet per person, format: "- @username: what they're working on". Keep each bullet to one line.

2. For each project/effort, a PROJECT section. Identify who has the most PRs/commits in this area as LEAD. List all other contributors as TEAM. Include recent activity per project.

Format:
TEAM_SUMMARY:
- @username: working on X and Y
- @username2: fixing Z, reviewing A
PROJECT: <Project Name>
STATUS: <active/in review/blocked/wrapping up>
LEAD: @username
TEAM: @user1, @user2
SUMMARY: <what this effort is about>
RECENT_ACTIVITY: <last 24h discussions, decisions, progress>
PRS:
- PR #N by @author: <contribution>
JIRA:
- TICKET-123: <summary> [status] — assignee

Rules:
- Every PR must appear under exactly one project
- LEAD is the person with the most activity/PRs in that project
- TEAM lists all other contributors (can be empty if solo)
- Group Jira issues with related PRs
- JIRA section can be omitted if none relate
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

    // Parse project sections
    const mentionedPRs = new Set<number>();
    const projectBlocks = content
      .split(/(?=^PROJECT:)/im)
      .filter((b: string) => b.startsWith("PROJECT:"));

    report += `## Projects & Efforts\n\n`;

    for (const block of projectBlocks) {
      const nameMatch = block.match(/^PROJECT:\s*(.+)/i);
      const statusMatch = block.match(/^STATUS:\s*(.+)/im);
      const leadMatch = block.match(/^LEAD:\s*(.+)/im);
      const teamMatch = block.match(/^TEAM:\s*(.+)/im);
      const summaryMatch = block.match(
        /^SUMMARY:\s*([^\n]*(?:\n(?!RECENT_ACTIVITY:|PRS:|JIRA:|PROJECT:|LEAD:|TEAM:).*)*)/im
      );
      const activityMatch = block.match(
        /^RECENT_ACTIVITY:\s*([^\n]*(?:\n(?!PRS:|JIRA:|PROJECT:).*)*)/im
      );
      const prsMatch = block.match(/^PRS:\s*\n((?:- .*(?:\n|$))*)/im);
      const jiraMatch = block.match(/^JIRA:\s*\n((?:- .*(?:\n|$))*)/im);

      const projectName = nameMatch ? nameMatch[1].trim() : "Unknown";
      const status = statusMatch ? statusMatch[1].trim() : "active";
      const lead = leadMatch ? leadMatch[1].trim() : "";
      const team = teamMatch ? teamMatch[1].trim() : "";
      const summary = summaryMatch ? summaryMatch[1].trim() : "";
      const recentActivityText = activityMatch
        ? activityMatch[1].trim()
        : "";
      const prLines = prsMatch ? prsMatch[1].trim() : "";
      const jiraLines = jiraMatch ? jiraMatch[1].trim() : "";

      // Track mentioned PRs
      const prNums = prLines.match(/#(\d+)/g);
      const projectPRNumbers: number[] = [];
      if (prNums) {
        prNums.forEach((n: string) => {
          const num = parseInt(n.slice(1));
          mentionedPRs.add(num);
          projectPRNumbers.push(num);
        });
      }

      const projectPRs = prs.filter((pr) =>
        projectPRNumbers.includes(pr.number)
      );
      const lastUpdated =
        projectPRs.length > 0 ? this.getLastUpdated(projectPRs) : "unknown";

      report += `### ${projectName}\n\n`;
      report += `**Status:** ${status} | **Last updated:** ${lastUpdated}\n\n`;
      if (lead) {
        report += `**Lead:** ${lead}`;
        if (team) {
          report += ` | **Team:** ${team}`;
        }
        report += `\n\n`;
      }
      report += `${summary}\n\n`;
      if (
        recentActivityText &&
        recentActivityText.toLowerCase() !== "no recent activity"
      ) {
        report += `**Recent activity:** ${recentActivityText}\n\n`;
      }
      if (prLines) {
        report += `**Pull Requests:**\n${prLines}\n\n`;
      }
      if (jiraLines) {
        report += `**Jira Tickets:**\n${jiraLines}\n\n`;
      }
    }

    // Add any missed PRs
    const missedPRs = prs.filter((pr) => !mentionedPRs.has(pr.number));
    if (missedPRs.length > 0) {
      const lastUpdated = this.getLastUpdated(missedPRs);
      report += `### Other\n\n`;
      report += `**Status:** active | **Last updated:** ${lastUpdated}\n\n`;
      const activityLines = this.formatActivityForPRs(
        missedPRs,
        recentActivity
      );
      if (activityLines) {
        report += `**Recent activity:** ${activityLines}\n\n`;
      }
      report += `**Pull Requests:**\n`;
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
    recentActivity: Map<number, PRActivity>,
    jiraIssues: JiraIssueData[]
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

    // Jira activity section
    if (jiraIssues.length > 0) {
      report += `## Jira Activity (last 24h)\n\n`;

      // Group by status
      const byStatus = new Map<string, JiraIssueData[]>();
      for (const issue of jiraIssues) {
        if (!byStatus.has(issue.status)) {
          byStatus.set(issue.status, []);
        }
        byStatus.get(issue.status)!.push(issue);
      }

      for (const [status, issues] of byStatus) {
        report += `### ${status} (${issues.length})\n\n`;
        for (const issue of issues) {
          report += `- **${issue.key}**: ${issue.summary} (${issue.issueType}, ${issue.priority}) — ${issue.assignee}\n`;
        }
        report += "\n";
      }
    }

    report += `---\n_Generated by kunj team | ${date}_\n`;

    return report;
  }
}
