// Command detail page template

import { CommandConfig } from "../../lib/command";
import { renderForm, escapeHtml } from "./partials";
import { renderWidgetContent } from "./dashboard";

export function renderCommandPage(
  command: CommandConfig,
  data?: any,
  error?: string
): string {
  const name = command.name.split(" ")[0];
  const ui = command.ui;
  const label = ui?.label || name;

  // Render current data if available
  let dataSection = "";
  if (error) {
    dataSection = `<div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm">${escapeHtml(error)}</div>`;
  } else if (data && ui) {
    dataSection = `
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-white">Current Data</h3>
          <button hx-get="/htmx/widget/${name}" hx-target="#live-data" hx-indicator="#refresh-loading"
            class="text-xs text-blue-400 hover:text-blue-300">
            Refresh <span id="refresh-loading" class="htmx-indicator">...</span>
          </button>
        </div>
        <div id="live-data">
          ${renderWidgetContent(ui, data)}
        </div>
      </div>`;
  }

  // Render form if command has options
  let formSection = "";
  if (command.options && command.options.length > 0) {
    formSection = `
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <h3 class="text-sm font-semibold text-white mb-3">Run Command</h3>
        ${renderForm(name, command.options)}
      </div>`;
  }

  // Render arguments info
  let argsSection = "";
  if (command.arguments) {
    argsSection = `
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <h3 class="text-sm font-semibold text-white mb-2">Arguments</h3>
        <code class="text-sm text-gray-300">kunj ${name} ${escapeHtml(command.arguments)}</code>
      </div>`;
  }

  return `
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-white">${escapeHtml(label)}</h1>
      <p class="text-gray-400 text-sm mt-1">${escapeHtml(command.description)}</p>
    </div>
    <div class="space-y-4">
      ${dataSection}
      ${argsSection}
      ${formSection}
      <div id="command-result"></div>
    </div>`;
}
