// Spike: monaco-vscode-api as an editor only (option B). Checks that, inside a WKWebView served
// from a custom scheme, the page can: initialize the VS Code services (configuration, languages,
// TextMate, themes), run the editor worker (the diff) and the TextMate worker (wasm), apply a
// VS Code theme and a kunj theme registered as an extension, and whether Monaco's own
// `defineTheme` still works. The result goes to `messageHandlers.spike` and `window.spikeResult`.
import { initialize } from '@codingame/monaco-vscode-api'
import { registerExtension, ExtensionHostKind } from '@codingame/monaco-vscode-api/extensions'
import getConfigurationServiceOverride, { updateUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import { whenReady as ThemeDefaultsReady } from '@codingame/monaco-vscode-theme-defaults-default-extension'
import { whenReady as TypescriptBasicsReady } from '@codingame/monaco-vscode-typescript-basics-default-extension'
import { whenReady as JavascriptReady } from '@codingame/monaco-vscode-javascript-default-extension'
import { whenReady as JsonReady } from '@codingame/monaco-vscode-json-default-extension'
import { whenReady as MarkdownBasicsReady } from '@codingame/monaco-vscode-markdown-basics-default-extension'
import { whenReady as SwiftReady } from '@codingame/monaco-vscode-swift-default-extension'
import { whenReady as PythonReady } from '@codingame/monaco-vscode-python-default-extension'
import { whenReady as GoReady } from '@codingame/monaco-vscode-go-default-extension'
import { whenReady as RustReady } from '@codingame/monaco-vscode-rust-default-extension'
import { whenReady as YamlReady } from '@codingame/monaco-vscode-yaml-default-extension'
import { whenReady as CssReady } from '@codingame/monaco-vscode-css-default-extension'
import { whenReady as HtmlReady } from '@codingame/monaco-vscode-html-default-extension'
import { whenReady as ShellscriptReady } from '@codingame/monaco-vscode-shellscript-default-extension'
import { whenReady as DockerReady } from '@codingame/monaco-vscode-docker-default-extension'
import * as monaco from 'monaco-editor'

const t0 = performance.now()
const marks: Record<string, number> = {}
const mark = (name: string) => { marks[name] = Math.round(performance.now() - t0) }
const errors: string[] = []
const workers: string[] = []
const notes: Record<string, unknown> = {}

const post = (m: unknown) => {
  try { (window as any).webkit.messageHandlers.spike.postMessage(m) } catch { /* not in the harness */ }
}
window.addEventListener('error', (e) => errors.push(`error: ${e.message} ${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${e.reason?.stack ?? e.reason}`))

// One loader per label; an unknown label is recorded, so the report shows every worker asked for.
const workerLoaders: Record<string, () => Worker> = {
  editorWorkerService: () => new Worker(new URL('@codingame/monaco-vscode-api/workers/editor.worker', import.meta.url), { type: 'module' }),
  TextMateWorker: () => new Worker(new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url), { type: 'module' }),
}
;(window as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    workers.push(label)
    const load = workerLoaders[label]
    if (!load) throw new Error(`no worker loader for ${label}`)
    const w = load()
    w.addEventListener('error', (e) => errors.push(`worker ${label}: ${(e as ErrorEvent).message ?? e.type}`))
    return w
  },
}

// A kunj theme as a VS Code colour theme extension: the app would generate this from tokens.json.
const KUNJ_THEME = {
  name: 'Kunj Warm Dark',
  type: 'dark',
  colors: { 'editor.background': '#1c1b19', 'editor.foreground': '#e8e2d6', 'editorLineNumber.foreground': '#6b655b' },
  tokenColors: [
    { scope: ['keyword', 'storage', 'storage.type'], settings: { foreground: '#c4a3d4' } },
    { scope: ['string'], settings: { foreground: '#a9c79b' } },
    { scope: ['constant.numeric'], settings: { foreground: '#dfae86' } },
    { scope: ['entity.name.type', 'support.type'], settings: { foreground: '#8fbfc8' } },
    { scope: ['comment'], settings: { foreground: '#6b655b', fontStyle: 'italic' } },
  ],
}

