import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitPathMatters, watchEvents } from '../events';
import { listTmuxSessions } from '../agent-session';
import { FakeBackend } from '../container/__tests__/fake-backend';
import type { KnownRepoInfo } from '../repos';
import type { EventJson } from '../json-types';

jest.mock('../agent-session', () => ({
  listTmuxSessions: jest.fn(async () => []),
}));

const tmuxMock = listTmuxSessions as unknown as jest.Mock<() => Promise<string[] | null>>;

let tmp: string;
let repo: KnownRepoInfo;
let kunjDir: string;
let events: EventJson[];
let controller: AbortController;
let running: Promise<void> | null;

function start(options: Partial<Parameters<typeof watchEvents>[0]> = {}): void {
  running = watchEvents({
    repos: [repo],
    kunjDir,
    backend: null,
    onEvent: e => events.push(e),
    signal: controller.signal,
    debounceMs: 50,
    tmuxPollMs: 60_000,
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
async function prime(type: EventJson['type'], write: () => void): Promise<void> {
  await waitFor(() => ofType(type).length > 0, write);
  await settle();
  events = [];
}

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
    start({ debounceMs: 300 });
    await prime('git', () => fs.writeFileSync(headFile(), 'ref: refs/heads/main\n'));
    fs.writeFileSync(headFile(), 'ref: refs/heads/x\n');
    fs.writeFileSync(headFile(), 'ref: refs/heads/y\n');
    await waitFor(() => ofType('git').length > 0);
    await settle(600);
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
});
