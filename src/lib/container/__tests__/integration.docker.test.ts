// End-to-end tests of `kunj container` against a real Docker engine. Run with `npm run test:docker`;
// `npm test` ignores *.docker.test.ts. Skipped when `docker info` fails.
//
// Origin is a bare repository on the host served by `git daemon`; containers reach it as
// git://host.docker.internal:<port>/<repo>.git. The host clone used as the start's cwd has the same
// URL as origin (which the host cannot resolve), so its remote-tracking refs are set up first
// through a direct clone and inspectOrigin's fetch fails harmlessly.
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { LocalDockerBackend } from '../docker';
import { LABEL, containerNames, repoIdFromUrl } from '../names';
import { StartError, StartOptions, containerStatus, removeContainer, startContainer } from '../lifecycle';
import { forwardPort } from '../forward';
import { AutoForwardChange, runAutoForward } from '../autoforward';
import { installMcpConfig, runBridge } from '../mcpbridge';
import { resolveHelperImage } from '../image';
import { getVersion } from '../../version';
import { parseBlueprint, resolveBlueprint, snapshotTag, SEED_DIR } from '../blueprint';
import { ensureSnapshot, planSnapshot, removeSnapshots, snapshotBlueprint } from '../snapshot';
import { KEPT_VOLUME, ORPHAN_GRACE_MS, PruneContext, applyPrune, parseLsRemoteHeads, planPrune } from '../prune';
import { isDockerDesktop } from '../dind';
import { KunjConfig } from '../../../types';
import { canConnect, containerOriginUrl, docker, freePort, git, startGitDaemon, waitFor, writeGitProxy } from './git-origin';

let dockerUp = false;
// What the daemon may run, known before the tests are defined so a real DinD start that cannot run
// here is reported as skipped (sysbox-runc installed, or a non-Desktop daemon and KUNJ_TEST_DIND_PRIVILEGED=1)
let engineRuntimes: string[] = [];
let engineIsDesktop = false;
try {
  const engine = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20000 }));
  dockerUp = !!engine.ServerVersion;
  engineRuntimes = Object.keys(engine.Runtimes ?? {});
  engineIsDesktop = isDockerDesktop({ operatingSystem: engine.OperatingSystem ?? '' });
} catch {
  dockerUp = false;
}
const realDindMode: 'sysbox' | 'privileged' | null = engineRuntimes.includes('sysbox-runc')
  ? 'sysbox'
  : process.env.KUNJ_TEST_DIND_PRIVILEGED === '1' && !engineIsDesktop
    ? 'privileged'
    : null;

jest.setTimeout(600_000);

const USER = 'dev';
const VERSION = getVersion();
const REPO_NAME = `it-${Math.random().toString(36).slice(2, 8)}`;

let tmp = '';
let bare = '';
let hostClone = '';
let daemon: ChildProcess | undefined;
let port = 0;
let originUrl = '';
let repoId = '';
/** Repository ids other tests label objects with; afterAll cleans these up too. */
const otherRepoIds: string[] = [];
const backend = new LocalDockerBackend();

