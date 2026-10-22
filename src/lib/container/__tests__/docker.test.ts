import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { LocalDockerBackend, runArgs, parsePsJson, parseInspect } from '../docker';
import { ContainerSpec, ExecTimeoutError } from '../backend';

jest.mock('child_process');
const spawnMock = spawn as unknown as jest.Mock;

interface FakeResult { code?: number; stdout?: string; stderr?: string }

// A child that writes its output and exits with `code`; with no result it never exits
function fakeChild(result?: FakeResult) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: jest.Mock;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  if (result) {
    setImmediate(() => {
      child.stdout.end(result.stdout ?? '');
      child.stderr.end(result.stderr ?? '');
      setImmediate(() => child.emit('close', result.code ?? 0));
    });
  }
  return child;
}

let results: FakeResult[];
let children: ReturnType<typeof fakeChild>[];

function argvOf(call: number): string[] {
  return spawnMock.mock.calls[call][1] as string[];
}

const baseSpec: ContainerSpec = {
  name: 'kunj-app-main-abc123',
  image: 'kunj/default:1',
  labels: { 'kunj.repo': 'github.com/org/app', 'kunj.branch': 'main' },
  env: { TOKEN: 'secret-value', OTHER: 'x' },
  network: 'kunj-app-main-abc123-net',
  user: 'dev',
  workdir: '/workspace',
  volumes: [
    { name: 'kunj-app-main-abc123-ws', path: '/workspace' },
    { name: 'kunj-app-main-abc123-home', path: '/home/dev' },
  ],
  publish: [{ container: 3000, host: 13000 }],
  command: ['sleep', 'infinity'],
};

beforeEach(() => {
  results = [];
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = fakeChild(results.shift());
    children.push(child);
    return child;
  });
});

