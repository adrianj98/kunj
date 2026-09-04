import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmp: string;
let keepRoot: string;

jest.mock('../config', () => ({
  getKunjDir: () => keepRoot,
}));

import { keepFile, listKeptFiles, applyKeptFiles, deleteKeptFile, toRelativeKeepPath, getKeepDir } from '../keep';

describe('keep files', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-keep-'));
    keepRoot = path.join(tmp, 'kunj');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores under <kunjDir>/keep', () => {
    expect(getKeepDir()).toBe(path.join(keepRoot, 'keep'));
  });

  it('normalises paths relative to the worktree root and rejects outside paths', () => {
    const root = path.join(tmp, 'wt');
    expect(toRelativeKeepPath('config/.env', root, root)).toBe('config/.env');
    expect(toRelativeKeepPath(path.join(root, '.env'), root, '/elsewhere')).toBe('.env');
    expect(() => toRelativeKeepPath('../.env', root, root)).toThrow('inside the worktree');
  });

  it('round-trips keep, list, apply and delete', () => {
    const wt1 = path.join(tmp, 'wt1');
    const wt2 = path.join(tmp, 'wt2');
    fs.mkdirSync(path.join(wt1, 'config'), { recursive: true });
    fs.mkdirSync(wt2, { recursive: true });
    fs.writeFileSync(path.join(wt1, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(wt1, 'config', 'local.json'), '{"a":1}');

    keepFile('.env', wt1);
    keepFile('config/local.json', wt1);
    expect(listKeptFiles()).toEqual(['.env', 'config/local.json']);

    const applied = applyKeptFiles(wt2);
    expect(applied).toEqual(['.env', 'config/local.json']);
    expect(fs.readFileSync(path.join(wt2, '.env'), 'utf8')).toBe('SECRET=1');
    expect(fs.readFileSync(path.join(wt2, 'config', 'local.json'), 'utf8')).toBe('{"a":1}');

    // Updating a kept file overwrites the stored copy
    fs.writeFileSync(path.join(wt1, '.env'), 'SECRET=2');
    keepFile('.env', wt1);
    applyKeptFiles(wt2);
    expect(fs.readFileSync(path.join(wt2, '.env'), 'utf8')).toBe('SECRET=2');

    expect(deleteKeptFile('config/local.json')).toBe(true);
    expect(deleteKeptFile('config/local.json')).toBe(false);
    expect(listKeptFiles()).toEqual(['.env']);
    expect(fs.existsSync(path.join(getKeepDir(), 'config'))).toBe(false);
  });

  it('keeps directories recursively', () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(wt, 'certs'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'certs', 'a.pem'), 'A');
    fs.writeFileSync(path.join(wt, 'certs', 'b.pem'), 'B');
    keepFile('certs', wt);
    expect(listKeptFiles()).toEqual(['certs/a.pem', 'certs/b.pem']);
  });

  it('throws when the source is missing', () => {
    expect(() => keepFile('missing.txt', tmp)).toThrow('File not found');
  });
});
