// Same samples and checks as web/src/main.ts, on the AMD build with defineTheme.
(function () {
  // ms since navigation start, as in web/src/main.ts.
  const marks = {};
  const mark = (n) => { marks[n] = Math.round(performance.now()); };
  const errors = [];
  const notes = {};
  window.addEventListener('error', (e) => errors.push('error: ' + e.message));
  const post = (m) => { try { window.webkit.messageHandlers.spike.postMessage(m); } catch (e) { /* not in the harness */ } };
  const TS = "// A TypeScript sample\nimport { readFile } from 'node:fs/promises'\n\ninterface Branch { name: string; ahead: number }\n\nexport async function load(path: string): Promise<Branch[]> {\n  const text = await readFile(path, 'utf8')\n  return JSON.parse(text).map((b: Branch) => ({ ...b, ahead: b.ahead ?? 0 }))\n}\n\nconst re = /^feature\\/(?<name>[a-z-]+)$/\ntype Mode = 'diff' | 'editor'\n";
  const SWIFT_A = 'import Foundation\n\nstruct Worktree {\n    let branch: String\n    var dirty = false\n}\n\nfunc describe(_ w: Worktree) -> String {\n    return "\\(w.branch)"\n}\n';
  const SWIFT_B = 'import Foundation\n\nstruct Worktree: Codable {\n    let branch: String\n    var dirty = false\n    var ahead: Int = 0\n}\n\nfunc describe(_ w: Worktree) -> String {\n    return w.dirty ? "\\(w.branch) *" : "\\(w.branch) +\\(w.ahead)"\n}\n';
  function tokenClasses(root) {
    const set = new Set();
    root.querySelectorAll('.view-line span span').forEach((s) => s.className.split(' ').forEach((c) => c.startsWith('mtk') && set.add(c)));
    return set.size;
  }
  async function until(f, ms) {
    const end = performance.now() + ms;
    while (performance.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); }
    return f();
  }
  const loader = document.createElement('script');
  loader.src = 'vs/loader.js';
  loader.onload = () => {
    mark('script');
    require.config({ paths: { vs: 'vs' } });
    require(['vs/editor/editor.main'], async function () {
      mark('initialized');
      monaco.editor.defineTheme('kunj', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1c1b19' } });
      monaco.editor.setTheme('kunj');
      mark('theme');
      const editorEl = document.getElementById('editor');
      monaco.editor.create(editorEl, { model: monaco.editor.createModel(TS, 'typescript'), automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5 });
      mark('editor');
      const diffEl = document.getElementById('diff');
      const diff = monaco.editor.createDiffEditor(diffEl, { readOnly: true, renderSideBySide: false, automaticLayout: true, minimap: { enabled: false }, hideUnchangedRegions: { enabled: true } });
      const done = new Promise((r) => diff.onDidUpdateDiff(() => r(true)));
      diff.setModel({ original: monaco.editor.createModel(SWIFT_A, 'swift'), modified: monaco.editor.createModel(SWIFT_B, 'swift') });
      const diffOk = await Promise.race([done, new Promise((r) => setTimeout(() => r(false), 10000))]);
      mark('diff');
      notes.diffChanges = (diff.getLineChanges() || []).length;
      notes.tsTokenised = await until(() => tokenClasses(editorEl) > 4, 10000);
      notes.tsTokenClasses = tokenClasses(editorEl);
      notes.swiftTokenised = await until(() => tokenClasses(diffEl) > 3, 10000);
      notes.swiftTokenClasses = tokenClasses(diffEl);
      mark('tokenised');
      notes.languages = monaco.languages.getLanguages().length;
      mark('done');
      const result = { ok: diffOk && errors.length === 0 && notes.tsTokenised && notes.swiftTokenised, diffOk, marks, notes, errors, crossOriginIsolated: self.crossOriginIsolated };
      window.spikeResult = result;
      post({ type: 'result', result });
    });
  };
  document.head.appendChild(loader);
})();
