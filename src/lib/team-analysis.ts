// Shared team analysis logic — AI prompt, invocation, and response parsing
// Used by both CLI (team command) and UI (data layer)

import { getBedrockClient } from "./ai-commit";

// --- Input types ---

export interface PRSummaryInput {
  prNumber: number;
  author: string;
  title: string;
  area: string;
  summary: string;
  recentDiscussion: string;
}

export interface JiraIssueInput {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  assignee: string;
}

export interface SlackMessageInput {
  channelId: string;
  channelName: string;
  user: string;
  text: string;
  timestamp: string;
  threadReplyCount?: number;
}

// --- Output types ---

export interface ParsedProject {
  name: string;
  status: string;
  lead: string;
  team: string[];
  summary: string;
  recentActivity: string;
  prLines: string;
  jiraLines: string;
  slackLines: string;
  prNumbers: number[];
  prs: Array<{ number: number; author: string; description: string }>;
  jiraTickets: Array<{ key: string; summary: string; status: string; assignee: string }>;
  slackHighlights: string[];
}

export interface TeamAnalysisResult {
  teamSummary: string;
  teamSummaryBullets: string[];
  projects: ParsedProject[];
  mentionedPRs: Set<number>;
  rawContent: string;
}

// --- Core functions ---

export function buildTeamContext(
  summaries: PRSummaryInput[],
  jiraIssues: JiraIssueInput[],
  slackMessages: SlackMessageInput[]
): { prContext: string; jiraContext: string; slackContext: string } {
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

  let slackContext = "";
  if (slackMessages.length > 0) {
    slackContext = `\nSlack Activity (last 24h):\n`;
    const byChannel = new Map<string, SlackMessageInput[]>();
    for (const msg of slackMessages) {
      if (!byChannel.has(msg.channelName)) byChannel.set(msg.channelName, []);
      byChannel.get(msg.channelName)!.push(msg);
    }
    for (const [channel, msgs] of byChannel) {
      slackContext += `#${channel}:\n`;
      for (const msg of msgs) {
        const text = msg.text.length > 200 ? msg.text.substring(0, 200) + "..." : msg.text;
        const thread = msg.threadReplyCount ? ` (${msg.threadReplyCount} replies)` : "";
        slackContext += `  - ${msg.user}: ${text}${thread}\n`;
      }
    }
  }

  return { prContext, jiraContext, slackContext };
}

function buildPrompt(prContext: string, jiraContext: string, slackContext: string): string {
  return `You are analyzing summarized pull requests, Jira issues, and Slack channel conversations for a team activity report. Group them by project/effort and synthesize.

PR Summaries:
${prContext}${jiraContext}${slackContext}

Generate a report:

1. TEAM_SUMMARY: Quick bullet points of what each person is doing. One bullet per person, format: "- @username: what they're working on". Keep each bullet to one line. Include context from Slack conversations where relevant.

2. For each project/effort, a PROJECT section. Identify who has the most PRs/commits in this area as LEAD. List all other contributors as TEAM. Include recent activity per project, including relevant Slack discussions.

Format:
TEAM_SUMMARY:
- @username: working on X and Y
- @username2: fixing Z, reviewing A
PROJECT: <Project Name>
STATUS: <active/in review/blocked/wrapping up>
LEAD: @username
TEAM: @user1, @user2
SUMMARY: <what this effort is about>
RECENT_ACTIVITY: <last 24h discussions, decisions, progress — include Slack context>
PRS:
- PR #N by @author: <contribution>
JIRA:
- TICKET-123: <summary> [status] — assignee
SLACK:
- Key discussion points or decisions from Slack channels

Rules:
- Every PR must appear under exactly one project
- LEAD is the person with the most activity/PRs in that project
- TEAM lists all other contributors (can be empty if solo)
- Group Jira issues with related PRs
- JIRA section can be omitted if none relate
- SLACK section can be omitted if no relevant messages
- Incorporate Slack discussions into RECENT_ACTIVITY to give a fuller picture of team coordination
- Be concise`;
}

