// End-to-end tests of `kunj container` against a real Docker engine. Run with `npm run test:docker`;
// `npm test` ignores *.docker.test.ts. Skipped when `docker info` fails.
//
// Origin is a bare repository on the host served by `git daemon`; containers reach it as
// git://host.docker.internal:<port>/<repo>.git. The host clone used as the start's cwd has the same
// URL as origin (which the host cannot resolve), so its remote-tracking refs are set up first
// through a direct clone and inspectOrigin's fetch fails harmlessly.
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { LocalDockerBackend } from '../docker';
import { LABEL, containerNames, repoIdFromUrl } from '../names';
import { StartError, StartOptions, containerStatus, removeContainer, startContainer } from '../lifecycle';
import { forwardPort } from '../forward';
import { getVersion } from '../../version';
import { KunjConfig } from '../../../types';

let dockerUp = false;
try {
  execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 });
  dockerUp = true;
} catch {
  dockerUp = false;
}

jest.setTimeout(600_000);

const USER = 'dev';
const VERSION = getVersion();
const REPO_NAME = `it-${Math.random().toString(36).slice(2, 8)}`;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'kunj test',
  GIT_AUTHOR_EMAIL: 'test@kunj.invalid',
  GIT_COMMITTER_NAME: 'kunj test',
  GIT_COMMITTER_EMAIL: 'test@kunj.invalid',
};

let tmp = '';
let bare = '';
let hostClone = '';
let daemon: ChildProcess | undefined;
let port = 0;
let originUrl = '';
let repoId = '';
const backend = new LocalDockerBackend();

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

