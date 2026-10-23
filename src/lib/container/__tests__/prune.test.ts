import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeBackend } from './fake-backend';
import { ContainerInfo, ExecIO, ImageInfo, Labels } from '../backend';
import { LABEL, containerNames, labelsFor } from '../names';
import { readForwards, writeForwards } from '../autoforward';
import { PruneContext, applyPrune, findOrphans, namesOfContainer, parseLsRemoteHeads, planPrune } from '../prune';

const REPO = { id: 'github.com/acme/app', name: 'app' };
const VERSION = '1.2.3';
const NOW = new Date('2026-10-23T12:00:00Z');
const CLEAN = '@@refs\nrefs/heads/x 0\n@@stash\n0\n@@stash-exit 0\n@@status\n# branch.oid abc\n@@status-exit 0\n';
const UNPUSHED = CLEAN.replace('@@stash', 'refs/heads/wip 2\n@@stash');

const n = (branch: string) => containerNames(REPO.name, REPO.id, branch);

function main(branch: string, over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: `id-${branch}`,
    name: n(branch).container,
    state: 'running',
    image: 'kunj-sandbox:1.2.3-aaa',
    createdAt: '2026-10-22T10:00:00.123456789Z',
    labels: labelsFor(REPO.id, branch, { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify({ user: 'dev' }) }),
    ports: [],
    ...over,
  };
}

function side(branch: string, name: string, role: string, repoId = REPO.id): ContainerInfo {
  return { id: `id-${name}`, name, state: 'running', image: 'x', createdAt: '', labels: labelsFor(repoId, branch, { [LABEL.role]: role }), ports: [] };
}

function image(tag: string, size: number, labels: Labels = {}, id = `img-${tag}`): ImageInfo {
  return { tag, id, createdAt: '', labels, size };
}

/** The guard script prints `guard[id]` (CLEAN by default); ls-remote inside the container succeeds. */
function backendWith(containers: ContainerInfo[], guard: Record<string, string> = {}): FakeBackend {
  const b = new FakeBackend();
  b.existing = containers;
  const real = b.exec.bind(b);
  b.exec = async (id: string, cmd: string[], io?: ExecIO) => {
    const r = await real(id, cmd, io);
    if (cmd[0] === 'sh' && cmd[1] === '-c') return { exitCode: 0, stdout: guard[id] ?? CLEAN };
    return r;
  };
  return b;
}

function ctx(over: Partial<PruneContext> = {}): PruneContext {
  return {
    repoId: REPO.id,
    repoName: REPO.name,
    cwd: '/repo',
    kunjVersion: VERSION,
    now: NOW,
    force: false,
    remoteBranches: async () => ['main', 'alive'],
    currentImages: ['kunj-sandbox:1.2.3-aaa', 'kunj-nethelper:1.2.3-bbb'],
    ...over,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-prune-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseLsRemoteHeads', () => {
  it('reads branch names, keeping slashes', () => {
    expect(parseLsRemoteHeads('abc\trefs/heads/main\ndef\trefs/heads/feature/x\n\n')).toEqual(['main', 'feature/x']);
  });
});

describe('namesOfContainer', () => {
  it('derives the helper, volumes and network from the container name', () => {
    expect(namesOfContainer(n('feature/x').container)).toEqual(n('feature/x'));
  });
});

