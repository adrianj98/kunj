// Data layer for web UI — calls src/lib/*.ts directly, no subprocess spawning

import { exec } from "child_process";
import { promisify } from "util";
import {
  getFileStatuses,
  getBranchesWithActivity,
  getCurrentBranch,
  getRecentCommitMessages,
  stageFiles,
  createCommit,
  getCommitsSinceBranch,
  pushBranch,
  checkGitRepo,
  getFileDiff,
  getFileDiffWithMain,
  revertFile,
  deleteFile,
} from "../lib/git";
import { loadBranchMetadata } from "../lib/metadata";
import { loadConfig, loadGlobalConfig, loadLocalConfig } from "../lib/config";
import { getAllStashesWithBranch } from "../lib/stash";
import {
  generateAICommitMessage,
  checkAWSCredentials,
} from "../lib/ai-commit";
import {
  analyzeTeamActivity,
  generateProjectReport,
  ParsedProject,
  ProjectReport,
  SlackMessageInput,
  JiraIssueInput,
} from "../lib/team-analysis";
import { getAllWorkLogs, readWorkLog, getTodayDate } from "../lib/work-log";
import { getKunjDir } from "../lib/config";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

// --- Dashboard data ---

export async function getBranchList(): Promise<any> {
  const config = loadConfig();
  const currentBranch = await getCurrentBranch();
  const branches = await getBranchesWithActivity(config.preferences.branchSort);
  const metadata = loadBranchMetadata();
  const allStashes = await getAllStashesWithBranch();

  return {
    branches: branches.map((branch) => {
      const meta = metadata.branches[branch.name] || {};
      const stashes = allStashes.get(branch.name) || [];
      return {
        name: branch.name,
        current: branch.name === currentBranch,
        lastActivity: branch.lastActivity || null,
        description: meta.description || null,
        tags: meta.tags || [],
        jiraIssueKey: meta.jiraIssueKey || null,
        jiraIssueStatus: meta.jiraIssueStatus || null,
        stashCount: stashes.length,
      };
    }),
  };
}

export async function getOpenPRs(): Promise<any> {
  try {
    const { stdout } = await execAsync(
      `gh pr list --json number,title,author,isDraft,headRefName,baseRefName,url,additions,deletions,createdAt,updatedAt,reviews,statusCheckRollup --limit 50`
    );
    const prs = JSON.parse(stdout || "[]");
    return {
      pullRequests: prs.map((pr: any) => {
        const approvals =
          pr.reviews?.filter((r: any) => r.state === "APPROVED").length || 0;
        const checks = pr.statusCheckRollup || [];
        const failedChecks = checks.filter(
          (c: any) => c.conclusion === "FAILURE"
        ).length;
        const pendingChecks = checks.filter(
          (c: any) =>
            c.status === "IN_PROGRESS" ||
            c.status === "QUEUED" ||
            c.status === "PENDING"
        ).length;
        return {
          number: pr.number,
          title: pr.title,
          author: pr.author.login,
          branch: pr.headRefName,
          isDraft: pr.isDraft,
          url: pr.url,
          additions: pr.additions,
          deletions: pr.deletions,
          approvals,
          checksStatus:
            failedChecks > 0
              ? "failure"
              : pendingChecks > 0
                ? "pending"
                : checks.length > 0
                  ? "success"
                  : "none",
        };
      }),
    };
  } catch {
    return { pullRequests: [], error: "GitHub CLI not available" };
  }
}

export async function getFileChanges(): Promise<any> {
  const files = await getFileStatuses();
  return {
    files: files.map((f) => ({
      path: f.path,
      status: f.status,
      staged: f.staged,
      additions: f.additions || 0,
      deletions: f.deletions || 0,
    })),
  };
}

