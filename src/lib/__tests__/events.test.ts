import { describe, it, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitPathMatters, watchEvents } from '../events';
import { listTmuxSessions } from '../agent-session';
import { FakeBackend } from '../container/__tests__/fake-backend';
import { STATUS_SCRIPT } from '../container/env';
import type { ContainerInfo } from '../container/backend';
import type { KnownRepoInfo } from '../repos';
import type { EventJson } from '../json-types';

// Fixture repositories and subprocesses: slow when the machine is busy
jest.setTimeout(30000);

jest.mock('../agent-session', () => ({
  ...jest.requireActual<object>('../agent-session'),
  listTmuxSessions: jest.fn(async () => []),
}));

// fs.watch tests wait for real events and quiet periods; the default 5 s is too short under load
jest.setTimeout(20_000);

const tmuxMock = listTmuxSessions as unknown as jest.Mock<() => Promise<string[] | null>>;

let tmp: string;
let repo: KnownRepoInfo;
let kunjDir: string;
let events: EventJson[];
let controller: AbortController;
let running: Promise<void> | null;
// The module object itself: `import * as` gives a copy whose properties cannot be spied on
const nodeFs: typeof fs = jest.requireActual('fs');
let watchSpy: jest.SpiedFunction<typeof fs.watch> | null = null;

function start(options: Partial<Parameters<typeof watchEvents>[0]> = {}): void {
  running = watchEvents({
    repos: [repo],
    kunjDir,
    backend: null,
    onEvent: e => events.push(e),
    signal: controller.signal,
    debounceMs: 50,
    tmuxPollMs: 60_000,
    statusPollMs: 60_000,
    backendRetryMs: 20,
    repoId: async () => 'github.com/acme/app',
    ...options,
  });
}

async function waitFor(pred: () => boolean, action?: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
    action?.();
    await new Promise(r => setTimeout(r, 100));
  }
}

// Until no event has arrived for `quietMs`
async function settle(quietMs = 400): Promise<void> {
  let count = -1;
  while (count !== events.length) {
    count = events.length;
    await new Promise(r => setTimeout(r, quietMs));
  }
}

const ofType = (type: EventJson['type']) => events.filter(e => e.type === type);

// The watchers start asynchronously: write until one event of the type has arrived, then let them settle
// (quietMs longer than the debounce: a write just before the event may have started another window)
async function prime(type: EventJson['type'], write: () => void, quietMs = 400): Promise<void> {
  await waitFor(() => ofType(type).length > 0, write);
  await settle(quietMs);
  events = [];
}