const TS = `// A TypeScript sample
import { readFile } from 'node:fs/promises'

interface Branch { name: string; ahead: number }

export async function load(path: string): Promise<Branch[]> {
  const text = await readFile(path, 'utf8')
  return JSON.parse(text).map((b: Branch) => ({ ...b, ahead: b.ahead ?? 0 }))
}

const re = /^feature\\/(?<name>[a-z-]+)$/
type Mode = 'diff' | 'editor'
`
const SWIFT_A = `import Foundation

struct Worktree {
    let branch: String
    var dirty = false
}

func describe(_ w: Worktree) -> String {
    return "\\(w.branch)"
}
`
const SWIFT_B = `import Foundation

struct Worktree: Codable {
    let branch: String
    var dirty = false
    var ahead: Int = 0
}

func describe(_ w: Worktree) -> String {
    return w.dirty ? "\\(w.branch) *" : "\\(w.branch) +\\(w.ahead)"
}
`

// Distinct token classes rendered in an editor's visible lines: more than a handful means a
// grammar coloured it (plain text renders one or two).
function tokenClasses(root: HTMLElement): number {
  const set = new Set<string>()
  root.querySelectorAll('.view-line span span').forEach((s) => s.className.split(' ').forEach((c) => c.startsWith('mtk') && set.add(c)))
  return set.size
}