export async function getCommitGraph(limit = 20): Promise<any> {
  try {
    const { stdout } = await execAsync(
      `git log --format=%H%x00%an%x00%aI%x00%D%x00%s -n ${limit}`
    );
    const commits = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => {
        const [hash, author, date, refs, message] = line.split("\x00");
        return { hash, author, date, refs: refs || null, message };
      });
    return { commits };
  } catch {
    return { commits: [] };
  }
}

export async function getStashList(): Promise<any> {
  try {
    const { stdout } = await execAsync("git stash list");
    if (!stdout.trim()) return { stashes: [] };
    const stashes = stdout
      .trim()
      .split("\n")
      .map((line: string) => {
        const match = line.match(/^(stash@\{(\d+)\}):\s+(.+)$/);
        if (match)
          return {
            ref: match[1],
            index: parseInt(match[2]),
            description: match[3],
          };
        return { ref: line, index: -1, description: line };
      });
    return { stashes };
  } catch {
    return { stashes: [] };
  }
}

export async function getWorkLogs(): Promise<any> {
  return { logs: getAllWorkLogs() };
}

export async function getWorkLog(date: string): Promise<any> {
  const content = readWorkLog(date);
  return { date, content };
}

export function getTeamData(): any {
  const teamDir = path.join(getKunjDir(), "team");
  const date = getTodayDate();

  // Read report
  let report = "";
  const reportPath = path.join(teamDir, `report-${date}.md`);
  if (fs.existsSync(reportPath)) {
    report = fs.readFileSync(reportPath, "utf8");
  }

  // Read cached PR data + AI summaries
  let cache: any = { prs: {} };
  const cachePath = path.join(teamDir, "cache.json");
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {}
  }

  // Parse summaries from cache
  const summaries: any[] = [];
  for (const [num, entry] of Object.entries(cache.prs || {})) {
    const e = entry as any;
    if (e.aiSummary) {
      try {
        summaries.push(JSON.parse(e.aiSummary));
      } catch {}
    }
  }

  // Read Jira data
  let jiraIssues: any[] = [];
  const jiraPath = path.join(teamDir, "jira", `issues-${date}.json`);
  if (fs.existsSync(jiraPath)) {
    try {
      const jiraData = JSON.parse(fs.readFileSync(jiraPath, "utf8"));
      jiraIssues = jiraData.issues || [];
    } catch {}
  }

  // Group Jira by status
  const jiraByStatus: Record<string, any[]> = {};
  for (const issue of jiraIssues) {
    const status = issue.status || "Unknown";
    if (!jiraByStatus[status]) jiraByStatus[status] = [];
    jiraByStatus[status].push(issue);
  }

  // Read Slack data (date file first, fall back to cache)
  let slackMessages: any[] = [];
  const slackPath = path.join(teamDir, "slack", `messages-${date}.json`);
  if (fs.existsSync(slackPath)) {
    try {
      const slackData = JSON.parse(fs.readFileSync(slackPath, "utf8"));
      slackMessages = slackData.messages || [];
    } catch {}
  }
  if (slackMessages.length === 0 && cache.cachedSlackMessages?.length > 0) {
    slackMessages = cache.cachedSlackMessages;
  }

  // Group summaries by area (as project proxy)
  const projectMap: Record<string, any[]> = {};
  for (const s of summaries) {
    const area = s.area || "General";
    if (!projectMap[area]) projectMap[area] = [];
    projectMap[area].push(s);
  }

  return {
    report,
    reportPath: fs.existsSync(reportPath) ? reportPath : null,
    summaries,
    projects: projectMap,
    jiraIssues,
    jiraByStatus,
    slackMessages,
    lastFetch: cache.lastActivityFetch || null,
    prCount: Object.keys(cache.prs || {}).length,
  };
}

export interface ProjectData extends ParsedProject {
  lastUpdated?: string;
}

export interface TeamAnalysis {
  teamSummary: string[];
  projects: ProjectData[];
  jiraByStatus: Record<string, any[]>;
  slackMessages: any[];
  prCount: number;
  lastFetch: string | null;
  analyzedAt?: string;
}

