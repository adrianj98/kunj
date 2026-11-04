// Language servers for the workspace app's editor (docs/specs/language-servers.md): which server
// serves which language, and the lifecycle numbers the app applies. `kunj lsp run` starts one in a
// worktree with stdio passed through; the app owns the child and stops it when idle.
// On the fast path: keep imports light.

import * as fs from 'fs';
import * as path from 'path';

export type LspRestart = 'cached' | 'cold';

export interface LspServerConfig {
  command: string[];
  extensions: string[];
  restart: LspRestart;
  /** Paths relative to the worktree the server writes its cache to (kept out of git status) */
  cachePaths: string[];
  /** How to install it, shown when it is missing */
  install?: string;
}

export const DEFAULT_LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: ['typescript-language-server', '--stdio'],
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
    restart: 'cold',
    cachePaths: [],
    install: 'npm i -g typescript-language-server typescript',
  },
  swift: {
    command: ['sourcekit-lsp'],
    extensions: ['swift'],
    restart: 'cached',
    cachePaths: ['.build/'],
    install: 'Install Xcode or the Swift toolchain (swift.org); sourcekit-lsp comes with it',
  },
  go: {
    command: ['gopls'],
    extensions: ['go'],
    restart: 'cached',
    cachePaths: [],
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  cpp: {
    command: ['clangd'],
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm'],
    restart: 'cached',
    cachePaths: ['.cache/clangd/'],
    install: 'xcode-select --install (or brew install llvm)',
  },
};

export interface LspLifecycle {
  idleStopMinutes: { cached: number; cold: number };
  closedStopMinutes: number;
  maxServers: number;
  readyTimeoutMs: number;
}

const LANGUAGE = /^[a-z][a-z0-9_-]{0,31}$/;

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
}

/** kunj's defaults with `lsp.servers` from the config merged in field by field; a bad entry is skipped. */
export function resolveLspServers(configured: unknown): Record<string, LspServerConfig> {
  const out: Record<string, LspServerConfig> = {};
  for (const [k, v] of Object.entries(DEFAULT_LSP_SERVERS)) out[k] = { ...v };
  if (!configured || typeof configured !== 'object') return out;
  for (const [language, raw] of Object.entries(configured as Record<string, unknown>)) {
    if (!LANGUAGE.test(language) || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const base = out[language];
    const command = strings(r.command) ?? (typeof r.command === 'string' ? r.command.split(/\s+/).filter(Boolean) : undefined) ?? base?.command;
    const extensions = (strings(r.extensions) ?? base?.extensions)?.map(e => e.replace(/^\./, '').toLowerCase());
    if (!command || command.length === 0 || !extensions) continue;
    out[language] = {
      command,
      extensions,
      restart: r.restart === 'cached' || r.restart === 'cold' ? r.restart : base?.restart ?? 'cold',
      cachePaths: strings(r.cachePaths) ?? base?.cachePaths ?? [],
      ...(base?.install && !r.command ? { install: base.install } : {}),
    };
  }
  return out;
}

function num(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
}

export function resolveLspLifecycle(lsp: Record<string, unknown> | undefined): LspLifecycle {
  const idle = (lsp?.idleStopMinutes ?? {}) as Record<string, unknown>;
  return {
    idleStopMinutes: { cached: num(idle.cached, 5, 0.5), cold: num(idle.cold, 15, 0.5) },
    closedStopMinutes: num(lsp?.closedStopMinutes, 2, 0),
    maxServers: Math.floor(num(lsp?.maxServers, 3, 1)),
    readyTimeoutMs: num(lsp?.readyTimeoutMs, 1500, 100),
  };
}

/** `program` on PATH (or as given when it has a slash), else null. */
export function findProgram(program: string, envPath = process.env.PATH ?? ''): string | null {
  const executable = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (program.includes('/')) return executable(program) ? path.resolve(program) : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, program);
    if (executable(p)) return p;
  }
  return null;
}

/** Adds each cache path to the repository's info/exclude, anchored and once; returns the lines added. */
export function excludeCachePaths(gitCommonDir: string, cachePaths: string[]): string[] {
  const lines = cachePaths
    .map(p => p.trim())
    .filter(p => p && !p.includes('\n') && !p.startsWith('/') && !p.split('/').includes('..'))
    .map(p => `/${p}`);
  if (lines.length === 0) return [];
  const file = path.join(gitCommonDir, 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* none yet */
  }
  const have = new Set(text.split('\n').map(l => l.trim()));
  const add = lines.filter(l => !have.has(l));
  if (add.length === 0) return [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# kunj lsp: language server caches\n${add.join('\n')}\n`);
  return add;
}