/** Everything labelled with this run's repo id (or `id`), by kind. */
function labelled(id = repoId): { containers: string[]; volumes: string[]; networks: string[] } {
  const filter = `label=${LABEL.repo}=${id}`;
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
    // Never the host copy in ~/.kunj/<repo>/blueprint.json; the blueprint tests resolve their own
    blueprint: null,
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

    ({ port, daemon } = await startGitDaemon(tmp));

    originUrl = containerOriginUrl(port, REPO_NAME);
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
    for (const id of [repoId, ...otherRepoIds].filter(Boolean)) {
      let left = { containers: [] as string[], volumes: [] as string[], networks: [] as string[] };
      attempt('listing labelled objects', () => (left = labelled(id)));
      if (left.containers.length) attempt('removing containers', () => docker(['rm', '-f', ...left.containers]));
      if (left.volumes.length) attempt('removing volumes', () => docker(['volume', 'rm', '-f', ...left.volumes]));
      if (left.networks.length) attempt('removing networks', () => docker(['network', 'rm', ...left.networks]));
      attempt('removing snapshot images', () => {
        // -a: a snapshot rebuilt under the same tag leaves the old image dangling, which -q alone hides
        const images = docker(['images', '-aq', '--filter', `label=${LABEL.repo}=${id}`]).split('\n').filter(Boolean);
        if (images.length) docker(['rmi', '-f', ...new Set(images)]);
      });
    }
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

    // Through the network helper (same network namespace), as kunj ct forward does: nothing is exec'd in the branch container
    const forwarder = await forwardPort(backend, namesA().helper, { container: 8123, host: await freePort() }, { hasSocat: true });
    try {
      const res = await fetch(`http://127.0.0.1:${forwarder.hostPort}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hi');
    } finally {
      await forwarder.close();
    }
  });

  it('forward --auto picks up a server started late and drops it when it stops', async () => {
    // Only this test's port: the server an earlier test left on 8123 is forwarded too
    const changes: AutoForwardChange[] = [];
    const controller = new AbortController();
    const run = runAutoForward(backend, { main: idA, helper: namesA().helper }, {
      ignore: [],
      intervalMs: 200,
      onChange: c => c.port === 18765 && changes.push(c),
      signal: controller.signal,
    });
    try {
      await new Promise(r => setTimeout(r, 1000));
      expect(changes).toEqual([]);

      const server = `require('http').createServer((q,s)=>s.end('auto')).listen(18765)`;
      await backend.exec(idA, ['sh', '-c', `nohup node -e "${server}" >/dev/null 2>&1 & echo $! > /tmp/auto.pid`], { user: USER });
      const started = Date.now();
      await waitFor(() => changes.length === 1, 'the forward to appear', 3000);
      expect(Date.now() - started).toBeLessThan(3000);
      const [add] = changes;
      expect(add).toMatchObject({ event: 'add', port: 18765 });
      const res = await fetch(`http://127.0.0.1:${add.hostPort}/`);
      expect(await res.text()).toBe('auto');

      await backend.exec(idA, ['sh', '-c', 'kill $(cat /tmp/auto.pid)'], { user: USER });
      await waitFor(() => changes.length === 2, 'the forward to be dropped', 3000);
      expect(changes[1]).toEqual({ event: 'remove', port: 18765, hostPort: add.hostPort });
      expect(await canConnect(add.hostPort)).toBe(false);
    } finally {
      controller.abort();
      await run;
    }
  });

  it('MCP bridge: a client in the container reaches a stdio server on the host, navigation limited to forwarded ports, no host files, listener as the user', async () => {
    // The fake MCP server on the host: answers every request with the method it was asked
    const script = path.join(tmp, 'echo-mcp.js');
    fs.writeFileSync(
      script,
      "require('readline').createInterface({ input: process.stdin }).on('line', l => { const m = JSON.parse(l); " +
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { echo: m.method } }) + '\\n'); });\n"
    );
    await installMcpConfig(backend, idA, USER, ['chrome']);
    const claude = await inside(idA, 'cat "$HOME/.claude.json"');
    expect(JSON.parse(claude.stdout).mcpServers.chrome).toEqual({ command: 'socat', args: ['-', 'UNIX-CONNECT:/run/kunj-mcp/chrome.sock'] });

    const controller = new AbortController();
    const run = runBridge(backend, idA, 'chrome', { command: process.execPath, args: [script] }, {
      // the default origins: only the container's forwarded host ports
      forwardedPorts: () => [3000],
      user: USER,
      signal: controller.signal,
      restartDelayMs: 100,
    });
    // One session per connection: send a line, keep stdin open a moment for the reply
    const ask = async (msg: object): Promise<any> => {
      let reply = '';
      await waitFor(async () => {
        const line = JSON.stringify(msg).replace(/'/g, "'\\''");
        const r = await inside(idA, `(printf '%s\\n' '${line}'; sleep 1) | socat - UNIX-CONNECT:/run/kunj-mcp/chrome.sock`);
        reply = r.stdout.trim();
        return reply !== '';
      }, 'a reply over the MCP socket', 20000);
      return JSON.parse(reply);
    };
    try {
      await waitFor(async () => (await inside(idA, 'test -S /run/kunj-mcp/chrome.sock')).exitCode === 0, 'the MCP socket');
      const mode = await backend.exec(idA, ['stat', '-c', '%a %U', '/run/kunj-mcp/chrome.sock'], { user: 'root' });
      expect(mode.stdout.trim()).toBe(`600 ${USER}`);
      // Root only made the directory: the pid file is the user's, and so is the listener
      const owner = await backend.exec(idA, ['sh', '-c', 'stat -c "%a %U" /run/kunj-mcp && stat -c %U /run/kunj-mcp/chrome.pid && stat -c %U /proc/$(cat /run/kunj-mcp/chrome.pid)'], { user: 'root' });
      expect(owner.stdout.trim().split('\n')).toEqual([`700 ${USER}`, USER, USER]);

      expect(await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: 'tools/list' } });
      const refused = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'https://example.com/' } } });
      expect(refused).toMatchObject({ id: 2, error: { code: -32602 } });
      const allowed = await ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'http://localhost:3000/' } } });
      expect(allowed).toEqual({ jsonrpc: '2.0', id: 3, result: { echo: 'tools/call' } });
      const otherPort = await ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'navigate_page', arguments: { url: 'http://localhost:5432/' } } });
      expect(otherPort).toMatchObject({ id: 4, error: { code: -32602 } });
      const hostFile = await ask({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'take_screenshot', arguments: { filePath: '/tmp/x.png' } } });
      expect(hostFile).toMatchObject({ id: 5, error: { code: -32602 } });
      const upload = await ask({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'upload_file', arguments: { uid: '1' } } });
      expect(upload).toMatchObject({ id: 6, error: { code: -32602 } });
    } finally {
      controller.abort();
      await run;
    }
    // The listener is gone with its pid file
    // ([N] keeps grep from matching its own command line)
    const listenerGone = 'test ! -e /run/kunj-mcp/chrome.pid && ! grep -lqa "UNIX-LISTE[N]" /proc/[0-9]*/cmdline 2>/dev/null';
    await waitFor(async () => (await backend.exec(idA, ['sh', '-c', listenerGone], { user: 'root' })).exitCode === 0, 'the listener to stop', 5000);
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

  it('default mode blocks the host except origin on its own port (allowHost=false)', async () => {
    // A server on another host port that would answer if the firewall let it through
    const server = http.createServer((_q, res) => res.end('open'));
    const other = await freePort();
    await new Promise<void>(resolve => server.listen(other, '0.0.0.0', resolve));
    try {
      // origin is on the host (git daemon), and is reachable: the clone succeeds
      const started = await startContainer(backend, startOptions(BRANCH_GW, config({})));
      expect(started.seeded).toBe(true);
      const head = await inside(started.containerId, 'git rev-parse --abbrev-ref HEAD');
      expect(head.stdout.trim()).toBe(BRANCH_GW);
      // Any other port on the host is not: refused (7) or timed out (28), never answered
      const blocked = await inside(started.containerId, `curl -s --max-time 5 http://host.docker.internal:${other}/`);
      expect([7, 28]).toContain(blocked.exitCode);
      expect(blocked.stdout).not.toContain('open');
    } finally {
      server.close();
      await removeContainer(backend, containerNames(REPO_NAME, repoId, BRANCH_GW), {
        user: USER,
        kunjVersion: VERSION,
        force: true,
        keepVolumes: false,
      });
    }
    expect(labelledFor(BRANCH_GW)).toEqual([]);
  });

  it('a failed start rolls back everything it created', async () => {
    // The helper image has no git, so the seed fails after the container and helper are up
    const options = { ...startOptions(BRANCH_GW, config({})), imageOverride: resolveHelperImage(VERSION).tag };
    const err = await startContainer(backend, options).catch(e => e);
    expect(err).toBeInstanceOf(StartError);
    expect((err as StartError).code).toBe('seed');
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

  describe('blueprints', () => {
    const BLUEPRINT = {
      tools: { apt: ['jq'] },
      setup: ['touch installed', 'echo built > built.txt'],
      maintain: ['touch maintained'],
      lockfiles: ['package-lock.json'],
    };
    const ctx = { user: USER, kunjVersion: VERSION, force: true, keepVolumes: false };
    let work = '';
    let tag = '';
    let hash = '';

    /** Commit `files` on origin's main (and `branches`), then bring the host clone's origin/* up to date. */
    function pushToMain(files: Record<string, string>, msg: string, branches: string[] = []): void {
      git(['pull', '-q', 'origin', 'main'], work);
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
        fs.writeFileSync(path.join(work, name), content);
      }
      git(['add', '.'], work);
      git(['commit', '-qm', msg], work);
      git(['push', '-q', 'origin', 'HEAD:main', ...branches.map(b => `HEAD:${b}`)], work);
      // The host clone's origin URL is the container's; fetch from the bare repository directly
      git(['fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*'], hostClone);
    }

    async function resolved() {
      const r = await resolveBlueprint({ cwd: hostClone, repoKunjDir: path.join(tmp, 'no-kunj-dir'), defaultBranch: 'main' });
      if (!r) throw new Error('no blueprint on origin/main');
      return r;
    }

    function snapshotOptions(blueprint: Awaited<ReturnType<typeof resolved>>) {
      return {
        branch: 'main',
        blueprint,
        config: config({ allowHost: true }),
        repo: { root: hostClone, name: REPO_NAME, id: repoId, originUrl },
        kunjVersion: VERSION,
        cwd: hostClone,
        jsonMode: false,
        rebuild: false,
        warn: (m: string) => process.stderr.write(`warn: ${m}\n`),
        log: () => {},
      };
    }

    // The branches are pushed beforehand rather than created by the start (create: true), which
    // asks origin with ls-remote from the host, and the host cannot resolve host.docker.internal
    /** startOptions for a new container that resolves the blueprint from origin/main. */
    function bpStart(branch: string, extra: Partial<StartOptions> = {}): StartOptions {
      return {
        ...startOptions(branch, config({ allowHost: true })),
        blueprint: undefined,
        defaultBranch: async () => 'main',
        ...extra,
      };
    }

    /** A clone or fetch of the git:// origin in any exec; the URL is shell-quoted in the seed script. */
    const NETWORK_CLONE = /git clone [^\n]*git:\/\//;
    const networkGit = (execs: string[][]) =>
      execs.map(argv => argv.join(' ')).filter(s => NETWORK_CLONE.test(s) || s.includes('git fetch origin'));

    /** Records every exec's argv, to tell a clone from a seed copy. */
    class RecordingBackend extends LocalDockerBackend {
      execs: string[][] = [];
      override exec(...args: Parameters<LocalDockerBackend['exec']>) {
        this.execs.push(args[1]);
        return super.exec(...args);
      }
    }

    beforeAll(() => {
      work = path.join(tmp, 'bp-work');
      git(['clone', '-q', bare, work], tmp);
      pushToMain(
        { '.kunj/blueprint.json': JSON.stringify(BLUEPRINT, null, 2) + '\n', 'package-lock.json': '{"v":1}\n' },
        'blueprint',
        ['it-bp-new', 'it-bp-fresh', 'it-bp-auto']
      );
      // The snapshot's host-side fetch goes to origin's URL, which only containers can resolve:
      // connect git:// to the daemon on localhost instead, leaving the URL itself unchanged
      const proxy = writeGitProxy(path.join(tmp, 'git-proxy'));
      git(['config', 'core.gitProxy', proxy], hostClone);
    });

    it('blueprint snapshot builds an image with jq and the seed', async () => {
      const result = await snapshotBlueprint(backend, snapshotOptions(await resolved()));
      expect(result.reused).toBe(false);
      ({ tag, hash } = result);
      expect(tag).toBe(snapshotTag(REPO_NAME, hash));
      expect(result.ref).toBe(git(['rev-parse', 'main'], bare));

      const labels = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag]));
      expect(labels[LABEL.repo]).toBe(repoId);
      expect(labels[LABEL.blueprintHash]).toBe(hash);
      expect(labels[LABEL.blueprintRef]).toBe(result.ref);
      expect(labels[LABEL.blueprintBase]).toBe(result.base);
      expect(labels[LABEL.blueprintUser]).toBe(USER);

      const check = [
        'command -v jq',
        `test -f ${SEED_DIR}/installed`,
        `test -f ${SEED_DIR}/built.txt`,
        `! test -f ${SEED_DIR}/.kunj-seeded`,
      ].join(' && ');
      expect(() => docker(['run', '--rm', '--entrypoint', 'sh', tag, '-c', check])).not.toThrow();

      // apt writes no /etc/kunj/env, and nothing secret is baked into the image
      const env: string[] = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config.Env}}', tag])) ?? [];
      expect(env.filter(e => /GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|ANTHROPIC/.test(e))).toEqual([]);
      // The temporary container is gone
      expect(labelled()).toEqual({ containers: [], volumes: [], networks: [] });
    });

    it('snapshot via bundle never clones from the network', async () => {
      const rec = new RecordingBackend();
      const result = await snapshotBlueprint(rec, { ...snapshotOptions(await resolved()), rebuild: true });
      expect(result).toMatchObject({ tag, hash, viaBundle: true, reused: false });
      const scripts = rec.execs.map(argv => argv.join(' '));
      expect(networkGit(rec.execs)).toEqual([]);
      expect(scripts.some(s => s.includes("git clone --no-checkout -b 'main' '/tmp/kunj-origin.bundle' /workspace"))).toBe(true);

      const originHead = git(['rev-parse', 'main'], bare);
      expect(result.ref).toBe(originHead);
      const seed = docker([
        'run', '--rm', '--entrypoint', 'sh', tag, '-c',
        `! test -e /tmp/kunj-origin.bundle && git -c safe.directory='*' -C ${SEED_DIR} rev-parse HEAD && git -c safe.directory='*' -C ${SEED_DIR} remote get-url origin && git -c safe.directory='*' -C ${SEED_DIR} rev-parse refs/remotes/origin/main`,
      ]);
      // prune needs the clone to have seen the branch on origin
      expect(seed.split('\n')).toEqual([originHead, originUrl, originHead]);
      expect(labelled()).toEqual({ containers: [], volumes: [], networks: [] });
    });

    it('start from the snapshot copies the seed and runs maintain', async () => {
      const rec = new RecordingBackend();
      const started = await startContainer(rec, bpStart('it-bp-new'));
      try {
        expect(started.blueprint).toMatchObject({ snapshot: tag, hash, stale: false, setupRan: false, maintainRan: true });
        expect(started.image).toBe(tag);
        const r = await inside(
          started.containerId,
          'test -f installed && test -f maintained && git rev-parse --abbrev-ref HEAD && git remote get-url origin && git for-each-ref --format=\'%(refname)\' refs/remotes/origin'
        );
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim().split('\n')).toEqual(['it-bp-new', originUrl, 'refs/remotes/origin/it-bp-new']);
        expect(rec.execs.filter(argv => argv.join(' ').includes('git clone'))).toEqual([]);
      } finally {
        await removeContainer(backend, started.names, ctx);
      }
      expect(labelledFor('it-bp-new')).toEqual([]);
    });

    it('stale snapshot prints the hint and is still used', async () => {
      pushToMain({ 'package-lock.json': '{"v":2}\n' }, 'lockfile change', ['it-bp-stale']);
      const warnings: string[] = [];
      const started = await startContainer(backend, bpStart('it-bp-stale', { warn: m => warnings.push(m) }));
      try {
        expect(warnings.some(w => /snapshot is stale/.test(w))).toBe(true);
        expect(started.blueprint).toMatchObject({ snapshot: tag, stale: true, setupRan: false });
        expect(started.blueprint?.hash).not.toBe(hash);
        // The branch is origin's, not the snapshot's commit
        const lock = await inside(started.containerId, 'cat package-lock.json && test -f installed');
        expect(lock.exitCode).toBe(0);
        expect(lock.stdout.trim()).toBe('{"v":2}');
      } finally {
        await removeContainer(backend, started.names, ctx);
      }
    });

    it('--no-snapshot clones and runs setup', async () => {
      const rec = new RecordingBackend();
      const started = await startContainer(rec, bpStart('it-bp-fresh', { noSnapshot: true }));
      try {
        // The matcher the bundle test relies on does catch a clone from origin
        expect(rec.execs.some(argv => NETWORK_CLONE.test(argv.join(' ')))).toBe(true);
        // setup has just run, so maintain is skipped in the same start
        expect(started.blueprint).toMatchObject({ snapshot: null, setupRan: true, maintainRan: false });
        expect(started.image).not.toBe(tag);
        const r = await inside(started.containerId, 'test -f installed && ! test -f maintained && command -v jq');
        expect(r.exitCode).toBe(0);
      } finally {
        await removeContainer(backend, started.names, ctx);
      }
    });

    it('start with a blueprint and no snapshot builds one and starts from it', async () => {
      // A repository identity with no snapshot yet; the sequence `kunj ct start` runs
      const freshName = `${REPO_NAME}-fresh`;
      const freshId = `${repoId}-fresh`;
      otherRepoIds.push(freshId);
      const repo = { root: hostClone, name: freshName, id: freshId, originUrl };
      expect(await backend.listImages({ [LABEL.repo]: freshId })).toEqual([]);

      const blueprint = await resolveBlueprint({ cwd: hostClone, repoRoot: hostClone, repoKunjDir: path.join(tmp, 'no-kunj-dir'), defaultBranch: 'main' });
      expect(blueprint).not.toBeNull();
      const logs: string[] = [];
      const ensured = await ensureSnapshot(backend, { ...snapshotOptions(blueprint!), repo, log: m => logs.push(m), stale: 'rebuild' });
      expect(ensured.failed).toBeUndefined();
      expect(ensured).toMatchObject({ built: true, stale: false });
      expect(logs[0]).toBe('Building blueprint snapshot (first use; this runs setup once)…');
      const built = ensured.result!.tag;
      expect(await backend.imageExists(built)).toBe(true);
      // maintain is skipped right after setup, also in the snapshot build
      expect(() => docker(['run', '--rm', '--entrypoint', 'sh', built, '-c', `test -f ${SEED_DIR}/installed && ! test -f ${SEED_DIR}/maintained`])).not.toThrow();

      const warnings: string[] = [];
      const started = await startContainer(backend, bpStart('it-bp-auto', {
        repo, blueprint, snapshotHandled: true, worktreeRoot: hostClone, warn: m => warnings.push(m),
      }));
      try {
        expect(started.image).toBe(built);
        expect(started.blueprint).toMatchObject({ snapshot: built, hash: ensured.result!.hash, stale: false, setupRan: false, maintainRan: true });
        // No stale or no-snapshot hint: the command has handled the snapshot
        expect(warnings.filter(w => /snapshot/i.test(w))).toEqual([]);
        const r = await inside(started.containerId, 'test -f installed && test -f maintained && git rev-parse --abbrev-ref HEAD');
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe('it-bp-auto');
      } finally {
        await removeContainer(backend, started.names, ctx);
        await removeSnapshots(backend, freshName, freshId);
      }
      expect(labelled(freshId)).toEqual({ containers: [], volumes: [], networks: [] });
      expect(await backend.listImages({ [LABEL.repo]: freshId })).toEqual([]);
    });

    it('snapshot failure leaves nothing', async () => {
      const text = JSON.stringify({ ...BLUEPRINT, tools: {}, setup: ['exit 1'] });
      const failing = { blueprint: parseBlueprint(text, 'failing.json'), source: 'file' as const, path: 'failing.json', text };
      const plan = await planSnapshot(snapshotOptions(failing));
      await expect(snapshotBlueprint(backend, snapshotOptions(failing))).rejects.toThrow(/setup command failed/);
      expect(await backend.imageExists(plan.tag)).toBe(false);
      expect(labelled()).toEqual({ containers: [], volumes: [], networks: [] });
      // The good snapshot is untouched
      expect(await backend.imageExists(tag)).toBe(true);
    });

    it('removeSnapshots removes the images', async () => {
      const removed = await removeSnapshots(backend, REPO_NAME, repoId);
      expect(removed).toEqual([tag]);
      expect(await backend.imageExists(tag)).toBe(false);
      expect(await backend.listImages({ [LABEL.repo]: repoId })).toEqual([]);
      expect(labelled()).toEqual({ containers: [], volumes: [], networks: [] });
    });
  });
  describe('services', () => {
    const SVC_A = 'it-svc-a';
    const SVC_B = 'it-svc-b';
    const ctx = { user: USER, kunjVersion: VERSION, force: true, keepVolumes: false };
    const POSTGRES = {
      postgres: {
        image: 'postgres:16-alpine',
        env: { POSTGRES_PASSWORD: 'dev' },
        // Over TCP: during initdb Postgres listens on its socket only, then restarts
        healthcheck: 'pg_isready -h 127.0.0.1 -U postgres',
        port: 5432,
        volumes: { data: '/var/lib/postgresql/data' },
      },
    };
    const REACH = `bash -c '</dev/tcp/postgres/5432'`;

    function withServices(services: object | undefined, env: string[] = []): KunjConfig {
      return { container: { network: { allowHost: true }, keepFiles: false, env, ...(services ? { services } : {}) } } as unknown as KunjConfig;
    }

    beforeAll(() => {
      const work = path.join(tmp, 'svc-work');
      git(['clone', '-q', bare, work], tmp);
      git(['push', '-q', 'origin', `origin/main:refs/heads/${SVC_A}`, `origin/main:refs/heads/${SVC_B}`], work);
      git(['fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*'], hostClone);
    });

    it('a service is reachable by name from its branch container only, and gets nothing from the host', async () => {
      const a = await startContainer(backend, startOptions(SVC_A, withServices(POSTGRES, TOKEN_ENV)));
      const b = await startContainer(backend, startOptions(SVC_B, withServices(undefined)));
      try {
        expect(a.services).toEqual(['postgres']);
        expect((await inside(a.containerId, REACH)).exitCode).toBe(0);

        // Review focus 2: another branch's container reaches it neither by name nor by address
        expect((await inside(b.containerId, `timeout 5 ${REACH}`)).exitCode).not.toBe(0);
        const svcName = `${a.names.container}-svc-postgres`;
        const ip = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', svcName]);
        expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        expect((await inside(b.containerId, `timeout 5 bash -c '</dev/tcp/${ip}/5432'`)).exitCode).not.toBe(0);

        // Review focus 1: no privileges, capabilities, binds, published ports or forwarded env
        const host = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', svcName]));
        expect(host.Privileged).toBe(false);
        expect(host.CapAdd ?? []).toEqual([]);
        // -v lists named volumes under Binds too; the Mounts check below is what shows none is a host path
        expect(Object.keys(host.PortBindings ?? {})).toEqual([]);
        const env: string[] = JSON.parse(docker(['inspect', '--format', '{{json .Config.Env}}', svcName]));
        expect(env).toContain('POSTGRES_PASSWORD=dev');
        expect(env.filter(e => /GH_TOKEN|KUNJ_/.test(e))).toEqual([]);
        const mounts: Array<{ Type: string; Name: string }> = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', svcName]));
        expect(mounts.map(m => `${m.Type}:${m.Name}`)).toEqual([`volume:${svcName}-data`]);

        // forward <service>:<port> tunnels through the service container's bash
        const forwarder = await forwardPort(backend, docker(['inspect', '--format', '{{.Id}}', svcName]), { container: 5432, host: await freePort() }, { hasSocat: false, tool: 'bash' });
        try {
          await waitFor(() => canConnect(forwarder.hostPort), 'the forwarded service port', 5000);
        } finally {
          await forwarder.close();
        }
      } finally {
        await removeContainer(backend, a.names, ctx);
        await removeContainer(backend, b.names, ctx);
      }
      expect(labelledFor(SVC_A)).toEqual([]);
      expect(labelledFor(SVC_B)).toEqual([]);
    });

    it('a snapshot build runs setup against its services and removes them with the temporary container', async () => {
      const text = JSON.stringify({ setup: [`${REACH} && touch migrated`], services: POSTGRES });
      const blueprint = { blueprint: parseBlueprint(text, 'svc.json'), source: 'file' as const, path: 'svc.json', text };
      const result = await snapshotBlueprint(backend, {
        branch: 'main',
        blueprint,
        config: config({ allowHost: true }),
        repo: { root: hostClone, name: REPO_NAME, id: repoId, originUrl },
        kunjVersion: VERSION,
        cwd: hostClone,
        jsonMode: false,
        rebuild: true,
        warn: (m: string) => process.stderr.write(`warn: ${m}\n`),
        log: () => {},
      });
      try {
        expect(() => docker(['run', '--rm', '--entrypoint', 'sh', result.tag, '-c', `test -f ${SEED_DIR}/migrated`])).not.toThrow();
        // The service and its volume went with the temporary container
        expect(labelled()).toEqual({ containers: [], volumes: [], networks: [] });
      } finally {
        await removeSnapshots(backend, REPO_NAME, repoId);
      }
    });
  });
  describe('prune', () => {
    const ORPH = 'it-prune-orphan';
    const WIP = 'it-prune-wip';
    const ctx = { user: USER, kunjVersion: VERSION, force: true, keepVolumes: false };

    beforeAll(() => {
      const work = path.join(tmp, 'prune-work');
      git(['clone', '-q', bare, work], tmp);
      git(['push', '-q', 'origin', `origin/main:refs/heads/${ORPH}`, `origin/main:refs/heads/${WIP}`], work);
      git(['fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*'], hostClone);
    });

    it('removes the helper, volumes and network a container removed out of band left, and keeps unpushed work on a deleted branch', async () => {
      const orphan = await startContainer(backend, startOptions(ORPH, config({ allowHost: true })));
      const wip = await startContainer(backend, startOptions(WIP, config({ allowHost: true })));
      try {
        expect((await inside(wip.containerId, 'echo w > w.txt && git add w.txt && git commit -qm wip')).exitCode).toBe(0);
        // The branch is deleted on origin (merged, say) while the container still has a commit it never pushed
        git(['update-ref', '-d', `refs/heads/${WIP}`], bare);
        // The main container goes behind kunj's back
        await backend.remove({ containers: [orphan.names.container] });

        const pruneCtx: PruneContext = {
          repoId,
          repoName: REPO_NAME,
          cwd: hostClone,
          kunjVersion: VERSION,
          force: false,
          // The host cannot resolve host.docker.internal, origin's name inside the container
          remoteBranches: async () => parseLsRemoteHeads(git(['ls-remote', '--heads', bare], tmp)),
          kunjImages: false,
        };
        // Just created: within the grace period (Docker's own creation times) nothing of it is an orphan yet
        expect((await planPrune(backend, pruneCtx)).orphans.filter(o => o.name.startsWith(orphan.names.container))).toEqual([]);
        pruneCtx.now = new Date(Date.now() + ORPHAN_GRACE_MS + 60_000);
        const applyCtx = { repoId, kunjVersion: VERSION, force: false, forwardsFile: path.join(tmp, 'forwards.json') };
        const plan = await planPrune(backend, pruneCtx);
        expect(plan.orphans).toEqual(expect.arrayContaining([
          { kind: 'container', name: orphan.names.helper },
          { kind: 'volume', name: orphan.names.workspaceVolume, kept: KEPT_VOLUME },
          { kind: 'volume', name: orphan.names.homeVolume, kept: KEPT_VOLUME },
          { kind: 'network', name: orphan.names.network },
        ]));
        const kept = plan.containers.find(c => c.branch === WIP);
        expect(kept).toMatchObject({ reason: 'branch-gone', kept: expect.stringMatching(/unpushed commits/) });

        // Without --force the orphan volumes stay (they may hold work); the helper and network go
        const result = await applyPrune(backend, { ...plan, images: [] }, applyCtx);
        expect(result.failed).toEqual([]);
        expect(labelledFor(ORPH).sort()).toEqual([orphan.names.homeVolume, orphan.names.workspaceVolume].sort());
        expect(docker(['ps', '-aq', '--filter', `name=^${wip.names.container}$`])).not.toBe('');

        // With --force they go too (only the orphans are applied, so the WIP container stays)
        const forced = await planPrune(backend, { ...pruneCtx, force: true });
        await applyPrune(backend, { ...forced, containers: [], images: [] }, { ...applyCtx, force: true });
        expect(labelledFor(ORPH)).toEqual([]);
        expect(docker(['ps', '-aq', '--filter', `name=^${wip.names.container}$`])).not.toBe('');
      } finally {
        await removeContainer(backend, orphan.names, ctx);
        await removeContainer(backend, wip.names, ctx);
      }
      expect(labelledFor(WIP)).toEqual([]);
    });
  });

  // A real Docker-in-Docker start needs a daemon that may run one: sysbox-runc installed, or a
  // throwaway non-Desktop daemon (run the suite with DOCKER_CONTEXT=<a Colima profile>) and
  // KUNJ_TEST_DIND_PRIVILEGED=1. Elsewhere the refusal is checked against the real daemon instead.
  describe('docker in docker', () => {
    const DIND = 'it-dind';
    const ctx = { user: USER, kunjVersion: VERSION, force: true, keepVolumes: false };
    const mode = realDindMode;
    const desktop = engineIsDesktop;
    const runtimes = engineRuntimes;

    function withDind(m: string, allowPrivileged = false): KunjConfig {
      return { container: { network: { allowHost: true }, keepFiles: false, env: [], dockerInDocker: m, allowPrivileged } } as unknown as KunjConfig;
    }

    beforeAll(async () => {
      const work = path.join(tmp, 'dind-work');
      git(['clone', '-q', bare, work], tmp);
      git(['push', '-q', 'origin', `origin/main:refs/heads/${DIND}`], work);
      git(['fetch', '-q', bare, '+refs/heads/*:refs/remotes/origin/*'], hostClone);
    });

    it('refuses what this daemon must not run, before creating anything', async () => {
      if (!runtimes.includes('sysbox-runc')) {
        await expect(startContainer(backend, startOptions(DIND, withDind('sysbox')))).rejects.toMatchObject({ code: 'dind' });
      }
      await expect(startContainer(backend, startOptions(DIND, withDind('privileged')))).rejects.toMatchObject({ code: 'dind' });
      if (desktop) {
        await expect(startContainer(backend, startOptions(DIND, withDind('privileged', true)))).rejects.toThrow(/Docker Desktop/);
      }
      expect(labelledFor(DIND)).toEqual([]);
    });

    (mode ? it : it.skip)('runs docker inside, with /var/lib/docker on the branch volume', async () => {
      const r = await startContainer(backend, startOptions(DIND, withDind(mode!, mode === 'privileged')));
      try {
        expect(r.dind).toBe(mode);
        const run = await inside(r.containerId, 'docker run --rm alpine true');
        expect(run.exitCode).toBe(0);
        const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', r.containerId])) as Array<{ Name?: string; Destination: string }>;
        expect(mounts.find(m => m.Destination === '/var/lib/docker')?.Name).toBe(r.names.dockerVolume);
      } finally {
        await removeContainer(backend, r.names, ctx);
      }
      expect(labelledFor(DIND)).toEqual([]);
    });
  });
});
