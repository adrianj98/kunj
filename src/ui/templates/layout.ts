// Main HTML shell template

import { CommandConfig } from "../../lib/command";

interface SidebarItem {
  name: string;
  label: string;
  icon: string;
  category: string;
  active?: boolean;
}

export function buildSidebar(commands: CommandConfig[]): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const cmd of commands) {
    if (!cmd.ui || cmd.ui.category === "hidden") continue;
    items.push({
      name: cmd.name.split(" ")[0], // strip arguments like "create <branch>"
      label: cmd.ui.label || cmd.name.split(" ")[0],
      icon: cmd.ui.icon || "terminal",
      category: cmd.ui.category,
    });
  }
  items.sort((a, b) => {
    const order = { dashboard: 0, data: 1, action: 2 };
    const ao = order[a.category as keyof typeof order] ?? 3;
    const bo = order[b.category as keyof typeof order] ?? 3;
    return ao - bo;
  });
  return items;
}

function sidebarIcon(icon: string): string {
  const icons: Record<string, string> = {
    "git-branch": "&#9906;",
    "git-pull-request": "&#8644;",
    "file-diff": "&#916;",
    "users": "&#9734;",
    "ticket": "&#9635;",
    "settings": "&#9881;",
    "graph": "&#9679;",
    "clock": "&#9200;",
    "archive": "&#9744;",
    "plus": "&#43;",
    "trash": "&#10060;",
    "check": "&#10003;",
    "tag": "&#9873;",
    terminal: "&#9654;",
  };
  return icons[icon] || icons.terminal;
}

export function htmlLayout(
  title: string,
  content: string,
  sidebar: SidebarItem[],
  activePage?: string
): string {
  const categoryLabels: Record<string, string> = {
    dashboard: "Dashboard",
    data: "Data",
    action: "Actions",
  };

  // Group sidebar items by category
  const grouped = new Map<string, SidebarItem[]>();
  for (const item of sidebar) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category)!.push(item);
  }

  let sidebarHtml = "";
  for (const [category, items] of grouped) {
    sidebarHtml += `<div class="px-3 pt-4 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">${categoryLabels[category] || category}</div>`;
    for (const item of items) {
      const isActive = item.name === activePage;
      const activeClass = isActive
        ? "bg-gray-700 text-white"
        : "text-gray-300 hover:bg-gray-700 hover:text-white";
      sidebarHtml += `
        <a href="/command/${item.name}" class="flex items-center gap-2 px-3 py-2 text-sm rounded-md mx-2 ${activeClass}">
          <span class="w-5 text-center">${sidebarIcon(item.icon)}</span>
          ${item.label}
        </a>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - kunj</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <link rel="stylesheet" href="/assets/styles.css">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: {} }
    }
  </script>
</head>
<body class="h-full bg-gray-900 text-gray-100">
  <div class="flex h-full">
    <!-- Sidebar -->
    <nav class="w-56 bg-gray-800 border-r border-gray-700 flex flex-col flex-shrink-0 overflow-y-auto">
      <div class="p-4 border-b border-gray-700">
        <a href="/" class="text-lg font-bold text-white flex items-center gap-2">
          <span class="text-blue-400">&#9656;</span> kunj
        </a>
        <div class="text-xs text-gray-400 mt-1">Git Branch Manager</div>
      </div>
      <div class="flex-1 py-2">
        <a href="/" class="flex items-center gap-2 px-3 py-2 text-sm rounded-md mx-2 ${activePage === "dashboard" ? "bg-gray-700 text-white" : "text-gray-300 hover:bg-gray-700 hover:text-white"}">
          <span class="w-5 text-center">&#9632;</span> Dashboard
        </a>
        ${sidebarHtml}
      </div>
      <div class="p-3 border-t border-gray-700">
        <button id="dark-toggle" class="text-xs text-gray-400 hover:text-white">Toggle Theme</button>
      </div>
    </nav>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto p-6">
      ${content}
    </main>
  </div>
  <script src="/assets/app.js"></script>
</body>
</html>`;
}
