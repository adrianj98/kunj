import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FakeBackend } from './fake-backend';
import { ImageInfo } from '../backend';
import { ResolvedBlueprint, blueprintHash, lockfileIds, parseBlueprint, snapshotTag } from '../blueprint';
import { LABEL, containerNames } from '../names';
import { resolvePresets } from '../presets';
import { KunjConfig } from '../../../types';

let tmp = '';

jest.mock('../lifecycle', () => ({
  startContainer: jest.fn(),
  removeContainer: jest.fn(),
  baseImageTag: jest.fn(),
}));

jest.mock('../../config', () => ({
  getGlobalKunjDir: () => path.join(tmp, 'global'),
}));

import * as lifecycle from '../lifecycle';
import { StartOptions, StartResult } from '../lifecycle';
import { SEED_COPY_SCRIPT, removeSnapshots, snapshotBlueprint, snapshotStatus, SnapshotOptions } from '../snapshot';

const mocked = lifecycle as jest.Mocked<typeof lifecycle>;

const REPO = { root: '', name: 'app', id: 'github.com/acme/app', originUrl: 'https://github.com/acme/app.git' };
const BASE = 'kunj-sandbox:9.9.9';
const NAMES = containerNames(REPO.name, REPO.id, 'main@snapshot');
const COPY = ['sh', '-c', SEED_COPY_SCRIPT];
const ENV_READ = ['sh', '-c', 'cat /etc/kunj/env 2>/dev/null || true'];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
const TEXT = '{ "tools": { "apt": ["jq"] }, "setup": ["npm ci"] }';

let originSha = '';
let warnings: string[] = [];
let logs: string[] = [];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: tmp, env: GIT_ENV }).toString().trim();
}

function blueprint(): ResolvedBlueprint {
  return { blueprint: parseBlueprint(TEXT, 'bp'), source: 'host', path: '/host/blueprint.json', text: TEXT };
}

function options(over: Partial<SnapshotOptions> = {}): SnapshotOptions {
  return {
    branch: 'main',
    blueprint: blueprint(),
    config: {
      container: { env: ['GH_TOKEN', 'SECRET=x'], keepFiles: true, files: ['~/.npmrc'], publish: ['3000'], cpus: '2' },
    } as KunjConfig,
    repo: REPO,
    kunjVersion: '9.9.9',
    cwd: tmp,
    jsonMode: false,
    rebuild: false,
    warn: m => warnings.push(m),
    log: m => logs.push(m),
    ...over,
  };
}

function startResult(over: Partial<StartResult> = {}): StartResult {
  return {
    names: NAMES,
    containerId: 'ctr-1',
    image: BASE,
    user: 'kunj',
    created: true,
    seeded: true,
    keptFiles: [],
    copiedFiles: [],
    publish: [],
    firewall: 'default',
    blueprint: {
      hash: 'h',
      snapshot: null,
      stale: false,
      toolsRun: ['apt'],
      tools: [{ name: 'apt', version: 'jq' }],
      setupRan: true,
      maintainRan: false,
    },
    ...over,
  };
}

async function expectedHash(ref: string): Promise<string> {
  const presets = await resolvePresets(['apt'], { repoRoot: tmp, globalKunjDir: path.join(tmp, 'global') });
  return blueprintHash({ text: TEXT, lockfiles: await lockfileIds([], ref, tmp), baseImage: BASE, presetHashes: presets.map(p => p.hash) });
}

function image(tag: string, hash: string, over: Partial<ImageInfo> = {}): ImageInfo {
  return { tag, id: `id-${tag}`, createdAt: '2026-10-01T00:00:00Z', labels: { [LABEL.repo]: REPO.id, [LABEL.blueprintHash]: hash }, size: 1, ...over };
}

function startOptionsPassed(): StartOptions {
  return mocked.startContainer.mock.calls[0][1];
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-snapshot-'));
  REPO.root = tmp;
  git('init', '-q', '-b', 'work');
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"v":1}');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  originSha = git('rev-parse', 'HEAD');
  // HEAD moves on, so a hash read at HEAD would differ from one at origin/main
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), '{"v":2}');
  git('commit', '-q', '-am', 'two');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  warnings = [];
  logs = [];
  mocked.baseImageTag.mockResolvedValue(BASE);
  mocked.startContainer.mockResolvedValue(startResult());
  mocked.removeContainer.mockResolvedValue({ unpushedRefs: [], stashes: 0, dirty: false, originReachable: true });
});

