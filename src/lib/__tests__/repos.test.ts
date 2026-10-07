import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addRepo, hideRepo, listRepos, pruneRepos, recordRepo } from '../repos';

describe('repo registry', () => {
  let tmp: string;
  let file: string;
  let repoDir: string;
  let commonDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-repos-'));
    file = path.join(tmp, 'repos.json');
    repoDir = path.join(tmp, 'project');
    commonDir = path.join(repoDir, '.git');
    fs.mkdirSync(commonDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records a repository once with its root and name', () => {
    recordRepo(commonDir, new Date('2026-01-01T00:00:00Z'), file);
    recordRepo(commonDir, new Date('2026-01-01T00:10:00Z'), file);
    const repos = listRepos({}, file);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ root: repoDir, gitCommonDir: commonDir, name: 'project', bare: false, exists: true });
    // Within the record interval the file is not rewritten
    expect(repos[0].lastSeen).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refreshes lastSeen after the record interval', () => {
    recordRepo(commonDir, new Date('2026-01-01T00:00:00Z'), file);
    recordRepo(commonDir, new Date('2026-01-01T02:00:00Z'), file);
    expect(listRepos({}, file)[0].lastSeen).toBe('2026-01-01T02:00:00.000Z');
  });

  it('treats a bare repository as its own root', () => {
    const bare = path.join(tmp, 'bare.git');
    fs.mkdirSync(bare);
    recordRepo(bare, new Date(), file);
    expect(listRepos({}, file)[0]).toMatchObject({ root: bare, name: 'bare.git', bare: true });
  });

  it('keeps a hidden repository hidden when recorded again, until added', () => {
    recordRepo(commonDir, new Date('2026-01-01T00:00:00Z'), file);
    expect(hideRepo(repoDir, file)?.name).toBe('project');
    recordRepo(commonDir, new Date('2026-01-02T00:00:00Z'), file);
    expect(listRepos({}, file)).toHaveLength(0);
    expect(listRepos({ includeHidden: true }, file)[0].hidden).toBe(true);

    addRepo(commonDir, new Date(), file);
    expect(listRepos({}, file)).toHaveLength(1);
  });

  it('lists the most recently used first and prunes missing ones', () => {
    const other = path.join(tmp, 'other', '.git');
    fs.mkdirSync(other, { recursive: true });
    recordRepo(commonDir, new Date('2026-01-01T00:00:00Z'), file);
    recordRepo(other, new Date('2026-02-01T00:00:00Z'), file);
    expect(listRepos({}, file).map(r => r.name)).toEqual(['other', 'project']);

    fs.rmSync(path.join(tmp, 'other'), { recursive: true });
    expect(listRepos({}, file).find(r => r.name === 'other')?.exists).toBe(false);
    expect(pruneRepos(file).map(r => r.name)).toEqual(['other']);
    expect(listRepos({}, file).map(r => r.name)).toEqual(['project']);
  });
});