import jdenticon from "jdenticon";

// Generate a project identicon SVG from name
export function projectIcon(name: string, size = 32): string {
  // Configure jdenticon for geometric shapes (no people/animals)
  jdenticon.configure({
    hues: [nameToHue(name)],
    lightness: {
      color: [0.4, 0.8],
      grayscale: [0.3, 0.9],
    },
    saturation: {
      color: 0.5,
      grayscale: 0.0,
    },
    backColor: "#00000000",
  });
  return jdenticon.toSvg(name, size);
}

function nameToHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return (Math.abs(hash) % 360) / 360;
}

// Generate a consistent color hue from a name string
export function nameToColor(name: string): string {
  const hue = nameToHue(name) * 360;
  return `hsl(${hue}, 65%, 55%)`;
}

// GitHub avatar URL from login
export function githubAvatar(login: string, size = 40): string {
  return `https://avatars.githubusercontent.com/${login}?s=${size}`;
}

export async function generateTeamAnalysis(): Promise<TeamAnalysis> {
  const teamDir = path.join(getKunjDir(), "team");
  const date = getTodayDate();

  // Read cached PR summaries
  const cachePath = path.join(teamDir, "cache.json");
  let cache: any = { prs: {} };
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {}
  }

  const summaries: any[] = [];
  for (const [, entry] of Object.entries(cache.prs || {})) {
    const e = entry as any;
    if (e.aiSummary) {
      try { summaries.push(JSON.parse(e.aiSummary)); } catch {}
    }
  }

  // Read Jira data
  let jiraIssues: any[] = [];
  const jiraPath = path.join(teamDir, "jira", `issues-${date}.json`);
  if (fs.existsSync(jiraPath)) {
    try {
      jiraIssues = JSON.parse(fs.readFileSync(jiraPath, "utf8")).issues || [];
    } catch {}
  }

  // Group Jira by status
  const jiraByStatus: Record<string, any[]> = {};
  for (const issue of jiraIssues) {
    const status = issue.status || "Unknown";
    if (!jiraByStatus[status]) jiraByStatus[status] = [];
    jiraByStatus[status].push(issue);
  }

  // Read Slack data (date file first, fall back to cache)
  let slackMessages: any[] = [];
  const slackPath2 = path.join(teamDir, "slack", `messages-${date}.json`);
  if (fs.existsSync(slackPath2)) {
    try {
      slackMessages = JSON.parse(fs.readFileSync(slackPath2, "utf8")).messages || [];
    } catch {}
  }
  if (slackMessages.length === 0 && cache.cachedSlackMessages?.length > 0) {
    slackMessages = cache.cachedSlackMessages;
  }

  // If no data at all, return empty
  if (summaries.length === 0 && jiraIssues.length === 0 && slackMessages.length === 0) {
    return {
      teamSummary: [],
      projects: [],
      jiraByStatus,
      slackMessages: [],
      prCount: 0,
      lastFetch: cache.lastActivityFetch || null,
    };
  }

  // Check if AI is available
  const hasAI = await checkAWSCredentials();
  if (!hasAI) {
    // No AI — group by area from summaries as fallback
    return buildFallbackAnalysis(summaries, jiraIssues, jiraByStatus, slackMessages, cache);
  }

  const result = await analyzeTeamActivity(summaries, jiraIssues, slackMessages);

  const teamSummary = result.teamSummaryBullets;
  const projects: ProjectData[] = result.projects.map(p => ({ ...p }));

  // Compute lastUpdated per project from PR and Jira timestamps
  for (const project of projects) {
    const timestamps: string[] = [];
    for (const pr of project.prs) {
      const cEntry = cache.prs[pr.number];
      if (cEntry?.updatedAt) {
        timestamps.push(cEntry.updatedAt);
        (pr as any).updatedAt = cEntry.updatedAt;
      }
    }
    for (const j of project.jiraTickets) {
      const jiraIssue = jiraIssues.find((i: any) => i.key === j.key);
      if (jiraIssue?.updated) {
        timestamps.push(jiraIssue.updated);
        (j as any).updated = jiraIssue.updated;
      }
    }
    if (timestamps.length > 0) {
      project.lastUpdated = timestamps.sort().reverse()[0];
    }
  }

  // Save the analysis to disk for caching
  const analysisPath = path.join(teamDir, `analysis-${date}.json`);
  const analysis: TeamAnalysis = {
    teamSummary,
    projects,
    jiraByStatus,
    slackMessages,
    prCount: Object.keys(cache.prs || {}).length,
    lastFetch: cache.lastActivityFetch || null,
    analyzedAt: new Date().toISOString(),
  };
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), "utf8");

  return analysis;
}

