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

let mockRoot = '/repo';
let mockKunjDir = '/kunj/app';

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ container: {} })),
  getKunjDir: jest.fn(() => mockKunjDir),
  getGlobalKunjDir: jest.fn(() => '/kunj'),
  getRepoName: jest.fn(() => 'app'),
  getRepoCommonRoot: jest.fn(() => '/repo'),
  getRepoCommonDir: jest.fn(() => '/repo/.git'),
  getOriginUrl: jest.fn(() => 'https://github.com/acme/app.git'),
  resetRepoCache: jest.fn(),
}));

jest.mock('../../lib/git', () => ({
  getCurrentBranch: jest.fn(async () => 'current'),
  getGitRoot: jest.fn(async () => mockRoot),
}));

jest.mock('../../lib/base-branch', () => ({
  detectDefaultBranch: jest.fn(async () => 'main'),
}));

jest.mock('../../lib/container/snapshot', () => ({
  ensureSnapshot: jest.fn(async () => ({ result: null, built: false })),
  snapshotBlueprint: jest.fn(),
  snapshotStatus: jest.fn(),
  removeSnapshots: jest.fn(),
  planSnapshot: jest.fn(async () => ({ hash: 'abc123abc123' })),
}));

jest.mock('../../lib/container/infer', () => ({ inferBlueprint: jest.fn() }));

jest.mock('../../lib/container/blueprint', () => ({
  ...jest.requireActual('../../lib/container/blueprint'),
  resolveBlueprint: jest.fn(async () => null),
}));

let mockRepos: Array<{ root: string; exists: boolean }> = [];
jest.mock('../../lib/repos', () => ({ recordRepo: jest.fn(), listRepos: jest.fn(() => mockRepos) }));

jest.mock('../../lib/container/prune', () => ({
  ...jest.requireActual('../../lib/container/prune'),
  planPrune: jest.fn(),
  applyPrune: jest.fn(async () => ({ removed: ['kunj-app-gone-abc123'], failed: [] })),
}));

let mockConfirm = true;
jest.mock('inquirer', () => ({ __esModule: true, default: { prompt: jest.fn(async () => ({ ok: mockConfirm })) } }));

jest.mock('../../lib/container/forward', () => ({
  ...jest.requireActual('../../lib/container/forward'),
  forwardPort: jest.fn(async (_b: unknown, _id: string, spec: { container: number }) => ({ hostPort: spec.container + 10000, close: async () => {} })),
}));

// The forward registry lives in the home directory: an in-memory list here
const mockForwards: Array<{ pid: number; container: string; port: number; hostPort: number; kind: 'forward' }> = [];
jest.mock('../../lib/container/autoforward', () => ({
  ...jest.requireActual('../../lib/container/autoforward'),
  readForwards: jest.fn(() => mockForwards.slice()),
  updateForwards: jest.fn((change: (rs: typeof mockForwards) => typeof mockForwards) => {
    mockForwards.splice(0, mockForwards.length, ...change(mockForwards.slice()));
    return mockForwards.slice();
  }),
  forwarderFor: jest.fn((container: string) => mockForwards.find(r => r.container === container)?.pid),
  spawnDetached: jest.fn(() => 4242),
  runAutoForward: jest.fn(async () => {}),
}));

// The editor config is written under the home directory: a temp dir in the open tests
let mockHome: string | undefined;
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockHome ?? actual.homedir() };
});

// The editor launch (openWorktree in worktree.ts): records the argv, emits 'spawn'
const mockSpawned: string[][] = [];
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  const { EventEmitter } = jest.requireActual('events');
  return {
    ...actual,
    spawn: jest.fn((cmd: string, args: string[]) => {
      mockSpawned.push([cmd, ...args]);
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      setImmediate(() => child.emit('spawn'));
      return child;
    }),
  };
});

