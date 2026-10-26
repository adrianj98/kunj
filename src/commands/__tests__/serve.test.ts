import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { FakeBackend } from '../../lib/container/__tests__/fake-backend';
import { ServeCommand, flagValues, parseListen, parseRuntimes } from '../serve';
import { isFastCommand } from '../fast';

jest.mock('../../lib/config', () => ({
  getGlobalKunjDir: jest.fn(() => '/nowhere/.kunj'),
  loadResolvedConfig: jest.fn(async () => ({})),
}));

function get(port: number, pathname: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('parseListen', () => {
  it('defaults and parses host:port, :port, port, host and [v6]:port', () => {
    expect(parseListen(undefined)).toEqual({ host: '127.0.0.1', port: 7433 });
    expect(parseListen('0.0.0.0:8000')).toEqual({ host: '0.0.0.0', port: 8000 });
    expect(parseListen(':8000')).toEqual({ host: '127.0.0.1', port: 8000 });
    expect(parseListen('8000')).toEqual({ host: '127.0.0.1', port: 8000 });
    expect(parseListen('localhost')).toEqual({ host: 'localhost', port: 7433 });
    expect(parseListen('[::1]:9')).toEqual({ host: '::1', port: 9 });
    expect(() => parseListen('box:70000')).toThrow(/0-65535/);
  });
});

describe('parseRuntimes', () => {
  it('takes the string Commander gives, a comma list or an array, as whole names', () => {
    expect(parseRuntimes(undefined)).toEqual([]);
    expect(parseRuntimes('sysbox-runc')).toEqual(['sysbox-runc']);
    expect(parseRuntimes('sysbox-runc, kata')).toEqual(['sysbox-runc', 'kata']);
    expect(parseRuntimes(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
  });

  it('flagValues reads a repeated flag from argv, which Commander would reduce to the last value', () => {
    const argv = ['node', 'kunj', 'serve', '--allow-runtime', 'sysbox-runc', '--allow-runtime=kata', '--verbose', '--', '--allow-runtime', 'x'];
    expect(flagValues(argv, '--allow-runtime')).toEqual(['sysbox-runc', 'kata']);
    expect(parseRuntimes(flagValues(argv, '--allow-runtime'))).toEqual(['sysbox-runc', 'kata']);
  });
});

describe('kunj serve', () => {
  let dir: string;
  let tokenFile: string;
  let fake: FakeBackend;
  let stderr: string[];
  let stdout: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-serve-'));
    tokenFile = path.join(dir, 'serve', 'token');
    fake = new FakeBackend();
    stderr = [];
    stdout = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(' '));
    });
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function command(onListening: (address: { host: string; port: number }, stop: () => void) => void): ServeCommand {
    return new ServeCommand({ backend: async () => fake, tokenFile, onListening, stderr: l => stderr.push(l) });
  }

  it('is on the fast path', () => {
    expect(isFastCommand('serve')).toBe(true);
    expect(isFastCommand('remote')).toBe(true);
  });

  it('says so in one line when the address is not this machine\'s or the port is taken', async () => {
    await expect(command(() => {}).execute({ listen: '203.0.113.9:0', allowRemoteListen: true })).rejects.toThrow(/not an address of this machine/);
    const busy = require('net').createServer();
    await new Promise<void>(r => busy.listen(0, '127.0.0.1', () => r()));
    try {
      await expect(command(() => {}).execute({ listen: `127.0.0.1:${busy.address().port}` })).rejects.toThrow(/already in use/);
    } finally {
      busy.close();
    }
  });

  it('refuses a non-loopback listen address without the flag, before touching Docker', async () => {
    const cmd = command(() => {
      throw new Error('must not listen');
    });
    await expect(cmd.execute({ listen: '0.0.0.0:7433' })).rejects.toThrow(/--allow-remote-listen/);
    expect(fake.calls).toEqual([]);
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('creates the token 0600 and prints it once, serves /v1/info with it, and logs a bad token without its bytes', async () => {
    let seen: { host: string; port: number } | undefined;
    const cmd = command(async (address, stop) => {
      seen = address;
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      expect((await get(address.port, '/v1/info', token)).body).toMatchObject({ protocol: 1, kunj: expect.any(String) });
      expect((await get(address.port, '/v1/info', 'wrong-token')).status).toBe(401);
      expect((await get(address.port, '/v1/info')).status).toBe(401);
      stop();
    });
    await cmd.execute({ listen: '127.0.0.1:0', verbose: true });
    expect(seen?.host).toBe('127.0.0.1');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    const log = stderr.join('\n');
    expect(log).toContain('New token (shown once');
    expect(log).toContain(`  ${token}`);
    expect(log).toMatch(/listening on 127\.0\.0\.1:\d+/);
    expect(log).toMatch(/unauthorized request from 127\.0\.0\.1/);
    expect(log).not.toContain('wrong-token');
    expect(log).toMatch(/GET \/v1\/info 200 \d+ms/);
    expect(fake.methods()).toContain('info');

    // The second run finds the token and does not print it
    stderr.length = 0;
    await command((_a, stop) => stop()).execute({ listen: '127.0.0.1:0' });
    expect(stderr.join('\n')).not.toContain(token);
    expect(stderr.join('\n')).not.toContain('New token');
  });

  it('fails early when Docker is down, with its message', async () => {
    fake.failOn = 'info';
    await expect(command(() => {}).execute({ listen: '127.0.0.1:0' })).rejects.toThrow('info failed');
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('token prints it, --rotate replaces it, --json wraps it', async () => {
    const cmd = command(() => {});
    await cmd.execute('token', {});
    const first = stdout.pop()!.trim();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await cmd.execute('token', { rotate: true });
    const second = stdout.pop()!.trim();
    expect(second).not.toBe(first);
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe(second);
    await new ServeCommand({ backend: async () => fake, tokenFile }).execute('token', { json: true });
    expect(JSON.parse(stdout.pop()!)).toEqual({ token: second, file: tokenFile, rotated: false });
  });

  it('passes the flags to the server: privileged refused without, allowed with', async () => {
    const spec = { name: 'kunj-r-b-1', image: 'kunj-sandbox:1', labels: { 'kunj.repo': 'r' }, env: {}, network: 'n', workdir: '/w', volumes: [], publish: [], command: ['sleep'], privileged: true };
    const post = (port: number, token: string) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify(spec);
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/containers', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length } }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end(body);
      });
    await command(async (a, stop) => {
      expect(await post(a.port, fs.readFileSync(tokenFile, 'utf8').trim())).toBe(403);
      stop();
    }).execute({ listen: '127.0.0.1:0' });
    await command(async (a, stop) => {
      expect(await post(a.port, fs.readFileSync(tokenFile, 'utf8').trim())).toBe(200);
      stop();
    }).execute({ listen: '127.0.0.1:0', allowPrivileged: true });
    expect(fake.callsOf('run')).toHaveLength(1);
    // --allow-runtime as Commander passes it (a string): exact names only, no substring match
    const withRuntime = (runtime: string) =>
      new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ ...spec, privileged: false, runtime });
        command(async (a, stop) => {
          const req = http.request({ host: '127.0.0.1', port: a.port, method: 'POST', path: '/v1/containers', headers: { authorization: `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`, 'content-type': 'application/json', 'content-length': body.length } }, res => {
            res.resume();
            res.on('end', () => {
              stop();
              resolve(res.statusCode ?? 0);
            });
          });
          req.on('error', reject);
          req.end(body);
        }).execute({ listen: '127.0.0.1:0', allowRuntime: 'sysbox-runc' });
      });
    expect(await withRuntime('sysbox-runc')).toBe(200);
    expect(await withRuntime('sysbox')).toBe(403);
    expect(stderr.join('\n')).toContain('privileged containers allowed');
  });
});