describe('docker backend', () => {
  // Pure helpers
  describe('runArgs', () => {
    it('runArgs puts labels, volumes, network, user, publish on 127.0.0.1 and no caps by default', () => {
      expect(runArgs(baseSpec, '/tmp/x/env')).toEqual([
        'run', '-d',
        '--name', 'kunj-app-main-abc123',
        '--init',
        '--label', 'kunj.branch=main',
        '--label', 'kunj.repo=github.com/org/app',
        '--env-file', '/tmp/x/env',
        '--network', 'kunj-app-main-abc123-net',
        '--user', 'dev',
        '--workdir', '/workspace',
        '-v', 'kunj-app-main-abc123-ws:/workspace',
        '-v', 'kunj-app-main-abc123-home:/home/dev',
        '-p', '127.0.0.1:13000:3000',
        'kunj/default:1',
        'sleep', 'infinity',
      ]);
    });

    it('runArgs adds --cap-add and --network container:<id> for the helper spec', () => {
      const args = runArgs({
        ...baseSpec,
        name: 'kunj-app-main-abc123-net-helper',
        user: undefined,
        volumes: [],
        publish: [],
        networkOf: 'abc',
        capabilities: ['NET_ADMIN', 'NET_RAW'],
        cpus: '1',
        memory: '256m',
      }, '/tmp/x/env');
      expect(args).toContain('--network');
      expect(args[args.indexOf('--network') + 1]).toBe('container:abc');
      expect(args.filter(a => a === '--network')).toHaveLength(1);
      expect(args).not.toContain('--user');
      expect(args.join(' ')).toContain('--cpus 1 --memory 256m --cap-add NET_ADMIN --cap-add NET_RAW kunj/default:1');
    });

    it('runArgs leaves out --init only when init is false', () => {
      expect(runArgs({ ...baseSpec, init: false }, '/e')).not.toContain('--init');
    });

    it('runArgs never contains an env value', () => {
      const args = runArgs(baseSpec, '/tmp/x/env').join('\n');
      expect(args).not.toContain('secret-value');
      expect(args).not.toContain('TOKEN');
    });
  });

  describe('parsePsJson', () => {
    it('parsePsJson maps State and Names', () => {
      const lines = [
        JSON.stringify({ ID: 'aaa', Names: 'kunj-a', State: 'running', Image: 'img:1', CreatedAt: '2026-10-21 10:00:00 +0000 UTC', Labels: 'kunj.repo=r,kunj.branch=b' }),
        '',
        JSON.stringify({ ID: 'bbb', Names: 'kunj-b', State: 'exited', Image: 'img:2', CreatedAt: 'later', Labels: '' }),
      ].join('\n');
      expect(parsePsJson(lines)).toEqual([
        { id: 'aaa', name: 'kunj-a', state: 'running', image: 'img:1', createdAt: '2026-10-21 10:00:00 +0000 UTC', labels: { 'kunj.repo': 'r', 'kunj.branch': 'b' }, ports: [] },
        { id: 'bbb', name: 'kunj-b', state: 'exited', image: 'img:2', createdAt: 'later', labels: {}, ports: [] },
      ]);
    });
  });

  describe('parseInspect', () => {
    it('parseInspect reads labels, state and published ports, skipping unpublished ones', () => {
      const line = JSON.stringify({
        Id: 'aaa', Name: '/kunj-a', Created: '2026-10-21T10:00:00Z',
        State: { Status: 'running' },
        Config: { Image: 'img:1', Labels: { 'kunj.repo': 'r,with,commas' } },
        NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '13000' }], '22/tcp': null } },
      });
      expect(parseInspect(line + '\n')).toEqual([{
        id: 'aaa', name: 'kunj-a', state: 'running', image: 'img:1', createdAt: '2026-10-21T10:00:00Z',
        labels: { 'kunj.repo': 'r,with,commas' }, ports: [{ container: 3000, host: 13000 }],
      }]);
    });
  });

  // Subprocess calls (spawn mocked)
  describe('LocalDockerBackend', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('exec rejects with ExecTimeoutError when the child does not exit', async () => {
      jest.useFakeTimers();
      const backend = new LocalDockerBackend();
      const p = backend.exec('abc', ['sleep', '100'], { timeoutMs: 500 });
      jest.advanceTimersByTime(500);
      await expect(p).rejects.toBeInstanceOf(ExecTimeoutError);
      await expect(p).rejects.toThrow('docker exec timed out after 500 ms');
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('exec captures stdout and returns a non-zero exit code without throwing', async () => {
      results.push({ code: 3, stdout: 'hello\n' });
      const backend = new LocalDockerBackend();
      await expect(backend.exec('abc', ['echo', 'hello'], { user: 'dev', workdir: '/w', env: { A: '1' } }))
        .resolves.toEqual({ exitCode: 3, stdout: 'hello\n' });
      expect(argvOf(0)).toEqual(['exec', '-u', 'dev', '-w', '/w', '-e', 'A=1', 'abc', 'echo', 'hello']);
    });

    it('exec passes -i and -t and inherits stdio for an interactive session', async () => {
      results.push({ code: 0 });
      const backend = new LocalDockerBackend();
      await backend.exec('abc', ['bash'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', tty: true });
      expect(argvOf(0)).toEqual(['exec', '-i', '-t', 'abc', 'bash']);
      const opts = spawnMock.mock.calls[0][2] as { stdio: unknown[] };
      expect(opts.stdio).toEqual(['inherit', 'inherit', 'inherit']);
    });

    it('prepends --context to every invocation when a context is set', async () => {
      results.push({ stdout: '27.0.1\n' });
      const backend = new LocalDockerBackend({ context: 'remote', dockerPath: '/usr/local/bin/docker' });
      await expect(backend.info()).resolves.toEqual({ serverVersion: '27.0.1' });
      expect(spawnMock.mock.calls[0][0]).toBe('/usr/local/bin/docker');
      expect(argvOf(0)).toEqual(['--context', 'remote', 'info', '--format', '{{.ServerVersion}}']);
    });

    it('info reports Docker as unavailable with the first line of stderr', async () => {
      results.push({ code: 1, stderr: 'Cannot connect to the Docker daemon\nmore\n' });
      await expect(new LocalDockerBackend().info()).rejects.toThrow('Docker is not available: Cannot connect to the Docker daemon');
    });

    it('run passes the env through a 0600 file and removes it afterwards', async () => {
      let envFile = '';
      let content = '';
      let mode = 0;
      spawnMock.mockImplementation((...a: unknown[]) => {
        const args = a[1] as string[];
        envFile = args[args.indexOf('--env-file') + 1];
        content = fs.readFileSync(envFile, 'utf8');
        mode = fs.statSync(envFile).mode & 0o777;
        return fakeChild({ stdout: 'cid123\n' });
      });
      await expect(new LocalDockerBackend().run(baseSpec)).resolves.toBe('cid123');
      expect(content).toBe('TOKEN=secret-value\nOTHER=x\n');
      expect(mode).toBe(0o600);
      expect(fs.existsSync(envFile)).toBe(false);
    });

    it('run rejects env values containing a newline before starting docker', async () => {
      await expect(new LocalDockerBackend().run({ ...baseSpec, env: { A: 'x\ny' } })).rejects.toThrow(/newline/);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('a failing command throws with the subcommand and first stderr line', async () => {
      results.push({ code: 125, stderr: 'Conflict. The name is already in use\n' });
      await expect(new LocalDockerBackend().run(baseSpec)).rejects.toThrow('docker run failed: Conflict. The name is already in use');
    });

    it('list filters by every label and inspects the matches in one call', async () => {
      results.push({ stdout: JSON.stringify({ ID: 'aaa', Names: 'kunj-a', State: 'running' }) + '\n' + JSON.stringify({ ID: 'bbb', Names: 'kunj-b', State: 'exited' }) + '\n' });
      results.push({ stdout: JSON.stringify({ Id: 'aaa', Name: '/kunj-a', State: { Status: 'running' }, Config: { Image: 'i', Labels: { k: 'v' } }, Created: 'c', NetworkSettings: { Ports: {} } }) + '\n' });
      const list = await new LocalDockerBackend().list({ 'kunj.repo': 'r', 'kunj.branch': 'b' });
      expect(argvOf(0)).toEqual(['ps', '-a', '--no-trunc', '--format', '{{json .}}', '--filter', 'label=kunj.repo=r', '--filter', 'label=kunj.branch=b']);
      expect(argvOf(1)).toEqual(['inspect', '--format', '{{json .}}', 'aaa', 'bbb']);
      expect(list.map(c => c.name)).toEqual(['kunj-a']);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('list returns [] without inspecting when nothing matches', async () => {
      results.push({ stdout: '' });
      await expect(new LocalDockerBackend().list({ 'kunj.repo': 'r' })).resolves.toEqual([]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('inspectLabels returns null for a missing object and the labels otherwise', async () => {
      results.push({ code: 1, stderr: 'Error: No such object: x\n' });
      results.push({ stdout: '{"kunj.repo":"r"}\n' });
      results.push({ stdout: 'null\n' });
      const backend = new LocalDockerBackend();
      await expect(backend.inspectLabels('x')).resolves.toBeNull();
      await expect(backend.inspectLabels('y')).resolves.toEqual({ 'kunj.repo': 'r' });
      await expect(backend.inspectLabels('z')).resolves.toEqual({});
    });

    it('copyIn pipes the tar into docker cp', async () => {
      results.push({});
      const tar = Readable.from([Buffer.from('tar-bytes')]);
      const received: Buffer[] = [];
      const p = new LocalDockerBackend().copyIn('abc', '/workspace', tar);
      children[0].stdin.on('data', (d: Buffer) => received.push(d));
      await p;
      expect(argvOf(0)).toEqual(['cp', '-', 'abc:/workspace']);
      expect(Buffer.concat(received).toString()).toBe('tar-bytes');
    });

    it('buildImage sends build output to stderr, not stdout', async () => {
      results.push({ stdout: 'Step 1/2\n' });
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await new LocalDockerBackend().buildImage('kunj/x:1', Readable.from([]), { dockerfile: 'Dockerfile.dev', buildArgs: { V: '1' } });
        expect(argvOf(0)).toEqual(['build', '-t', 'kunj/x:1', '-f', 'Dockerfile.dev', '--build-arg', 'V=1', '-']);
        expect(write.mock.calls.map(c => String(c[0])).join('')).toContain('Step 1/2');
      } finally {
        write.mockRestore();
      }
    });

    it('remove skips empty lists and ignores objects that are already gone', async () => {
      results.push({ code: 1, stderr: 'Error response from daemon: No such container: a\n' });
      results.push({ code: 1, stderr: 'Error response from daemon: get v: no such volume\n' });
      await new LocalDockerBackend().remove({ containers: ['a'], volumes: ['v'], networks: [] });
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(argvOf(0)).toEqual(['rm', '-f', 'a']);
      expect(argvOf(1)).toEqual(['volume', 'rm', 'v']);
    });

    it('remove throws on other failures', async () => {
      results.push({ code: 1, stderr: 'Error response from daemon: network n has active endpoints\n' });
      await expect(new LocalDockerBackend().remove({ networks: ['n'] })).rejects.toThrow('docker network rm failed: Error response from daemon: network n has active endpoints');
    });

    it('imageExists reflects the exit code of docker image inspect', async () => {
      results.push({ code: 0, stdout: 'sha256:x\n' });
      results.push({ code: 1, stderr: 'No such image\n' });
      const backend = new LocalDockerBackend();
      await expect(backend.imageExists('a')).resolves.toBe(true);
      await expect(backend.imageExists('b')).resolves.toBe(false);
    });
  });
});