function buildFallbackAnalysis(
  summaries: any[],
  jiraIssues: any[],
  jiraByStatus: Record<string, any[]>,
  slackMessages: any[],
  cache: any
): TeamAnalysis {
  // Group by area as a rough project proxy
  const byArea: Record<string, any[]> = {};
  for (const s of summaries) {
    const area = s.area || "General";
    if (!byArea[area]) byArea[area] = [];
    byArea[area].push(s);
  }

  const projects: ProjectData[] = Object.entries(byArea).map(([area, prs]) => {
    const authors = [...new Set(prs.map((p: any) => p.author))];
    return {
      name: area,
      status: "active",
      lead: authors[0] || "",
      team: authors.slice(1),
      summary: prs.map((p: any) => p.summary).join(". "),
      recentActivity: "",
      prLines: "",
      jiraLines: "",
      slackLines: "",
      prNumbers: prs.map((p: any) => p.prNumber),
      prs: prs.map((p: any) => ({
        number: p.prNumber,
        author: p.author,
        description: p.title,
      })),
      jiraTickets: [],
      slackHighlights: [],
    };
  });

  return {
    teamSummary: summaries.map((s: any) => `@${s.author}: ${s.title}`),
    projects,
    jiraByStatus,
    slackMessages,
    prCount: Object.keys(cache.prs || {}).length,
    lastFetch: cache.lastActivityFetch || null,
  };
}

// Load cached analysis from disk (fast, no AI call)
export function getCachedTeamAnalysis(): TeamAnalysis | null {
  const teamDir = path.join(getKunjDir(), "team");
  const date = getTodayDate();
  const analysisPath = path.join(teamDir, `analysis-${date}.json`);
  if (fs.existsSync(analysisPath)) {
    try {
      return JSON.parse(fs.readFileSync(analysisPath, "utf8"));
    } catch {}
  }
  return null;
}