jest.mock('../../lib/hooks', () => {
  const actual = jest.requireActual('../../lib/hooks');
  return {
    HookError: actual.HookError,
    runActionHook: jest.fn(async (hook: string) => ({ hook, enabled: true, executions: [], ok: true })),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { ContainerCommand, agentCommandLine } from '../container';
import * as lifecycle from '../../lib/container/lifecycle';
import * as snapshot from '../../lib/container/snapshot';
import { inferBlueprint } from '../../lib/container/infer';
import { parseBlueprint, resolveBlueprint } from '../../lib/container/blueprint';
import { detectDefaultBranch } from '../../lib/base-branch';
import { loadResolvedConfig } from '../../lib/config';
import { EDITOR_CREDENTIALS_WARNING, attachedContainerUri } from '../../lib/container/editor';
import * as autoforward from '../../lib/container/autoforward';
import * as prune from '../../lib/container/prune';
import * as config from '../../lib/config';
import { runActionHook } from '../../lib/hooks';
import inquirer from 'inquirer';

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
let errors: string[];
let consoleErrSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  backend.calls = [];
  backend.existing = [];
  backend.execResults.clear();
  backend.volumes.clear();
  backend.volumeLabels.clear();
  backend.networks.clear();
  mockForwards.length = 0;
  stdout = [];
  writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errors = [];
  consoleErrSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  writeSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  consoleErrSpy.mockRestore();
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
    await new ContainerCommand().execute('frobnicate', {});
    expect(errors).toEqual([
      "✗ Unknown container action 'frobnicate'. Expected one of: start, shell, exec, agent, attach, open, forward, logs, list, stop, remove, prune, blueprint, file",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('rejects unknown options before running', async () => {
    const program = new Command();
    program.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
    const cmd = new ContainerCommand();
    const execute = jest.spyOn(cmd, 'execute');
    cmd.register(program);
    expect(() => program.parse(['ct', 'stop', '--nope', '--json'], { from: 'user' })).toThrow(/unknown option '--nope'/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('prints a failing docker call as one line, without a stack', async () => {
    jest.spyOn(backend, 'list').mockRejectedValueOnce(new Error('docker ps failed: Cannot connect to the Docker daemon'));
    await new ContainerCommand().execute('list', {});
    expect(errors).toEqual(['✗ docker ps failed: Cannot connect to the Docker daemon']);
    expect(process.exitCode).toBe(1);
  });

  it("prefers docker info's message when the daemon is down", async () => {
    jest.spyOn(backend, 'list').mockRejectedValueOnce(new Error('docker ps failed: Cannot connect to the Docker daemon'));
    jest.spyOn(backend, 'info').mockRejectedValueOnce(new Error('Docker is not available: Cannot connect to the Docker daemon'));
    await new ContainerCommand().execute('list', {});
    expect(errors).toEqual(['✗ Docker is not available: Cannot connect to the Docker daemon']);
  });

  it('hands the agent command to tmux as one shell command', async () => {
    backend.existing = [mainContainer('feat')];
    (jest.requireMock('../../lib/config').loadResolvedConfig as jest.Mock).mockResolvedValueOnce({
      container: { agentCommand: 'claude --append-system-prompt "be brief"' },
    });
    await new ContainerCommand().execute('agent', 'feat', ["it's"], {});
    const cmds = backend.callsOf('exec').map(c => c[1]);
    expect(cmds).toEqual([
      ['sh', '-c', 'command -v tmux'],
      ['tmux', '-u', 'new-session', '-A', '-s', 'agent', `claude --append-system-prompt "be brief" 'it'\\''s'`],
    ]);
  });

  it('runs the agent through sh without tmux', async () => {
    backend.existing = [mainContainer('feat')];
    backend.execResults.set('sh -c command -v tmux', { exitCode: 1, stdout: '' });
    await new ContainerCommand().execute('agent', 'feat', [], {});
    expect(backend.callsOf('exec')[1][1]).toEqual(['sh', '-lc', agentCommandLine(undefined, [])]);
  });

  describe('auto forwarding', () => {
    const NAME = containerNames('app', REPO_ID, 'feat').container;
    const spawnDetached = autoforward.spawnDetached as jest.Mock;
    const runAutoForward = autoforward.runAutoForward as jest.Mock;

    it('agent starts a detached auto-forwarder and registers it', async () => {
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('agent', 'feat', [], {});
      expect(spawnDetached).toHaveBeenCalledWith(['ct', 'forward', 'feat', '--auto']);
      expect(mockForwards).toEqual([{ pid: 4242, container: NAME, port: 0, hostPort: 0, kind: 'forward' }]);
    });

    it('agent passes the Docker context on to the forwarder', async () => {
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('agent', 'feat', [], { context: 'colima' });
      expect(spawnDetached).toHaveBeenCalledWith(['ct', 'forward', 'feat', '--auto', '--context', 'colima']);
    });

    it('agent starts none when container.forward.auto is false', async () => {
      backend.existing = [mainContainer('feat')];
      (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ container: { forward: { auto: false } } });
      await new ContainerCommand().execute('agent', 'feat', [], {});
      expect(spawnDetached).not.toHaveBeenCalled();
      expect(mockForwards).toEqual([]);
    });

    it('agent starts none when one is already registered for the container', async () => {
      backend.existing = [mainContainer('feat')];
      mockForwards.push({ pid: 777, container: NAME, port: 3000, hostPort: 3000, kind: 'forward' });
      await new ContainerCommand().execute('agent', 'feat', [], {});
      expect(spawnDetached).not.toHaveBeenCalled();
    });

    it('agent still runs when the forwarder cannot be started', async () => {
      backend.existing = [mainContainer('feat')];
      spawnDetached.mockImplementationOnce(() => {
        throw new Error('Could not start the background forwarder');
      });
      await new ContainerCommand().execute('agent', 'feat', [], {});
      expect(backend.callsOf('exec').map(c => (c[1] as string[])[0])).toEqual(['sh', 'tmux']);
    });

    it('forward --auto --detach prints the pid as JSON and registers it', async () => {
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('forward', 'feat', [], { auto: true, detach: true, json: true });
      expect(spawnDetached).toHaveBeenCalledWith(['ct', 'forward', 'feat', '--auto']);
      expect(JSON.parse(stdout.join(''))).toEqual({ success: true, branch: 'feat', pid: 4242 });
      expect(mockForwards).toEqual([{ pid: 4242, container: NAME, port: 0, hostPort: 0, kind: 'forward' }]);
    });

    it('forward --auto refuses port arguments', async () => {
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('forward', 'feat', ['3000'], { auto: true });
      expect(errors).toEqual(['✗ forward --auto takes no ports; it forwards whatever listens in the container']);
      expect(runAutoForward).not.toHaveBeenCalled();
    });

    it('forward --auto prints one NDJSON object per change and keeps the registry in step', async () => {
      backend.existing = [mainContainer('feat')];
      (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ container: { forward: { ignore: ['9229', 5555] } } });
      const seen: unknown[] = [];
      runAutoForward.mockImplementationOnce(async (_b: unknown, _id: string, opts: any) => {
        seen.push(mockForwards.slice());
        opts.onChange({ event: 'add', port: 3000, hostPort: 3001 });
        seen.push(mockForwards.slice());
        opts.onChange({ event: 'remove', port: 3000, hostPort: 3001 });
        seen.push(mockForwards.slice());
      });
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        await new ContainerCommand().execute('forward', 'feat', [], { auto: true, json: true });
      } finally {
        exit.mockRestore();
      }
      const [, id, opts] = runAutoForward.mock.calls[0];
      expect(id).toBe('cid-1');
      expect(opts).toMatchObject({ ignore: [9229, 5555], user: 'dev' });
      expect(stdout.join('').trim().split('\n').map(l => JSON.parse(l))).toEqual([
        { event: 'add', port: 3000, hostPort: 3001 },
        { event: 'remove', port: 3000, hostPort: 3001 },
      ]);
      const marker = { pid: process.pid, container: NAME, port: 0, hostPort: 0, kind: 'forward' };
      expect(seen).toEqual([[marker], [marker, { ...marker, port: 3000, hostPort: 3001 }], [marker]]);
      expect(mockForwards).toEqual([]);
    });

    it('list JSON shows auto forwards with their pid', async () => {
      backend.existing = [mainContainer('feat')];
      (lifecycle.containerStatus as jest.Mock).mockResolvedValue({ agentRunning: false, head: null, ahead: 0, dirty: false, status: 'ok' });
      mockForwards.push(
        { pid: 4242, container: NAME, port: 0, hostPort: 0, kind: 'forward' },
        { pid: 4242, container: NAME, port: 5173, hostPort: 5174, kind: 'forward' },
        { pid: 4242, container: 'kunj-other', port: 8080, hostPort: 8080, kind: 'forward' },
      );
      await new ContainerCommand().execute('list', { json: true });
      expect(JSON.parse(stdout.join('')).containers[0].ports).toEqual([
        { container: 3000, host: 13000, kind: 'publish' },
        { container: 5173, host: 5174, kind: 'forward', pid: 4242 },
      ]);
    });
  });

  it('list marks the Docker-in-Docker mode in JSON and text', async () => {
    const main = mainContainer('feat');
    main.labels['kunj.options'] = JSON.stringify({ firewall: 'default', user: 'dev', dind: 'sysbox' });
    backend.existing = [main];
    (lifecycle.containerStatus as jest.Mock).mockResolvedValue({ agentRunning: false, head: null, ahead: 0, dirty: false, status: 'ok' });
    await new ContainerCommand().execute('list', { json: true });
    expect(JSON.parse(stdout.join('')).containers[0].dind).toBe('sysbox');

    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await new ContainerCommand().execute('list', {});
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('[dind sysbox]');
    } finally {
      log.mockRestore();
    }
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
          imageInfo: { tag: 'kunj-sandbox:1.3.0' },
          createdAt: '2026-10-21T10:00:00Z',
          firewall: 'default',
          dind: 'off',
          ports: [{ container: 3000, host: 13000, kind: 'publish' }],
          agent: { running: true },
          workspace: { head: 'a1b2c3d', ahead: 2, dirty: true },
          status: 'ok',
          services: [],
        },
      ],
      orphans: [],
    });
  });

  describe('services', () => {
    const NAMES = containerNames('app', REPO_ID, 'feat-x');
    function service(name: string, state: ContainerInfo['state'], record: object = {}): ContainerInfo {
      return {
        id: `${name}-id`,
        name: `${NAMES.container}-svc-${name}`,
        state,
        image: `${name}:1`,
        createdAt: '',
        labels: { 'kunj.repo': REPO_ID, 'kunj.branch': 'feat-x', 'kunj.role': 'service', 'kunj.service': name, 'kunj.options': JSON.stringify(record) },
        ports: [],
      };
    }

    it('list json reports each container\'s services with state and port', async () => {
      backend.existing = [mainContainer('feat-x'), helperContainer('feat-x'), service('redis', 'exited'), service('postgres', 'running', { port: 5432 })];
      await new ContainerCommand().execute('list', { json: true, status: false });
      const out = JSON.parse(stdout.join(''));
      expect(out.containers).toHaveLength(1);
      expect(out.containers[0].services).toEqual([
        { name: 'postgres', state: 'running', port: 5432 },
        { name: 'redis', state: 'exited', port: null },
      ]);
    });

    it('logs streams the container or one service', async () => {
      backend.existing = [mainContainer('feat-x'), service('postgres', 'running')];
      await new ContainerCommand().execute('logs', 'feat-x', ['postgres'], { follow: true });
      await new ContainerCommand().execute('logs', 'feat-x', [], {});
      expect(backend.callsOf('logs')).toEqual([['postgres-id', { follow: true }], ['cid-1', { follow: false }]]);
      await new ContainerCommand().execute('logs', 'feat-x', ['nope'], {});
      expect(errors).toEqual(['✗ feat-x has no service nope; services: postgres']);
    });

    it('forward <service>:<port> tunnels through the service container with the tool it has', async () => {
      const forward = jest.requireMock('../../lib/container/forward') as { forwardPort: jest.Mock; TUNNEL_PROBE: string };
      backend.existing = [mainContainer('feat-x'), service('postgres', 'running')];
      backend.execResults.set(`sh -c ${forward.TUNNEL_PROBE}`, { exitCode: 0, stdout: 'bash\n' });
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        const done = new ContainerCommand().execute('forward', 'feat-x', ['postgres:5432'], { json: true });
        await new Promise(r => setTimeout(r, 20));
        process.emit('SIGINT');
        await done;
      } finally {
        exit.mockRestore();
      }
      expect(forward.forwardPort).toHaveBeenCalledWith(backend, 'postgres-id', { service: 'postgres', container: 5432 }, { hasSocat: false, tool: 'bash' });
      // No socat probe in the branch container: only the service's port was asked for
      expect(backend.callsOf('exec').map(c => c[0])).toEqual(['postgres-id']);
      expect(JSON.parse(stdout.join(''))).toEqual({ forwards: [{ container: 5432, host: 15432, service: 'postgres' }] });
    });

    it('forward refuses a service image without socat, bash or nc, and a stopped service', async () => {
      const forward = jest.requireMock('../../lib/container/forward') as { forwardPort: jest.Mock; TUNNEL_PROBE: string };
      backend.existing = [mainContainer('feat-x'), service('postgres', 'running'), service('redis', 'exited')];
      backend.execResults.set(`sh -c ${forward.TUNNEL_PROBE}`, { exitCode: 1, stdout: '' });
      await new ContainerCommand().execute('forward', 'feat-x', ['postgres:5432'], {});
      await new ContainerCommand().execute('forward', 'feat-x', ['redis:6379'], {});
      expect(errors[0]).toMatch(/^✗ The postgres image has none of socat, bash or nc/);
      expect(errors[1]).toBe('✗ Service redis is not running; run kunj ct start feat-x');
      expect(forward.forwardPort).not.toHaveBeenCalled();
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

  it("runs as the image's own user (no -u) when the recorded user is empty", async () => {
    const labels = { ...mainContainer('feat').labels, 'kunj.options': JSON.stringify({ firewall: 'default', user: '' }) };
    backend.existing = [mainContainer('feat', { labels })];
    await new ContainerCommand().execute('exec', 'feat', ['ls'], {});
    await new ContainerCommand().execute('agent', 'feat', [], {});
    const ios = backend.callsOf('exec').map(c => c[2] as any);
    expect(ios).toHaveLength(3);
    for (const io of ios) expect(io.user).toBeUndefined();
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
    await new ContainerCommand().execute('exec', 'feat', ['ls'], {});
    expect(errors).toEqual(['✗ Container for feat is not running; run kunj ct start feat']);
    expect(backend.callsOf('exec')).toEqual([]);
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

  it('runs no create hooks when resuming an existing container', async () => {
    backend.existing = [mainContainer('feat')];
    (lifecycle.startContainer as jest.Mock).mockResolvedValue({
      names: containerNames('app', REPO_ID, 'feat'),
      containerId: 'cid-1',
      image: 'kunj-sandbox:1.3.0',
      user: 'dev',
      created: false,
      seeded: false,
      keptFiles: [],
      copiedFiles: [],
      publish: [],
      firewall: 'default',
    });
    const hooks = jest.requireMock('../../lib/hooks').runActionHook as jest.Mock;
    await new ContainerCommand().execute('start', 'feat', { json: true });
    expect(lifecycle.startContainer).toHaveBeenCalled();
    expect(hooks).not.toHaveBeenCalled();

    // --rebuild recreates it: both hooks
    (lifecycle.startContainer as jest.Mock).mockResolvedValue({
      ...(await (lifecycle.startContainer as jest.Mock).mock.results[0].value),
      created: true,
    });
    await new ContainerCommand().execute('start', 'feat', { json: true, rebuild: true });
    expect(hooks.mock.calls.map(c => c[0])).toEqual(['pre-container-create', 'post-container-create']);
  });

  describe('blueprint', () => {
    let tmp: string;
    const resolved = (text = '{"setup":["npm ci"]}', source: 'repo' | 'host' = 'repo') => ({
      blueprint: parseBlueprint(text, 'x'),
      source,
      path: source === 'repo' ? 'origin/main:.kunj/blueprint.json' : '/kunj/app/blueprint.json',
      text,
      ref: source === 'repo' ? 'origin/main' : undefined,
    });

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-ct-bp-'));
      mockRoot = path.join(tmp, 'repo');
      mockKunjDir = path.join(tmp, 'kunj', 'app');
      fs.mkdirSync(mockRoot);
      (inferBlueprint as jest.Mock).mockReturnValue({
        tools: { node: '24', apt: ['jq', 'git-lfs'] },
        setup: ['npm ci', 'npm run build'],
        maintain: ['npm ci'],
        lockfiles: ['package-lock.json'],
        reasons: ['package-lock.json → npm ci'],
      });
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      mockRoot = '/repo';
      mockKunjDir = '/kunj/app';
    });

    it('blueprint init writes the inferred file (--yes) and refuses to overwrite', async () => {
      await new ContainerCommand().execute('blueprint', 'init', [], { yes: true, json: true });
      const file = path.join(mockRoot, '.kunj', 'blueprint.json');
      const text = fs.readFileSync(file, 'utf8');
      expect(text.endsWith('}\n')).toBe(true);
      expect(JSON.parse(text)).toEqual({
        tools: { node: '24', apt: ['jq', 'git-lfs'] },
        setup: ['npm ci', 'npm run build'],
        maintain: ['npm ci'],
        lockfiles: ['package-lock.json'],
      });
      expect(JSON.parse(stdout.join(''))).toEqual({
        path: file,
        blueprint: JSON.parse(text),
        reasons: ['package-lock.json → npm ci'],
      });

      // Without --yes and without a TTY to confirm: refused, file unchanged
      fs.writeFileSync(file, '{"setup":["make"]}\n');
      const isTTY = process.stdin.isTTY;
      (process.stdin as any).isTTY = false;
      try {
        await new ContainerCommand().execute('blueprint', 'init', [], {});
      } finally {
        (process.stdin as any).isTTY = isTTY;
      }
      expect(errors).toEqual([`✗ ${file} already exists; pass --yes to overwrite it`]);
      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"setup":["make"]}\n');
    });

    it('blueprint init keeps the notes of the file it overwrites', async () => {
      const file = path.join(mockRoot, '.kunj', 'blueprint.json');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, '{ "setup": ["make"], "notes": "ask Ada about the db" }\n');
      await new ContainerCommand().execute('blueprint', 'init', [], { yes: true });
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(written.setup).toEqual(['npm ci', 'npm run build']);
      expect(written.notes).toBe('ask Ada about the db');
    });

    it('status and snapshot resolve the working tree first and no longer ask to push', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(null);
      fs.mkdirSync(path.join(mockRoot, '.kunj'));
      fs.writeFileSync(path.join(mockRoot, '.kunj', 'blueprint.json'), '{}');
      await new ContainerCommand().execute('blueprint', 'status', [], {});
      await new ContainerCommand().execute('blueprint', 'snapshot', [], {});
      for (const call of (resolveBlueprint as jest.Mock).mock.calls) {
        expect(call[0]).toEqual({ cwd: process.cwd(), repoRoot: mockRoot, repoKunjDir: mockKunjDir, defaultBranch: 'main', override: undefined });
      }
      expect((resolveBlueprint as jest.Mock).mock.calls).toHaveLength(2);
      expect(logSpy.mock.calls.map(c => c.join(' ')).filter(l => /push/.test(l))).toEqual([]);
      expect(errors).toEqual(['✗ No blueprint; run kunj ct blueprint init', '✗ No blueprint; run kunj ct blueprint init']);
      expect(snapshot.snapshotBlueprint).not.toHaveBeenCalled();
    });

    it('blueprint init says start builds the snapshot', async () => {
      await new ContainerCommand().execute('blueprint', 'init', [], { yes: true });
      const lines = logSpy.mock.calls.map(c => c.join(' '));
      expect(lines).toContain('Next: commit .kunj/blueprint.json; kunj ct start <branch> builds the snapshot on first use');
      expect(lines.filter(l => /push/i.test(l))).toEqual([]);
    });

    it('blueprint init --global writes to the kunj dir', async () => {
      await new ContainerCommand().execute('blueprint', 'init', [], { yes: true, global: true });
      expect(fs.existsSync(path.join(mockKunjDir, 'blueprint.json'))).toBe(true);
      expect(fs.existsSync(path.join(mockRoot, '.kunj'))).toBe(false);
      expect(logSpy.mock.calls.map(c => c.join(' '))).toContain('Next: kunj ct start <branch> builds the snapshot on first use');
    });

    it('blueprint snapshot calls snapshotBlueprint with the default branch and prints the tag', async () => {
      const r = resolved();
      (resolveBlueprint as jest.Mock).mockResolvedValue(r);
      (snapshot.snapshotBlueprint as jest.Mock).mockResolvedValue({
        tag: 'kunj-blueprint-app:abc123abc123',
        hash: 'abc123abc123',
        ref: '0123456789abcdef0123456789abcdef01234567',
        base: 'kunj-sandbox:1.3.0',
        sizeBytes: 512 * 1024 * 1024,
        tools: [{ name: 'node', version: '24.1.0' }],
        reused: false,
      });

      await new ContainerCommand().execute('blueprint', 'snapshot', [], {});

      expect(resolveBlueprint).toHaveBeenCalledWith({ cwd: process.cwd(), repoRoot: mockRoot, repoKunjDir: mockKunjDir, defaultBranch: 'main', override: undefined });
      const opts = (snapshot.snapshotBlueprint as jest.Mock).mock.calls[0][1];
      expect(opts).toMatchObject({ branch: 'main', blueprint: r, rebuild: false, jsonMode: false });
      expect(opts.repo).toEqual({ root: '/repo', name: 'app', id: REPO_ID, originUrl: 'https://github.com/acme/app.git' });
      const lines = logSpy.mock.calls.map(c => c.join(' '));
      expect(lines).toContain('✓ Snapshot kunj-blueprint-app:abc123abc123 (512 MB) from 0123456');
      expect(lines).toContain('  installed node 24.1.0');
    });

    it('blueprint snapshot --base wins and no default branch is an error', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      (snapshot.snapshotBlueprint as jest.Mock).mockResolvedValue({ tag: 't', hash: 'h', ref: '', base: 'b', sizeBytes: 0, tools: [], reused: true });
      await new ContainerCommand().execute('blueprint', 'snapshot', [], { base: 'origin/develop', json: true });
      expect((snapshot.snapshotBlueprint as jest.Mock).mock.calls[0][1].branch).toBe('develop');

      (detectDefaultBranch as jest.Mock).mockResolvedValueOnce(null);
      await new ContainerCommand().execute('blueprint', 'snapshot', [], {});
      expect(errors).toEqual(['✗ cannot detect the default branch; pass --base']);
    });

    it('blueprint snapshot takes an ssh origin through a host bundle, and --no-bundle opts out', async () => {
      (jest.requireMock('../../lib/config').getOriginUrl as jest.Mock).mockReturnValueOnce('git@github.com:acme/app.git');
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      (snapshot.snapshotBlueprint as jest.Mock).mockResolvedValue({
        tag: 'kunj-blueprint-app:abc123abc123', hash: 'h', ref: '0123456789', base: 'b', sizeBytes: 0, tools: [], reused: false, viaBundle: true,
      });
      await new ContainerCommand().execute('blueprint', 'snapshot', [], {});
      expect(errors).toEqual([]);
      expect((snapshot.snapshotBlueprint as jest.Mock).mock.calls[0][1].noBundle).toBe(false);
      expect(logSpy.mock.calls.map(c => c.join(' '))).toContain('✓ Snapshot kunj-blueprint-app:abc123abc123 (0 MB) from 0123456 (from a host bundle)');

      await new ContainerCommand().execute('blueprint', 'snapshot', [], { bundle: false });
      expect((snapshot.snapshotBlueprint as jest.Mock).mock.calls[1][1].noBundle).toBe(true);
    });

    it('blueprint status json shape', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved('{"setup":["npm ci"],"notes":"hi"}'));
      (snapshot.snapshotStatus as jest.Mock).mockResolvedValue({
        current: {
          tag: 'kunj-blueprint-app:abc123abc123',
          id: 'img-1',
          createdAt: '2026-10-22T09:00:00Z',
          labels: { 'kunj.blueprint.createdAt': '2026-10-22T08:59:00.000Z' },
          size: 1000,
        },
        others: [],
      });
      await new ContainerCommand().execute('blueprint', 'status', [], { json: true });
      expect(snapshot.snapshotStatus).toHaveBeenCalledWith(backend, 'app', REPO_ID, 'abc123abc123');
      expect(JSON.parse(stdout.join(''))).toEqual({
        source: 'repo',
        path: 'origin/main:.kunj/blueprint.json',
        hash: 'abc123abc123',
        snapshot: { tag: 'kunj-blueprint-app:abc123abc123', createdAt: '2026-10-22T08:59:00.000Z', sizeBytes: 1000 },
        stale: false,
        others: [],
        notes: 'hi',
      });

      // Only an older snapshot: stale
      stdout.length = 0;
      (snapshot.snapshotStatus as jest.Mock).mockResolvedValue({
        current: null,
        others: [{ tag: 'kunj-blueprint-app:old', id: 'img-0', createdAt: '', labels: {}, size: 1 }],
      });
      await new ContainerCommand().execute('blueprint', 'status', [], { json: true });
      expect(JSON.parse(stdout.join(''))).toMatchObject({ snapshot: null, stale: true, others: ['kunj-blueprint-app:old'] });

      // No blueprint at all
      stdout.length = 0;
      (resolveBlueprint as jest.Mock).mockResolvedValue(null);
      await new ContainerCommand().execute('blueprint', 'status', [], { json: true });
      expect(JSON.parse(stdout.join(''))).toEqual({ source: null });
    });

    it('blueprint status without a blueprint exits 1 in text', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(null);
      await new ContainerCommand().execute('blueprint', 'status', [], {});
      expect(errors).toEqual(['✗ No blueprint; run kunj ct blueprint init']);
      expect(process.exitCode).toBe(1);
    });

    it('blueprint remove lists removed tags', async () => {
      (snapshot.removeSnapshots as jest.Mock).mockResolvedValue(['kunj-blueprint-app:a', 'kunj-blueprint-app:b']);
      await new ContainerCommand().execute('blueprint', 'remove', [], {});
      expect((snapshot.removeSnapshots as jest.Mock).mock.calls[0].slice(0, 3)).toEqual([backend, 'app', REPO_ID]);
      const lines = logSpy.mock.calls.map(c => c.join(' '));
      expect(lines).toEqual(['✓ Removed kunj-blueprint-app:a', '✓ Removed kunj-blueprint-app:b']);
    });

    it('rejects an unknown blueprint sub-verb', async () => {
      await new ContainerCommand().execute('blueprint', 'frob', [], {});
      expect(errors).toEqual(["✗ Unknown blueprint action 'frob'. Expected one of: init, snapshot, status, remove"]);
    });

    it('start passes noSnapshot and prints the blueprint line', async () => {
      (lifecycle.startContainer as jest.Mock).mockResolvedValue({
        names: containerNames('app', REPO_ID, 'feat'),
        containerId: 'cid-9',
        image: 'kunj-blueprint-app:abc',
        user: 'dev',
        created: true,
        seeded: true,
        keptFiles: [],
        copiedFiles: [],
        publish: [],
        firewall: 'default',
        blueprint: { hash: 'abc', snapshot: 'kunj-blueprint-app:old', stale: true, toolsRun: [], setupRan: false, maintainRan: true },
      });
      await new ContainerCommand().execute('start', 'feat', { snapshot: false });
      expect((lifecycle.startContainer as jest.Mock).mock.calls[0][1].noSnapshot).toBe(true);
      expect(logSpy.mock.calls.map(c => c.join(' '))).toContain('  blueprint snapshot abc (stale)');

      await new ContainerCommand().execute('start', 'feat', {});
      expect((lifecycle.startContainer as jest.Mock).mock.calls[1][1].noSnapshot).toBe(false);
    });

    const created = (over: object = {}) => ({
      names: containerNames('app', REPO_ID, 'feat'),
      containerId: 'cid-9',
      image: 'kunj-blueprint-app:abc',
      user: 'dev',
      created: true,
      seeded: true,
      keptFiles: [],
      copiedFiles: [],
      publish: [],
      firewall: 'default',
      ...over,
    });
    const ensure = snapshot.ensureSnapshot as jest.Mock;
    const start = lifecycle.startContainer as jest.Mock;
    const lines = () => logSpy.mock.calls.map(c => c.join(' '));

    it('start builds the snapshot when none exists, then starts from it', async () => {
      const r = resolved();
      (resolveBlueprint as jest.Mock).mockResolvedValue(r);
      ensure.mockImplementation(async (_b, o) => {
        o.log('Building blueprint snapshot (first use; this runs setup once)…');
        return { result: { tag: 'kunj-blueprint-app:abc' }, built: true };
      });
      start.mockResolvedValue(created());
      await new ContainerCommand().execute('start', 'feat', {});

      expect(resolveBlueprint).toHaveBeenCalledWith({ cwd: process.cwd(), repoRoot: mockRoot, repoKunjDir: mockKunjDir, defaultBranch: 'main' });
      expect(ensure).toHaveBeenCalledTimes(1);
      const [b, eo] = ensure.mock.calls[0];
      expect(b).toBe(backend);
      expect(eo).toMatchObject({ branch: 'main', blueprint: r, stale: 'rebuild', jsonMode: false });
      expect(eo.repo).toEqual({ root: '/repo', name: 'app', id: REPO_ID, originUrl: 'https://github.com/acme/app.git' });
      expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
      // The same blueprint, and lifecycle prints no hint of its own
      expect(start.mock.calls[0][1]).toMatchObject({ blueprint: r, snapshotHandled: true, noSnapshot: false, worktreeRoot: mockRoot });
      expect(lines()).toContain('Building blueprint snapshot (first use; this runs setup once)…');
      expect(lines()).toContain('✓ Container ' + created().names.container + ' created');
    });

    it('start rebuilds a stale snapshot', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      ensure.mockImplementation(async (_b, o) => {
        o.log('Blueprint changed; rebuilding the snapshot…');
        return { result: { tag: 'kunj-blueprint-app:new' }, built: true };
      });
      start.mockResolvedValue(created());
      await new ContainerCommand().execute('start', 'feat', { json: true });
      expect(ensure.mock.calls[0][1]).toMatchObject({ stale: 'rebuild', jsonMode: true });
      expect(start.mock.calls[0][1].snapshotHandled).toBe(true);
      // Progress goes to stderr in --json mode; stdout stays one document
      expect(errSpy.mock.calls.map(c => String(c[0]))).toContain('Blueprint changed; rebuilding the snapshot…\n');
      expect(JSON.parse(stdout.join(''))).toMatchObject({ branch: 'feat', created: true });
    });

    it('start falls back with a warning when the snapshot build fails', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      ensure.mockResolvedValue({ result: null, built: false, failed: 'git fetch failed: denied' });
      start.mockResolvedValue(created({ image: 'kunj-sandbox:1.3.0' }));
      await new ContainerCommand().execute('start', 'feat', {});
      expect(lines().some(l =>
        l.includes('Blueprint snapshot could not be built (git fetch failed: denied); running tools and setup in the container instead'))).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start.mock.calls[0][1]).toMatchObject({ snapshotHandled: true, noSnapshot: false });
      expect(errors).toEqual([]);
      expect(process.exitCode).toBeUndefined();

      // A failed rebuild of a stale snapshot: lifecycle still starts from the stale one
      ensure.mockResolvedValue({ result: null, built: false, failed: 'setup failed', stale: true });
      await new ContainerCommand().execute('start', 'feat', {});
      expect(lines().some(l => l.includes('Blueprint snapshot could not be rebuilt (setup failed); starting from the stale snapshot'))).toBe(true);
    });

    it('--no-snapshot, --image and no blueprint skip the build', async () => {
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      start.mockResolvedValue(created());
      await new ContainerCommand().execute('start', 'feat', { snapshot: false });
      await new ContainerCommand().execute('start', 'feat', { image: 'node:22' });
      (resolveBlueprint as jest.Mock).mockResolvedValue(null);
      await new ContainerCommand().execute('start', 'feat', {});
      expect(ensure).not.toHaveBeenCalled();
      expect(start.mock.calls[0][1]).toMatchObject({ noSnapshot: true, snapshotHandled: false });
      expect(start.mock.calls[2][1]).toMatchObject({ blueprint: null, snapshotHandled: false });
    });

    it('resuming an existing container never builds a snapshot', async () => {
      backend.existing = [mainContainer('feat')];
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      start.mockResolvedValue(created({ created: false }));
      await new ContainerCommand().execute('start', 'feat', {});
      expect(ensure).not.toHaveBeenCalled();
      expect(resolveBlueprint).not.toHaveBeenCalled();
      // Lifecycle resolves the blueprint itself (for maintain), the working tree first
      expect(start.mock.calls[0][1]).toMatchObject({ snapshotHandled: false, worktreeRoot: mockRoot });
      expect(start.mock.calls[0][1].blueprint).toBeUndefined();
    });

    it('start skips the build with a hint when the default branch is unknown', async () => {
      (detectDefaultBranch as jest.Mock).mockResolvedValue(null);
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved('{"setup":["make"]}', 'host'));
      start.mockResolvedValue(created());
      try {
        await new ContainerCommand().execute('start', 'feat', {});
      } finally {
        (detectDefaultBranch as jest.Mock).mockResolvedValue('main');
      }
      expect(ensure).not.toHaveBeenCalled();
      expect(lines().some(l => l.includes('cannot detect the default branch; the blueprint snapshot is not built'))).toBe(true);
      expect(start.mock.calls[0][1]).toMatchObject({ snapshotHandled: false });
    });

    it('list json includes image.kind and blueprint', async () => {
      const options = (o: object) => ({ ...mainContainer('x').labels, 'kunj.options': JSON.stringify({ firewall: 'default', user: 'dev', ...o }) });
      backend.existing = [
        mainContainer('a', { id: 'c-a', image: 'kunj-blueprint-app:abc123abc123', labels: options({ imageKind: 'blueprint', blueprintHash: 'abc123abc123' }) }),
        mainContainer('b', { id: 'c-b', image: 'kunj-blueprint-app:old', labels: options({ imageKind: 'blueprint', blueprintHash: 'old' }) }),
        mainContainer('c', { id: 'c-c', labels: options({ imageKind: 'sandbox' }) }),
        mainContainer('d', { id: 'c-d' }),
      ];
      (resolveBlueprint as jest.Mock).mockResolvedValue(resolved());
      await new ContainerCommand().execute('list', { json: true, status: false });
      const out = JSON.parse(stdout.join(''));
      expect(out.containers.map((c: any) => [c.image, c.imageInfo, c.blueprint])).toEqual([
        ['kunj-blueprint-app:abc123abc123', { tag: 'kunj-blueprint-app:abc123abc123', kind: 'blueprint' }, { hash: 'abc123abc123', stale: false }],
        ['kunj-blueprint-app:old', { tag: 'kunj-blueprint-app:old', kind: 'blueprint' }, { hash: 'old', stale: true }],
        ['kunj-sandbox:1.3.0', { tag: 'kunj-sandbox:1.3.0', kind: 'sandbox' }, undefined],
        ['kunj-sandbox:1.3.0', { tag: 'kunj-sandbox:1.3.0' }, undefined],
      ]);
      expect(snapshot.planSnapshot).toHaveBeenCalledTimes(1);
    });

    it('list computes no blueprint hash without blueprint containers, and null when it fails', async () => {
      backend.existing = [mainContainer('d', { id: 'c-d' })];
      await new ContainerCommand().execute('list', { json: true, status: false });
      expect(resolveBlueprint).not.toHaveBeenCalled();

      stdout.length = 0;
      backend.existing = [
        mainContainer('a', { labels: { ...mainContainer('a').labels, 'kunj.options': JSON.stringify({ imageKind: 'blueprint', blueprintHash: 'h' }) } }),
      ];
      (resolveBlueprint as jest.Mock).mockRejectedValueOnce(new Error('bad blueprint'));
      await new ContainerCommand().execute('list', { json: true, status: false });
      expect(JSON.parse(stdout.join('')).containers[0].blueprint).toEqual({ hash: 'h', stale: null });
    });
  });

  describe('open', () => {
    let home: string;
    const vscodeDir = () => path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'ms-vscode-remote.remote-containers', 'imageConfigs');
    const linuxDir = () => path.join(home, '.config', 'Code', 'User', 'globalStorage', 'ms-vscode-remote.remote-containers', 'imageConfigs');
    const configDir = () => (process.platform === 'darwin' ? vscodeDir() : linuxDir());

    beforeEach(() => {
      mockSpawned.length = 0;
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-open-'));
      mockHome = home;
    });
    afterEach(() => {
      mockHome = undefined;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('writes the image config and launches the editor on the attached-container uri', async () => {
      const main = mainContainer('feat');
      backend.existing = [main];
      await new ContainerCommand().execute('open', 'feat', { json: true });

      const uri = attachedContainerUri(main.name);
      expect(mockSpawned).toEqual([['code', '-r', '--folder-uri', uri]]);
      const file = path.join(configDir(), 'kunj-sandbox%3a1.3.0.json');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ remoteUser: 'dev', workspaceFolder: '/workspace' });
      expect(JSON.parse(stdout.join(''))).toEqual({ success: true, branch: 'feat', name: main.name, editor: 'code', uri, warning: EDITOR_CREDENTIALS_WARNING });
      expect(lifecycle.startContainer).not.toHaveBeenCalled();
    });

    it('warns that the editor may forward host credentials, naming the settings that turn them off', async () => {
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('open', 'feat', {});
      const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(printed).toContain(EDITOR_CREDENTIALS_WARNING);
      expect(EDITOR_CREDENTIALS_WARNING).toMatch(/git credentials, SSH agent and GPG agent/);
      expect(EDITOR_CREDENTIALS_WARNING).toContain('"dev.containers.copyGitConfig": false');
      expect(EDITOR_CREDENTIALS_WARNING).toContain('"dev.containers.gitCredentialHelperConfigLocation": "none"');
    });

    it('opens a new window with --new-window and uses the configured editor', async () => {
      (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ container: {}, worktree: { editorCommand: 'cursor' } });
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('open', 'feat', { newWindow: true });
      expect(mockSpawned[0].slice(0, 3)).toEqual(['cursor', '-n', '--folder-uri']);
    });

    it('starts a stopped container first, through the start routine', async () => {
      const main = mainContainer('feat', { state: 'exited' });
      backend.existing = [main];
      (lifecycle.startContainer as jest.Mock).mockResolvedValueOnce({
        names: containerNames('app', REPO_ID, 'feat'),
        containerId: 'cid-1',
        image: 'kunj-sandbox:1.3.0',
        user: 'dev',
        created: false,
        seeded: false,
        keptFiles: [],
        copiedFiles: [],
        publish: [],
        firewall: 'default',
      });
      await new ContainerCommand().execute('open', 'feat', { json: true, rebuild: true, create: true, image: 'other:1', publish: '3000' });
      // only resumed: start's options never reach it
      expect((lifecycle.startContainer as jest.Mock).mock.calls[0][1]).toMatchObject({ branch: 'feat', create: false, rebuild: false, imageOverride: undefined, publish: [] });
      expect(mockSpawned).toHaveLength(1);
      expect(JSON.parse(stdout.join(''))).toMatchObject({ success: true, branch: 'feat' });
    });

    it('prints the docker exec command for an editor that cannot attach', async () => {
      (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ container: {}, worktree: { editorCommand: 'subl' } });
      const main = mainContainer('feat');
      backend.existing = [main];
      await new ContainerCommand().execute('open', 'feat', {});
      expect(mockSpawned).toEqual([]);
      const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(printed).toContain(`docker exec -it -u dev -w /workspace ${main.name} sh -lc 'exec $(command -v zsh || command -v bash || echo sh) -l'`);
      expect(printed).not.toContain('Dev Containers extension');
      expect(fs.existsSync(configDir())).toBe(false);
    });

    it('warns in allowlist mode that the editor server needs its domains', async () => {
      (loadResolvedConfig as jest.Mock).mockResolvedValueOnce({ container: { network: { allow: ['registry.npmjs.org'] } } });
      backend.existing = [mainContainer('feat')];
      await new ContainerCommand().execute('open', 'feat', {});
      const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(printed).toMatch(/allowlist.*marketplace/i);
      expect(mockSpawned).toHaveLength(1);
    });

    it('refuses a branch without a container', async () => {
      await new ContainerCommand().execute('open', 'feat', {});
      expect(errors).toEqual(['✗ No container for feat; run kunj ct start feat']);
      expect(mockSpawned).toEqual([]);
    });
  });
  describe('prune', () => {
    const NAMES = containerNames('app', REPO_ID, 'gone');
    const PLAN = {
      containers: [{ branch: 'gone', names: NAMES, reason: 'branch-gone', image: 'kunj-sandbox:1', user: 'dev', guard: { unpushedRefs: [], stashes: 0, dirty: false, originReachable: true } }],
      orphans: [{ kind: 'volume', name: 'kunj-app-old-123456-ws' }],
      images: ['kunj-blueprint-app:old'],
      bytes: 5 * 1024 * 1024,
      warnings: [],
    };
    let isTTY: boolean | undefined;

    beforeEach(() => {
      (prune.planPrune as jest.Mock).mockImplementation(async () => JSON.parse(JSON.stringify(PLAN)));
      isTTY = process.stdout.isTTY;
      mockConfirm = true;
      mockRepos = [];
    });
    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    });
    const tty = (value: boolean) => Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });

    it('is a dry run when stdout is not a TTY', async () => {
      tty(false);
      await new ContainerCommand().execute('prune', { json: true });
      expect(prune.planPrune).toHaveBeenCalledWith(backend, expect.objectContaining({ repoId: REPO_ID, repoName: 'app', cwd: '/repo', force: false }));
      expect(prune.applyPrune).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.join(''))).toEqual({ success: true, dryRun: true, plan: PLAN, removed: [], failed: [] });
    });

    it('--dry-run on a TTY lists what would go, with sizes', async () => {
      tty(true);
      await new ContainerCommand().execute('prune', { dryRun: true });
      expect(prune.applyPrune).not.toHaveBeenCalled();
      expect(inquirer.prompt).not.toHaveBeenCalled();
      const printed = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(printed).toContain(NAMES.container);
      expect(printed).toContain('kunj-app-old-123456-ws');
      expect(printed).toMatch(/kunj-blueprint-app:old/);
      expect(printed).toMatch(/5 MB/);
    });

    it('confirms once on a TTY, then removes with the container-delete hooks', async () => {
      tty(true);
      await new ContainerCommand().execute('prune', {});
      expect(inquirer.prompt).toHaveBeenCalledTimes(1);
      expect(prune.applyPrune).toHaveBeenCalledWith(backend, PLAN, expect.objectContaining({ repoId: REPO_ID, force: false }));
      const hook = (prune.applyPrune as jest.Mock).mock.calls[0][2].hook;
      await hook('pre-container-delete', { branch: 'gone', container: NAMES.container, image: 'kunj-sandbox:1' });
      expect(runActionHook).toHaveBeenCalledWith('pre-container-delete', { branch: 'gone', container: NAMES.container, image: 'kunj-sandbox:1' }, expect.objectContaining({ skip: false }));
    });

    it('removes nothing when the confirmation is declined', async () => {
      tty(true);
      mockConfirm = false;
      await new ContainerCommand().execute('prune', {});
      expect(prune.applyPrune).not.toHaveBeenCalled();
    });

    it('--force skips the guard but still asks on a TTY', async () => {
      tty(true);
      await new ContainerCommand().execute('prune', { force: true, hooks: false });
      expect(inquirer.prompt).toHaveBeenCalledTimes(1);
      expect(prune.planPrune).toHaveBeenCalledWith(backend, expect.objectContaining({ force: true }));
      expect(prune.applyPrune).toHaveBeenCalledWith(backend, PLAN, expect.objectContaining({ force: true }));
    });

    it('--force alone is a dry run without a TTY, and with --json', async () => {
      tty(false);
      await new ContainerCommand().execute('prune', { force: true });
      expect(prune.applyPrune).not.toHaveBeenCalled();

      tty(true);
      await new ContainerCommand().execute('prune', { force: true, json: true });
      expect(prune.applyPrune).not.toHaveBeenCalled();
      expect(inquirer.prompt).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.join(''))).toMatchObject({ dryRun: true, removed: [] });
    });

    it('--yes applies without asking, without a TTY and with --json, keeping the guard unless --force', async () => {
      tty(false);
      await new ContainerCommand().execute('prune', { yes: true, json: true });
      expect(inquirer.prompt).not.toHaveBeenCalled();
      expect(prune.planPrune).toHaveBeenLastCalledWith(backend, expect.objectContaining({ force: false }));
      expect(prune.applyPrune).toHaveBeenLastCalledWith(backend, PLAN, expect.objectContaining({ force: false }));
      expect(JSON.parse(stdout.join(''))).toMatchObject({ success: true, dryRun: false, removed: ['kunj-app-gone-abc123'], failed: [] });

      await new ContainerCommand().execute('prune', { yes: true, force: true });
      expect(prune.applyPrune).toHaveBeenLastCalledWith(backend, PLAN, expect.objectContaining({ force: true }));
      expect(inquirer.prompt).not.toHaveBeenCalled();
    });

    it('lists kept orphan volumes as kept', async () => {
      tty(true);
      (prune.planPrune as jest.Mock).mockResolvedValue({ ...PLAN, containers: [], images: [], orphans: [{ kind: 'volume', name: 'v-ws', kept: prune.KEPT_VOLUME }] });
      await new ContainerCommand().execute('prune', { dryRun: true });
      expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/keep\s+volume v-ws\s+volume without a container; use --force/);
    });

    it('--all plans every recorded repository from its own directory, asking about kunj images once', async () => {
      tty(false);
      const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-b-'))].map(d => fs.realpathSync(d));
      mockRepos = [{ root: dirs[0], exists: true }, { root: dirs[1], exists: true }, { root: '/gone', exists: false }];
      const seen: string[] = [];
      (config.getRepoCommonRoot as jest.Mock).mockImplementation(() => process.cwd());
      (prune.planPrune as jest.Mock).mockImplementation(async (_b: unknown, c: { cwd: string; kunjImages?: boolean }) => {
        seen.push(`${c.cwd}:${c.kunjImages}`);
        return { containers: [], orphans: [], images: [], bytes: 0, warnings: [] };
      });
      const cwd = process.cwd();
      try {
        await new ContainerCommand().execute('prune', { all: true, json: true });
      } finally {
        (config.getRepoCommonRoot as jest.Mock).mockImplementation(() => '/repo');
        dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true }));
      }
      expect(seen).toEqual([`${dirs[0]}:true`, `${dirs[1]}:false`]);
      expect(process.cwd()).toBe(cwd);
      expect(config.resetRepoCache).toHaveBeenCalled();
      expect(JSON.parse(stdout.join(''))).toMatchObject({ success: true, dryRun: true });
    });

    it('list reports orphans in JSON and as a line in text', async () => {
      backend.existing = [mainContainer('feat')];
      (lifecycle.containerStatus as jest.Mock).mockResolvedValue({ agentRunning: false, head: null, ahead: 0, dirty: false, status: 'ok' });
      const old = containerNames('app', REPO_ID, 'old');
      backend.volumes.add(old.workspaceVolume);
      backend.volumeLabels.set(old.workspaceVolume, { 'kunj.repo': REPO_ID, 'kunj.branch': 'old' });
      backend.networks.set(old.network, { 'kunj.repo': REPO_ID, 'kunj.branch': 'old' });
      await new ContainerCommand().execute('list', { json: true });
      expect(JSON.parse(stdout.join('')).orphans).toEqual([
        { kind: 'volume', name: old.workspaceVolume },
        { kind: 'network', name: old.network },
      ]);
      await new ContainerCommand().execute('list', {});
      expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/orphans.*2.*kunj ct prune/);
    });
  });
});