async function until(f: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (f()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return f()
}

async function main() {
  mark('script')
  await initialize({
    ...getConfigurationServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
  })
  mark('initialized')
  // Language and theme extensions register asynchronously; a model created earlier stays plaintext.
  await Promise.all([ThemeDefaultsReady(), TypescriptBasicsReady(), JavascriptReady(), JsonReady(), MarkdownBasicsReady(), SwiftReady(), PythonReady(), GoReady(), RustReady(), YamlReady(), CssReady(), HtmlReady(), ShellscriptReady(), DockerReady()])
  mark('extensions')

  const kunjTheme = registerExtension({
    name: 'kunj-themes', publisher: 'kunj', version: '0.0.0', engines: { vscode: '*' },
    contributes: { themes: [{ id: 'Kunj Warm Dark', label: 'Kunj Warm Dark', uiTheme: 'vs-dark', path: './kunj-dark.json' }] },
  }, ExtensionHostKind.LocalProcess)
  kunjTheme.registerFileUrl('./kunj-dark.json', URL.createObjectURL(new Blob([JSON.stringify(KUNJ_THEME)], { type: 'application/json' })))
  await kunjTheme.whenReady()
  await updateUserConfiguration(JSON.stringify({ 'workbench.colorTheme': 'Kunj Warm Dark', 'editor.fontSize': 12.5 }))
  mark('theme')

  const editorEl = document.getElementById('editor')!
  const model = monaco.editor.createModel(TS, 'typescript', monaco.Uri.parse('file:///sample.ts'))
  const editor = monaco.editor.create(editorEl, { model, automaticLayout: true, minimap: { enabled: false } })
  mark('editor')

  const diffEl = document.getElementById('diff')!
  const diff = monaco.editor.createDiffEditor(diffEl, {
    readOnly: true, renderSideBySide: false, automaticLayout: true, minimap: { enabled: false },
    hideUnchangedRegions: { enabled: true },
  })
  const diffDone = new Promise<void>((r) => diff.onDidUpdateDiff(() => r()))
  diff.setModel({
    original: monaco.editor.createModel(SWIFT_A, 'swift', monaco.Uri.parse('file:///a/Worktree.swift')),
    modified: monaco.editor.createModel(SWIFT_B, 'swift', monaco.Uri.parse('file:///b/Worktree.swift')),
  })
  const diffOk = await Promise.race([diffDone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10000))])
  mark('diff')
  notes.diffChanges = diff.getLineChanges()?.length ?? null

  notes.tsTokenised = await until(() => tokenClasses(editorEl) > 4, 10000)
  notes.tsTokenClasses = tokenClasses(editorEl)
  notes.swiftTokenised = await until(() => tokenClasses(diffEl) > 3, 10000)
  notes.swiftTokenClasses = tokenClasses(diffEl)
  mark('tokenised')

  notes.languages = monaco.languages.getLanguages().length
  notes.tsLanguageId = model.getLanguageId()
  // The app maps file extensions to language ids itself (app.js BY_EXT); with the languages
  // service a model created without a language may get one from its file name.
  notes.languageByUri = Object.fromEntries(['Package.swift', 'Dockerfile', 'x.go', 'x.rs', 'x.yml', 'x.sh', '.zshrc', 'x.tsx', 'x.md', 'x.unknown'].map((name) => {
    const m = monaco.editor.createModel('', undefined, monaco.Uri.parse(`file:///probe/${name}`))
    const id = m.getLanguageId()
    m.dispose()
    return [name, id]
  }))
  const firstLine = editorEl.querySelector('.view-line') as HTMLElement | null
  notes.dom = {
    editorRect: JSON.stringify(editorEl.getBoundingClientRect()),
    monacoEditors: document.querySelectorAll('.monaco-editor').length,
    viewLines: editorEl.querySelectorAll('.view-line').length,
    firstLineText: firstLine?.textContent?.slice(0, 40) ?? null,
    firstLineColor: firstLine ? getComputedStyle(firstLine).color : null,
    firstLineFont: firstLine ? getComputedStyle(firstLine).font : null,
    styleSheets: document.styleSheets.length,
    styleTags: document.querySelectorAll('style').length,
    layout: JSON.stringify(editor.getLayoutInfo()).slice(0, 200),
    visible: JSON.stringify(editor.getVisibleRanges()),
    lines: model.getLineCount(),
    tree: Array.from(editorEl.querySelectorAll('*')).slice(0, 40).map((e) => e.className).filter(Boolean).join(' | ').slice(0, 1500),
    cssRules: Array.from(document.styleSheets).reduce((n, s) => { try { return n + s.cssRules.length } catch { return n } }, 0),
  }
  notes.editorBackground = getComputedStyle(editorEl.querySelector('.monaco-editor-background') ?? editorEl).backgroundColor
  // The current app themes with defineTheme/setTheme; check whether they still apply here.
  try {
    monaco.editor.defineTheme('legacy', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ff0000' } })
    monaco.editor.setTheme('legacy')
    await new Promise((r) => setTimeout(r, 300))
    notes.defineTheme = getComputedStyle(editorEl.querySelector('.monaco-editor-background')!).backgroundColor
  } catch (e) {
    notes.defineTheme = `threw: ${e}`
  }
  await updateUserConfiguration(JSON.stringify({ 'workbench.colorTheme': 'Kunj Warm Dark', 'editor.fontSize': 12.5 }))
  // Back to the kunj theme for the screenshot; switching via configuration is the live-theme path.
  await new Promise((r) => setTimeout(r, 300))
  notes.backgroundAfterSwitch = getComputedStyle(editorEl.querySelector('.monaco-editor-background')!).backgroundColor

  return diffOk
}

main().then((diffOk) => {
  mark('done')
  const result = { ok: diffOk && errors.length === 0, diffOk, marks, workers, notes, errors, crossOriginIsolated: self.crossOriginIsolated, userAgent: navigator.userAgent }
  ;(window as any).spikeResult = result
  post({ type: 'result', result })
}).catch((e) => {
  errors.push(`main: ${e?.stack ?? e}`)
  const result = { ok: false, marks, workers, notes, errors }
  ;(window as any).spikeResult = result
  post({ type: 'result', result })
})