describe('snapshotBlueprint', () => {
  it('snapshot forwards no env and no keep files', async () => {
    const b = new FakeBackend();
    await snapshotBlueprint(b, options());
    const o = startOptionsPassed();
    expect(o.config.container).toMatchObject({ env: [], keepFiles: false, files: [], publish: [], agentCommand: '', cpus: '2' });
    expect(o).toMatchObject({
      branch: 'main',
      create: false,
      namesFor: 'main@snapshot',
      noSnapshot: true,
      skipHooks: true,
      keepOnError: false,
      rebuild: true,
      publish: [],
      hostEnv: {},
    });
    expect(o.blueprint?.text).toBe(TEXT);
    expect(o.presets?.map(p => p.name)).toEqual(['apt']);
    await expect(o.confirmPush()).resolves.toBe(false);
    await expect(o.defaultBranch?.()).resolves.toBe('main');
    // The base image is resolved with the same options the start gets
    expect(mocked.baseImageTag.mock.calls[0][0]).toBe(o);
  });

  it('copies the seed as root, commits with labels, removes temp objects and older snapshots', async () => {
    const b = new FakeBackend();
    const hash = await expectedHash('origin/main');
    const tag = snapshotTag('app', hash);
    b.images.push(image('kunj-blueprint-app:old', 'old'), image('other-repo:x', 'old'), image('kunj-blueprint-app:older', 'older'));
    const result = await snapshotBlueprint(b, options());

    const execs = b.callsOf('exec');
    expect(execs[0]).toEqual(['ctr-1', COPY, { user: 'root' }]);
    expect(SEED_COPY_SCRIPT).toBe(
      'mkdir -p /opt/kunj && rm -rf /opt/kunj/seed && cp -a /workspace /opt/kunj/seed' +
        ' && rm -f /opt/kunj/seed/.kunj-seeded /opt/kunj/seed/.kunj-fresh /opt/kunj/seed/.kunj-copying' +
        ' && chown -R "$(stat -c %u:%g /workspace)" /opt/kunj/seed'
    );
    expect(execs[1]).toEqual(['ctr-1', ENV_READ, { user: 'root' }]);

    const [id, commitTag, labels, changes] = b.callsOf('commitContainer')[0] as [string, string, Record<string, string>, string[]];
    expect([id, commitTag, changes]).toEqual(['ctr-1', tag, []]);
    expect(labels).toMatchObject({
      [LABEL.repo]: REPO.id,
      [LABEL.blueprintHash]: hash,
      [LABEL.blueprintRef]: originSha,
      [LABEL.blueprintBase]: BASE,
      [LABEL.blueprintUser]: 'kunj',
    });
    expect(labels[LABEL.blueprintCreatedAt]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(logs).toContain('Committing snapshot…');

    expect(mocked.removeContainer).toHaveBeenCalledWith(b, NAMES, expect.objectContaining({ force: true, keepVolumes: false, user: 'kunj', kunjVersion: '9.9.9' }));
    // Removed after the commit; another repository's image of the same label set is left alone
    expect(b.callsOf('removeImage')).toEqual([['kunj-blueprint-app:old'], ['kunj-blueprint-app:older']]);
    expect(b.methods().indexOf('removeImage')).toBeGreaterThan(b.methods().indexOf('commitContainer'));
    expect(b.images.map(i => i.tag)).toEqual(['other-repo:x', tag]);
    expect(result).toEqual({ tag, hash, ref: originSha, base: BASE, sizeBytes: 0, tools: [{ name: 'apt', version: 'jq' }], reused: false });
  });

  it('turns /etc/kunj/env into ENV changes', async () => {
    const b = new FakeBackend();
    b.execResults.set(ENV_READ.join(' '), {
      exitCode: 0,
      stdout: 'COREPACK_HOME=/usr/local/share/corepack\nWEIRD=a "b" $HOME\n\nnot a line\n',
    });
    await snapshotBlueprint(b, options());
    const changes = b.callsOf('commitContainer')[0][3];
    expect(changes).toEqual(['ENV COREPACK_HOME="/usr/local/share/corepack"', 'ENV WEIRD="a \\"b\\" \\$HOME"']);
    expect(warnings).toContain('Ignoring malformed line in /etc/kunj/env: not a line');
  });

  it('hashes with blueprintRef (origin/<default>)', async () => {
    const b = new FakeBackend();
    const result = await snapshotBlueprint(b, options());
    expect(result.hash).toBe(await expectedHash('origin/main'));
    expect(result.hash).not.toBe(await expectedHash('HEAD'));
    // A blueprint read from origin hashes at its own ref
    const fromRepo = await snapshotBlueprint(new FakeBackend(), options({ blueprint: { ...blueprint(), source: 'repo', ref: 'HEAD' } }));
    expect(fromRepo.hash).toBe(await expectedHash('HEAD'));
  });

  it('reuses an existing tag unless rebuild', async () => {
    const b = new FakeBackend();
    const hash = await expectedHash('origin/main');
    const tag = snapshotTag('app', hash);
    b.images.push(image(tag, hash, { size: 1234 }));
    const reused = await snapshotBlueprint(b, options());
    expect(reused).toEqual({ tag, hash, ref: '', base: BASE, sizeBytes: 1234, tools: [], reused: true });
    expect(mocked.startContainer).not.toHaveBeenCalled();
    expect(b.callsOf('commitContainer')).toEqual([]);

    const rebuilt = await snapshotBlueprint(b, options({ rebuild: true }));
    expect(rebuilt.reused).toBe(false);
    expect(mocked.startContainer).toHaveBeenCalledTimes(1);
    expect(b.callsOf('commitContainer')).toHaveLength(1);
  });

  it('cleans up on setup failure', async () => {
    const b = new FakeBackend();
    mocked.startContainer.mockRejectedValue(new Error('setup command failed (exit 1): npm ci'));
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('setup command failed (exit 1): npm ci');
    expect(b.callsOf('commitContainer')).toEqual([]);
    expect(b.callsOf('removeImage')).toEqual([]);
    // startContainer (keepOnError: false) rolled itself back; there is no result to remove
    expect(mocked.removeContainer).not.toHaveBeenCalled();
  });

  it('a failed seed copy removes the temp container and commits nothing', async () => {
    const b = new FakeBackend();
    b.execResults.set(COPY.join(' '), { exitCode: 1, stdout: '' });
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('Copying the workspace to /opt/kunj/seed failed (exit 1)');
    expect(b.callsOf('commitContainer')).toEqual([]);
    expect(mocked.removeContainer).toHaveBeenCalledTimes(1);
  });

  it('commit failure still removes the temp container', async () => {
    const b = new FakeBackend();
    b.images.push(image('kunj-blueprint-app:old', 'old'));
    b.failOn = 'commitContainer';
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('commitContainer failed');
    expect(mocked.removeContainer).toHaveBeenCalledWith(b, NAMES, expect.objectContaining({ force: true, keepVolumes: false }));
    // Older snapshots are only pruned after a successful commit
    expect(b.callsOf('removeImage')).toEqual([]);
  });

  it('a failing removal is a warning, not a failure', async () => {
    const b = new FakeBackend();
    mocked.removeContainer.mockRejectedValue(new Error('busy'));
    await expect(snapshotBlueprint(b, options())).resolves.toMatchObject({ reused: false });
    expect(warnings).toContain('Could not remove the temporary snapshot container: busy');
  });
});

describe('snapshotStatus', () => {
  it('status reports current vs others', async () => {
    const b = new FakeBackend();
    const cur = image('kunj-blueprint-app:aaa', 'aaa');
    const old = image('kunj-blueprint-app:bbb', 'bbb');
    b.images.push(cur, old, image('unrelated:aaa', 'aaa'));
    await expect(snapshotStatus(b, 'app', REPO.id, 'aaa')).resolves.toEqual({ current: cur, others: [old] });
    await expect(snapshotStatus(b, 'app', REPO.id, 'zzz')).resolves.toEqual({ current: null, others: [cur, old] });
    expect(b.callsOf('listImages')[0]).toEqual([{ [LABEL.repo]: REPO.id }]);
  });
});

describe('removeSnapshots', () => {
  it('removeSnapshots removes all tags for the repo', async () => {
    const b = new FakeBackend();
    b.images.push(image('kunj-blueprint-app:aaa', 'aaa'), image('kunj-blueprint-app:bbb', 'bbb'), image('unrelated:aaa', 'aaa'));
    b.images.push(image('kunj-blueprint-app:ccc', 'ccc', { labels: { [LABEL.repo]: 'github.com/other/app' } }));
    await expect(removeSnapshots(b, 'app', REPO.id)).resolves.toEqual(['kunj-blueprint-app:aaa', 'kunj-blueprint-app:bbb']);
    expect(b.callsOf('removeImage')).toEqual([['kunj-blueprint-app:aaa'], ['kunj-blueprint-app:bbb']]);
  });
});