export function getCachedProjectReport(projectName: string): ProjectReport | null {
  const teamDir = path.join(getKunjDir(), "team");
  const date = getTodayDate();
  const slug = projectName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const reportPath = path.join(teamDir, "project-reports", `${slug}-${date}.json`);
  if (fs.existsSync(reportPath)) {
    try {
      return JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch {}
  }
  return null;
}

export async function generateProjectDetailReport(projectName: string): Promise<ProjectReport> {
  const teamDir = path.join(getKunjDir(), "team");
  const date = getTodayDate();

  // Load analysis to find the project
  const analysis = getCachedTeamAnalysis();
  if (!analysis) throw new Error("No team analysis available. Run 'kunj team' first.");

  const project = analysis.projects.find((p: any) => p.name === projectName);
  if (!project) throw new Error(`Project "${projectName}" not found in analysis.`);

  // Load diffs from disk
  const diffsDir = path.join(teamDir, "diffs");
  const cachePath = path.join(teamDir, "cache.json");
  let cache: any = { prs: {} };
  if (fs.existsSync(cachePath)) {
    try { cache = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch {}
  }

  const diffs = new Map<number, string>();
  for (const pr of project.prs) {
    const cacheEntry = cache.prs[pr.number];
    if (cacheEntry?.diffFile) {
      const diffPath = path.join(diffsDir, cacheEntry.diffFile);
      if (fs.existsSync(diffPath)) {
        diffs.set(pr.number, fs.readFileSync(diffPath, "utf8"));
      }
    }
  }

  // Load Slack messages
  let slackMessages: SlackMessageInput[] = [];
  const slackPath = path.join(teamDir, "slack", `messages-${date}.json`);
  if (fs.existsSync(slackPath)) {
    try {
      slackMessages = JSON.parse(fs.readFileSync(slackPath, "utf8")).messages || [];
    } catch {}
  }

  // Load Jira issues for this project
  let allJiraIssues: JiraIssueInput[] = [];
  const jiraPath = path.join(teamDir, "jira", `issues-${date}.json`);
  if (fs.existsSync(jiraPath)) {
    try {
      allJiraIssues = JSON.parse(fs.readFileSync(jiraPath, "utf8")).issues || [];
    } catch {}
  }
  // Filter to this project's tickets
  const projectJiraKeys = new Set(project.jiraTickets.map((j: any) => j.key));
  const projectJira = allJiraIssues.filter(i => projectJiraKeys.has(i.key));

  const report = await generateProjectReport(project, diffs, slackMessages, projectJira);

  // Save to disk
  const reportsDir = path.join(teamDir, "project-reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const slug = projectName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const reportPath = path.join(reportsDir, `${slug}-${date}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  return report;
}

export { ProjectReport };

export function getConfiguration(): any {
  return {
    global: loadGlobalConfig(),
    local: loadLocalConfig(),
    merged: loadConfig(),
  };
}

// --- Action endpoints ---

export async function doStageFiles(files: string[]): Promise<any> {
  const result = await stageFiles(files);
  return { success: result.success, message: result.message };
}

export async function doCommit(message: string): Promise<any> {
  const result = await createCommit(message);
  return { success: result.success, message: result.message };
}

export async function doGenerateAIMessage(): Promise<any> {
  const hasCredentials = await checkAWSCredentials();
  if (!hasCredentials) {
    return { error: "AWS credentials not configured" };
  }
  const branch = await getCurrentBranch();
  const files = await getFileStatuses();
  const staged = files.filter((f) => f.staged).map((f) => f.path);
  if (staged.length === 0) {
    return { error: "No staged files" };
  }
  const branchCommits = await getCommitsSinceBranch();
  const result = await generateAICommitMessage(
    staged,
    branchCommits,
    branch
  );
  return {
    message: result.fullMessage || "",
    type: result.type,
    branchDescription: result.branchDescription || null,
  };
}

export async function doGetDiff(
  filePath: string,
  withMain?: boolean
): Promise<any> {
  const diff = withMain
    ? await getFileDiffWithMain(filePath)
    : await getFileDiff(filePath, false);
  return { filePath, diff };
}

export async function doRevertFile(filePath: string): Promise<any> {
  const result = await revertFile(filePath);
  return { success: result.success, message: result.message };
}

export async function doDeleteFile(filePath: string): Promise<any> {
  const result = await deleteFile(filePath);
  return { success: result.success, message: result.message };
}

export async function getRecentCommits(limit = 5): Promise<any> {
  const messages = await getRecentCommitMessages(limit);
  const aiAvailable = await checkAWSCredentials();
  return { messages, aiAvailable };
}

export async function doPush(): Promise<any> {
  const branch = await getCurrentBranch();
  let hasUpstream = false;
  try {
    const { stdout } = await execAsync(
      `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`
    );
    hasUpstream = !!stdout.trim();
  } catch {
    hasUpstream = false;
  }
  const result = await pushBranch(branch, !hasUpstream);
  return { success: result.success, message: result.message };
}