function canConnect(p: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(p, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Everything labelled with this run's repo id, by kind. */
function labelled(): { containers: string[]; volumes: string[]; networks: string[] } {
  const filter = `label=${LABEL.repo}=${repoId}`;
  const lines = (s: string) => s.split('\n').filter(Boolean);
  return {
    containers: lines(docker(['ps', '-aq', '--filter', filter])),
    volumes: lines(docker(['volume', 'ls', '-q', '--filter', filter])),
    networks: lines(docker(['network', 'ls', '-q', '--filter', filter])),
  };
}

function labelledFor(branch: string): string[] {
  const filters = ['--filter', `label=${LABEL.repo}=${repoId}`, '--filter', `label=${LABEL.branch}=${branch}`];
  return [
    ...docker(['ps', '-aq', ...filters]).split('\n'),
    ...docker(['volume', 'ls', '-q', ...filters]).split('\n'),
    ...docker(['network', 'ls', '-q', ...filters]).split('\n'),
  ].filter(Boolean);
}

function config(network: { allow?: string[]; allowHost?: boolean }, env: string[] = []): KunjConfig {
  return { container: { network, keepFiles: false, env } } as unknown as KunjConfig;
}

// A token makes the start install git-credential-kunj; git:// never asks for it
const TOKEN_ENV = ['GH_TOKEN=secret-token'];

function startOptions(branch: string, cfg: KunjConfig): StartOptions {
  return {
    branch,
    create: false,
    publish: [],
    rebuild: false,
    config: cfg,
    repo: { root: hostClone, name: REPO_NAME, id: repoId, originUrl },
    kunjVersion: VERSION,
    hostEnv: {},
    cwd: hostClone,
    jsonMode: false,
    skipHooks: true,
    keepOnError: false,
    confirmPush: async () => false,
    warn: msg => process.stderr.write(`warn: ${msg}\n`),
  };
}

async function inside(id: string, script: string, env?: Record<string, string>): Promise<{ exitCode: number; stdout: string }> {
  return backend.exec(id, ['sh', '-c', script], { user: USER, workdir: '/workspace', env });
}

const BRANCH_A = 'it-a';
const BRANCH_GW = 'it-gw';
const BRANCH_ALLOW = 'it-allow';

(dockerUp ? describe : describe.skip)('kunj container against Docker', () => {
  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-it-')));
    bare = path.join(tmp, `${REPO_NAME}.git`);
    git(['init', '--bare', '-b', 'main', bare], tmp);
    git(['config', 'daemon.receivepack', 'true'], bare);

    // Seed origin with main and the test branches
    const work = path.join(tmp, 'work');
    git(['clone', bare, work], tmp);
    fs.writeFileSync(path.join(work, 'README.md'), 'integration\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'initial'], work);
    git(['push', 'origin', 'HEAD:main', `HEAD:${BRANCH_A}`, `HEAD:${BRANCH_GW}`, `HEAD:${BRANCH_ALLOW}`], work);

    port = await freePort();
    daemon = spawn(
      'git',
      ['daemon', '--export-all', `--base-path=${tmp}`, `--port=${port}`, '--enable=receive-pack', '--reuseaddr', tmp],
      { stdio: 'ignore' }
    );
    await waitFor(() => canConnect(port), 'git daemon');

    originUrl = `git://host.docker.internal:${port}/${REPO_NAME}.git`;
    repoId = repoIdFromUrl(originUrl);

    // The cwd for startContainer: a clone whose origin is the URL the container uses
    hostClone = path.join(tmp, 'host');
    git(['clone', bare, hostClone], tmp);
    for (const b of [BRANCH_A, BRANCH_GW, BRANCH_ALLOW]) git(['branch', b, `origin/${b}`], hostClone);
    git(['remote', 'set-url', 'origin', originUrl], hostClone);
    git(['config', 'user.name', 'kunj test'], hostClone);
    git(['config', 'user.email', 'test@kunj.invalid'], hostClone);
  });

  afterAll(async () => {
    // Each step on its own, so one failure (Docker gone, say) never leaks the daemon or temp dir
    const attempt = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        process.stderr.write(`cleanup: ${what} failed: ${(err as Error).message}\n`);
      }
    };
    let left = { containers: [] as string[], volumes: [] as string[], networks: [] as string[] };
    if (repoId) attempt('listing labelled objects', () => (left = labelled()));
    if (left.containers.length) attempt('removing containers', () => docker(['rm', '-f', ...left.containers]));
    if (left.volumes.length) attempt('removing volumes', () => docker(['volume', 'rm', '-f', ...left.volumes]));
    if (left.networks.length) attempt('removing networks', () => docker(['network', 'rm', ...left.networks]));
    attempt('stopping git daemon', () => daemon?.kill());
    if (tmp) attempt('removing the temp dir', () => fs.rmSync(tmp, { recursive: true, force: true }));
  });

  const namesA = () => containerNames(REPO_NAME, repoId, BRANCH_A);
  let idA = '';

  it('start clones the branch and seeds once', async () => {
    const first = await startContainer(backend, startOptions(BRANCH_A, config({ allowHost: true }, TOKEN_ENV)));
    expect(first.created).toBe(true);
    expect(first.seeded).toBe(true);
    expect(first.firewall).toBe('default');
    idA = first.containerId;

    const head = await inside(idA, 'git rev-parse --abbrev-ref HEAD');
    expect(head.stdout.trim()).toBe(BRANCH_A);

    // Every capability dropped but the few chown and sudo need (no NET_RAW)
    const caps = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', idA]));
    const strip = (list: string[] | null) => (list ?? []).map(c => c.replace(/^CAP_/, '')).sort();
    expect(strip(caps.CapDrop)).toEqual(['ALL']);
    expect(strip(caps.CapAdd)).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);

    const second = await startContainer(backend, startOptions(BRANCH_A, config({ allowHost: true }, TOKEN_ENV)));
    expect(second.created).toBe(false);
    expect(second.seeded).toBe(false);
    expect(second.containerId).toBe(idA);
  });

  it('push from inside without -u reaches origin', async () => {
    const r = await inside(
      idA,
      'echo change > change.txt && git add change.txt && git commit -qm "from the container" && git push -q && git rev-parse HEAD'
    );
    expect(r.exitCode).toBe(0);
    const sha = r.stdout.trim().split('\n').pop();
    expect(git(['rev-parse', `refs/heads/${BRANCH_A}`], bare)).toBe(sha);
  });

  it('credential helper is installed in the home volume and gives nothing to another host', async () => {
    const helper = await inside(idA, 'git config --global credential.helper');
    expect(helper.stdout.trim()).toBe(`/home/${USER}/.kunj/bin/git-credential-kunj`);
    // The configured helper, with GH_TOKEN from the run env-file
    const fill = (host: string) =>
      inside(idA, `printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill`, { GIT_TERMINAL_PROMPT: '0' });
    const evil = await fill('evil.example');
    expect(evil.stdout).not.toContain('password=');
    // Control: origin's host (with its port, as git sends it) does get the token
    const origin = await fill(`host.docker.internal:${port}`);
    expect(origin.stdout).toContain('password=secret-token');
  });

  it('reports status and lists main and helper with their roles', async () => {
    const status = await containerStatus(backend, idA, USER, 10000);
    expect(status.status).toBe('ok');
    expect(status.agentRunning).toBe(false);
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);

    const listed = await backend.list({ [LABEL.repo]: repoId, [LABEL.branch]: BRANCH_A });
    const roles = Object.fromEntries(listed.map(c => [c.name, c.labels[LABEL.role]]));
    expect(roles).toEqual({ [namesA().container]: 'main', [namesA().helper]: 'helper' });
    expect(listed.every(c => c.state === 'running')).toBe(true);
  });

  it('forward reaches a server bound to localhost in the container', async () => {
    const server = `require('http').createServer((q,s)=>s.end('hi')).listen(8123,'127.0.0.1')`;
    await backend.exec(idA, ['sh', '-c', `nohup node -e "${server}" >/dev/null 2>&1 &`], { user: USER });
    await waitFor(async () => (await inside(idA, 'curl -s http://127.0.0.1:8123/')).stdout === 'hi', 'the server in the container');

    const forwarder = await forwardPort(backend, idA, { container: 8123, host: await freePort() }, { hasSocat: true });
    try {
      const res = await fetch(`http://127.0.0.1:${forwarder.hostPort}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hi');
    } finally {
      await forwarder.close();
    }
  });

  it('remove refuses with a second unpushed branch, then removes with force and leaves nothing labelled', async () => {
    const r = await inside(idA, 'git switch -qc it-unpushed && echo x > x.txt && git add x.txt && git commit -qm unpushed');
    expect(r.exitCode).toBe(0);

    const ctx = { user: USER, kunjVersion: VERSION, keepVolumes: false };
    await expect(removeContainer(backend, namesA(), { ...ctx, force: false })).rejects.toThrow(/unpushed commits on it-unpushed/);
    expect(labelledFor(BRANCH_A)).not.toHaveLength(0);

    await removeContainer(backend, namesA(), { ...ctx, force: true });
    expect(labelledFor(BRANCH_A)).toEqual([]);
  });

  it('default mode blocks the host (start fails at seed with allowHost=false)', async () => {
    const err = await startContainer(backend, startOptions(BRANCH_GW, config({}))).catch(e => e);
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).code).toBe('seed');
    // A failed start rolls back everything it created
    expect(labelledFor(BRANCH_GW)).toEqual([]);
  });

  it('allowlist blocks example.com', async () => {
    const started = await startContainer(
      backend,
      startOptions(BRANCH_ALLOW, config({ allow: ['registry.npmjs.org'], allowHost: true }))
    );
    expect(started.firewall).toBe('allowlist');
    try {
      const blocked = await inside(started.containerId, 'curl -s -o /dev/null --max-time 5 https://example.com');
      expect(blocked.exitCode).not.toBe(0);
      const allowed = await inside(started.containerId, 'curl -sI -o /dev/null --max-time 10 https://registry.npmjs.org/');
      expect(allowed.exitCode).toBe(0);
    } finally {
      await removeContainer(backend, containerNames(REPO_NAME, repoId, BRANCH_ALLOW), {
        user: USER,
        kunjVersion: VERSION,
        force: true,
        keepVolumes: false,
      });
    }
    expect(labelled()).toEqual({ containers: [], volumes: [], networks: [] });
  });
});
