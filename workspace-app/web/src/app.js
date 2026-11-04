// The Monaco page (monaco-vscode-api, started by main.ts). Swift (MonacoWebView) calls
// `window.kunj[name](args)` with one argument object and receives messages posted to
// `window.webkit.messageHandlers.kunj`: `ready` once the editor is up, `error` for page errors. Modes:
// `?mode=diff` (the Changes column) and `?mode=editor` (the editor tabs: one model per open file, keyed
// by the tab id; posts `dirty` and `save` with the id only, so the page never names a file to Swift).
import * as monaco from 'monaco-editor';
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions';
import { updateUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override';

export async function start() {
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

  // A model's language comes from its URI (the language extensions' file names and extensions); each
  // model gets a unique one under /kunj/<n>/ so two sides or two tabs of one file never collide.
  let modelCount = 0;
  function newModel(text, path, language) {
    const name = String(path || '').replace(/^\/+/, '');
    if (language) return monaco.editor.createModel(text, language);
    if (!name) return monaco.editor.createModel(text, 'plaintext');
    const uri = monaco.Uri.from({ scheme: 'file', path: `/kunj/${++modelCount}/${name}` });
    return monaco.editor.createModel(text, undefined, uri);
  }
  function languageFor(path) {
    const m = newModel('', path);
    const id = m.getLanguageId();
    m.dispose();
    return id;
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
    const rule = (scope, color) => ({ scope, settings: { foreground: '#' + color } });
    return [
      rule(['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'], c.keyword),
      rule(['string', 'string.quoted', 'string.template'], c.string),
      rule(['constant.character.escape', 'string.regexp'], c.regexp),
      rule(['constant.numeric', 'constant.language', 'constant.other', 'support.constant'], c.number),
      rule(['entity.name.type', 'entity.name.class', 'entity.name.interface', 'entity.name.enum', 'support.type',
        'support.class', 'meta.decorator', 'support.type.property-name', 'entity.name.namespace'], c.type),
      rule(['entity.other.attribute-name'], c.number),
      rule(['entity.name.tag', 'variable.language', 'support.variable'], c.tag),
    ];
  }

  // setTheme registers each theme as a VS Code colour-theme extension under a new id (a theme
  // extension cannot be changed once registered) and selects it.
  let themeCount = 0;
  async function applyTheme(dark, colors, tokenColors) {
    const id = `kunj-${++themeCount}`;
    const ext = registerExtension({
      name: id, publisher: 'kunj', version: '0.0.0', engines: { vscode: '*' },
      contributes: { themes: [{ id, label: id, uiTheme: dark ? 'vs-dark' : 'vs', path: `./${id}.json` }] },
    }, ExtensionHostKind.LocalProcess);
    const json = JSON.stringify({ name: id, type: dark ? 'dark' : 'light', colors, tokenColors, semanticHighlighting: false });
    ext.registerFileUrl(`./${id}.json`, URL.createObjectURL(new Blob([json], { type: 'application/json' })));
    await ext.whenReady();
    await updateUserConfiguration(JSON.stringify({ 'workbench.colorTheme': id, 'editor.semanticHighlighting.enabled': false }));
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
      // The diff is in the ramp's text colours only, as the mockup's is (status colours are the
      // design's only chroma, DESIGN.md principle 4); editor tabs get muted syntax colours.
      const tokenColors = [
        { settings: { foreground: t.text2 } },
        { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: t.muted } },
      ].concat(mode === 'editor' ? syntaxRules(t.dark) : []);
      const colors = Object.assign(brackets, {
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
        });
      return applyTheme(t.dark, colors, tokenColors).then(() => true);
    },

    /** Shows one file's two sides; resolves once the diff is shown ({ changes, language }). */
    showDiff({ original, modified, language, path }) {
      original = original || '';
      modified = modified || '';
      if ((original === '') !== (modified === '')) {
        return showSingle(original === '' ? modified : original, original === '', path, language);
      }
      const dispose = replaceModels([newModel(original, path, language), newModel(modified, path, language)]);
      const lang = models[1].getLanguageId();
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
      const model = newModel(content || '', path, language);
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
      // kunj counts characters (code points); Monaco counts UTF-16 units, so an emoji before the
      // match would shift the selection
      const model = code.getModel();
      line = Math.min(Math.max(1, line || 1), model.getLineCount());
      const chars = Array.from(model.getLineContent(line));
      const start = Math.min(Math.max(1, column || 1) - 1, chars.length);
      const col = chars.slice(0, start).join('').length + 1;
      const len = chars.slice(start, start + Math.max(0, length || 0)).join('').length;
      code.setSelection(new monaco.Selection(line, col, line, col + len));
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
    wireDefinition(code, () => (current ? { id: current } : null));
  }

  function showSingle(text, added, path, language) {
    const model = newModel(text, path, language);
    const lang = model.getLanguageId();
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

  // ---- go to declaration (both modes) ----
  // ⌘-click or F12 on a name posts { type: 'definition', word, line } (plus the tab id in editor
  // mode); Swift searches the environment for its declaration and opens it. No path is ever sent.
  function definitionAt(ed, position) {
    const model = ed.getModel();
    if (!model || !position) return null;
    const w = model.getWordAtPosition(position);
    return w ? { word: w.word, line: position.lineNumber } : null;
  }

  function wireDefinition(ed, extra) {
    const send = (position) => {
      const d = definitionAt(ed, position);
      const more = extra();
      if (d && more) post(Object.assign({ type: 'definition' }, d, more));
    };
    ed.onMouseDown((e) => {
      const ev = e.event;
      if (!ev.metaKey || ev.altKey || ev.shiftKey || !ev.leftButton) return;
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      ev.preventDefault();
      ev.stopPropagation();
      send(e.target.position);
    });
    ed.addAction({
      id: 'kunj.goToDeclaration',
      label: 'Go to Declaration',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (e) => send(e.getPosition()),
    });
  }

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
    wireDefinition(editor.getModifiedEditor(), () => ({ side: 'modified' }));
    wireDefinition(editor.getOriginalEditor(), () => ({ side: 'original' }));
    wireDefinition(single, () => ({ side: 'single' }));
  }

  // Monaco measures the font when an editor is created: load it first.
  try { await document.fonts.load(`${FONT_SIZE}px 'JetBrains Mono'`); } catch (e) { /* fallback font */ }
  // The other mode's empty panes cover the whole page (inset: 0) and would take every click
  // and wheel event (#editor is last, so on top of the diff): take them out of the page.
  for (const id of mode === 'diff' ? ['editor'] : ['diff', 'single']) {
    document.getElementById(id).style.display = 'none';
  }
  if (mode === 'diff') createDiff();
  else createEditor();
  post({ type: 'ready', mode });
}