export function parseTeamAnalysisResponse(content: string): TeamAnalysisResult {
  const teamSummaryMatch = content.match(
    /TEAM_SUMMARY:\s*([^\n]*(?:\n(?!PROJECT:).*)*)/i
  );
  const teamSummaryRaw = teamSummaryMatch ? teamSummaryMatch[1].trim() : "";
  const teamSummaryBullets = teamSummaryRaw
    .split("\n")
    .map((l: string) => l.replace(/^- /, "").trim())
    .filter(Boolean);

  const mentionedPRs = new Set<number>();
  const projects: ParsedProject[] = [];

  const projectBlocks = content
    .split(/(?=^PROJECT:)/im)
    .filter((b: string) => b.startsWith("PROJECT:"));

  for (const block of projectBlocks) {
    const nameMatch = block.match(/^PROJECT:\s*(.+)/i);
    const statusMatch = block.match(/^STATUS:\s*(.+)/im);
    const leadMatch = block.match(/^LEAD:\s*(.+)/im);
    const teamMatch = block.match(/^TEAM:\s*(.+)/im);
    const summaryMatch = block.match(
      /^SUMMARY:\s*([^\n]*(?:\n(?!RECENT_ACTIVITY:|PRS:|JIRA:|SLACK:|PROJECT:|LEAD:|TEAM:).*)*)/im
    );
    const activityMatch = block.match(
      /^RECENT_ACTIVITY:\s*([^\n]*(?:\n(?!PRS:|JIRA:|SLACK:|PROJECT:).*)*)/im
    );
    const prsMatch = block.match(/^PRS:\s*\n((?:- .*(?:\n|$))*)/im);
    const jiraMatch = block.match(/^JIRA:\s*\n((?:- .*(?:\n|$))*)/im);
    const slackMatch = block.match(/^SLACK:\s*\n((?:- .*(?:\n|$))*)/im);

    const prLinesRaw = prsMatch ? prsMatch[1].trim() : "";
    const jiraLinesRaw = jiraMatch ? jiraMatch[1].trim() : "";
    const slackLinesRaw = slackMatch ? slackMatch[1].trim() : "";

    // Track PR numbers
    const prNums = prLinesRaw.match(/#(\d+)/g);
    const prNumbers: number[] = [];
    if (prNums) {
      prNums.forEach((n: string) => {
        const num = parseInt(n.slice(1));
        mentionedPRs.add(num);
        prNumbers.push(num);
      });
    }

    // Parse PR lines into structured data
    const prLinesList = prLinesRaw ? prLinesRaw.split("\n").filter(Boolean) : [];
    const prs = prLinesList.map((line: string) => {
      const m = line.match(/PR #(\d+)\s+by\s+@(\S+):\s*(.*)/);
      return m
        ? { number: parseInt(m[1]), author: m[2], description: m[3].trim() }
        : { number: 0, author: "", description: line.replace(/^- /, "") };
    });

    // Parse Jira lines
    const jiraLinesList = jiraLinesRaw ? jiraLinesRaw.split("\n").filter(Boolean) : [];
    const jiraTickets = jiraLinesList.map((line: string) => {
      const m = line.match(/([A-Z]+-\d+):\s*(.*?)\s*\[([^\]]*)\]\s*—\s*(.*)/);
      return m
        ? { key: m[1], summary: m[2].trim(), status: m[3].trim(), assignee: m[4].trim() }
        : { key: "", summary: line.replace(/^- /, ""), status: "", assignee: "" };
    });

    // Parse Slack lines
    const slackHighlights = slackLinesRaw
      ? slackLinesRaw.split("\n").map((l: string) => l.replace(/^- /, "").trim()).filter(Boolean)
      : [];

    const teamStr = teamMatch ? teamMatch[1].trim() : "";
    const teamMembers = teamStr
      ? teamStr.split(",").map((t: string) => t.trim().replace(/^@/, "")).filter(Boolean)
      : [];

    projects.push({
      name: nameMatch ? nameMatch[1].trim() : "Unknown",
      status: statusMatch ? statusMatch[1].trim() : "active",
      lead: leadMatch ? leadMatch[1].trim().replace(/^@/, "") : "",
      team: teamMembers,
      summary: summaryMatch ? summaryMatch[1].trim() : "",
      recentActivity: activityMatch ? activityMatch[1].trim() : "",
      prLines: prLinesRaw,
      jiraLines: jiraLinesRaw,
      slackLines: slackLinesRaw,
      prNumbers,
      prs,
      jiraTickets,
      slackHighlights,
    });
  }

  return {
    teamSummary: teamSummaryRaw,
    teamSummaryBullets,
    projects,
    mentionedPRs,
    rawContent: content,
  };
}

/**
 * Run the AI reduce phase: build context, invoke model, parse response.
 */
export async function analyzeTeamActivity(
  summaries: PRSummaryInput[],
  jiraIssues: JiraIssueInput[],
  slackMessages: SlackMessageInput[]
): Promise<TeamAnalysisResult> {
  const { prContext, jiraContext, slackContext } = buildTeamContext(summaries, jiraIssues, slackMessages);
  const prompt = buildPrompt(prContext, jiraContext, slackContext);

  const client = await getBedrockClient();
  const response = await client.invoke([{ role: "user", content: prompt }]);
  const content = response.content?.toString() || "";

  return parseTeamAnalysisResponse(content);
}
