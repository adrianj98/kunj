import { FakeBackend } from '../../lib/container/__tests__/fake-backend';
import { ContainerInfo } from '../../lib/container/backend';
import { containerNames, repoIdFromUrl } from '../../lib/container/names';

const backend = new FakeBackend();

jest.mock('../../lib/container/docker', () => ({
  LocalDockerBackend: jest.fn().mockImplementation(() => backend),
}));

jest.mock('../../lib/container/lifecycle', () => {
  const actual = jest.requireActual('../../lib/container/lifecycle');
  return {
    StartError: actual.StartError,
    startContainer: jest.fn(),
    stopContainer: jest.fn(),
    inspectForRemove: jest.fn(),
    removeContainer: jest.fn(),
    containerStatus: jest.fn(),
  };
});

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ container: {} })),
  getRepoName: jest.fn(() => 'app'),
  getRepoCommonRoot: jest.fn(() => '/repo'),
  getRepoCommonDir: jest.fn(() => '/repo/.git'),
  getOriginUrl: jest.fn(() => 'https://github.com/acme/app.git'),
}));

jest.mock('../../lib/git', () => ({
  getCurrentBranch: jest.fn(async () => 'current'),
}));

jest.mock('../../lib/repos', () => ({ recordRepo: jest.fn() }));

jest.mock('../../lib/hooks', () => {
  const actual = jest.requireActual('../../lib/hooks');
  return {
    HookError: actual.HookError,
    runActionHook: jest.fn(async (hook: string) => ({ hook, enabled: true, executions: [], ok: true })),
  };
});

import { ContainerCommand } from '../container';
import * as lifecycle from '../../lib/container/lifecycle';

const REPO_ID = repoIdFromUrl('https://github.com/acme/app.git');

function mainContainer(branch: string, overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  const names = containerNames('app', REPO_ID, branch);
  return {
    id: 'cid-1',
    name: names.container,
    state: 'running',
    image: 'kunj-sandbox:1.3.0',
    createdAt: '2026-10-21T10:00:00Z',
    labels: {
      'kunj.repo': REPO_ID,
      'kunj.branch': branch,
      'kunj.role': 'main',
      'kunj.options': JSON.stringify({ firewall: 'default', user: 'dev' }),
    },
    ports: [{ container: 3000, host: 13000 }],
    ...overrides,
  };
}

function helperContainer(branch: string): ContainerInfo {
  const names = containerNames('app', REPO_ID, branch);
  return {
    id: 'hid-1',
    name: names.helper,
    state: 'running',
    image: 'kunj-net-helper:1.3.0',
    createdAt: '2026-10-21T10:00:00Z',
    labels: { 'kunj.repo': REPO_ID, 'kunj.branch': branch, 'kunj.role': 'helper' },
    ports: [],
  };
}

let stdout: string[];
let writeSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  backend.calls = [];
  backend.existing = [];
  backend.execResults.clear();
  stdout = [];
  writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  writeSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = undefined;
});

