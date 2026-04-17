// Dashboard page template

import { CommandConfig, UIWidgetConfig } from "../../lib/command";
import {
  renderTable,
  renderKeyValue,
  renderTimeline,
  renderMarkdown,
  escapeHtml,
} from "./partials";

interface WidgetData {
  command: CommandConfig;
  data: any;
  error?: string;
}

export function renderDashboard(widgets: WidgetData[]): string {
  const widgetCards = widgets
    .map((w) => {
      const ui = w.command.ui!;
      const name = w.command.name.split(" ")[0];
      const label = ui.label || name;
      const refreshAttr = ui.refreshInterval
        ? `hx-get="/htmx/widget/${name}" hx-trigger="every ${ui.refreshInterval}s" hx-swap="innerHTML"`
        : "";

      let content: string;
      if (w.error) {
        content = `<div class="text-red-400 text-sm py-2">${escapeHtml(w.error)}</div>`;
      } else if (!w.data) {
        content = `<div class="text-gray-500 text-sm py-2">Loading...</div>`;
      } else {
        content = renderWidgetContent(ui, w.data);
      }

      return `
        <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden" id="widget-${name}" ${refreshAttr}>
          <div class="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-white">${escapeHtml(label)}</h3>
            <a href="/command/${name}" class="text-xs text-gray-400 hover:text-white">View &rarr;</a>
          </div>
          <div class="p-0">
            ${content}
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-white">Dashboard</h1>
      <p class="text-gray-400 text-sm mt-1">Overview of your git workspace</p>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      ${widgetCards}
    </div>`;
}

function renderTeamWidget(data: any): string {
  const projects = Object.entries(data.projects || {});
  const jiraCount = data.jiraIssues?.length || 0;
  const authors = new Set<string>();
  for (const [, prs] of projects) {
    for (const pr of prs as any[]) authors.add(pr.author);
  }

  // Stats bar
  let html = `<div class="flex gap-4 px-4 py-3 border-b border-gray-700 text-xs text-gray-400">
    <span>${data.prCount || 0} PRs</span>
    <span>${projects.length} projects</span>
    <span>${jiraCount} Jira issues</span>
    <span>${authors.size} people</span>
  </div>`;

  // Compact project list
  html += `<div class="divide-y divide-gray-700">`;
  for (const [area, prs] of projects) {
    const prList = prs as any[];
    const prAuthors = [...new Set(prList.map((p: any) => p.author))];
    html += `
      <div class="px-4 py-2">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-white">${escapeHtml(area)}</span>
          <span class="text-xs text-gray-400">${prList.length} PR${prList.length !== 1 ? "s" : ""}</span>
        </div>
        <div class="text-xs text-gray-400 mt-0.5">${prAuthors.map((a) => "@" + escapeHtml(a)).join(", ")}</div>
      </div>`;
  }
  html += `</div>`;

  if (projects.length === 0 && jiraCount === 0) {
    html = `<div class="p-4 text-sm text-gray-400">Run <code class="bg-gray-700 px-1 py-0.5 rounded text-xs">kunj team</code> to generate</div>`;
  }

  return html;
}

export function renderWidgetContent(ui: UIWidgetConfig, data: any): string {
  // Custom team widget rendering
  if (data && data.projects && data.jiraByStatus) {
    return renderTeamWidget(data);
  }

  const widgetData = ui.dataKey ? data[ui.dataKey] : data;

  switch (ui.widget) {
    case "table":
      return renderTable(
        Array.isArray(widgetData) ? widgetData : [],
        ui.columns
      );
    case "key-value":
      return renderKeyValue(widgetData);
    case "timeline":
      return renderTimeline(Array.isArray(widgetData) ? widgetData : []);
    case "markdown":
      return renderMarkdown(typeof widgetData === "string" ? widgetData : JSON.stringify(widgetData, null, 2));
    case "stat-card":
      return renderTable(
        Array.isArray(widgetData) ? widgetData : [],
        ui.columns
      );
    default:
      // Fallback: try to render as table if array, key-value if object
      if (Array.isArray(widgetData)) return renderTable(widgetData);
      if (typeof widgetData === "object" && widgetData !== null) return renderKeyValue(widgetData);
      return `<pre class="p-4 text-sm text-gray-300">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
}
