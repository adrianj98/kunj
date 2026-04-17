// Team report page — project cards, avatars, Jira board, SSE refresh, stale collapsing

import { escapeHtml } from "./partials";

interface ProjectData {
  name: string;
  status: string;
  lead: string;
  team: string[];
  summary: string;
  recentActivity: string;
  lastUpdated?: string;
  prs: Array<{ number: number; author: string; description: string; updatedAt?: string }>;
  jiraTickets: Array<{ key: string; summary: string; status: string; assignee: string; updated?: string }>;
  slackHighlights?: string[];
}

interface TeamAnalysis {
  teamSummary: string[];
  projects: ProjectData[];
  jiraByStatus: Record<string, any[]>;
  prCount: number;
  lastFetch: string | null;
  analyzedAt?: string;
}

// Generate consistent hue from a name
function nameToHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function nameColor(name: string): string {
  return `hsl(${nameToHue(name)}, 60%, 55%)`;
}

function avatarHtml(name: string, isGitHub = false, size = 28): string {
  if (isGitHub) {
    return `<img src="https://avatars.githubusercontent.com/${name}?s=${size * 2}"
      alt="@${escapeHtml(name)}"
      class="rounded-full inline-block"
      style="width:${size}px;height:${size}px"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <span class="rounded-full inline-flex items-center justify-center text-xs font-bold text-white"
      style="width:${size}px;height:${size}px;background:${nameColor(name)};display:none">
      ${escapeHtml(name.charAt(0).toUpperCase())}
    </span>`;
  }
  // Jira / generic — initial with color
  const initial = name.replace(/[^a-zA-Z]/g, "").charAt(0).toUpperCase() || "?";
  return `<span class="rounded-full inline-flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
    style="width:${size}px;height:${size}px;background:${nameColor(name)}"
    title="${escapeHtml(name)}">
    ${initial}
  </span>`;
}

// Project identicon as an img tag pointing to the API
function projectIconImg(name: string, size = 32): string {
  return `<img src="/api/icon/${encodeURIComponent(name)}" alt="" class="rounded" style="width:${size}px;height:${size}px">`;
}

