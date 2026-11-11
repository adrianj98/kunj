// Language server settings - `kunj lsp` and the workspace app's editor (docs/specs/language-servers.md).
// lsp.servers.<language> ({ command, extensions, restart, cachePaths }) is read from the config by
// `kunj lsp`; it is registered so `kunj config --schema` lists it.

import { registerSettings } from '../lib/settings-registry';

export function registerLspSettings(): void {
  registerSettings([
    {
      key: 'lsp.idleStopMinutes.cached',
      description: 'Stop a language server that keeps a cache on disk (gopls, sourcekit-lsp, clangd) after this many idle minutes, even with tabs open',
      type: 'number',
      defaultValue: 5,
      category: 'lsp',
    },
    {
      key: 'lsp.idleStopMinutes.cold',
      description: 'Stop a language server without a disk cache (typescript-language-server) after this many idle minutes, even with tabs open',
      type: 'number',
      defaultValue: 15,
      category: 'lsp',
    },
    {
      key: 'lsp.closedStopMinutes',
      description: "Stop a language server this many minutes after the last editor tab of its language in that worktree closes",
      type: 'number',
      defaultValue: 2,
      category: 'lsp',
    },
    {
      key: 'lsp.maxServers',
      description: 'At most this many language servers run at once; starting another stops one (a cached one first, else the least recently used)',
      type: 'number',
      defaultValue: 3,
      category: 'lsp',
    },
    {
      key: 'lsp.readyTimeoutMs',
      description: 'A go to definition waits this long for a starting server before it searches instead',
      type: 'number',
      defaultValue: 1500,
      category: 'lsp',
    },
    {
      key: 'lsp.servers',
      description: 'Language servers by language, over the built-in ones (typescript, swift, go, cpp)',
      type: 'object',
      defaultValue: {},
      category: 'lsp',
      detailedDescription:
        'An object of language: { command, extensions?, restart?, cachePaths? }. An entry replaces the built-in server ' +
        'of that language or adds a new one; see `kunj lsp list`.',
      examples: ['{"python": {"command": "pyright-langserver --stdio", "extensions": [".py"]}}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
  ]);
}