// The repo-id and status git calls inherit this: no user config (insteadOf, fsmonitor) in the tests
const configBefore = process.env.GIT_CONFIG_GLOBAL;
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
});
afterAll(() => {
  if (configBefore === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = configBefore;
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-events-'));
  const gitDir = path.join(tmp, 'app', '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
  kunjDir = path.join(tmp, 'kunj');
  fs.mkdirSync(kunjDir);
  repo = {
    root: path.join(tmp, 'app'), gitCommonDir: gitDir, name: 'app', bare: false,
    addedAt: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z', exists: true,
  };
  events = [];
  controller = new AbortController();
  running = null;
  tmuxMock.mockReset();
  tmuxMock.mockResolvedValue([]);
});

afterEach(async () => {
  controller.abort();
  await running;
  watchSpy?.mockRestore();
  watchSpy = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('gitPathMatters', () => {
  it.each([
    ['HEAD', true],
    ['ORIG_HEAD', true],
    ['index', true],
    ['packed-refs', true],
    ['refs/heads/x', true],
    ['refs/remotes/origin/main', true],
    ['worktrees/a/HEAD', true],
    ['worktrees/a/index', true],
    ['worktrees/a/logs/HEAD', false],
    ['logs/HEAD', false],
    ['logs/refs/heads/x', false],
    ['objects/ab/cd', false],
    ['index.lock', false],
    ['refs/heads/x.lock', false],
    ['config', false],
  ])('%s -> %s', (p, expected) => {
    expect(gitPathMatters(p)).toBe(expected);
  });
});

describe('watchEvents', () => {
  const headFile = () => path.join(repo.gitCommonDir, 'HEAD');

  it('two HEAD writes within the debounce yield one git event with the repo', async () => {
    start({ debounceMs: 1000 });
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'), 1500);
    fs.writeFileSync(headFile(), 'ref: refs/heads/x\n');
    fs.writeFileSync(headFile(), 'ref: refs/heads/y\n');
    await waitFor(() => ofType('git').length > 0);
    await settle(1500);
    expect(ofType('git')).toEqual([{ type: 'git', repo: { name: 'app', root: repo.root }, at: expect.any(String) }]);
  });

  it('ignores writes under objects/ and logs/', async () => {
    start();
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
    fs.mkdirSync(path.join(repo.gitCommonDir, 'objects', 'ab'), { recursive: true });
    fs.writeFileSync(path.join(repo.gitCommonDir, 'objects', 'ab', 'cd'), 'x');
    fs.mkdirSync(path.join(repo.gitCommonDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(repo.gitCommonDir, 'logs', 'HEAD'), 'x');
    await settle(600);
    expect(ofType('git')).toEqual([]);
  });

  it('does not watch the worktree checkouts inside the common dir', async () => {
    watchSpy = jest.spyOn(nodeFs, 'watch');
    const nodeModules = path.join(repo.gitCommonDir, 'kunj', 'worktrees', 'x', 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    start();
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
    const recursive = watchSpy!.mock.calls
      .filter(([, opts]) => (opts as fs.WatchOptions | undefined)?.recursive)
      .map(([dir]) => String(dir));
    expect(recursive).toEqual([path.join(repo.gitCommonDir, 'refs')]);
    expect(watchSpy!.mock.calls.map(([dir]) => String(dir))).not.toContain(path.join(repo.gitCommonDir, 'kunj'));
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(nodeModules, 'a'), String(i));
    await settle(600);
    expect(ofType('git')).toEqual([]);
  });

  it('a new ref under refs/ yields a git event', async () => {
    start();
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
    await waitFor(() => ofType('git').length > 0, () => fs.writeFileSync(path.join(repo.gitCommonDir, 'refs', 'heads', 'y'), 'b'.repeat(40) + '\n'));
  });

  it('worktrees/ created after start is watched: worktrees/<n>/HEAD yields a git event', async () => {
    watchSpy = jest.spyOn(nodeFs, 'watch');
    start();
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
    const worktrees = path.join(repo.gitCommonDir, 'worktrees');
    fs.mkdirSync(path.join(worktrees, 'n'), { recursive: true });
    await waitFor(() => watchSpy!.mock.calls.some(([dir]) => String(dir) === worktrees));
    await settle();
    events = [];
    await waitFor(() => ofType('git').length > 0, () => fs.writeFileSync(path.join(worktrees, 'n', 'HEAD'), 'ref: refs/heads/n\n'));
  });

  it('writing worktree-sessions.json yields a sessions event', async () => {
    start();
    const file = path.join(kunjDir, 'worktree-sessions.json');
    await waitFor(() => ofType('sessions').length > 0, () => fs.writeFileSync(file, '{}'));
    expect(ofType('sessions')[0]).toEqual({ type: 'sessions', at: expect.any(String) });
  });

  it('maps the forwards and repos files to their event types', async () => {
    start();
    await waitFor(() => ofType('forwards').length > 0, () => fs.writeFileSync(path.join(kunjDir, 'container-forwards.json'), '[]'));
    await waitFor(() => ofType('repos').length > 0, () => fs.writeFileSync(path.join(kunjDir, 'repos.json'), '{}'));
  });

  it('a backend event maps kunj.repo to the known repo and carries the branch', async () => {
    const backend = new FakeBackend();
    start({ backend });
    await waitFor(() => backend.callsOf('events').length > 0);
    expect(backend.callsOf('events')[0][0]).toEqual({ 'kunj.repo': '' });
    backend.emitEvent({ action: 'start', name: 'kunj-app-x-abc123', labels: { 'kunj.repo': 'github.com/acme/app', 'kunj.branch': 'x' }, at: '2026-10-23T10:00:00.000Z' });
    backend.emitEvent({ action: 'die', name: 'kunj-other-y-def456', labels: { 'kunj.repo': 'github.com/acme/other' }, at: '2026-10-23T10:00:01.000Z' });
    // exec_* would make every `kunj ct list` (which execs into each container) trigger another refresh
    backend.emitEvent({ action: 'exec_start: sh -c true', name: 'kunj-app-x-abc123', labels: { 'kunj.repo': 'github.com/acme/app' }, at: '2026-10-23T10:00:02.000Z' });
    expect(ofType('container')).toEqual([
      { type: 'container', repo: { name: 'app', root: repo.root }, branch: 'x', container: 'kunj-app-x-abc123', action: 'start', at: '2026-10-23T10:00:00.000Z' },
      { type: 'container', repo: null, branch: null, container: 'kunj-other-y-def456', action: 'die', at: '2026-10-23T10:00:01.000Z' },
    ]);
  });

  it('backend unavailable is reported once and the git watcher still works', async () => {
    const backend = new FakeBackend();
    jest.spyOn(backend, 'events').mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    jest.spyOn(backend, 'info').mockRejectedValue(new Error('Docker is not available'));
    start({ backend });
    await waitFor(() => (backend.events as jest.Mock).mock.calls.length > 0 && (backend.info as jest.Mock).mock.calls.length >= 3);
    expect(ofType('backend')).toEqual([{ type: 'backend', status: 'unavailable', message: 'Cannot connect to the Docker daemon', at: expect.any(String) }]);
    await waitFor(() => ofType('git').length > 0, () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
  });

  it('backend available is reported when a retry succeeds', async () => {
    const backend = new FakeBackend();
    const real = backend.events.bind(backend);
    jest.spyOn(backend, 'events').mockRejectedValueOnce(new Error('daemon down')).mockImplementation(real);
    start({ backend });
    await waitFor(() => ofType('backend').length >= 2);
    expect(ofType('backend').map(e => (e as { status: string }).status)).toEqual(['unavailable', 'available']);
  });

  it('a new kunj- tmux session yields an agent event, and one that ends another', async () => {
    tmuxMock.mockResolvedValueOnce([]).mockResolvedValueOnce(['main', 'kunj-app-x-abc123']).mockResolvedValue([]);
    start({ tmuxPollMs: 10 });
    await waitFor(() => ofType('agent').length >= 2);
    expect(ofType('agent')).toEqual([
      { type: 'agent', session: 'kunj-app-x-abc123', running: true, at: expect.any(String) },
      { type: 'agent', session: 'kunj-app-x-abc123', running: false, at: expect.any(String) },
    ]);
  });

  it('a write to agent-state/<session> yields an agent event with the state', async () => {
    const stateDir = path.join(kunjDir, 'app', 'agent-state');
    fs.mkdirSync(stateDir, { recursive: true });
    start();
    await prime('agent', () => fs.writeFileSync(path.join(stateDir, 'kunj-app-x-abc123'), 'running'));
    fs.writeFileSync(path.join(stateDir, 'kunj-app-x-abc123'), 'waiting');
    await waitFor(() => ofType('agent').length > 0);
    expect(ofType('agent')[0]).toEqual({ type: 'agent', session: 'kunj-app-x-abc123', running: true, state: 'waiting', at: expect.any(String) });
  });

  it('a changed agent state in a container yields a container status event', async () => {
    const key = `sh -c ${STATUS_SCRIPT}`;
    const backend = new FakeBackend();
    backend.existing = [{
      id: 'id-1', name: 'kunj-app-x-1', state: 'running', image: 'img', createdAt: '', ports: [],
      labels: { 'kunj.repo': 'github.com/acme/app', 'kunj.branch': 'x', 'kunj.role': 'main' },
    }];
    backend.execResults.set(key, { exitCode: 0, stdout: 'tmux=0\nstate=running\n# branch.oid ' + 'a'.repeat(40) + '\n' });
    let ready!: () => void;
    const armed = new Promise<void>(r => (ready = r));
    start({ backend, statusPollMs: 50, onReady: ready });
    await armed;
    await waitFor(() => backend.callsOf('exec').length > 1);
    backend.execResults.set(key, { exitCode: 0, stdout: 'tmux=0\nstate=waiting\n# branch.oid ' + 'a'.repeat(40) + '\n' });
    await waitFor(() => ofType('container').some(e => (e as { action: string }).action === 'status'));
  });

  it('a missing directory is skipped, not fatal', async () => {
    fs.rmSync(kunjDir, { recursive: true });
    repo = { ...repo, gitCommonDir: path.join(tmp, 'gone', '.git') };
    start();
    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it('aborting the signal resolves watchEvents', async () => {
    const backend = new FakeBackend();
    start({ backend, tmuxPollMs: 10 });
    await waitFor(() => backend.callsOf('events').length > 0);
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    const before = tmuxMock.mock.calls.length;
    await new Promise(r => setTimeout(r, 100));
    expect(tmuxMock.mock.calls.length).toBe(before);
  });

  it('onReady comes after the watchers are armed: a change right after it is reported', async () => {
    let ready!: () => void;
    const armed = new Promise<void>(r => (ready = r));
    start({ onReady: ready });
    await armed;
    expect(tmuxMock).toHaveBeenCalled();
    fs.writeFileSync(path.join(repo.gitCommonDir, 'refs', 'heads', 'z'), 'c'.repeat(40) + '\n');
    await waitFor(() => ofType('git').length > 0);
  });

  it('a tmux failure (null) is not read as every agent ending', async () => {
    tmuxMock.mockResolvedValueOnce(['kunj-app-x-abc123']).mockResolvedValueOnce(null).mockResolvedValue(['kunj-app-x-abc123']);
    start({ tmuxPollMs: 10 });
    await waitFor(() => tmuxMock.mock.calls.length >= 5);
    expect(ofType('agent')).toEqual([]);
  });

  it('a subwatcher that errors is closed and restarted', async () => {
    watchSpy = jest.spyOn(nodeFs, 'watch');
    const refs = path.join(repo.gitCommonDir, 'refs');
    start({ statusPollMs: 50 });
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
    const index = watchSpy!.mock.calls.findIndex(([dir]) => String(dir) === refs);
    const watcher = watchSpy!.mock.results[index].value as fs.FSWatcher;
    const close = jest.spyOn(watcher, 'close');
    watcher.emit('error', new Error('EMFILE'));
    expect(close).toHaveBeenCalled();
    await waitFor(() => watchSpy!.mock.calls.filter(([dir]) => String(dir) === refs).length >= 2);
    await settle();
    events = [];
    await waitFor(() => ofType('git').length > 0, () => fs.writeFileSync(path.join(refs, 'heads', 'w'), 'd'.repeat(40) + '\n'));
  });

  it('a hung Docker daemon does not block exit', async () => {
    const backend = new FakeBackend();
    jest.spyOn(backend, 'events').mockRejectedValue(new Error('daemon down'));
    jest.spyOn(backend, 'info').mockReturnValue(new Promise(() => undefined));
    start({ backend });
    await waitFor(() => (backend.info as jest.Mock).mock.calls.length > 0);
    controller.abort();
    const outcome = await Promise.race([running!.then(() => 'done'), new Promise(r => setTimeout(() => r('hung'), 1000))]);
    expect(outcome).toBe('done');
  });

  it('a hung container list does not block exit', async () => {
    const backend = new FakeBackend();
    jest.spyOn(backend, 'list').mockReturnValue(new Promise(() => undefined));
    start({ backend, statusPollMs: 20 });
    await waitFor(() => (backend.list as jest.Mock).mock.calls.length > 0);
    controller.abort();
    const outcome = await Promise.race([running!.then(() => 'done'), new Promise(r => setTimeout(() => r('hung'), 1000))]);
    expect(outcome).toBe('done');
  });

  it('the repo id defaults to origin\'s URL as git reports it (insteadOf), without userinfo', async () => {
    const root = path.join(tmp, 'real');
    git(['init', '-q', root]);
    git(['-C', root, 'remote', 'add', 'origin', 'gh:Real.git']);
    git(['-C', root, 'config', 'url.https://user:secret@github.com/acme/.insteadOf', 'gh:']);
    repo = { ...repo, root, gitCommonDir: path.join(root, '.git'), name: 'real' };
    const backend = new FakeBackend();
    start({ backend, repoId: undefined });
    await waitFor(() => backend.callsOf('events').length > 0);
    backend.emitEvent({ action: 'start', name: 'kunj-real-x-1', labels: { 'kunj.repo': 'github.com/acme/real', 'kunj.branch': 'x' }, at: '2026-10-23T10:00:00.000Z' });
    expect(ofType('container')).toEqual([expect.objectContaining({ repo: { name: 'real', root }, branch: 'x' })]);
  });
});

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

describe('watchEvents status poll', () => {
  let root: string;
  let ready: Promise<void>;

  // A real repository with one commit and a linked worktree
  beforeEach(() => {
    root = path.join(tmp, 'real');
    git(['init', '-q', '-b', 'main', root]);
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    git(['-C', root, 'add', 'a.txt']);
    git(['-C', root, 'commit', '-q', '-m', 'a']);
    git(['-C', root, 'worktree', 'add', '-q', '-b', 'side', path.join(tmp, 'side')]);
    repo = { ...repo, root, gitCommonDir: path.join(root, '.git'), name: 'real' };
  });

  function startPolling(options: Partial<Parameters<typeof watchEvents>[0]> = {}): void {
    let onReady!: () => void;
    ready = new Promise<void>(r => (onReady = r));
    start({ statusPollMs: 100, onReady, ...options });
  }

  it('primes on the first poll, then reports a change in a linked worktree as one git event', async () => {
    startPolling();
    await ready;
    // macOS may still deliver the fixture's own git writes to the fresh watches: let them pass, then
    // several polls (100 ms apart) of an unchanged repository must report nothing
    await settle(600);
    events = [];
    await new Promise(r => setTimeout(r, 800));
    expect(ofType('git')).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'side', 'new.txt'), 'x');
    await waitFor(() => ofType('git').length > 0);
    expect(ofType('git')[0]).toEqual({ type: 'git', repo: { name: 'real', root }, at: expect.any(String) });
    await settle(600);
    expect(ofType('git')).toHaveLength(1);
  });

  it('a worktree whose status fails is skipped, not fatal', async () => {
    startPolling();
    await ready;
    fs.rmSync(path.join(tmp, 'side'), { recursive: true, force: true });
    await settle(600);
    events = [];
    fs.writeFileSync(path.join(root, 'new.txt'), 'x');
    await waitFor(() => ofType('git').length > 0);
  });

  describe('containers', () => {
    const key = `sh -c ${STATUS_SCRIPT}`;
    const main = (name: string, labels: Record<string, string>): ContainerInfo => ({
      id: `id-${name}`, name, state: 'running', image: 'img', createdAt: '', ports: [],
      labels: { 'kunj.repo': 'github.com/acme/app', 'kunj.branch': 'x', 'kunj.role': 'main', ...labels },
    });

    it('a changed agent, head, ahead or dirty state yields a container status event', async () => {
      const backend = new FakeBackend();
      backend.existing = [main('kunj-app-x-1', {}), main('kunj-app-x-1-net-helper', { 'kunj.role': 'helper' })];
      backend.execResults.set(key, { exitCode: 0, stdout: 'tmux=1\n# branch.oid ' + 'a'.repeat(40) + '\n' });
      startPolling({ backend });
      await ready;
      await waitFor(() => backend.callsOf('exec').length > 0);
      await settle(600);
      expect(ofType('container')).toEqual([]);
      expect(backend.callsOf('exec').every(([id]) => id === 'id-kunj-app-x-1')).toBe(true);
      backend.execResults.set(key, { exitCode: 0, stdout: 'tmux=0\n# branch.oid ' + 'a'.repeat(40) + '\n' });
      await waitFor(() => ofType('container').length > 0);
      expect(ofType('container')[0]).toEqual({
        type: 'container', repo: { name: 'real', root }, branch: 'x', container: 'kunj-app-x-1', action: 'status', at: expect.any(String),
      });
      await settle(600);
      expect(ofType('container')).toHaveLength(1);
    });

    it('a failing exec is skipped and polls never overlap', async () => {
      const backend = new FakeBackend();
      backend.existing = [main('kunj-app-x-1', {})];
      let inFlight = 0;
      let maxInFlight = 0;
      jest.spyOn(backend, 'exec').mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 120));
        inFlight--;
        throw new Error('container is not running');
      });
      startPolling({ backend, statusPollMs: 20 });
      await ready;
      await waitFor(() => (backend.exec as jest.Mock).mock.calls.length >= 3);
      expect(maxInFlight).toBe(1);
      expect(ofType('container')).toEqual([]);
    });
  });
});
