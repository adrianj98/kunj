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
const actualLifecycle = jest.requireActual('../lifecycle') as typeof import('../lifecycle');

jest.mock('../../config', () => ({
  getGlobalKunjDir: () => path.join(tmp, 'global'),
}));

import * as lifecycle from '../lifecycle';
import { StartOptions, StartResult } from '../lifecycle';
import {
  BUNDLE_CONTAINER_PATH,
  SEED_COPY_SCRIPT,
  SNAPSHOT_READ_SCRIPT,
  ensureSnapshot,
  makeBranchBundle,
  removeSnapshots,
  snapshotBlueprint,
  snapshotStatus,
  SnapshotOptions,
} from '../snapshot';

const mocked = lifecycle as jest.Mocked<typeof lifecycle>;

const REPO = { root: '', name: 'app', id: 'github.com/acme/app', originUrl: 'https://github.com/acme/app.git' };
const BASE = 'kunj-sandbox:9.9.9';
const NAMES = containerNames(REPO.name, REPO.id, 'main:snapshot');
const COPY = ['sh', '-c', SEED_COPY_SCRIPT];
const READ = ['sh', '-c', SNAPSHOT_READ_SCRIPT];
const SHA = 'a'.repeat(40);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
const TEXT = '{ "tools": { "apt": ["jq"] }, "setup": ["npm ci"] }';

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

// The container's HEAD, then the presets' env file
function backendWith(env = ''): FakeBackend {
  const b = new FakeBackend();
  b.execResults.set(READ.join(' '), { exitCode: 0, stdout: `${SHA}\n${env}` });
  return b;
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
  // A real origin, which the host-side bundle fetches main from
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(tmp, 'origin.git')]);
  git('remote', 'add', 'origin', path.join(tmp, 'origin.git'));
  git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
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
  mocked.removeContainer.mockImplementation(actualLifecycle.removeContainer);
});

