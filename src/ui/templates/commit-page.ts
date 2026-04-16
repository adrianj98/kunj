// Commit page — full-featured web UI matching the CLI commit flow
// Steps: 1. Select files  2. Choose message type  3. Write/generate message  4. Commit  5. Push

import { escapeHtml } from "./partials";

interface FileInfo {
  path: string;
  status: string;
  staged: boolean;
  additions: number;
  deletions: number;
}

export function renderCommitPage(
  files: FileInfo[],
  branch: string,
  recentCommits: string[],
  aiAvailable: boolean
): string {
  const statusIcons: Record<string, string> = {
    new: '<span class="text-green-400">+</span>',
    modified: '<span class="text-yellow-400">M</span>',
    deleted: '<span class="text-red-400">D</span>',
    renamed: '<span class="text-blue-400">R</span>',
    copied: '<span class="text-cyan-400">C</span>',
    unmerged: '<span class="text-purple-400">U</span>',
  };

  if (files.length === 0) {
    return `
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-white">Commit</h1>
        <p class="text-gray-400 text-sm mt-1">On branch: <span class="text-blue-400">${escapeHtml(branch)}</span></p>
      </div>
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-8 text-center">
        <p class="text-gray-400">No changes to commit — working tree is clean</p>
      </div>`;
  }

  // File list with checkboxes
  const fileRows = files
    .map((f) => {
      const icon = statusIcons[f.status] || '<span class="text-gray-400">?</span>';
      const stats =
        f.additions || f.deletions
          ? `<span class="text-green-400">+${f.additions}</span> <span class="text-red-400">-${f.deletions}</span>`
          : "";
      const stagedBadge = f.staged
        ? '<span class="text-xs px-1.5 py-0.5 bg-green-900 text-green-300 rounded">staged</span>'
        : "";

      return `
        <tr class="border-t border-gray-700 hover:bg-gray-750">
          <td class="px-3 py-2">
            <input type="checkbox" name="files" value="${escapeHtml(f.path)}" ${f.staged ? "checked" : ""}
              class="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500">
          </td>
          <td class="px-3 py-2 text-sm">${icon}</td>
          <td class="px-3 py-2 text-sm font-mono">${escapeHtml(f.path)}</td>
          <td class="px-3 py-2 text-sm">${stagedBadge}</td>
          <td class="px-3 py-2 text-sm text-right">${stats}</td>
          <td class="px-3 py-2 text-sm text-right">
            <button type="button" onclick="viewDiff('${escapeHtml(f.path)}')"
              class="text-blue-400 hover:text-blue-300 text-xs mr-2">diff</button>
            <button type="button" onclick="viewDiff('${escapeHtml(f.path)}', true)"
              class="text-blue-400 hover:text-blue-300 text-xs mr-2">vs main</button>
            ${f.status !== "new" ? `<button type="button" onclick="revertFile('${escapeHtml(f.path)}')" class="text-yellow-400 hover:text-yellow-300 text-xs mr-2">revert</button>` : ""}
            <button type="button" onclick="deleteFileAction('${escapeHtml(f.path)}')"
              class="text-red-400 hover:text-red-300 text-xs">delete</button>
          </td>
        </tr>`;
    })
    .join("");

  // Recent commits for reference
  const recentCommitsHtml = recentCommits
    .map(
      (msg, i) =>
        `<div class="text-xs text-gray-400 py-0.5">${i + 1}. ${escapeHtml(msg)}</div>`
    )
    .join("");

  // Commit type options
  const commitTypes = [
    { value: "feat", label: "feat: A new feature" },
    { value: "fix", label: "fix: A bug fix" },
    { value: "docs", label: "docs: Documentation changes" },
    { value: "style", label: "style: Code style changes" },
    { value: "refactor", label: "refactor: Code refactoring" },
    { value: "test", label: "test: Adding or updating tests" },
    { value: "chore", label: "chore: Maintenance tasks" },
    { value: "build", label: "build: Build system changes" },
    { value: "ci", label: "ci: CI configuration changes" },
    { value: "perf", label: "perf: Performance improvements" },
  ];

  const typeOptions = commitTypes
    .map(
      (t) =>
        `<option value="${t.value}">${escapeHtml(t.label)}</option>`
    )
    .join("");

  return `
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-white">Commit</h1>
      <p class="text-gray-400 text-sm mt-1">On branch: <span class="text-blue-400">${escapeHtml(branch)}</span></p>
    </div>

    <div class="space-y-4">
      <!-- Step 1: Select Files -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-white">1. Select files to commit</h3>
          <div class="flex gap-2">
            <button type="button" onclick="toggleAllFiles(true)" class="text-xs text-blue-400 hover:text-blue-300">Select all</button>
            <button type="button" onclick="toggleAllFiles(false)" class="text-xs text-gray-400 hover:text-gray-300">Deselect all</button>
          </div>
        </div>
        <div id="file-list">
          <table class="min-w-full">
            <thead class="bg-gray-800">
              <tr>
                <th class="px-3 py-2 w-8"></th>
                <th class="px-3 py-2 w-8"></th>
                <th class="px-3 py-2 text-left text-xs font-medium text-gray-400">File</th>
                <th class="px-3 py-2 text-left text-xs font-medium text-gray-400 w-16">Status</th>
                <th class="px-3 py-2 text-right text-xs font-medium text-gray-400 w-24">Changes</th>
                <th class="px-3 py-2 text-right text-xs font-medium text-gray-400 w-40">Actions</th>
              </tr>
            </thead>
            <tbody>${fileRows}</tbody>
          </table>
        </div>
        <div class="px-4 py-3 border-t border-gray-700">
          <button type="button" onclick="stageSelected()"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md font-medium">
            Stage selected files
          </button>
          <span id="stage-status" class="ml-3 text-sm text-gray-400"></span>
        </div>
      </div>

      <!-- Diff Viewer (hidden by default) -->
      <div id="diff-viewer" class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden hidden">
        <div class="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-white" id="diff-title">Diff</h3>
          <button type="button" onclick="closeDiff()" class="text-xs text-gray-400 hover:text-white">Close</button>
        </div>
        <pre id="diff-content" class="p-4 text-xs overflow-x-auto max-h-96 overflow-y-auto font-mono"></pre>
      </div>

      <!-- Step 2: Commit Message -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-700">
          <h3 class="text-sm font-semibold text-white">2. Commit message</h3>
        </div>
        <div class="p-4 space-y-3">
          <!-- AI generate button -->
          <div class="flex items-center gap-3">
            <button type="button" onclick="generateAIMessage()"
              class="px-4 py-2 ${aiAvailable ? "bg-purple-600 hover:bg-purple-700" : "bg-gray-600 cursor-not-allowed"} text-white text-sm rounded-md font-medium"
              ${aiAvailable ? "" : "disabled"}>
              Generate with AI
            </button>
            <span id="ai-status" class="text-sm text-gray-400">
              ${aiAvailable ? "" : "AI not configured"}
            </span>
          </div>

          <div class="text-xs text-gray-500">— or write manually —</div>

          <!-- Manual message -->
          <div class="flex gap-2">
            <select id="commit-type" class="bg-gray-700 border border-gray-600 rounded-md text-sm text-white px-2 py-2">
              <option value="">No prefix</option>
              ${typeOptions}
            </select>
            <input type="text" id="commit-subject" placeholder="Commit message..."
              class="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-sm text-white focus:ring-blue-500 focus:border-blue-500">
          </div>
          <textarea id="commit-body" placeholder="Extended description (optional)"
            rows="3" class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-sm text-white focus:ring-blue-500 focus:border-blue-500"></textarea>

          <!-- Message preview -->
          <div id="message-preview" class="hidden bg-gray-900 rounded p-3">
            <div class="text-xs text-gray-400 mb-1">Preview:</div>
            <pre id="preview-text" class="text-sm text-white whitespace-pre-wrap"></pre>
          </div>

          ${recentCommitsHtml ? `<details class="text-xs"><summary class="text-gray-400 cursor-pointer hover:text-gray-300">Recent commits for reference</summary><div class="mt-1 pl-2">${recentCommitsHtml}</div></details>` : ""}
        </div>
      </div>

      <!-- Step 3: Commit -->
      <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <div class="flex items-center gap-3">
          <button type="button" onclick="doCommit()"
            class="px-6 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-md font-medium">
            Commit
          </button>
          <span id="commit-status" class="text-sm text-gray-400"></span>
        </div>
      </div>

      <!-- Step 4: Push (shown after commit) -->
      <div id="push-section" class="bg-gray-800 rounded-lg border border-gray-700 p-4 hidden">
        <h3 class="text-sm font-semibold text-white mb-3">4. Push to remote</h3>
        <div class="flex items-center gap-3">
          <button type="button" onclick="doPush()"
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md font-medium">
            Push
          </button>
          <button type="button" onclick="document.getElementById('push-section').classList.add('hidden')"
            class="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded-md font-medium">
            Skip
          </button>
          <span id="push-status" class="text-sm text-gray-400"></span>
        </div>
      </div>

      <!-- Result area -->
      <div id="commit-result"></div>
    </div>

    <script>
    function getSelectedFiles() {
      return Array.from(document.querySelectorAll('input[name="files"]:checked'))
        .map(el => el.value);
    }

    function toggleAllFiles(checked) {
      document.querySelectorAll('input[name="files"]').forEach(el => el.checked = checked);
    }

    async function stageSelected() {
      const files = getSelectedFiles();
      if (files.length === 0) {
        document.getElementById('stage-status').textContent = 'No files selected';
        return;
      }
      document.getElementById('stage-status').textContent = 'Staging...';
      try {
        const res = await fetch('/api/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files })
        });
        const data = await res.json();
        document.getElementById('stage-status').textContent = data.success
          ? files.length + ' file(s) staged'
          : 'Failed: ' + data.message;
      } catch (err) {
        document.getElementById('stage-status').textContent = 'Error: ' + err.message;
      }
    }

    async function viewDiff(filePath, withMain) {
      const viewer = document.getElementById('diff-viewer');
      const content = document.getElementById('diff-content');
      const title = document.getElementById('diff-title');
      title.textContent = (withMain ? 'Diff vs main: ' : 'Diff: ') + filePath;
      content.textContent = 'Loading...';
      viewer.classList.remove('hidden');

      try {
        const res = await fetch('/api/diff?file=' + encodeURIComponent(filePath) + (withMain ? '&withMain=true' : ''));
        const data = await res.json();
        content.textContent = data.diff || 'No diff available';
        // Color diff lines
        content.innerHTML = data.diff.split('\\n').map(line => {
          if (line.startsWith('+') && !line.startsWith('+++'))
            return '<span class="text-green-400">' + escapeHtml(line) + '</span>';
          if (line.startsWith('-') && !line.startsWith('---'))
            return '<span class="text-red-400">' + escapeHtml(line) + '</span>';
          if (line.startsWith('@@'))
            return '<span class="text-cyan-400">' + escapeHtml(line) + '</span>';
          return escapeHtml(line);
        }).join('\\n');
      } catch (err) {
        content.textContent = 'Error: ' + err.message;
      }
    }

    function closeDiff() {
      document.getElementById('diff-viewer').classList.add('hidden');
    }

    async function revertFile(filePath) {
      if (!confirm('Revert ' + filePath + '? This cannot be undone.')) return;
      try {
        const res = await fetch('/api/revert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: filePath })
        });
        const data = await res.json();
        if (data.success) location.reload();
        else alert('Revert failed: ' + data.message);
      } catch (err) { alert('Error: ' + err.message); }
    }

    async function deleteFileAction(filePath) {
      if (!confirm('Delete ' + filePath + '? This cannot be undone.')) return;
      try {
        const res = await fetch('/api/delete-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: filePath })
        });
        const data = await res.json();
        if (data.success) location.reload();
        else alert('Delete failed: ' + data.message);
      } catch (err) { alert('Error: ' + err.message); }
    }

    async function generateAIMessage() {
      const status = document.getElementById('ai-status');
      status.textContent = 'Generating...';
      try {
        const res = await fetch('/api/ai-message', { method: 'POST' });
        const data = await res.json();
        if (data.error) {
          status.textContent = data.error;
          return;
        }
        document.getElementById('commit-subject').value = data.message.split('\\n')[0];
        const bodyLines = data.message.split('\\n').slice(1).join('\\n').trim();
        if (bodyLines) document.getElementById('commit-body').value = bodyLines;
        status.textContent = 'AI message generated';
        updatePreview();
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
      }
    }

    function getCommitMessage() {
      const type = document.getElementById('commit-type').value;
      const subject = document.getElementById('commit-subject').value.trim();
      const body = document.getElementById('commit-body').value.trim();
      if (!subject) return '';
      let message = type ? type + ': ' + subject : subject;
      if (body) message += '\\n\\n' + body;
      return message;
    }

    function updatePreview() {
      const msg = getCommitMessage();
      const preview = document.getElementById('message-preview');
      const text = document.getElementById('preview-text');
      if (msg) {
        preview.classList.remove('hidden');
        text.textContent = msg;
      } else {
        preview.classList.add('hidden');
      }
    }

    // Update preview on input
    document.getElementById('commit-subject')?.addEventListener('input', updatePreview);
    document.getElementById('commit-body')?.addEventListener('input', updatePreview);
    document.getElementById('commit-type')?.addEventListener('change', updatePreview);

    async function doCommit() {
      const message = getCommitMessage();
      if (!message) {
        document.getElementById('commit-status').textContent = 'Enter a commit message first';
        return;
      }
      document.getElementById('commit-status').textContent = 'Committing...';
      try {
        const res = await fetch('/api/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('commit-status').innerHTML =
            '<span class="text-green-400">Commit created successfully</span>';
          document.getElementById('push-section').classList.remove('hidden');
        } else {
          document.getElementById('commit-status').innerHTML =
            '<span class="text-red-400">Failed: ' + escapeHtml(data.message) + '</span>';
        }
      } catch (err) {
        document.getElementById('commit-status').innerHTML =
          '<span class="text-red-400">Error: ' + escapeHtml(err.message) + '</span>';
      }
    }

    async function doPush() {
      document.getElementById('push-status').textContent = 'Pushing...';
      try {
        const res = await fetch('/api/push', { method: 'POST' });
        const data = await res.json();
        document.getElementById('push-status').innerHTML = data.success
          ? '<span class="text-green-400">Pushed to remote</span>'
          : '<span class="text-red-400">Failed: ' + escapeHtml(data.message) + '</span>';
      } catch (err) {
        document.getElementById('push-status').innerHTML =
          '<span class="text-red-400">Error: ' + escapeHtml(err.message) + '</span>';
      }
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
    </script>`;
}
