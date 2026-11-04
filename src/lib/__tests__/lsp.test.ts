import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_LSP_SERVERS, excludeCachePaths, findProgram, resolveLspLifecycle, resolveLspServers } from '../lsp';

describe('lsp servers', () => {
  it('defaults cover typescript, swift, go and cpp', () => {
    expect(Object.keys(resolveLspServers(undefined)).sort()).toEqual(['cpp', 'go', 'swift', 'typescript']);
    expect(DEFAULT_LSP_SERVERS.typescript.restart).toBe('cold');
    expect(DEFAULT_LSP_SERVERS.go.restart).toBe('cached');
  });

  it('a configured server merges field by field, adds languages and skips bad entries', () => {
    const s = resolveLspServers({
      typescript: { command: ['tsgo', 'lsp', '--stdio'], restart: 'cached' },
      python: { command: 'pyright-langserver --stdio', extensions: ['.py'] },
      'Bad Name': { command: ['x'], extensions: ['x'] },
      kotlin: { command: ['kls'] },
    });
    expect(s.typescript).toMatchObject({ command: ['tsgo', 'lsp', '--stdio'], restart: 'cached', extensions: DEFAULT_LSP_SERVERS.typescript.extensions });
    expect(s.typescript.install).toBeUndefined();
    expect(s.python).toEqual({ command: ['pyright-langserver', '--stdio'], extensions: ['py'], restart: 'cold', cachePaths: [] });
    expect(s['Bad Name']).toBeUndefined();
    expect(s.kotlin).toBeUndefined(); // no extensions
  });

  it('lifecycle numbers default and ignore nonsense', () => {
    expect(resolveLspLifecycle(undefined)).toEqual({ idleStopMinutes: { cached: 5, cold: 15 }, closedStopMinutes: 2, maxServers: 3, readyTimeoutMs: 1500 });
    expect(resolveLspLifecycle({ maxServers: 0, closedStopMinutes: 'x', idleStopMinutes: { cold: 30 } })).toMatchObject({ maxServers: 3, closedStopMinutes: 2, idleStopMinutes: { cached: 5, cold: 30 } });
  });

  it('finds a program on PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-lsp-'));
    fs.writeFileSync(path.join(dir, 'fake-ls'), '#!/bin/sh\n', { mode: 0o755 });
    expect(findProgram('fake-ls', dir)).toBe(path.join(dir, 'fake-ls'));
    expect(findProgram('nope-ls', dir)).toBeNull();
  });

  it('adds cache paths to info/exclude anchored and once', () => {
    const common = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-lsp-git-'));
    fs.mkdirSync(path.join(common, 'info'));
    fs.writeFileSync(path.join(common, 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude');
    expect(excludeCachePaths(common, ['.cache/clangd/', '../evil', '/abs'])).toEqual(['/.cache/clangd/']);
    expect(excludeCachePaths(common, ['.cache/clangd/'])).toEqual([]);
    expect(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8').split('\n').filter(l => l === '/.cache/clangd/')).toHaveLength(1);
  });
});
