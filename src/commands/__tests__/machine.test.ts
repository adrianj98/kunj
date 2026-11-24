import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeBackend } from '../../lib/container/__tests__/fake-backend';
import { FakeProvider } from '../../lib/machines/__tests__/fake-provider';
import { MachineClient } from '../../lib/machines/client';
import { Coordinator, ServeCaller, memoryTokenStore } from '../../lib/machines/coordinator';
import { writeRecord } from '../../lib/machines/local-coordinator';
import { ServeServer, createServeServer } from '../../lib/serve/server';
import { machineRoutes } from '../../lib/serve/machines';
import { isFastCommand } from '../fast';
import { MachineCommand } from '../machine';

jest.mock('../../lib/config', () => ({
  getGlobalKunjDir: jest.fn(() => '/nowhere/.kunj'),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

const REPO = { id: 'github.com/acme/app', name: 'app' };

describe('kunj machine', () => {
  let server: ServeServer;
  let provider: FakeProvider;
  let client: MachineClient;
  let stdout: string[];

  beforeEach(async () => {
    provider = new FakeProvider();
    // every machine's serve pairs at once and answers
    const tokens = new Map<string, string>();
    const call: ServeCaller = async (baseUrl, method, route, token) => {
      const host = new URL(baseUrl).hostname;
      if (method === 'POST' && route === '/v1/pair') {
        tokens.set(host, `t-${host}`);
        return { status: 200, body: { token: `t-${host}` } };
      }
      return token === tokens.get(host) ? { status: 200, body: {} } : { status: 401, body: {} };
    };
    const coordinator = new Coordinator({
      provider,
      network: 'private',
      tokens: memoryTokenStore(),
      version: '1.2.3',
      defaults: { size: 'medium', diskGb: 30, spot: false, selfSuspend: false, bootTimeoutMs: 1000 },
      call,
      sleep: async () => {},
    });
    server = createServeServer({ backend: new FakeBackend(), token: 'cli-token-0123456789', version: '1', extend: machineRoutes(coordinator) });
    const { port } = await server.listen('127.0.0.1', 0);
    client = new MachineClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'cli-token-0123456789', name: 'the local coordinator' });
    stdout = [];
    jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.join(' ')));
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await server.close();
  });

  const cmd = (extra: Partial<ConstructorParameters<typeof MachineCommand>[0]> = {}) =>
    new MachineCommand({
      coordinator: async () => ({ client, name: 'local', kind: 'local', close: async () => {} }),
      repo: () => REPO,
      branch: async () => 'feature/x',
      ...extra,
    });
  const json = () => JSON.parse(stdout.pop()!);

  it('is on the fast path', () => {
    expect(isFastCommand('machine')).toBe(true);
  });

  it('creates the current branch\'s machine, then lists, suspends, resumes and deletes it', async () => {
    await cmd().execute('create', { json: true, size: 'large' });
    const created = json();
    expect(created).toMatchObject({ coordinator: 'local', created: true, machine: { repo: REPO.id, branch: 'feature/x', size: 'fake-16', state: 'running', paired: true } });

    await cmd().execute('create', { json: true });
    expect(json().created).toBe(false);

    await cmd().execute('list', { json: true });
    expect(json()).toEqual({ coordinator: 'local', repo: REPO.id, machines: [expect.objectContaining({ name: created.machine.name })] });

    await cmd().execute('suspend', { json: true });
    expect(json().machine.state).toBe('suspended');
    await cmd().execute('status', 'feature/x', { json: true });
    expect(json().machine.state).toBe('suspended');
    await cmd().execute('resume', { json: true });
    expect(json()).toMatchObject({ woke: true, machine: { state: 'running' } });

    await expect(cmd().execute('delete', { json: true })).rejects.toThrow(/--yes/);
    await cmd().execute('delete', { json: true, yes: true, keepDisks: true });
    expect(json()).toEqual({ coordinator: 'local', deleted: created.machine.name });
    expect(provider.callsOf('delete')[0].args[1]).toEqual({ disks: false });
  });

  it('bakes a golden image from a builder machine, and new machines boot from the newest', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await cmd().execute('image', { json: true });
    expect(json()).toEqual({ coordinator: 'local', repo: REPO.id, images: [] });

    const snapshots: string[] = [];
    const snapshot = async (remote: string, branch: string) => (snapshots.push(`${remote} ${branch}`), { code: 0, hash: 'abc123def456' });
    await cmd({ snapshot }).execute('image', 'build', { json: true });
    const built = json();
    expect(snapshots).toEqual(['machines kunj..image-build']);
    // the image says which blueprint its snapshot is for
    expect(built).toMatchObject({ coordinator: 'local', snapshot: true, image: { repo: REPO.id, version: '1.2.3', blueprint: 'abc123def456' } });
    expect(built.image.name).toMatch(/^kunj-app-.*-img-[0-9]{14}$/);
    // the builder started from the stock image, was stopped before the bake and is gone
    const builderSpec = provider.callsOf('create')[0].args[0] as { image: string; name: string };
    expect(builderSpec.image).toBe('');
    expect(provider.methods().join(' ')).toMatch(/stop .*images\.createFrom .*delete/);
    expect(provider.machines.size).toBe(0);

    await cmd().execute('create', { json: true });
    expect(json().machine.image).toBe(built.image.name);

    // a second bake replaces the first image
    await new Promise(r => setTimeout(r, 1100));
    await cmd({ snapshot }).execute('image', 'build', { json: true, snapshot: false });
    const second = json();
    expect(second.snapshot).toBe(false);
    expect(snapshots).toHaveLength(1);
    await cmd().execute('image', 'list', { json: true });
    expect(json().images.map((i: { name: string }) => i.name)).toEqual([second.image.name]);

    await cmd().execute('image', 'delete', second.image.name, { json: true });
    expect(json()).toEqual({ coordinator: 'local', deleted: second.image.name });
    await expect(cmd().execute('image', 'delete', 'not-kunjs-image', { json: true })).rejects.toMatchObject({ code: 'machine-not-found' });
  });

  it('bakes only a builder, never a branch\'s machine, and refuses while a builder exists', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await cmd().execute('create', { json: true });
    const branchMachine = json().machine.name;
    await expect(client.bake(branchMachine)).rejects.toThrow(/not an image builder/);
    expect(provider.machines.get(branchMachine)?.state).toBe('running');
    expect(provider.images_.size).toBe(0);

    // a builder that already exists (another build, or an interrupted one) is neither baked nor deleted
    const left = await client.locate({ repo: REPO.id, repoName: REPO.name, branch: 'kunj..image-build', create: true });
    await expect(cmd({ snapshot: async () => 0 }).execute('image', 'build', { json: true })).rejects.toMatchObject({ code: 'machine-exists', message: expect.stringContaining('kunj machine delete') });
    expect(provider.machines.has(left.machine.name)).toBe(true);
    expect(provider.images_.size).toBe(0);
    await cmd().execute('delete', 'kunj..image-build', { json: true, yes: true });
    stdout.pop();
    await cmd({ snapshot: async () => 0 }).execute('image', 'build', { json: true });
    expect(json().builder).toBe(left.machine.name);
    expect([...provider.machines.keys()]).toEqual([branchMachine]);
  });

  it('makes no image and deletes the builder when the snapshot fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // also a builder whose create failed after the VM existed
    const locate = client.locate.bind(client);
    jest.spyOn(client, 'locate').mockImplementation(async body => {
      const r = await locate(body);
      if (body.create) throw new Error('serve never answered');
      return r;
    });
    await expect(cmd({ snapshot: async () => 0 }).execute('image', 'build', { json: true })).rejects.toThrow(/never answered/);
    expect(provider.machines.size).toBe(0);
    jest.mocked(client.locate).mockRestore();
    await expect(cmd({ snapshot: async () => 3 }).execute('image', 'build', { json: true })).rejects.toThrow(/--no-snapshot/);
    expect(provider.images_.size).toBe(0);
    expect(provider.machines.size).toBe(0);
  });

  it('asks before deleting on a terminal and deletes nothing on no', async () => {
    await cmd().execute('create', {});
    const asked: string[] = [];
    await cmd({ confirm: async m => (asked.push(m), false) }).execute('delete', {});
    expect(asked[0]).toMatch(/Delete machine kunj-app-feature-x-.* and its disks\?/);
    expect(provider.machines.size).toBe(1);
    await cmd({ confirm: async () => true }).execute('delete', {});
    expect(provider.machines.size).toBe(0);
  });

  it('prunes the machine of a branch gone from origin, dry by default, and keeps one that holds work', async () => {
    await cmd().execute('create', 'gone', {});
    await cmd().execute('create', 'dirty', {});
    await cmd().execute('create', 'here', {});
    const deps = {
      heads: async () => ['here'],
      inspect: async (m: { branch: string }) => ({ container: true, problems: m.branch === 'dirty' ? ['uncommitted changes'] : [] }),
    };
    stdout.length = 0;
    await cmd(deps).execute('prune', { json: true });
    const dry = JSON.parse(stdout.pop()!);
    expect(dry).toMatchObject({ dryRun: true, removed: [] });
    expect(dry.plan.machines.map((m: any) => [m.branch, m.reason, !!m.kept])).toEqual([['dirty', 'branch-gone', true], ['gone', 'branch-gone', false]]);
    expect(provider.machines.size).toBe(3);

    await cmd(deps).execute('prune', { json: true, yes: true });
    const done = JSON.parse(stdout.pop()!);
    expect(done.removed).toHaveLength(1);
    expect([...provider.machines.values()].map(m => m.labels['kunj.branch']).sort()).toEqual(['dirty', 'here']);
    await cmd(deps).execute('prune', { json: true, yes: true, force: true });
    expect([...provider.machines.values()].map(m => m.labels['kunj.branch'])).toEqual(['here']);
  });

  it('prunes golden images over 14 days old of a repository with no machine: this one\'s removed, every one\'s listed with --all', async () => {
    const old = new Date(Date.now() - 20 * 24 * 3600_000).toISOString();
    const img = (name: string, repo: string, createdAt = old) => provider.images_.set(name, { name, labels: { 'kunj.repo': repo, 'kunj.role': 'machine-image' }, createdAt });
    img('app-old', REPO.id);
    img('app-new', REPO.id, new Date().toISOString());
    img('other-old', 'github.com/acme/other');
    const deps = { heads: async () => ['main'], inspect: async () => ({ container: true, problems: [] }) };
    stdout.length = 0;
    await cmd(deps).execute('prune', { json: true });
    const dry = json();
    expect(dry).toMatchObject({ dryRun: true, removedImages: [] });
    expect(dry.plan.images.map((i: any) => i.name)).toEqual(['app-old']);

    // a machine of the repository keeps its images
    await cmd().execute('create', 'main', {});
    stdout.length = 0;
    await cmd(deps).execute('prune', { json: true, yes: true });
    expect(json().plan.images).toEqual([]);
    await cmd({ confirm: async () => true }).execute('delete', 'main', { yes: true });

    stdout.length = 0;
    await cmd(deps).execute('prune', { all: true, json: true, yes: true });
    // --all lists another repository's image but keeps it (its own machine.image may name it)
    const all = json();
    expect(all).toMatchObject({ success: true, removedImages: ['app-old'], failedImages: [] });
    expect(all.plan.images.find((i: any) => i.name === 'other-old').kept).toMatch(/another repository/);
    expect([...provider.images_.keys()].sort()).toEqual(['app-new', 'other-old']);
  });

  it('removes what setup made only when no machine or image is left, and the bucket only when asked', async () => {
    const gone = new Set<string>();
    let machines = '[{"name":"kunj-app-x","zone":"z/us-central1-a"}]';
    const calls: string[] = [];
    const run = async (_cmd: string, args: string[]) => {
      const line = args.join(' ');
      calls.push(line);
      if (line.startsWith('compute instances list')) return { code: 0, stdout: machines, stderr: '' };
      if (line.startsWith('compute images list')) return { code: 0, stdout: '[]', stderr: '' };
      if (line.startsWith('projects get-iam-policy')) return { code: 0, stdout: '{"bindings":[]}', stderr: '' };
      if (line.startsWith('compute routers describe')) return gone.has('router') ? { code: 1, stdout: '', stderr: 'NOT_FOUND' } : { code: 0, stdout: '{"nats":[]}', stderr: '' };
      if (line.includes(' describe ')) return gone.has(line.split(' ')[1]) ? { code: 1, stdout: '', stderr: 'NOT_FOUND' } : { code: 0, stdout: '{}', stderr: '' };
      if (line.includes(' delete ')) gone.add(line.split(' ')[1]);
      if (line.startsWith('compute routers delete')) gone.add('router');
      if (line.startsWith('storage rm')) gone.add('buckets');
      return { code: 0, stdout: '', stderr: '' };
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(cmd({ run }).execute('setup', { remove: true, json: true, yes: true, project: 'my-proj-123' })).rejects.toThrow(/kunj-app-x \(us-central1-a\)[\s\S]*kunj machine delete/);
    expect(calls.some(c => c.includes(' delete '))).toBe(false);

    machines = '[]';
    stdout.length = 0;
    await cmd({ run }).execute('setup', { remove: true, json: true, project: 'my-proj-123' });
    const dry = json();
    expect(dry).toMatchObject({ remove: true, dryRun: true, bucket: { name: 'gs://my-proj-123-kunj-cache', state: 'present' } });
    expect(calls.some(c => c.includes(' delete ') || c.startsWith('storage rm'))).toBe(false);

    await cmd({ run }).execute('setup', { remove: true, json: true, yes: true, project: 'my-proj-123' });
    const done = json();
    expect(done.success).toBe(true);
    expect(done.steps.filter((s: any) => s.state === 'removed').length).toBeGreaterThan(0);
    expect(done.bucket.state).toBe('kept');
    expect(calls.some(c => c.startsWith('storage rm'))).toBe(false);

    await cmd({ run }).execute('setup', { remove: true, json: true, yes: true, removeBucket: true, project: 'my-proj-123' });
    expect(json().bucket.state).toBe('removed');
    expect(calls.some(c => c.startsWith('storage rm --recursive gs://my-proj-123-kunj-cache'))).toBe(true);
  });

  it('sets a project up: a dry run by default, then everything missing, then the settings', async () => {
    const have = new Set<string>();
    const run = async (_cmd: string, args: string[]) => {
      const line = args.join(' ');
      if (line.startsWith('services list')) return { code: 0, stdout: have.has('apis') ? JSON.stringify([{ config: { name: 'compute.googleapis.com' } }, { config: { name: 'iap.googleapis.com' } }]) : '[]', stderr: '' };
      if (line.startsWith('services enable')) have.add('apis');
      if (/ list | get-iam-policy /.test(` ${line} `)) return { code: 0, stdout: '[]', stderr: '' };
      if (line.includes(' describe ')) return { code: 1, stdout: '', stderr: 'NOT_FOUND' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const saved: Record<string, unknown> = {};
    const deps = { run, setConfig: async (k: string, v: unknown) => void (saved[k] = v) };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await cmd(deps).execute('setup', { json: true, project: 'my-proj-123', cache: false });
    const dry = json();
    expect(dry).toMatchObject({ provider: 'gce', dryRun: true, success: true, config: {} });
    expect(dry.steps.map((s: any) => s.state)).toEqual(['planned', 'planned', 'planned', 'planned', 'planned']);
    expect(saved).toEqual({});

    await cmd(deps).execute('setup', { json: true, project: 'my-proj-123', cache: false, yes: true });
    const done = json();
    expect(done.steps.map((s: any) => s.state)).toEqual(['created', 'created', 'created', 'created', 'created']);
    expect(saved).toMatchObject({ 'machine.provider': 'gce', 'machine.gce': { project: 'my-proj-123', zone: 'us-central1-a' } });
  });

  it('lists in text, says when there is nothing, and shows the provider', async () => {
    await cmd().execute('list', {});
    expect(stdout.pop()).toMatch(/No machines for app/);
    await cmd().execute('create', 'b2', {});
    stdout.length = 0;
    await cmd().execute({});
    expect(stdout.join('\n')).toMatch(/running\s+b2\s+kunj-app-b2-/);
    await cmd().execute('providers', {});
    expect(stdout.join('\n')).toMatch(/fake via the local coordinator \(private network\)/);
    expect(stdout.join('\n')).toMatch(/medium\s+fake-8/);
  });

  it('passes machine errors on with their code', async () => {
    await expect(cmd().execute('status', 'nothing-here', { json: true })).rejects.toMatchObject({ code: 'machine-not-found' });
    await expect(cmd().execute('frobnicate', {})).rejects.toThrow(/Unknown machine action/);
    await expect(cmd({ branch: async () => '' }).execute('status', {})).rejects.toThrow(/not on a branch/);
  });

  it('reports and stops the local coordinator from its record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-mc-'));
    try {
      await cmd({ coordinatorDir: dir }).execute('coordinator', { json: true });
      expect(json()).toEqual({ running: false, log: path.join(dir, 'serve.log') });
      const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      writeRecord(path.join(dir, 'coordinator.json'), { pid: child.pid, port: 4242, version: '1', startedAt: 'then' });
      await cmd({ coordinatorDir: dir }).execute('coordinator', 'status', { json: true });
      expect(json()).toMatchObject({ running: true, pid: child.pid, port: 4242 });
      const exited = new Promise(r => child.on('exit', r));
      await cmd({ coordinatorDir: dir }).execute('coordinator', 'stop', { json: true });
      expect(json()).toMatchObject({ running: true, stopped: true, pid: child.pid });
      await exited;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