describe('ct file', () => {
  const READ = 'sh -c cat -- "$1" sh src/a.ts';
  const WRITE = 'sh -c mkdir -p -- "$(dirname -- "$1")" && cat > "$1" sh src/a.ts';
  let exit: jest.SpyInstance;

  beforeEach(() => {
    backend.stdinData = [];
    exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });
  afterEach(() => exit.mockRestore());

  it('read --json prints the content', async () => {
    backend.existing = [mainContainer('feat')];
    backend.execResults.set(READ, { exitCode: 0, stdout: 'hello' });
    await new ContainerCommand().execute('file', 'read', ['feat', './src/a.ts'], { json: true });
    expect(JSON.parse(stdout.join(''))).toEqual({ path: 'src/a.ts', content: 'hello' });
    const [, cmd, io] = backend.callsOf('exec')[0] as [string, string[], { user?: string; workdir?: string }];
    expect(cmd.slice(-2)).toEqual(['sh', 'src/a.ts']);
    expect(io).toMatchObject({ user: 'dev', workdir: '/workspace' });
  });

  it('read without --json prints the content raw', async () => {
    backend.existing = [mainContainer('feat')];
    backend.execResults.set(READ, { exitCode: 0, stdout: 'hello\n' });
    await new ContainerCommand().execute('file', 'read', ['feat', 'src/a.ts'], {});
    expect(stdout.join('')).toBe('hello\n');
  });

  it('read with one positional uses the current branch', async () => {
    backend.existing = [mainContainer('current')];
    backend.execResults.set(READ, { exitCode: 0, stdout: 'x' });
    await new ContainerCommand().execute('file', 'read', ['src/a.ts'], { json: true });
    expect(JSON.parse(stdout.join(''))).toEqual({ path: 'src/a.ts', content: 'x' });
  });

  it('write --json reads stdin to the end', async () => {
    const { Readable } = await import('stream');
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: Readable.from(['new']), configurable: true });
    try {
      backend.existing = [mainContainer('feat')];
      backend.execResults.set(WRITE, { exitCode: 0, stdout: '' });
      await new ContainerCommand().execute('file', 'write', ['feat', 'src/a.ts'], { json: true });
    } finally {
      Object.defineProperty(process, 'stdin', original);
    }
    expect(JSON.parse(stdout.join(''))).toEqual({ success: true, path: 'src/a.ts' });
    expect(backend.stdinData).toEqual(['new']);
  });

  it('read on a stopped container fails', async () => {
    backend.existing = [mainContainer('feat', { state: 'exited' })];
    await new ContainerCommand().execute('file', 'read', ['feat', 'src/a.ts'], {});
    expect(errors).toEqual(['✗ Container for feat is not running; run kunj ct start feat']);
  });

  it('a coded error prints { code, message } in --json mode', async () => {
    backend.existing = [mainContainer('feat')];
    await new ContainerCommand().execute('file', 'read', ['feat', '../x'], { json: true });
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(stdout.join(''))).toEqual({ error: { code: 'bad-path', message: 'Path must stay inside /workspace: ../x' } });
  });

  it('a missing file is not-found', async () => {
    backend.existing = [mainContainer('feat')];
    backend.execResults.set(READ, { exitCode: 1, stdout: '' });
    await new ContainerCommand().execute('file', 'read', ['feat', 'src/a.ts'], { json: true });
    expect(JSON.parse(stdout.join('')).error.code).toBe('not-found');
  });

  it('an uncoded ContainerError prints code "error" in --json mode', async () => {
    backend.existing = [mainContainer('feat', { state: 'exited' })];
    await new ContainerCommand().execute('file', 'read', ['feat', 'src/a.ts'], { json: true });
    expect(JSON.parse(stdout.join(''))).toEqual({ error: { code: 'error', message: 'Container for feat is not running; run kunj ct start feat' } });
  });

  it('rejects an unknown file action and a missing path', async () => {
    await new ContainerCommand().execute('file', 'frob', ['a'], {});
    await new ContainerCommand().execute('file', 'read', [], {});
    expect(errors).toEqual(["✗ Unknown file action 'frob'. Expected one of: read, write", '✗ Usage: kunj ct file read [branch] <path>']);
  });
});
