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
import { getAllWorkLogs, readWorkLog } from "../lib/work-log";

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