describe('ContainerCommand', () => {
  it('registers as container with the ct alias', () => {
    const config = new ContainerCommand().getConfig();
    expect(config.name).toBe('container');
    expect(config.aliases).toEqual(['ct']);
    expect(config.arguments).toBe('[action] [target] [extra...]');
  });

  it('shifts positionals like the worktree command', async () => {
    const cmd = new ContainerCommand();
    const list = jest.spyOn(cmd as any, 'list').mockResolvedValue(undefined);
    const start = jest.spyOn(cmd as any, 'start').mockResolvedValue(undefined);

    const options = { status: false };
    await cmd.execute(options);
    expect(list).toHaveBeenCalledWith(options);

    const startOptions = { create: true };
    await cmd.execute('start', 'feat', startOptions);
    expect(start).toHaveBeenCalledWith('feat', startOptions);

    // Commander passes [] for the variadic and the Command object last
    await (cmd.execute as any).call(cmd, 'start', undefined, [], startOptions, {});
    expect(start).toHaveBeenLastCalledWith(undefined, startOptions);
  });

  it('rejects unknown actions', async () => {
    await expect(new ContainerCommand().execute('frobnicate', {})).rejects.toThrow(
      "Unknown container action 'frobnicate'. Expected one of: start, shell, exec, agent, attach, forward, list, stop, remove"
    );
  });

  it('prints the list json shape', async () => {
    backend.existing = [mainContainer('feat-x'), helperContainer('feat-x')];
    (lifecycle.containerStatus as jest.Mock).mockResolvedValue({
      agentRunning: true,
      head: 'a1b2c3d4e5f6',
      ahead: 2,
      dirty: true,
      status: 'ok',
    });

    await new ContainerCommand().execute('list', { json: true });

    expect(lifecycle.containerStatus).toHaveBeenCalledWith(backend, 'cid-1', 'dev', 2000);
    expect(backend.callsOf('list')).toEqual([[{ 'kunj.repo': REPO_ID }]]);
    expect(JSON.parse(stdout.join(''))).toEqual({
      repo: 'app',
      backend: { kind: 'docker', context: 'default' },
      containers: [
        {
          branch: 'feat-x',
          name: containerNames('app', REPO_ID, 'feat-x').container,
          id: 'cid-1',
          state: 'running',
          image: 'kunj-sandbox:1.3.0',
          createdAt: '2026-10-21T10:00:00Z',
          firewall: 'default',
          ports: [{ container: 3000, host: 13000, kind: 'publish' }],
          agent: { running: true },
          workspace: { head: 'a1b2c3d', ahead: 2, dirty: true },
          status: 'ok',
        },
      ],
    });
  });

  it('skips the status exec with --no-status and for stopped containers', async () => {
    backend.existing = [mainContainer('feat-x'), mainContainer('other', { id: 'cid-2', state: 'exited' })];
    await new ContainerCommand().execute('list', { json: true, status: false });
    expect(lifecycle.containerStatus).not.toHaveBeenCalled();
    const out = JSON.parse(stdout.join(''));
    expect(out.containers.map((c: any) => c.status)).toEqual(['skipped', 'stopped']);
  });

  it('exec passes the args after --', async () => {
    backend.existing = [mainContainer('feat')];
    backend.execResults.set('ls -la', { exitCode: 3, stdout: '' });

    await new ContainerCommand().execute('exec', 'feat', ['ls', '-la'], {});

    const [id, cmd, io] = backend.callsOf('exec')[0] as [string, string[], any];
    expect(id).toBe('cid-1');
    expect(cmd).toEqual(['ls', '-la']);
    expect(io).toMatchObject({ stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', user: 'dev', workdir: '/workspace' });
    expect(process.exitCode).toBe(3);
  });

  it('exec without a branch takes the current one when everything is after --', async () => {
    backend.existing = [mainContainer('current')];
    const argv = process.argv;
    process.argv = ['node', 'kunj', 'ct', 'exec', '--', 'ls', '-la'];
    try {
      await new ContainerCommand().execute('exec', 'ls', ['-la'], {});
    } finally {
      process.argv = argv;
    }
    expect(backend.callsOf('exec')[0][1]).toEqual(['ls', '-la']);
  });

  it('refuses to exec in a stopped container', async () => {
    backend.existing = [mainContainer('feat', { state: 'exited' })];
    await expect(new ContainerCommand().execute('exec', 'feat', ['ls'], {})).rejects.toThrow(
      'Container for feat is not running; run kunj ct start feat'
    );
  });

  it('writes the json error envelope for a StartError', async () => {
    (lifecycle.startContainer as jest.Mock).mockRejectedValue(new lifecycle.StartError('feat is not on origin', 'unpushed'));
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
    try {
      await new ContainerCommand().execute('start', 'feat', { json: true });
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
    expect(JSON.parse(stdout.join(''))).toEqual({ error: { code: 'unpushed', message: 'feat is not on origin' } });
  });

  it('wraps start with the container hooks and prints the result as json', async () => {
    const names = containerNames('app', REPO_ID, 'feat');
    (lifecycle.startContainer as jest.Mock).mockResolvedValue({
      names,
      containerId: 'cid-9',
      image: 'kunj-sandbox:1.3.0',
      created: true,
      seeded: true,
      keptFiles: ['.env'],
      copiedFiles: [],
      publish: [{ container: 3000, host: 3000 }],
      firewall: 'default',
    });
    const hooks = jest.requireMock('../../lib/hooks').runActionHook as jest.Mock;

    await new ContainerCommand().execute('start', 'feat', { json: true, publish: '3000,5432' });

    const opts = (lifecycle.startContainer as jest.Mock).mock.calls[0][1];
    expect(opts).toMatchObject({ branch: 'feat', create: false, publish: [3000, 5432], jsonMode: true });
    expect(opts.repo).toEqual({ root: '/repo', name: 'app', id: REPO_ID, originUrl: 'https://github.com/acme/app.git' });
    expect(hooks.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['pre-container-create', { branch: 'feat', container: names.container, image: '' }],
      ['post-container-create', { branch: 'feat', container: names.container, image: 'kunj-sandbox:1.3.0' }],
    ]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ branch: 'feat', containerId: 'cid-9', keptFiles: ['.env'] });
  });
});
