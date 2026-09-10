import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmp: string;
let repoKunjDir: string;
let globalKunjDir: string;

jest.mock('../config', () => ({
  getKunjDir: () => repoKunjDir,
  getGlobalKunjDir: () => globalKunjDir,
}));

import {
  HOOKS,
  HookError,
  configuredHookCommands,
  createHookScript,
  findHookScripts,
  getHooksDir,
  hookTemplate,
  listHookSources,
  runHook,
  worktreeHookContext,
} from '../hooks';
import { repoVariables } from '../config-vars';

const posixOnly = process.platform === 'win32' ? it.skip : it;

// A hook script that appends its arguments, cwd and KUNJ_* environment to a log file
function recordingScript(logFile: string, exitCode = 0): string {
  return [
    '#!/bin/sh',
    `echo "args=$*" >> '${logFile}'`,
    `echo "cwd=$(pwd)" >> '${logFile}'`,
    `env | grep '^KUNJ_' | sort >> '${logFile}'`,
    `exit ${exitCode}`,
    '',
  ].join('\n');
}

function writeScript(file: string, content: string, mode = 0o755): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

describe('hooks', () => {
  let repo: ReturnType<typeof repoVariables>;
  let worktree: string;
  let logFile: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-hooks-')));
    repoKunjDir = path.join(tmp, 'kunj', 'repo');
    globalKunjDir = path.join(tmp, 'kunj');
    const repoRoot = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    repo = repoVariables(path.join(repoRoot, '.git'));
    worktree = path.join(tmp, 'wt');
    fs.mkdirSync(worktree);
    logFile = path.join(tmp, 'hook.log');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps global and repo hooks under <kunjDir>/hooks', () => {
    expect(getHooksDir('global')).toBe(path.join(globalKunjDir, 'hooks'));
    expect(getHooksDir('repo')).toBe(path.join(repoKunjDir, 'hooks'));
  });

  it('describes every hook with arguments and a template', () => {
    for (const hook of HOOKS) {
      expect(hook.args.length).toBeGreaterThan(0);
      const template = hookTemplate(hook);
      expect(template.startsWith('#!/bin/sh')).toBe(true);
      expect(template).toContain(hook.name);
    }
  });

  it('finds single files and drop-in directories, global before repo, in sorted order', () => {
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create'), '#!/bin/sh\n');
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create.d', '20-second'), '#!/bin/sh\n');
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create.d', '10-first'), '#!/bin/sh\n');
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create.d', 'ignored.sample'), '#!/bin/sh\n');
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create.d', '.hidden'), '#!/bin/sh\n');
    writeScript(path.join(getHooksDir('global'), 'post-worktree-create'), '#!/bin/sh\n');
    // Other hooks are not picked up
    writeScript(path.join(getHooksDir('repo'), 'pre-worktree-delete'), '#!/bin/sh\n');

    const scripts = findHookScripts('post-worktree-create');
    expect(scripts.map(s => [s.scope, path.relative(tmp, s.path)])).toEqual([
      ['global', path.join('kunj', 'hooks', 'post-worktree-create')],
      ['repo', path.join('kunj', 'repo', 'hooks', 'post-worktree-create')],
      ['repo', path.join('kunj', 'repo', 'hooks', 'post-worktree-create.d', '10-first')],
      ['repo', path.join('kunj', 'repo', 'hooks', 'post-worktree-create.d', '20-second')],
    ]);
  });

  posixOnly('flags scripts that are not executable', () => {
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create'), '#!/bin/sh\n', 0o644);
    expect(findHookScripts('post-worktree-create')).toEqual([
      expect.objectContaining({ scope: 'repo', executable: false }),
    ]);
  });

  it('reads configured commands as a string or a list', () => {
    expect(configuredHookCommands('post-worktree-create', undefined)).toEqual([]);
    expect(configuredHookCommands('post-worktree-create', { 'post-worktree-create': '' })).toEqual([]);
    expect(configuredHookCommands('post-worktree-create', { 'post-worktree-create': ' npm install ' })).toEqual(['npm install']);
    expect(
      configuredHookCommands('post-worktree-create', { 'post-worktree-create': ['a', '', 'b'] })
    ).toEqual(['a', 'b']);
  });

  it('lists scripts and configured commands together', () => {
    writeScript(path.join(getHooksDir('repo'), 'pre-worktree-delete'), '#!/bin/sh\n');
    const sources = listHookSources('pre-worktree-delete', { 'pre-worktree-delete': 'docker compose down' });
    expect(sources).toEqual([
      expect.objectContaining({ kind: 'script', scope: 'repo' }),
      { kind: 'config', scope: 'config', target: 'docker compose down', executable: true },
    ]);
  });

  it('builds a worktree context that runs inside the worktree when it exists', () => {
    const inside = worktreeHookContext(repo, worktree, 'feature/x');
    expect(inside.cwd).toBe(worktree);
    expect(inside.args).toEqual([worktree, 'feature/x']);
    expect(inside.env).toEqual({
      KUNJ_REPO_ROOT: repo.repoRoot,
      KUNJ_REPO_CONFIG: repo.repoconfig,
      KUNJ_REPO_NAME: repo.repoName,
      KUNJ_WORKTREE_PATH: worktree,
      KUNJ_BRANCH: 'feature/x',
    });
    expect(inside.vars.worktree).toBe(worktree);
    expect(inside.vars.branch).toBe('feature/x');

    const missing = worktreeHookContext(repo, path.join(tmp, 'gone'), null);
    expect(missing.cwd).toBe(repo.repoRoot);
    expect(missing.env.KUNJ_BRANCH).toBe('');
  });

  posixOnly('runs scripts with the arguments, cwd and environment', async () => {
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create'), recordingScript(logFile));
    const result = await runHook('post-worktree-create', worktreeHookContext(repo, worktree, 'feature/x'));

    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({ kind: 'script', status: 'ok', exitCode: 0 });

    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain(`args=${worktree} feature/x`);
    expect(log).toContain(`cwd=${worktree}`);
    expect(log).toContain('KUNJ_HOOK=post-worktree-create');
    expect(log).toContain('KUNJ_BRANCH=feature/x');
    expect(log).toContain(`KUNJ_WORKTREE_PATH=${worktree}`);
    expect(log).toContain(`KUNJ_REPO_ROOT=${repo.repoRoot}`);
  });

  posixOnly('runs configured commands through the shell with variables expanded', async () => {
    const result = await runHook('post-worktree-create', worktreeHookContext(repo, worktree, 'feature/x'), {
      hooks: { 'post-worktree-create': [`echo "${'${branch}'} in ${'${worktree}'} of ${'${repoName}'}" > '${logFile}'`, 'true'] },
    });
    expect(result.ok).toBe(true);
    expect(result.executions.map(e => e.status)).toEqual(['ok', 'ok']);
    expect(result.executions[0].kind).toBe('config');
    expect(result.executions[0].command).toContain(`feature/x in ${worktree} of ${repo.repoName}`);
    expect(fs.readFileSync(logFile, 'utf8').trim()).toBe(`feature/x in ${worktree} of ${repo.repoName}`);
  });

  posixOnly('a failing pre hook throws a HookError and stops later hooks', async () => {
    writeScript(path.join(getHooksDir('global'), 'pre-worktree-delete'), recordingScript(logFile, 3));
    writeScript(path.join(getHooksDir('repo'), 'pre-worktree-delete'), recordingScript(logFile));

    let error: unknown;
    try {
      await runHook('pre-worktree-delete', worktreeHookContext(repo, worktree, 'feature/x'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HookError);
    const { result, message } = error as HookError;
    expect(message).toMatch(/pre-worktree-delete hook failed \(exit code 3\)/);
    expect(result.ok).toBe(false);
    expect(result.executions).toHaveLength(1); // the repo hook did not run
    expect(fs.readFileSync(logFile, 'utf8').match(/args=/g)).toHaveLength(1);
  });

  posixOnly('a failing post hook is reported but does not throw', async () => {
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-delete.d', '1-fail'), recordingScript(logFile, 1));
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-delete.d', '2-ok'), recordingScript(logFile));

    const result = await runHook('post-worktree-delete', worktreeHookContext(repo, worktree, 'feature/x'));
    expect(result.ok).toBe(false);
    expect(result.executions.map(e => e.status)).toEqual(['failed', 'ok']);
    expect(result.executions[0].exitCode).toBe(1);
  });

  posixOnly('skips non-executable scripts with a reason', async () => {
    writeScript(path.join(getHooksDir('repo'), 'post-worktree-create'), recordingScript(logFile), 0o644);
    const result = await runHook('post-worktree-create', worktreeHookContext(repo, worktree, 'x'));
    expect(result.ok).toBe(true);
    expect(result.executions[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('not executable') });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  posixOnly('does nothing when hooks are disabled', async () => {
    writeScript(path.join(getHooksDir('repo'), 'pre-worktree-create'), recordingScript(logFile, 1));
    const result = await runHook('pre-worktree-create', worktreeHookContext(repo, worktree, 'x'), { skip: true });
    expect(result).toEqual({ hook: 'pre-worktree-create', enabled: false, executions: [], ok: true });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('rejects unknown hooks', async () => {
    await expect(runHook('nope' as any, worktreeHookContext(repo, worktree, 'x'))).rejects.toThrow(/Unknown hook 'nope'/);
    expect(() => createHookScript('nope' as any, 'repo')).toThrow(/Unknown hook/);
  });

  it('scaffolds an executable script and refuses to overwrite without force', () => {
    const file = createHookScript('post-worktree-create', 'repo');
    expect(file).toBe(path.join(getHooksDir('repo'), 'post-worktree-create'));
    expect(fs.readFileSync(file, 'utf8')).toContain('post-worktree-create');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    }
    expect(() => createHookScript('post-worktree-create', 'repo')).toThrow(/already exists/);
    fs.writeFileSync(file, '#!/bin/sh\necho custom\n');
    createHookScript('post-worktree-create', 'repo', true);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('custom');
  });
});
