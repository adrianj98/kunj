import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectDefaultBranch, resolveBaseRef } from '../base-branch';

const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
const commit = (cwd: string, msg: string) =>
  run(`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m ${msg}`, cwd);

describe('base-branch', () => {
  let tmp: string;
  let origin: string;
  let clone: string;
  let upstream: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-base-'));
    upstream = path.join(tmp, 'upstream');
    origin = path.join(tmp, 'origin.git');
    clone = path.join(tmp, 'clone');
    fs.mkdirSync(upstream);
    run('git init -q -b trunk', upstream);
    commit(upstream, 'one');
    run('git branch develop', upstream);
    run(`git clone -q --bare ${upstream} ${origin}`, tmp);
    run(`git clone -q ${origin} ${clone}`, tmp);
    // origin moves on after the clone; only a fetch sees it
    run(`git remote add origin ${origin}`, upstream);
    commit(upstream, 'two');
    run('git push -q origin trunk', upstream);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects the default branch from origin/HEAD', async () => {
    expect(await detectDefaultBranch(clone)).toBe('trunk');
  });

  it('fetches and uses origin/<default> by default', async () => {
    const base = await resolveBaseRef({ cwd: clone });
    expect(base).toMatchObject({ ref: 'origin/trunk', branch: 'trunk', fromOrigin: true });
    expect(run('git rev-parse origin/trunk', clone)).toBe(run('git rev-parse trunk', upstream));
  });

  it('uses the local branch when origin is turned off', async () => {
    expect(await resolveBaseRef({ cwd: clone, fromOrigin: false })).toMatchObject({ ref: 'trunk', fromOrigin: false });
  });

  it('prefers --base over the configured default', async () => {
    expect(await resolveBaseRef({ cwd: clone, base: 'develop', defaultBase: 'trunk' })).toMatchObject({ ref: 'origin/develop' });
    expect(await resolveBaseRef({ cwd: clone, defaultBase: 'develop' })).toMatchObject({ ref: 'origin/develop' });
  });

  it('uses a commit or origin/<branch> as given', async () => {
    const sha = run('git rev-parse HEAD', clone);
    expect(await resolveBaseRef({ cwd: clone, base: sha })).toMatchObject({ ref: sha, fromOrigin: false });
    expect(await resolveBaseRef({ cwd: clone, base: 'origin/develop', fromOrigin: false })).toMatchObject({ ref: 'origin/develop' });
  });

  it('falls back to a local-only branch with a warning', async () => {
    run('git branch local-only', clone);
    const base = await resolveBaseRef({ cwd: clone, base: 'local-only' });
    expect(base).toMatchObject({ ref: 'local-only', fromOrigin: false });
    expect(base?.warning).toMatch(/not on origin/);
  });

  it('throws for a base that does not exist', async () => {
    await expect(resolveBaseRef({ cwd: clone, base: 'nope' })).rejects.toThrow(/Base branch 'nope' not found/);
  });

  it('returns null with no base and no main/master in a repo without origin', async () => {
    const lone = path.join(tmp, 'lone');
    fs.mkdirSync(lone);
    run('git init -q -b trunk', lone);
    commit(lone, 'one');
    expect(await resolveBaseRef({ cwd: lone })).toBeNull();
  });
});