function isStale(lastUpdated?: string): boolean {
  if (!lastUpdated) return false;
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  return new Date(lastUpdated).getTime() < twoDaysAgo;
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const statusBadge: Record<string, string> = {
  active: "bg-green-900 text-green-300",
  "in review": "bg-purple-900 text-purple-300",
  blocked: "bg-red-900 text-red-300",
  "wrapping up": "bg-yellow-900 text-yellow-300",
};

const jiraColumnColors: Record<string, string> = {
  "To Do": "border-gray-500",
  "In Progress": "border-blue-500",
  "In Review": "border-purple-500",
  QA: "border-yellow-500",
  Done: "border-green-500",
};

const priorityColors: Record<string, string> = {
  Highest: "text-red-400",
  High: "text-orange-400",
  Medium: "text-yellow-400",
  Low: "text-blue-400",
  Lowest: "text-gray-400",
};

export function renderTeamPage(analysis: TeamAnalysis): string {
  const lastFetchDisplay = analysis.lastFetch
    ? timeAgo(analysis.lastFetch)
    : "never";
  const analyzedDisplay = analysis.analyzedAt
    ? timeAgo(analysis.analyzedAt)
    : null;

  // No data
  if (analysis.projects.length === 0 && Object.keys(analysis.jiraByStatus).length === 0) {
    return `
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-white">Team Report</h1>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-8 text-center">
        <p class="text-gray-400 mb-3">No team data available</p>
        <p class="text-gray-500 text-sm mb-4">Run <code class="bg-gray-700 px-1.5 py-0.5 rounded">kunj team</code> to fetch PRs, then click Analyze.</p>
        <button onclick="refreshAnalysis()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md">
          Analyze with AI
        </button>
        <div id="progress-area" class="mt-4 text-sm text-gray-400"></div>
      </div>
      ${sseScript()}`;
  }

  // Collect all people
  const allAuthors = new Set<string>();
  for (const p of analysis.projects) {
    if (p.lead) allAuthors.add(p.lead);
    for (const t of p.team) allAuthors.add(t);
    for (const pr of p.prs) if (pr.author) allAuthors.add(pr.author);
  }

  // Separate stale vs active projects
  const activeProjects = analysis.projects.filter((p) => !isStale(p.lastUpdated));
  const staleProjects = analysis.projects.filter((p) => isStale(p.lastUpdated));

  // Stats
  const statsHtml = `
    <div class="grid grid-cols-4 gap-4 mb-6">
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 text-center">
        <div class="text-2xl font-bold text-white">${analysis.prCount}</div>
        <div class="text-xs text-gray-400">Open PRs</div>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 text-center">
        <div class="text-2xl font-bold text-white">${analysis.projects.length}</div>
        <div class="text-xs text-gray-400">Projects</div>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 text-center">
        <div class="text-2xl font-bold text-white">${Object.values(analysis.jiraByStatus).flat().length}</div>
        <div class="text-xs text-gray-400">Jira Issues</div>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 text-center">
        <div class="text-2xl font-bold text-white">${allAuthors.size}</div>
        <div class="text-xs text-gray-400">Contributors</div>
      </div>
    </div>`;

  // Team summary with avatars
  const summaryHtml = analysis.teamSummary.length > 0 ? `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
      <h2 class="text-sm font-semibold text-white mb-3">Team Activity</h2>
      <div class="space-y-2">
        ${analysis.teamSummary.map((line) => {
          const userMatch = line.match(/^@(\S+)/);
          const username = userMatch ? userMatch[1].replace(":", "") : "";
          const text = userMatch ? line.slice(userMatch[0].length).replace(/^:\s*/, "") : line;
          return `
          <div class="flex items-center gap-2">
            ${username ? avatarHtml(username, true, 24) : ""}
            <span class="text-sm text-gray-300">${username ? `<span class="font-medium text-white">@${escapeHtml(username)}</span> ` : ""}${escapeHtml(text)}</span>
          </div>`;
        }).join("")}
      </div>
    </div>` : "";

  // Project cards
  const renderProjectCard = (project: ProjectData, collapsed = false) => {
    const iconHtml = projectIconImg(project.name, 28);
    const statusColor = statusBadge[project.status.toLowerCase()] || "bg-gray-700 text-gray-300";
    const stale = isStale(project.lastUpdated);
    const updated = timeAgo(project.lastUpdated);

    const prItems = project.prs.map((pr) => `
      <div class="flex items-center gap-2 py-1.5 border-t border-gray-700/50">
        ${avatarHtml(pr.author, true, 22)}
        <span class="text-xs text-gray-500 flex-shrink-0">#${pr.number}</span>
        <span class="text-sm text-gray-300 flex-1 truncate">${escapeHtml(pr.description)}</span>
        ${pr.updatedAt ? `<span class="text-xs text-gray-600 flex-shrink-0">${timeAgo(pr.updatedAt)}</span>` : ""}
      </div>`).join("");

    const jiraItems = project.jiraTickets.map((j) => `
      <div class="flex items-center gap-2 py-1.5 border-t border-gray-700/50">
        ${projectIconImg(project.name, 16)}
        <span class="text-xs font-mono text-blue-400 flex-shrink-0">${escapeHtml(j.key)}</span>
        <span class="text-sm text-gray-300 flex-1 truncate">${escapeHtml(j.summary)}</span>
        ${j.assignee ? avatarHtml(j.assignee, false, 20) : ""}
      </div>`).join("");

    const cardId = `project-${project.name.replace(/[^a-zA-Z0-9]/g, "-")}`;

    if (collapsed) {
      return `
        <div class="bg-gray-800/50 rounded-lg border border-gray-700/50 overflow-hidden opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
          onclick="document.getElementById('${cardId}-body').classList.toggle('hidden');this.classList.toggle('opacity-60')">
          <div class="px-4 py-3 flex items-center gap-3">
            ${iconHtml}
            <div class="flex-1 min-w-0">
              <span class="text-sm font-medium text-gray-400">${escapeHtml(project.name)}</span>
              <span class="text-xs text-gray-600 ml-2">${updated}</span>
            </div>
            <span class="text-xs ${statusColor} px-2 py-0.5 rounded-full">${escapeHtml(project.status)}</span>
            <span class="text-xs text-gray-600">▼</span>
          </div>
          <div id="${cardId}-body" class="hidden px-4 pb-3">
            <p class="text-sm text-gray-400 mb-2">${escapeHtml(project.summary)}</p>
            ${prItems ? `<div class="text-xs text-gray-500 mb-1">Pull Requests</div>${prItems}` : ""}
            ${jiraItems ? `<div class="text-xs text-gray-500 mb-1 mt-2">Jira Tickets</div>${jiraItems}` : ""}
          </div>
        </div>`;
    }

    const projectUrl = `/command/team/project/${encodeURIComponent(project.name)}`;

    return `
      <a href="${projectUrl}" class="block bg-gray-800 rounded-lg border border-gray-700 overflow-hidden hover:border-gray-500 transition-colors">
        <div class="px-4 py-3 border-b border-gray-700">
          <div class="flex items-center gap-3">
            ${iconHtml}
            <div class="flex-1">
              <h3 class="text-base font-semibold text-white">${escapeHtml(project.name)}</h3>
              <div class="flex items-center gap-2 mt-1">
                ${project.lead ? `${avatarHtml(project.lead, true, 20)} <span class="text-xs text-gray-400">Lead</span>` : ""}
                ${project.team.length > 0 ? `<span class="text-xs text-gray-600 mx-1">|</span> ${project.team.map((t) => avatarHtml(t, true, 20)).join(" ")}` : ""}
              </div>
            </div>
            <div class="text-right flex-shrink-0">
              <span class="text-xs ${statusColor} px-2 py-0.5 rounded-full">${escapeHtml(project.status)}</span>
              ${updated ? `<div class="text-xs text-gray-500 mt-1">${updated}</div>` : ""}
            </div>
          </div>
        </div>
        <div class="px-4 py-3">
          <p class="text-sm text-gray-300">${escapeHtml(project.summary)}</p>
          ${project.recentActivity && project.recentActivity.toLowerCase() !== "no recent activity" ? `
            <div class="mt-2 px-3 py-2 bg-gray-900 rounded text-xs text-blue-300">
              ${escapeHtml(project.recentActivity)}
            </div>` : ""}
        </div>
        ${prItems ? `<div class="px-4 pb-2"><div class="text-xs text-gray-500 mb-1">Pull Requests</div>${prItems}</div>` : ""}
        ${jiraItems ? `<div class="px-4 pb-3"><div class="text-xs text-gray-500 mb-1">Jira Tickets</div>${jiraItems}</div>` : ""}
      </a>`;
  };

  const activeCards = activeProjects.map((p) => renderProjectCard(p)).join("");
  const staleCards = staleProjects.map((p) => renderProjectCard(p, true)).join("");

  // Jira board
  const statusOrder = ["In Progress", "In Review", "QA", "To Do", "Done"];
  const statuses = statusOrder.filter((s) => analysis.jiraByStatus[s]);
  for (const s of Object.keys(analysis.jiraByStatus)) {
    if (!statuses.includes(s)) statuses.push(s);
  }

  const jiraBoard = statuses.length > 0 ? `
    <div class="mb-6">
      <h2 class="text-lg font-semibold text-white mb-3">Jira Board</h2>
      <div class="flex gap-4 overflow-x-auto pb-4">
        ${statuses.map((status) => {
          const issues = analysis.jiraByStatus[status] || [];
          const borderColor = jiraColumnColors[status] || "border-gray-600";
          // Find which project each ticket belongs to
          const issueToProject = new Map<string, string>();
          for (const p of analysis.projects) {
            for (const j of p.jiraTickets) {
              issueToProject.set(j.key, p.name);
            }
          }
          return `
          <div class="min-w-64 flex-shrink-0">
            <div class="rounded-lg border ${borderColor} bg-gray-800/50 p-3">
              <h4 class="text-sm font-semibold text-white mb-2">${escapeHtml(status)} <span class="text-gray-400 font-normal">(${issues.length})</span></h4>
              <div class="space-y-2">
                ${issues.map((issue: any) => {
                  const pColor = priorityColors[issue.priority] || "text-gray-400";
                  const projName = issueToProject.get(issue.key);
                  return `
                  <div class="bg-gray-900 rounded p-2.5 border border-gray-700">
                    <div class="flex items-start justify-between">
                      <div class="flex items-center gap-1">
                        ${projName ? projectIconImg(projName, 14) : ""}
                        <span class="text-xs font-mono text-blue-400">${escapeHtml(issue.key)}</span>
                      </div>
                      <span class="text-xs ${pColor}">${escapeHtml(issue.priority)}</span>
                    </div>
                    <p class="text-xs text-white mt-1">${escapeHtml(issue.summary)}</p>
                    <div class="flex items-center justify-between mt-1.5">
                      <div class="flex items-center gap-1">
                        ${issue.assignee && issue.assignee !== "Unassigned" ? avatarHtml(issue.assignee, false, 18) : ""}
                        <span class="text-xs text-gray-500">${escapeHtml(issue.assignee)}</span>
                      </div>
                      <span class="text-xs px-1 py-0.5 bg-gray-700 text-gray-400 rounded">${escapeHtml(issue.issueType)}</span>
                    </div>
                  </div>`;
                }).join("")}
              </div>
            </div>
          </div>`;
        }).join("")}
      </div>
    </div>` : "";

  return `
    <div class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">Team Report</h1>
        <p class="text-gray-400 text-sm mt-1">
          Data: ${escapeHtml(lastFetchDisplay)}
          ${analyzedDisplay ? ` | Analyzed: ${escapeHtml(analyzedDisplay)}` : ""}
        </p>
      </div>
      <div class="flex gap-2 items-center">
        <div id="progress-area" class="text-sm text-gray-400"></div>
        <button onclick="refreshAnalysis()" id="refresh-btn"
          class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md font-medium">
          Refresh Analysis
        </button>
      </div>
    </div>

    ${statsHtml}
    ${summaryHtml}

    ${activeProjects.length > 0 ? `
    <div class="mb-6">
      <h2 class="text-lg font-semibold text-white mb-3">Active Projects</h2>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        ${activeCards}
      </div>
    </div>` : ""}

    ${staleProjects.length > 0 ? `
    <div class="mb-6">
      <h2 class="text-sm font-semibold text-gray-500 mb-2">Older Projects <span class="font-normal">(not updated in 2+ days — click to expand)</span></h2>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
        ${staleCards}
      </div>
    </div>` : ""}

    ${jiraBoard}

    ${sseScript()}`;
}

export function renderProjectDetailPage(project: ProjectData, analysis: TeamAnalysis): string {
  const statusColor = statusBadge[project.status.toLowerCase()] || "bg-gray-700 text-gray-300";
  const updated = timeAgo(project.lastUpdated);

  // Header
  let html = `
    <div class="mb-6">
      <a href="/command/team" class="text-sm text-gray-400 hover:text-gray-200 mb-2 inline-block">&larr; Back to Team Report</a>
      <div class="flex items-center gap-4 mt-2">
        ${projectIconImg(project.name, 48)}
        <div class="flex-1">
          <h1 class="text-2xl font-bold text-white">${escapeHtml(project.name)}</h1>
          <div class="flex items-center gap-3 mt-1">
            <span class="text-xs ${statusColor} px-2 py-0.5 rounded-full">${escapeHtml(project.status)}</span>
            ${updated ? `<span class="text-xs text-gray-500">Updated ${updated}</span>` : ""}
          </div>
        </div>
      </div>
    </div>`;

  // Team section
  html += `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
      <h2 class="text-sm font-semibold text-white mb-3">Team</h2>
      <div class="flex flex-wrap gap-4">
        ${project.lead ? `
        <div class="flex items-center gap-2">
          ${avatarHtml(project.lead, true, 32)}
          <div>
            <div class="text-sm font-medium text-white">@${escapeHtml(project.lead)}</div>
            <div class="text-xs text-gray-400">Lead</div>
          </div>
        </div>` : ""}
        ${project.team.map(t => `
        <div class="flex items-center gap-2">
          ${avatarHtml(t, true, 32)}
          <div>
            <div class="text-sm font-medium text-white">@${escapeHtml(t)}</div>
            <div class="text-xs text-gray-400">Contributor</div>
          </div>
        </div>`).join("")}
      </div>
    </div>`;

  // Summary & Recent Activity
  html += `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
      <h2 class="text-sm font-semibold text-white mb-2">Summary</h2>
      <p class="text-sm text-gray-300">${escapeHtml(project.summary)}</p>
      ${project.recentActivity && project.recentActivity.toLowerCase() !== "no recent activity" ? `
      <div class="mt-4">
        <h3 class="text-sm font-semibold text-white mb-2">Recent Activity</h3>
        <div class="px-3 py-2 bg-gray-900 rounded text-sm text-blue-300">
          ${escapeHtml(project.recentActivity)}
        </div>
      </div>` : ""}
    </div>`;

  // Pull Requests (expanded)
  if (project.prs.length > 0) {
    html += `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
      <h2 class="text-sm font-semibold text-white mb-3">Pull Requests <span class="text-gray-400 font-normal">(${project.prs.length})</span></h2>
      <div class="space-y-0">
        ${project.prs.map(pr => `
        <div class="flex items-center gap-3 py-3 border-b border-gray-700/50 last:border-0">
          ${avatarHtml(pr.author, true, 28)}
          <div class="flex-1 min-w-0">
            <div class="text-sm text-white">${escapeHtml(pr.description)}</div>
            <div class="text-xs text-gray-500 mt-0.5">
              #${pr.number} by @${escapeHtml(pr.author)}
              ${pr.updatedAt ? ` &middot; ${timeAgo(pr.updatedAt)}` : ""}
            </div>
          </div>
        </div>`).join("")}
      </div>
    </div>`;
  }

  // Jira Tickets (expanded)
  if (project.jiraTickets.length > 0) {
    html += `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
      <h2 class="text-sm font-semibold text-white mb-3">Jira Tickets <span class="text-gray-400 font-normal">(${project.jiraTickets.length})</span></h2>
      <div class="space-y-0">
        ${project.jiraTickets.map(j => `
        <div class="flex items-center gap-3 py-3 border-b border-gray-700/50 last:border-0">
          ${projectIconImg(project.name, 20)}
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-xs font-mono text-blue-400">${escapeHtml(j.key)}</span>
              <span class="text-xs ${statusColor} px-1.5 py-0.5 rounded">${escapeHtml(j.status)}</span>
            </div>
            <div class="text-sm text-white mt-0.5">${escapeHtml(j.summary)}</div>
          </div>
          ${j.assignee ? `
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${avatarHtml(j.assignee, false, 22)}
            <span class="text-xs text-gray-400">${escapeHtml(j.assignee)}</span>
          </div>` : ""}
        </div>`).join("")}
      </div>
    </div>`;
  }

  // Slack Highlights
  const highlights = project.slackHighlights || [];
  if (highlights.length > 0) {
    html += `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4 mb-6">
      <h2 class="text-sm font-semibold text-white mb-3">Slack Highlights</h2>
      <div class="space-y-2">
        ${highlights.map(h => `
        <div class="flex items-start gap-2 text-sm text-gray-300">
          <span class="text-gray-500 flex-shrink-0 mt-0.5">&bull;</span>
          <span>${escapeHtml(h)}</span>
        </div>`).join("")}
      </div>
    </div>`;
  }

  return html;
}

function sseScript(): string {
  return `
    <script>
    function refreshAnalysis() {
      const area = document.getElementById('progress-area');
      const btn = document.getElementById('refresh-btn');
      if (btn) { btn.disabled = true; btn.classList.add('opacity-50'); }
      area.textContent = 'Connecting...';

      const source = new EventSource('/api/team/analyze');

      source.addEventListener('progress', (e) => {
        area.textContent = JSON.parse(e.data);
      });

      source.addEventListener('done', (e) => {
        area.textContent = 'Done! Reloading...';
        source.close();
        setTimeout(() => location.reload(), 500);
      });

      source.addEventListener('error', (e) => {
        if (e.data) {
          area.innerHTML = '<span class="text-red-400">Error: ' + JSON.parse(e.data) + '</span>';
        } else {
          area.innerHTML = '<span class="text-red-400">Connection lost</span>';
        }
        source.close();
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
      });

      source.onerror = () => {
        area.innerHTML = '<span class="text-red-400">Connection error</span>';
        source.close();
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
      };
    }
    </script>`;
}