describe('planPrune', () => {
  it('removes a gone branch whose guard is clean and keeps one with unpushed work, with the reason', async () => {
    const b = backendWith([main('gone'), main('wip'), main('alive')], { 'id-wip': UNPUSHED });
    const plan = await planPrune(b, ctx());
    expect(plan.containers).toEqual([
      { branch: 'gone', names: n('gone'), reason: 'branch-gone', image: 'kunj-sandbox:1.2.3-aaa', guard: { unpushedRefs: [], stashes: 0, dirty: false, originReachable: true } },
      {
        branch: 'wip', names: n('wip'), reason: 'branch-gone', image: 'kunj-sandbox:1.2.3-aaa',
        guard: { unpushedRefs: ['refs/heads/wip'], stashes: 0, dirty: false, originReachable: true },
        kept: 'unpushed commits on wip',
      },
    ]);
    // The guard ran as the recorded user
    const guardCall = b.callsOf('exec').find(c => (c[1] as string[])[0] === 'sh');
    expect((guardCall![2] as ExecIO).user).toBe('dev');
  });

  it('keeps a container whose guard cannot run, with the error as the reason', async () => {
    const b = backendWith([main('gone', { state: 'exited', labels: labelsFor(REPO.id, 'gone', { [LABEL.role]: 'main' }) })]);
    const plan = await planPrune(b, ctx());
    expect(plan.containers[0].kept).toMatch(/firewall settings/);
  });

  it('--force skips the guard', async () => {
    const b = backendWith([main('wip')], { 'id-wip': UNPUSHED });
    const plan = await planPrune(b, ctx({ force: true }));
    expect(plan.containers).toEqual([{ branch: 'wip', names: n('wip'), reason: 'branch-gone', image: 'kunj-sandbox:1.2.3-aaa' }]);
    expect(b.callsOf('exec')).toEqual([]);
  });

  it('prunes nothing for the branch-gone reason when origin is unreachable, and says so', async () => {
    const b = backendWith([main('gone')]);
    const plan = await planPrune(b, ctx({ remoteBranches: async () => null }));
    expect(plan.containers).toEqual([]);
    expect(plan.warnings).toEqual([expect.stringMatching(/origin.*unreachable/i)]);
  });

  it('leaves a snapshot build container alone', async () => {
    const b = backendWith([main('main:snapshot')]);
    expect((await planPrune(b, ctx())).containers).toEqual([]);
  });

  it('removes stopped containers older than pruneAfterDays, and nothing by age when it is unset', async () => {
    const old = '2026-09-01T00:00:00.000000001Z';
    const containers = [
      main('alive', { state: 'exited', createdAt: old, labels: labelsFor(REPO.id, 'alive', { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify({ user: 'dev', helperEnv: { KUNJ_FW_MODE: 'default' } }) }) }),
      main('main', { createdAt: old }),
    ];
    expect((await planPrune(backendWith(containers), ctx({ pruneAfterDays: 0 }))).containers).toEqual([]);
    const plan = await planPrune(backendWith(containers), ctx({ pruneAfterDays: 30 }));
    expect(plan.containers.map(c => [c.branch, c.reason, c.kept])).toEqual([['alive', 'age', undefined]]);
  });

  it('lists helpers, services, volumes and networks labelled for a branch without a main container as orphans', async () => {
    const gone = n('rm-oob');
    const b = backendWith([
      main('alive'),
      side('alive', n('alive').helper, 'helper'),
      side('rm-oob', gone.helper, 'helper'),
      side('rm-oob', `${gone.container}-svc-postgres`, 'service'),
    ]);
    b.volumes.add(n('alive').workspaceVolume);
    b.volumeLabels.set(n('alive').workspaceVolume, labelsFor(REPO.id, 'alive'));
    for (const v of [gone.workspaceVolume, `${gone.container}-svc-postgres-data`]) {
      b.volumes.add(v);
      b.volumeLabels.set(v, labelsFor(REPO.id, 'rm-oob'));
    }
    // Named like alive's, labelled for a branch with no container: the labels decide
    b.volumes.add(`${n('alive').container}-x`);
    b.volumeLabels.set(`${n('alive').container}-x`, labelsFor(REPO.id, 'other'));
    b.networks.set(gone.network, labelsFor(REPO.id, 'rm-oob'));
    b.networks.set(n('alive').network, labelsFor(REPO.id, 'alive'));

    const plan = await planPrune(b, ctx());
    expect(plan.orphans).toEqual([
      { kind: 'container', name: gone.helper },
      { kind: 'container', name: `${gone.container}-svc-postgres` },
      { kind: 'volume', name: gone.workspaceVolume },
      { kind: 'volume', name: `${gone.container}-svc-postgres-data` },
      { kind: 'volume', name: `${n('alive').container}-x` },
      { kind: 'network', name: gone.network },
    ]);
    expect(b.callsOf('listVolumes')).toEqual([[{ [LABEL.repo]: REPO.id }]]);
    expect(b.callsOf('listNetworks')).toEqual([[{ [LABEL.repo]: REPO.id }]]);
  });

  it('removes snapshots of other hashes (not one in use) and keeps every snapshot when the hash is unknown', async () => {
    const snap = (hash: string, size: number) => image(`kunj-blueprint-app:${hash}`, size, { [LABEL.repo]: REPO.id, [LABEL.blueprintHash]: hash });
    const b = backendWith([main('alive', { image: 'kunj-blueprint-app:used' })]);
    b.images = [snap('cur', 100), snap('old', 2_000_000), snap('used', 50)];

    const plan = await planPrune(b, ctx({ currentBlueprintHash: async () => 'cur' }));
    expect(plan.images).toEqual(['kunj-blueprint-app:old']);
    expect(plan.bytes).toBe(2_000_000);

    expect((await planPrune(b, ctx({ currentBlueprintHash: async () => null }))).images).toEqual([]);
    expect((await planPrune(b, ctx())).images).toEqual([]);
  });

  it('removes superseded kunj-sandbox and kunj-nethelper tags that no container uses', async () => {
    const b = backendWith([main('alive', { image: 'kunj-sandbox:1.1.0-old' })]);
    b.images = [
      image('kunj-sandbox:1.2.3-aaa', 10),
      image('kunj-sandbox:1.1.0-old', 20),
      image('kunj-sandbox:1.0.0-older', 30, {}, 'shared'),
      image('kunj-sandbox:0.9.0', 30, {}, 'shared'),
      image('kunj-nethelper:1.2.3-bbb', 40),
      image('kunj-nethelper:1.0.0-x', 50),
      image('other:1', 60),
    ];
    const plan = await planPrune(b, ctx());
    expect(plan.images).toEqual(['kunj-sandbox:1.0.0-older', 'kunj-sandbox:0.9.0', 'kunj-nethelper:1.0.0-x']);
    // One image with two tags counts once
    expect(plan.bytes).toBe(80);
    expect(b.callsOf('listImages')).toContainEqual([{}, { references: ['kunj-sandbox', 'kunj-nethelper'] }]);
  });

  it('checks images in use against every container, not only this repository\'s', async () => {
    const b = backendWith([main('alive'), side('x', 'other-repo-ctr', 'main', 'gitlab.com/other')]);
    b.existing[1].image = 'kunj-sandbox:1.0.0';
    b.images = [image('kunj-sandbox:1.0.0', 1)];
    expect((await planPrune(b, ctx())).images).toEqual([]);
  });
});

