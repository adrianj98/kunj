// The Monaco page. Swift (MonacoWebView) calls `window.kunj[name](args)` with one argument object
// and receives messages posted to `window.webkit.messageHandlers.kunj`: `ready` once Monaco is up,
// `error` for page errors. Modes: `?mode=diff` (the Changes column) and `?mode=editor` (the editor
// tabs: one model per open file, keyed by the tab id; posts `dirty` and `save` with the id only, so
// the page never names a file to Swift).
(function () {
  'use strict';
  const mode = new URLSearchParams(location.search).get('mode') || 'diff';
  const post = (m) => {
    try { window.webkit.messageHandlers.kunj.postMessage(m); } catch (e) { /* not in the app */ }
  };
  window.onerror = (msg, src, line) => post({ type: 'error', message: String(msg) + ' ' + src + ':' + line });
  window.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: 'unhandled: ' + e.reason }));

  const FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
  const FONT_SIZE = 11.5; // tokens.json type.mono-diff: 11.5px / 1.65
  const LINE_HEIGHT = Math.round(11.5 * 1.65);
  const EDITOR_FONT_SIZE = 12.5; // the terminal's size: an editor tab sits where terminals do

  // Language ids by file extension (Monaco's basic languages), or by file name.
  const BY_EXT = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', mdx: 'mdx',
    swift: 'swift', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
    m: 'objective-c', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml',
    css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml', plist: 'xml', svg: 'xml',
    sql: 'sql', graphql: 'graphql', gql: 'graphql', lua: 'lua', r: 'r', dart: 'dart', scala: 'scala',
    ini: 'ini', toml: 'ini', proto: 'proto', tf: 'hcl', hcl: 'hcl', ps1: 'powershell', vue: 'html',
  };
  const BY_NAME = { dockerfile: 'dockerfile', makefile: 'shell', '.gitignore': 'shell', '.env': 'shell' };
  function languageFor(path) {
    const name = String(path || '').split('/').pop().toLowerCase();
    if (BY_NAME[name]) return BY_NAME[name];
    if (name.startsWith('dockerfile')) return 'dockerfile';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? (BY_EXT[name.slice(dot + 1)] || 'plaintext') : 'plaintext';
  }

  // `#rrggbb` + alpha (0–1) as `#rrggbbaa`.
  function alpha(hex, a) {
    const h = Math.round(a * 255).toString(16).padStart(2, '0');
    return String(hex).slice(0, 7) + h;
  }

  // Editor tabs' token colours: desaturated, so code reads coloured without competing with the
  // status colours.
  const SYNTAX = {
    dark: { keyword: 'c4a3d4', string: 'a9c79b', number: 'dfae86', type: '8fbfc8', tag: 'd59b9b', regexp: 'd9a07a' },
    light: { keyword: '84509a', string: '4c7a3c', number: 'a35b22', type: '2c7380', tag: 'a34848', regexp: '9a5a1f' },
  };
  function syntaxRules(dark) {
    const c = dark ? SYNTAX.dark : SYNTAX.light;
    return [
      { token: 'keyword', foreground: c.keyword },
      { token: 'storage', foreground: c.keyword },
      { token: 'string', foreground: c.string },
      { token: 'string.escape', foreground: c.regexp },
      { token: 'regexp', foreground: c.regexp },
      { token: 'number', foreground: c.number },
      { token: 'constant', foreground: c.number },
      { token: 'type', foreground: c.type },
      { token: 'type.identifier', foreground: c.type },
      { token: 'annotation', foreground: c.type },
      { token: 'string.key.json', foreground: c.type },
      { token: 'key', foreground: c.type },
      { token: 'attribute.name', foreground: c.number },
      { token: 'attribute.value', foreground: c.string },
      { token: 'tag', foreground: c.tag },
      { token: 'metatag', foreground: c.tag },
      { token: 'variable', foreground: c.tag },
      { token: 'variable.predefined', foreground: c.tag },
    ];
  }

  let editor = null; // the diff editor (diff mode)
  let single = null; // a whole added or deleted file, one side only (diff mode)
  let models = [];
  let singleDecorations = null;

  // Monaco diffs an empty side as one empty line that changed, so an added file would show a
  // deleted empty line above it: a file with one empty side is shown in `single` instead, every
  // line marked as added (or deleted), as the mockup's new file reads `1 + import …`.
  function showPane(which) {
    document.getElementById('diff').style.display = which === 'diff' ? 'block' : 'none';
    document.getElementById('single').style.display = which === 'single' ? 'block' : 'none';
  }

  function replaceModels(next) {
    const old = models;
    models = next;
    return () => { for (const m of old) m.dispose(); };
  }

  const api = {
    /** tokens: the theme's token strings plus `dark` (Bool). */
    setTheme({ tokens }) {
      const t = tokens;
      document.body.style.background = t.bg;
      const root = document.documentElement.style;
      root.setProperty('--add-bg', t.addBg);
      root.setProperty('--del-bg', alpha(t.red, 0.18));
      root.setProperty('--green', t.green);
      root.setProperty('--red', t.red);
      const brackets = {};
      for (let i = 1; i <= 6; i++) brackets['editorBracketHighlight.foreground' + i] = t.text2;
      monaco.editor.defineTheme('kunj', {
        // The diff is in the ramp's text colours only, as the mockup's is (status colours are the
        // design's only chroma, DESIGN.md principle 4); editor tabs get muted syntax colours.
        base: t.dark ? 'vs-dark' : 'vs',
        inherit: false,
        rules: [
          { token: '', foreground: t.text2.slice(1) },
          { token: 'keyword', foreground: t.text2.slice(1) },
          { token: 'comment', foreground: t.muted.slice(1) },
        ].concat(mode === 'editor' ? syntaxRules(t.dark) : []),
        colors: Object.assign(brackets, {
          'editor.background': t.bg,
          'editor.foreground': t.text2,
          'editorGutter.background': t.bg,
          'editorLineNumber.foreground': t.faintest,
          'editorLineNumber.activeForeground': t.faintest,
          'editor.lineHighlightBackground': '#00000000',
          'editor.lineHighlightBorder': '#00000000',
          'editor.selectionBackground': alpha(t.muted, 0.3),
          'editorCursor.foreground': t.text,
          'editorBracketHighlight.unexpectedBracket.foreground': t.text2,
          'editorWidget.background': t.raised2,
          'editorWidget.border': t.borderStrong,
          'input.background': t.bg,
          'input.border': t.borderStrong,
          'focusBorder': t.borderStrong,
          'diffEditor.insertedLineBackground': t.addBg,
          'diffEditor.insertedTextBackground': alpha(t.green, 0.18),
          'diffEditor.removedLineBackground': alpha(t.red, 0.18),
          'diffEditor.removedTextBackground': alpha(t.red, 0.28),
          'diffEditorGutter.insertedLineBackground': t.addBg,
          'diffEditorGutter.removedLineBackground': alpha(t.red, 0.18),
          'diffEditor.border': t.border,
          'diffEditor.unchangedRegionBackground': t.raised2,
          'diffEditor.unchangedRegionForeground': t.muted,
          'diffEditor.unchangedCodeBackground': '#00000000',
          'scrollbar.shadow': '#00000000',
          'scrollbarSlider.background': alpha(t.muted, 0.2),
          'scrollbarSlider.hoverBackground': alpha(t.muted, 0.35),
          'scrollbarSlider.activeBackground': alpha(t.muted, 0.45),
        }),
      });
      monaco.editor.setTheme('kunj');
      return true;
    },

    /** Shows one file's two sides; resolves once the diff is shown ({ changes, language }). */
    showDiff({ original, modified, language, path }) {
      const lang = language || languageFor(path);
      original = original || '';
      modified = modified || '';
      if ((original === '') !== (modified === '')) {
        return showSingle(original === '' ? modified : original, original === '', lang);
      }
      const dispose = replaceModels([monaco.editor.createModel(original, lang), monaco.editor.createModel(modified, lang)]);
      showPane('diff');
      return new Promise((resolve) => {
        let done = false;
        let d = null;
        const finish = (force) => {
          const changes = editor.getLineChanges();
          if (done || (!changes && !force)) return; // the first update only resets the diff
          done = true;
          if (d) d.dispose();
          resolve({ changes: (changes || []).length, language: lang });
        };
        d = editor.onDidUpdateDiff(() => finish(false));
        editor.setModel({ original: models[0], modified: models[1] });
        dispose();
        editor.getModifiedEditor().setScrollTop(0);
        setTimeout(() => finish(true), 3000); // identical sides or a huge file: never wait forever
      });
    },

    /** Empties the diff (no file selected). */
    clear() {
      const dispose = replaceModels([monaco.editor.createModel('', 'plaintext'), monaco.editor.createModel('', 'plaintext')]);
      editor.setModel({ original: models[0], modified: models[1] });
      single.setModel(null);
      dispose();
      showPane('diff');
      return true;
    },

    languageFor({ path }) { return languageFor(path); },
  };
  window.kunj = api;

  // ---- editor mode ----
  let code = null; // the editor (editor mode)
  const files = new Map(); // tab id -> { model, saved (alternative version id), dirty, view }
  let current = null;

  function postDirty(id, f) {
    const dirty = f.model.getAlternativeVersionId() !== f.saved;
    if (dirty === f.dirty) return;
    f.dirty = dirty;
    post({ type: 'dirty', id, dirty });
  }

  Object.assign(api, {
    /** Opens (or replaces) the tab `id`'s file and shows it. */
    openFile({ id, content, language, path }) {
      const old = files.get(id);
      if (old) old.model.dispose();
      const model = monaco.editor.createModel(content || '', language || languageFor(path));
      const f = { model, saved: model.getAlternativeVersionId(), dirty: false, view: null };
      files.set(id, f);
      model.onDidChangeContent(() => postDirty(id, f));
      if (old && old.dirty) post({ type: 'dirty', id, dirty: false });
      return api.showFile({ id });
    },

    /** Shows the tab `id`'s file, where it was scrolled to. */
    showFile({ id }) {
      const f = files.get(id);
      if (!f) return false;
      if (current === id && code.getModel() === f.model) return true;
      const prev = current && files.get(current);
      if (prev) prev.view = code.saveViewState();
      current = id;
      code.setModel(f.model);
      if (f.view) code.restoreViewState(f.view);
      return true;
    },

    /** Shows the tab `id`'s file with line `line` centred and `length` characters from `column` selected (a search match). */
    revealLine({ id, line, column, length }) {
      if (!api.showFile({ id })) return false;
      const col = Math.max(1, column || 1);
      code.setSelection(new monaco.Selection(line, col, line, col + Math.max(0, length || 0)));
      code.revealLineInCenter(line);
      return true;
    },

    closeFile({ id }) {
      const f = files.get(id);
      if (!f) return false;
      files.delete(id);
      if (current === id) { code.setModel(null); current = null; }
      f.model.dispose();
      return true;
    },

    /** The text to save and its version, which `markSaved` takes back once it is written. */
    getContent({ id }) {
      const f = files.get(id);
      if (!f) return null;
      return { content: f.model.getValue(), version: f.model.getAlternativeVersionId() };
    },

    /** `version` (from getContent) is on disk: the tab is clean while the text is that version. */
    markSaved({ id, version }) {
      const f = files.get(id);
      if (!f) return false;
      f.saved = version;
      postDirty(id, f);
      return true;
    },

    focus() { if (code) code.focus(); return true; },
  });

  function createEditor() {
    code = monaco.editor.create(document.getElementById('editor'), Object.assign({}, COMMON, {
      model: null,
      readOnly: false,
      fontSize: EDITOR_FONT_SIZE,
      lineHeight: Math.round(EDITOR_FONT_SIZE * 1.6),
      lineNumbersMinChars: 4,
      lineDecorationsWidth: 10,
      renderLineHighlight: 'line',
      contextmenu: true,
      matchBrackets: 'near',
      occurrencesHighlight: 'singleFile',
      selectionHighlight: true,
      padding: { top: 12, bottom: 12 },
      scrollBeyondLastLine: true,
    }));
    // ⌘S inside Monaco (the File > Save menu covers it when the page does not take the key)
    code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (current) post({ type: 'save', id: current });
    });
  }

  function showSingle(text, added, lang) {
    const model = monaco.editor.createModel(text, lang);
    const dispose = replaceModels([model]);
    single.setModel(model);
    editor.setModel(null);
    dispose();
    let lines = model.getLineCount();
    if (lines > 1 && model.getLineContent(lines) === '') lines -= 1; // the newline at the end
    const kind = added ? 'add' : 'del';
    const decorations = [];
    for (let i = 1; i <= lines; i++) {
      decorations.push({ range: new monaco.Range(i, 1, i, 1), options: {
        isWholeLine: true, className: `kunj-${kind}-line`, marginClassName: `kunj-${kind}-margin`,
        linesDecorationsClassName: `kunj-${kind}-sign`,
      } });
    }
    if (singleDecorations) singleDecorations.clear();
    singleDecorations = single.createDecorationsCollection(decorations);
    showPane('single');
    single.setScrollTop(0);
    return Promise.resolve({ changes: 1, language: lang });
  }

  const COMMON = {
    readOnly: true,
    automaticLayout: true,
    theme: 'kunj',
    fontFamily: FONT,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    scrollBeyondLastLine: false,
    glyphMargin: false,
    folding: false,
    lineNumbersMinChars: 3,
    lineDecorationsWidth: 14,
    renderLineHighlight: 'none',
    contextmenu: false,
    padding: { top: 6, bottom: 6 },
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
    stickyScroll: { enabled: false },
    fontLigatures: false,
    bracketPairColorization: { enabled: false },
    guides: { indentation: false, bracketPairs: false },
    matchBrackets: 'never',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
  };

  function createDiff() {
    editor = monaco.editor.createDiffEditor(document.getElementById('diff'), Object.assign({}, COMMON, {
      originalEditable: false,
      renderSideBySide: true, // Monaco switches to inline below 900 px (useInlineViewWhenSpaceIsLimited)
      renderOverviewRuler: false,
      renderMarginRevertIcon: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
    }));
    single = monaco.editor.create(document.getElementById('single'), Object.assign({}, COMMON, { model: null }));
    models = [monaco.editor.createModel('', 'plaintext'), monaco.editor.createModel('', 'plaintext')];
    editor.setModel({ original: models[0], modified: models[1] });
    showPane('diff');
  }

  const loader = document.createElement('script');
  loader.src = 'vs/loader.js';
  loader.onerror = () => post({ type: 'error', message: 'vs/loader.js did not load' });
  loader.onload = () => {
    require.config({ paths: { vs: 'vs' } });
    require(['vs/editor/editor.main'], async function () {
      // Monaco measures the font when an editor is created: load it first.
      try { await document.fonts.load(`${FONT_SIZE}px 'JetBrains Mono'`); } catch (e) { /* fallback font */ }
      monaco.editor.defineTheme('kunj', { base: 'vs-dark', inherit: true, rules: [], colors: {} });
      // The page sees one file and no node_modules, so every import would be an error: keep
      // only syntax errors.
      const ts = monaco.typescript;
      if (ts) {
        for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
          d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
        }
      }
      if (mode === 'diff') createDiff();
      else createEditor();
      post({ type: 'ready', mode });
    }, (err) => post({ type: 'error', message: 'require failed: ' + err }));
  };
  document.head.appendChild(loader);
})();