describe('snapshotBlueprint', () => {
  it('snapshot forwards no env and no keep files', async () => {
    const b = backendWith();
    await snapshotBlueprint(b, options());
    const o = startOptionsPassed();
    expect(o.config.container).toMatchObject({ env: [], keepFiles: false, files: [], publish: [], agentCommand: '', cpus: '2' });
    expect(o).toMatchObject({
      branch: 'main',
      create: false,
      namesFor: 'main:snapshot',
      noSnapshot: true,
      ignoreForwardPorts: true,
      // DinD never runs in a snapshot: /var/lib/docker must not end up in an image
      withoutDind: true,
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

  it('keeps container.services, so the temporary container starts them before setup', async () => {
    const b = backendWith();
    const services = { postgres: { image: 'postgres:16-alpine' } };
    await snapshotBlueprint(b, options({ config: { container: { services } } as unknown as KunjConfig }));
    expect(startOptionsPassed().config.container?.services).toEqual(services);
    // The temporary objects, services included, are removed by removeContainer with the snapshot's names
    expect(mocked.removeContainer.mock.calls.every(c => c[1].container === NAMES.container)).toBe(true);
  });

  it('removes a leftover temporary container and its volumes before starting', async () => {
    const b = backendWith();
    b.existing.push({
      id: 'old-ctr',
      name: NAMES.container,
      state: 'exited',
      image: BASE,
      createdAt: '',
      labels: { [LABEL.repo]: REPO.id, [LABEL.branch]: 'main:snapshot' },
      ports: [],
    });
    b.volumes.add(NAMES.workspaceVolume);
    b.volumes.add(NAMES.homeVolume);
    await snapshotBlueprint(b, options());
    expect(b.callsOf('remove')[0]).toEqual([
      { containers: [NAMES.helper, NAMES.container], volumes: [NAMES.workspaceVolume, NAMES.homeVolume, NAMES.dockerVolume], networks: [NAMES.network] },
    ]);
    expect(mocked.removeContainer.mock.invocationCallOrder[0]).toBeLessThan(mocked.startContainer.mock.invocationCallOrder[0]);
    expect(mocked.removeContainer.mock.calls[0][2]).toMatchObject({ force: true, keepVolumes: false });
  });

  it('copies the seed as root, commits with labels, removes temp objects and older snapshots', async () => {
    const b = backendWith();
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
    expect(execs[1]).toEqual(['ctr-1', READ, { user: 'root' }]);
    expect(SNAPSHOT_READ_SCRIPT).toBe(
      'git -c safe.directory=/workspace -C /workspace rev-parse HEAD 2>/dev/null || echo; cat /etc/kunj/env 2>/dev/null || true'
    );

    const [id, commitTag, labels, changes] = b.callsOf('commitContainer')[0] as [string, string, Record<string, string>, string[]];
    expect([id, commitTag, changes]).toEqual(['ctr-1', tag, []]);
    expect(labels).toMatchObject({
      [LABEL.repo]: REPO.id,
      [LABEL.blueprintHash]: hash,
      // The commit checked out in the container, not the host's possibly stale origin/main
      [LABEL.blueprintRef]: SHA,
      [LABEL.blueprintBase]: BASE,
      [LABEL.blueprintUser]: 'kunj',
    });
    expect(labels[LABEL.blueprintCreatedAt]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(logs).toContain('Committing snapshot…');

    // Once before the start (leftovers), once after the commit
    expect(mocked.removeContainer).toHaveBeenCalledTimes(2);
    expect(mocked.removeContainer).toHaveBeenLastCalledWith(b, NAMES, expect.objectContaining({ force: true, keepVolumes: false, user: 'kunj', kunjVersion: '9.9.9' }));
    // Removed after the commit; another repository's image of the same label set is left alone
    expect(b.callsOf('removeImage')).toEqual([['kunj-blueprint-app:old'], ['kunj-blueprint-app:older']]);
    expect(b.methods().indexOf('removeImage')).toBeGreaterThan(b.methods().indexOf('commitContainer'));
    expect(b.images.map(i => i.tag)).toEqual(['other-repo:x', tag]);
    expect(result).toEqual({ tag, hash, ref: SHA, base: BASE, sizeBytes: 0, tools: [{ name: 'apt', version: 'jq' }], reused: false, viaBundle: true });
  });

  it('turns /etc/kunj/env into ENV changes', async () => {
    const b = backendWith('COREPACK_HOME=/usr/local/share/corepack\nWEIRD=a "b" $HOME\n\nnot a line\n');
    await snapshotBlueprint(b, options());
    const changes = b.callsOf('commitContainer')[0][3];
    expect(changes).toEqual(['ENV COREPACK_HOME="/usr/local/share/corepack"', 'ENV WEIRD="a \\"b\\" \\$HOME"']);
    expect(warnings).toContain('Ignoring malformed line in /etc/kunj/env: not a line');
  });

  it('refuses to commit when the container commit cannot be read', async () => {
    const b = new FakeBackend();
    b.execResults.set(READ.join(' '), { exitCode: 0, stdout: '\nA=1\n' });
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('Could not read the commit checked out in the snapshot container');
    expect(b.callsOf('commitContainer')).toEqual([]);
    expect(mocked.removeContainer).toHaveBeenCalledTimes(2);
  });

  it('hashes with blueprintRef (origin/<default>)', async () => {
    const b = backendWith();
    const result = await snapshotBlueprint(b, options());
    expect(result.hash).toBe(await expectedHash('origin/main'));
    expect(result.hash).not.toBe(await expectedHash('HEAD'));
    // A blueprint read from origin hashes at its own ref
    const fromRepo = await snapshotBlueprint(backendWith(), options({ blueprint: { ...blueprint(), source: 'repo', ref: 'HEAD' } }));
    expect(fromRepo.hash).toBe(await expectedHash('HEAD'));
  });

  it('reuses an existing tag unless rebuild', async () => {
    const b = backendWith();
    const hash = await expectedHash('origin/main');
    const tag = snapshotTag('app', hash);
    b.images.push(image(tag, hash, { size: 1234, labels: { [LABEL.repo]: REPO.id, [LABEL.blueprintHash]: hash, [LABEL.blueprintRef]: 'f00d' } }));
    const reused = await snapshotBlueprint(b, options());
    expect(reused).toEqual({ tag, hash, ref: 'f00d', base: BASE, sizeBytes: 1234, tools: [], reused: true, viaBundle: false });
    expect(mocked.startContainer).not.toHaveBeenCalled();
    expect(mocked.removeContainer).not.toHaveBeenCalled();
    expect(b.callsOf('commitContainer')).toEqual([]);

    const rebuilt = await snapshotBlueprint(b, options({ rebuild: true }));
    expect(rebuilt.reused).toBe(false);
    expect(mocked.startContainer).toHaveBeenCalledTimes(1);
    expect(b.callsOf('commitContainer')).toHaveLength(1);
  });

  it('cleans up on setup failure', async () => {
    const b = backendWith();
    mocked.startContainer.mockRejectedValue(new Error('setup command failed (exit 1): npm ci'));
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('setup command failed (exit 1): npm ci');
    expect(b.callsOf('commitContainer')).toEqual([]);
    expect(b.callsOf('removeImage')).toEqual([]);
    // Only the leftover cleanup before the start: startContainer (keepOnError: false) rolled itself back
    expect(mocked.removeContainer).toHaveBeenCalledTimes(1);
  });

  it('a failed seed copy removes the temp container and commits nothing', async () => {
    const b = backendWith();
    b.execResults.set(COPY.join(' '), { exitCode: 1, stdout: '' });
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('Copying the workspace to /opt/kunj/seed failed (exit 1)');
    expect(b.callsOf('commitContainer')).toEqual([]);
    expect(mocked.removeContainer).toHaveBeenCalledTimes(2);
  });

  it('commit failure still removes the temp container', async () => {
    const b = backendWith();
    b.images.push(image('kunj-blueprint-app:old', 'old'));
    b.failOn = 'commitContainer';
    await expect(snapshotBlueprint(b, options())).rejects.toThrow('commitContainer failed');
    expect(mocked.removeContainer).toHaveBeenCalledTimes(2);
    expect(mocked.removeContainer).toHaveBeenLastCalledWith(b, NAMES, expect.objectContaining({ force: true, keepVolumes: false, user: 'kunj' }));
    // Older snapshots are only pruned after a successful commit
    expect(b.callsOf('removeImage')).toEqual([]);
  });

  it('a failing removal after the commit is a warning, not a failure', async () => {
    const b = backendWith();
    mocked.removeContainer
      .mockImplementationOnce(actualLifecycle.removeContainer)
      .mockRejectedValueOnce(new Error('busy'));
    await expect(snapshotBlueprint(b, options())).resolves.toMatchObject({ reused: false });
    expect(warnings).toContain('Could not remove the temporary snapshot container: busy');
  });
});

describe('snapshot bundle', () => {
  it('makeBranchBundle creates a bundle containing only refs/heads/<branch>', async () => {
    // origin has another branch, which must stay out of the bundle
    git('push', '-q', 'origin', 'HEAD:refs/heads/other');
    const originMain = execFileSync('git', ['rev-parse', 'main'], { cwd: path.join(tmp, 'origin.git') }).toString().trim();
    const bundle = await makeBranchBundle('main', tmp);
    try {
      const heads = git('bundle', 'list-heads', bundle.path);
      expect(heads).toBe(`${originMain} refs/heads/main`);
      git('bundle', 'verify', '-q', bundle.path);
    } finally {
      bundle.cleanup();
    }
    expect(fs.existsSync(path.dirname(bundle.path))).toBe(false);
    await expect(makeBranchBundle('missing', tmp)).rejects.toThrow(/git fetch failed: .*missing/);
  });

  it('passes a bundle and cleans up on success and failure', async () => {
    let seen = '';
    mocked.startContainer.mockImplementation(async (_b, o) => {
      seen = o.bundle!.hostPath;
      expect(o.bundle!.containerPath).toBe(BUNDLE_CONTAINER_PATH);
      expect(fs.existsSync(seen)).toBe(true);
      return startResult();
    });
    const result = await snapshotBlueprint(backendWith(), options());
    expect(result.viaBundle).toBe(true);
    expect(fs.existsSync(path.dirname(seen))).toBe(false);

    mocked.startContainer.mockImplementation(async (_b, o) => {
      seen = o.bundle!.hostPath;
      throw new Error('setup failed');
    });
    await expect(snapshotBlueprint(backendWith(), options())).rejects.toThrow('setup failed');
    expect(fs.existsSync(path.dirname(seen))).toBe(false);
  });

  it('noBundle keeps the old path', async () => {
    const result = await snapshotBlueprint(backendWith(), options({ noBundle: true }));
    expect(startOptionsPassed().bundle).toBeUndefined();
    expect(result.viaBundle).toBe(false);
  });
});

describe('ensureSnapshot', () => {
  const ensureOptions = (stale: 'rebuild' | 'keep', over: Partial<SnapshotOptions> = {}) => {
    const { rebuild: _rebuild, ...rest } = options(over);
    return { ...rest, stale };
  };

  it('builds when no snapshot exists, with a first-use progress line', async () => {
    const b = backendWith();
    const out = await ensureSnapshot(b, ensureOptions('keep'));
    expect(out).toMatchObject({ built: true, stale: false });
    expect(out.failed).toBeUndefined();
    expect(out.result).toMatchObject({ tag: snapshotTag('app', await expectedHash('origin/main')), reused: false });
    expect(logs[0]).toBe('Building blueprint snapshot (first use; this runs setup once)…');
    expect(mocked.startContainer).toHaveBeenCalledTimes(1);
    expect(b.callsOf('commitContainer')).toHaveLength(1);
  });

  it('does nothing when the current snapshot exists', async () => {
    const b = backendWith();
    const hash = await expectedHash('origin/main');
    b.images.push(image(snapshotTag('app', hash), hash));
    await expect(ensureSnapshot(b, ensureOptions('rebuild'))).resolves.toEqual({ result: null, built: false });
    expect(mocked.startContainer).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("rebuilds a stale snapshot with 'rebuild' and keeps it with 'keep'", async () => {
    const b = backendWith();
    b.images.push(image('kunj-blueprint-app:old', 'old'));
    await expect(ensureSnapshot(b, ensureOptions('keep'))).resolves.toEqual({ result: null, built: false, stale: true });
    expect(mocked.startContainer).not.toHaveBeenCalled();

    const out = await ensureSnapshot(b, ensureOptions('rebuild'));
    expect(out).toMatchObject({ built: true, stale: true });
    expect(logs[0]).toBe('Blueprint changed; rebuilding the snapshot…');
    // The old snapshot is replaced
    expect(b.callsOf('removeImage')).toEqual([['kunj-blueprint-app:old']]);
  });

  it('turns a failed build into failed, never a throw', async () => {
    const b = backendWith();
    mocked.startContainer.mockRejectedValue(new Error('setup command failed (exit 1): npm ci'));
    await expect(ensureSnapshot(b, ensureOptions('rebuild'))).resolves.toEqual({
      result: null,
      built: false,
      failed: 'setup command failed (exit 1): npm ci',
      stale: false,
    });
    // A failed rebuild says an older snapshot exists, which the start then uses
    b.images.push(image('kunj-blueprint-app:old', 'old'));
    await expect(ensureSnapshot(b, ensureOptions('rebuild'))).resolves.toMatchObject({ failed: 'setup command failed (exit 1): npm ci', stale: true });
    // Before the plan is made, staleness is unknown
    mocked.baseImageTag.mockRejectedValue(new Error('no devcontainer'));
    await expect(ensureSnapshot(b, ensureOptions('rebuild'))).resolves.toEqual({ result: null, built: false, failed: 'no devcontainer' });
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

  it('keeps going past a tag that cannot be removed and warns', async () => {
    const b = new FakeBackend();
    b.images.push(image('kunj-blueprint-app:aaa', 'aaa'), image('kunj-blueprint-app:bbb', 'bbb'));
    const real = b.removeImage.bind(b);
    jest.spyOn(b, 'removeImage').mockImplementation(async tag => {
      if (tag.endsWith(':aaa')) throw new Error('image is being used by a container');
      return real(tag);
    });
    const warned: string[] = [];
    await expect(removeSnapshots(b, 'app', REPO.id, m => warned.push(m))).resolves.toEqual(['kunj-blueprint-app:bbb']);
    expect(warned).toEqual(['Could not remove kunj-blueprint-app:aaa: image is being used by a container']);
  });
});