describe('findOrphans', () => {
  it('ignores objects without kunj labels and treats unlabelled-role containers by name', () => {
    const legacyMain: ContainerInfo = { ...main('alive'), labels: labelsFor(REPO.id, 'alive') };
    expect(findOrphans([legacyMain], [{ name: 'v', labels: {} }, { name: n('alive').homeVolume, labels: labelsFor(REPO.id, 'alive') }], [])).toEqual([]);
  });
});

describe('applyPrune', () => {
  it('removes kept-free containers with their hooks, then orphans, images and stale forwards', async () => {
    const b = backendWith([main('gone'), main('wip'), main('alive')], { 'id-wip': UNPUSHED });
    const gone = n('rm-oob');
    b.existing.push(side('rm-oob', gone.helper, 'helper'));
    b.volumes.add(gone.workspaceVolume);
    b.volumeLabels.set(gone.workspaceVolume, labelsFor(REPO.id, 'rm-oob'));
    b.networks.set(gone.network, labelsFor(REPO.id, 'rm-oob'));
    b.images = [image('kunj-sandbox:0.1.0', 5)];
    const file = path.join(tmp, 'forwards.json');
    writeForwards([
      { pid: process.pid, container: n('alive').container, port: 3000, hostPort: 3000, kind: 'forward' },
      { pid: process.pid, container: 'kunj-app-vanished-abcdef', port: 3001, hostPort: 3001, kind: 'forward' },
    ], file);

    const plan = await planPrune(b, ctx());
    // remove() in the fake keeps `existing`: drop what was removed so the forward check sees it gone
    const realRemove = b.remove.bind(b);
    b.remove = async ids => {
      await realRemove(ids);
      b.existing = b.existing.filter(c => !(ids.containers ?? []).includes(c.name));
    };
    const hooks: Array<[string, Record<string, string>]> = [];
    const result = await applyPrune(b, plan, {
      repoId: REPO.id,
      kunjVersion: VERSION,
      forwardsFile: file,
      hook: async (name, values) => {
        hooks.push([name, values]);
      },
    });

    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([n('gone').container, gone.helper, gone.workspaceVolume, gone.network, 'kunj-sandbox:0.1.0']);
    expect(hooks).toEqual([
      ['pre-container-delete', { branch: 'gone', container: n('gone').container, image: 'kunj-sandbox:1.2.3-aaa' }],
      ['post-container-delete', { branch: 'gone', container: n('gone').container, image: 'kunj-sandbox:1.2.3-aaa' }],
    ]);
    expect(b.callsOf('remove')).toEqual([
      [{ containers: [n('gone').helper, n('gone').container], volumes: [n('gone').workspaceVolume, n('gone').homeVolume], networks: [n('gone').network] }],
      [{ containers: [gone.helper] }],
      [{ volumes: [gone.workspaceVolume] }],
      [{ networks: [gone.network] }],
    ]);
    expect(b.callsOf('removeImage')).toEqual([['kunj-sandbox:0.1.0']]);
    // The wip container was never touched by a remove
    expect(JSON.stringify(b.callsOf('remove'))).not.toContain(n('wip').container);
    expect(readForwards(file).map(r => r.container)).toEqual([n('alive').container]);
  });

  it('reports a failure and carries on; a failing pre hook skips that container', async () => {
    const b = backendWith([main('gone'), main('gone2')]);
    b.images = [image('kunj-sandbox:0.1.0', 5)];
    const plan = await planPrune(b, ctx());
    b.removeImage = async () => {
      throw new Error('conflict');
    };
    const result = await applyPrune(b, plan, {
      repoId: REPO.id,
      kunjVersion: VERSION,
      forwardsFile: path.join(tmp, 'f.json'),
      hook: async (name, values) => {
        if (name === 'pre-container-delete' && values.branch === 'gone') throw new Error('hook said no');
      },
    });
    expect(result.removed).toEqual([n('gone2').container]);
    expect(result.failed).toEqual([`${n('gone').container}: hook said no`, 'kunj-sandbox:0.1.0: conflict']);
  });
});
