// Reusable HTML fragment generators

interface ColumnDef {
  key: string;
  label: string;
  format?: string;
}

export function renderTable(
  data: any[],
  columns?: ColumnDef[]
): string {
  if (!data || data.length === 0) {
    return `<div class="text-gray-400 text-sm py-4">No data available</div>`;
  }

  // Auto-detect columns from first item if not provided
  const cols: ColumnDef[] =
    columns ||
    Object.keys(data[0])
      .filter((k) => typeof data[0][k] !== "object" || data[0][k] === null)
      .map((k) => ({ key: k, label: k.replace(/([A-Z])/g, " $1").trim() }));

  const headers = cols
    .map(
      (c) =>
        `<th class="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">${c.label}</th>`
    )
    .join("");

  const rows = data
    .map((row) => {
      const cells = cols
        .map((c) => {
          const val = row[c.key];
          return `<td class="px-4 py-3 text-sm">${formatCell(val, c.format)}</td>`;
        })
        .join("");
      return `<tr class="border-t border-gray-700 hover:bg-gray-750">${cells}</tr>`;
    })
    .join("");

  return `
    <div class="overflow-x-auto">
      <table class="min-w-full">
        <thead class="bg-gray-800"><tr>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function formatCell(value: any, format?: string): string {
  if (value === null || value === undefined) return `<span class="text-gray-500">-</span>`;
  if (typeof value === "boolean") {
    return value
      ? `<span class="text-green-400">Yes</span>`
      : `<span class="text-gray-500">No</span>`;
  }
  if (format === "badge") {
    const color = badgeColor(String(value));
    return `<span class="px-2 py-0.5 text-xs rounded-full ${color}">${escapeHtml(String(value))}</span>`;
  }
  if (format === "link" && typeof value === "string" && value.startsWith("http")) {
    return `<a href="${escapeHtml(value)}" target="_blank" class="text-blue-400 hover:underline">${escapeHtml(value)}</a>`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => `<span class="px-1.5 py-0.5 text-xs bg-gray-700 rounded mr-1">${escapeHtml(String(v))}</span>`).join("");
  }
  return escapeHtml(String(value));
}

function badgeColor(value: string): string {
  const v = value.toLowerCase();
  if (v.includes("success") || v.includes("open") || v.includes("active")) return "bg-green-900 text-green-300";
  if (v.includes("fail") || v.includes("error") || v.includes("closed")) return "bg-red-900 text-red-300";
  if (v.includes("pending") || v.includes("draft") || v.includes("progress")) return "bg-yellow-900 text-yellow-300";
  return "bg-gray-700 text-gray-300";
}

export function renderKeyValue(data: any, prefix = ""): string {
  if (!data || typeof data !== "object") {
    return `<div class="text-gray-400 text-sm py-4">No data</div>`;
  }

  let rows = "";
  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows += `<tr class="border-t border-gray-700"><td colspan="2" class="px-4 py-2 text-xs font-semibold text-gray-400 uppercase bg-gray-800">${escapeHtml(fullKey)}</td></tr>`;
      rows += renderKeyValueRows(value as Record<string, any>, fullKey);
    } else {
      rows += `<tr class="border-t border-gray-700">
        <td class="px-4 py-2 text-sm font-mono text-gray-300">${escapeHtml(fullKey)}</td>
        <td class="px-4 py-2 text-sm">${formatCell(value)}</td>
      </tr>`;
    }
  }

  return `<div class="overflow-x-auto"><table class="min-w-full">${rows}</table></div>`;
}

function renderKeyValueRows(obj: Record<string, any>, prefix: string): string {
  let rows = "";
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = `${prefix}.${key}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows += renderKeyValueRows(value as Record<string, any>, fullKey);
    } else {
      const displayVal = key.toLowerCase().includes("token") || key.toLowerCase().includes("secret")
        ? "********"
        : value;
      rows += `<tr class="border-t border-gray-700">
        <td class="px-4 py-2 text-sm font-mono text-gray-400 pl-8">${escapeHtml(fullKey)}</td>
        <td class="px-4 py-2 text-sm">${formatCell(displayVal)}</td>
      </tr>`;
    }
  }
  return rows;
}

export function renderTimeline(data: any[]): string {
  if (!data || data.length === 0) {
    return `<div class="text-gray-400 text-sm py-4">No entries</div>`;
  }

  const items = data
    .map((item) => {
      const title = item.message || item.summary || item.content || String(item);
      const meta = [item.author, item.date, item.hash?.substring(0, 7)]
        .filter(Boolean)
        .join(" &middot; ");
      const refs = item.refs ? `<span class="text-xs px-1.5 py-0.5 bg-blue-900 text-blue-300 rounded">${escapeHtml(item.refs)}</span>` : "";

      return `
        <div class="flex gap-3 pb-4">
          <div class="flex flex-col items-center">
            <div class="w-2 h-2 rounded-full bg-blue-400 mt-2"></div>
            <div class="w-px flex-1 bg-gray-700"></div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm">${escapeHtml(title)} ${refs}</div>
            <div class="text-xs text-gray-400">${meta}</div>
          </div>
        </div>`;
    })
    .join("");

  return `<div class="pl-2">${items}</div>`;
}

export function renderMarkdown(text: string): string {
  // Basic markdown rendering
  let html = escapeHtml(text);
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-6 mb-2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold mt-6 mb-3">$1</h1>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');
  // Line breaks
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');
  return `<div class="prose prose-invert prose-sm max-w-none">${html}</div>`;
}

export function renderForm(
  commandName: string,
  options: Array<{ flags: string; description: string; defaultValue?: any }>
): string {
  const fields = options
    .filter((o) => o.flags !== "--json")
    .map((o) => {
      const hasValue = o.flags.includes("<");
      const isArray = o.flags.includes("...");
      const isNegation = o.flags.startsWith("--no-");
      const longMatch = o.flags.match(/--([a-z-]+)/);
      const name = longMatch ? longMatch[1] : o.flags;

      if (!hasValue && !isNegation) {
        // Boolean checkbox
        return `
          <label class="flex items-center gap-2 py-1">
            <input type="checkbox" name="${name}" class="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500">
            <span class="text-sm">${escapeHtml(o.description)}</span>
          </label>`;
      }
      if (isNegation) {
        const posName = name.replace("no-", "");
        return `
          <label class="flex items-center gap-2 py-1">
            <input type="checkbox" name="${posName}" checked class="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500">
            <span class="text-sm">${escapeHtml(o.description)}</span>
          </label>`;
      }
      // Text/array input
      return `
        <div class="py-1">
          <label class="block text-sm text-gray-300 mb-1">${escapeHtml(o.description)}</label>
          <input type="text" name="${name}" value="${escapeHtml(String(o.defaultValue || ""))}"
            class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-sm text-white focus:ring-blue-500 focus:border-blue-500"
            placeholder="${name}">
        </div>`;
    })
    .join("");

  return `
    <form hx-post="/htmx/command/${commandName}" hx-target="#command-result" hx-indicator="#loading-${commandName}" class="space-y-2">
      ${fields}
      <div class="pt-3 flex items-center gap-3">
        <button type="submit" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md font-medium">
          Run ${escapeHtml(commandName)}
        </button>
        <span id="loading-${commandName}" class="htmx-indicator text-gray-400 text-sm">Running...</span>
      </div>
    </form>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
