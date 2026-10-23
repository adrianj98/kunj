import { PassThrough } from 'stream';
import { EventsCommand } from '../events';
import { watchEvents } from '../../lib/events';
import type { EventJson } from '../../lib/json-types';

// Fixture repositories and subprocesses: slow when the machine is busy
jest.setTimeout(30000);

jest.mock('../../lib/events', () => ({
  watchEvents: jest.fn(),
}));

const repo = (root: string, extra: object = {}) => ({
  root, gitCommonDir: `${root}/.git`, name: root.slice(1), bare: false,
  addedAt: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z', exists: true, ...extra,
});

jest.mock('../../lib/repos', () => ({
  ...jest.requireActual('../../lib/repos'),
  listRepos: jest.fn(() => [repo('/x'), repo('/y', { hidden: true })]),
}));

jest.mock('../../lib/config', () => ({
  loadResolvedConfig: jest.fn(async () => ({ container: { dockerContext: 'remote' } })),
  getGlobalKunjDir: jest.fn(() => '/home/.kunj'),
}));

const watchMock = watchEvents as jest.Mock;
let stdout: string[];
let stdin: PassThrough;

beforeEach(() => {
  stdout = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  stdin = new PassThrough();
  jest.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as any);
  // Emits one event, then runs until aborted
  watchMock.mockReset();
  watchMock.mockImplementation(async (opts: any) => {
    opts.onReady();
    opts.onEvent({ type: 'git', repo: { name: 'x', root: '/x' }, at: '2026-10-23T10:00:00.000Z' } satisfies EventJson);
    await new Promise<void>(resolve => opts.signal.addEventListener('abort', () => resolve()));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const lines = () => stdout.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('--json prints hello, then each event as one JSON line, until stdin ends', async () => {
  const run = new EventsCommand().execute({ json: true });
  await new Promise(r => setImmediate(r));
  expect(watchMock).toHaveBeenCalledTimes(1);
  const opts = watchMock.mock.calls[0][0];
  expect(opts.repos.map((r: any) => r.root)).toEqual(['/x']);
  expect(opts.kunjDir).toBe('/home/.kunj');
  expect(opts.backend).not.toBeNull();
  expect(lines()).toEqual([
    { type: 'hello', version: expect.any(String), repos: 1, at: expect.any(String) },
    { type: 'git', repo: { name: 'x', root: '/x' }, at: '2026-10-23T10:00:00.000Z' },
  ]);
  expect(opts.signal.aborted).toBe(false);
  stdin.end();
  await run;
  expect(opts.signal.aborted).toBe(true);
});

test('--repo limits the stream to that repository, hidden or not', async () => {
  const run = new EventsCommand().execute({ json: true, repo: ['/y'] });
  await new Promise(r => setImmediate(r));
  expect(watchMock.mock.calls[0][0].repos.map((r: any) => r.root)).toEqual(['/y']);
  expect(lines()[0]).toMatchObject({ type: 'hello', repos: 1 });
  process.emit('SIGTERM');
  await run;
  expect(watchMock.mock.calls[0][0].signal.aborted).toBe(true);
});

test('without --json each event is one readable line', async () => {
  const run = new EventsCommand().execute({});
  await new Promise(r => setImmediate(r));
  stdin.end();
  await run;
  const text = stdout.join('').split('\n').filter(Boolean);
  expect(text).toHaveLength(2);
  expect(text[0]).toMatch(/^\d\d:\d\d:\d\d hello /);
  expect(text[1]).toMatch(/^\d\d:\d\d:\d\d git x$/);
});

test('a --repo that is not a git repository is an error with a code', async () => {
  await expect(new EventsCommand().execute({ json: true, repo: ['/definitely/not/a/repo'] }))
    .rejects.toMatchObject({ jsonCode: 'not-a-repo' });
  expect(watchMock).not.toHaveBeenCalled();
});

test('hello is printed only once the watcher is ready', async () => {
  let ready!: () => void;
  watchMock.mockImplementation(async (opts: any) => {
    ready = opts.onReady;
    await new Promise<void>(resolve => opts.signal.addEventListener('abort', () => resolve()));
  });
  const run = new EventsCommand().execute({ json: true });
  await new Promise(r => setImmediate(r));
  expect(stdout.join('')).toBe('');
  ready();
  expect(lines()).toEqual([{ type: 'hello', version: expect.any(String), repos: 1, at: expect.any(String) }]);
  stdin.end();
  await run;
});
