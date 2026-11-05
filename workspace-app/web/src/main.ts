// Starts monaco-vscode-api as an editor only (VS Code's configuration, languages, TextMate and theme
// services, the default language extensions; no workbench, no extension host), then hands over to
// app.js, which builds the diff or the editor and talks to Swift. See docs/specs/language-servers.md.
import { initialize } from '@codingame/monaco-vscode-api'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import { whenReady as themeDefaults } from '@codingame/monaco-vscode-theme-defaults-default-extension'
import { whenReady as typescriptBasics } from '@codingame/monaco-vscode-typescript-basics-default-extension'
import { whenReady as javascript } from '@codingame/monaco-vscode-javascript-default-extension'
import { whenReady as json } from '@codingame/monaco-vscode-json-default-extension'
import { whenReady as markdownBasics } from '@codingame/monaco-vscode-markdown-basics-default-extension'
import { whenReady as swift } from '@codingame/monaco-vscode-swift-default-extension'
import { whenReady as python } from '@codingame/monaco-vscode-python-default-extension'
import { whenReady as go } from '@codingame/monaco-vscode-go-default-extension'
import { whenReady as rust } from '@codingame/monaco-vscode-rust-default-extension'
import { whenReady as yaml } from '@codingame/monaco-vscode-yaml-default-extension'
import { whenReady as css } from '@codingame/monaco-vscode-css-default-extension'
import { whenReady as html } from '@codingame/monaco-vscode-html-default-extension'
import { whenReady as shellscript } from '@codingame/monaco-vscode-shellscript-default-extension'
import { whenReady as docker } from '@codingame/monaco-vscode-docker-default-extension'
import { whenReady as cpp } from '@codingame/monaco-vscode-cpp-default-extension'
import { whenReady as java } from '@codingame/monaco-vscode-java-default-extension'
import { whenReady as ruby } from '@codingame/monaco-vscode-ruby-default-extension'
import { whenReady as sql } from '@codingame/monaco-vscode-sql-default-extension'
import { whenReady as xml } from '@codingame/monaco-vscode-xml-default-extension'
import { whenReady as ini } from '@codingame/monaco-vscode-ini-default-extension'
import { whenReady as php } from '@codingame/monaco-vscode-php-default-extension'
import { whenReady as csharp } from '@codingame/monaco-vscode-csharp-default-extension'
import { whenReady as lua } from '@codingame/monaco-vscode-lua-default-extension'
import { whenReady as r } from '@codingame/monaco-vscode-r-default-extension'
import { whenReady as dart } from '@codingame/monaco-vscode-dart-default-extension'
import { whenReady as powershell } from '@codingame/monaco-vscode-powershell-default-extension'
import { start } from './app.js'

const post = (m: unknown) => {
  try { (window as any).webkit.messageHandlers.kunj.postMessage(m) } catch { /* not in the app */ }
}

// Explicit worker labels (the spike's finding): the diff runs in the editor worker, the grammars in
// the TextMate worker.
const workers: Record<string, () => Worker> = {
  editorWorkerService: () => new Worker(new URL('@codingame/monaco-vscode-api/workers/editor.worker', import.meta.url), { type: 'module' }),
  TextMateWorker: () => new Worker(new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url), { type: 'module' }),
}
;(window as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    const load = workers[label]
    if (!load) throw new Error(`no worker for ${label}`)
    return load()
  },
}

// The web view is often created before it has a frame (the Changes column is laid out later), and
// VS Code's layout service throws "Unable to figure out browser width and height" at 0×0.
function hasSize() {
  return document.documentElement.clientWidth > 0 && document.documentElement.clientHeight > 0
}
function whenSized(): Promise<void> {
  if (hasSize()) return Promise.resolve()
  return new Promise((resolve) => {
    const check = () => { if (hasSize()) { window.removeEventListener('resize', check); clearInterval(t); resolve() } }
    window.addEventListener('resize', check)
    const t = setInterval(check, 100)
  })
}

async function boot() {
  await whenSized()
  await initialize({
    ...getConfigurationServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
  })
  // a model created before its language's extension registered stays plain text
  await Promise.all([themeDefaults(), typescriptBasics(), javascript(), json(), markdownBasics(), swift(), python(), go(),
    rust(), yaml(), css(), html(), shellscript(), docker(), cpp(), java(), ruby(), sql(), xml(), ini(), php(), csharp(),
    lua(), r(), dart(), powershell()])
  await start()
}

boot().catch((e) => post({ type: 'error', message: 'startup failed: ' + (e?.stack ?? e) }))
