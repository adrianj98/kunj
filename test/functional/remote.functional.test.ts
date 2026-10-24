// Remote containers through the built CLI: a `kunj serve` child in the fixture's HOME, a `--url`
// remote to it on 127.0.0.1, and the start/list/exec/stop/remove path with --remote. Opt-in: npm run
// test:functional. (Written without a daemon at hand; the first run on one may need adjusting.)
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { describeFunctional, useFixture } from './harness';

describeFunctional('kunj ct (functional): remote', () => {
  const ctx = useFixture('remote');
  let port = 0;
  let token = '';

  beforeAll(async () => {
    const { fx } = ctx;
    // The server, on a port the OS picks; its first run creates and prints the token
    const serve = fx.spawn(['serve', '--listen', '127.0.0.1:0', '--verbose']);
    const line = await serve.line(l => /listening on 127\.0\.0\.1:\d+/.test(l), 'kunj serve listening');
    port = Number(/:(\d+)/.exec(line)![1]);
    token = fs.readFileSync(path.join(fx.home, '.kunj', 'serve', 'token'), 'utf8').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const added = await fx.kunj(['remote', 'add', 'box', '--url', `http://127.0.0.1:${port}`, '--token-stdin'], { input: token + '\n' });
    expect(added.status).toBe(0);
  });

  it('pings the remote and never lists the token', async () => {
    const { fx } = ctx;
    const ping = await fx.kunjJson<{ name: string; via: string; kunj: string; features: { editorAttach: boolean } }>(['remote', 'ping', 'box']);
    expect(ping).toMatchObject({ name: 'box', via: 'url', features: { editorAttach: false } });
    const list = await fx.kunj(['remote', 'list']);
    expect(list.stdout).toContain('box');
    expect(list.stdout).not.toContain(token);
  });

  it('starts, lists, execs, stops and removes a container through the server', async () => {
    const { fx } = ctx;
    const branch = 'ft-remote-a';
    const started = await fx.start(branch, ['--remote', 'box']);
    expect(started.created).toBe(true);

    const list = await fx.kunjJson<{ backend: { kind: string; remote?: string }; containers: Array<{ branch: string; state: string }> }>(['ct', 'list', '--remote', 'box']);
    expect(list.backend).toMatchObject({ kind: 'remote', remote: 'box' });
    expect(list.containers.find(c => c.branch === branch)).toMatchObject({ state: 'running' });

    const whoami = await fx.kunj(['ct', 'exec', branch, '--remote', 'box', '--', 'sh', '-c', 'id -un; git rev-parse --abbrev-ref HEAD']);
    expect(whoami.status).toBe(0);
    expect(whoami.stdout.trim().split('\n')).toEqual(['dev', branch]);

    // The same container through the local backend: it is the daemon's, whichever path made it
    const local = await fx.kunjJson<{ containers: Array<{ branch: string }> }>(['ct', 'list']);
    expect(local.containers.map(c => c.branch)).toContain(branch);

    const open = await fx.kunjJsonError(['ct', 'open', branch, '--remote', 'box']);
    expect(open.code).toBe('remote-no-editor');

    expect((await fx.kunj(['ct', 'stop', branch, '--remote', 'box'])).status).toBe(0);
    const stopped = await fx.kunjJson<{ containers: Array<{ branch: string; state: string }> }>(['ct', 'list', '--remote', 'box', '--no-status']);
    expect(stopped.containers.find(c => c.branch === branch)?.state).toBe('exited');

    expect((await fx.kunj(['ct', 'remove', branch, '--remote', 'box', '--force'])).status).toBe(0);
    expect(fx.labelled(branch).containers).toEqual([]);
  });

  it('refuses a wrong token and an unknown remote with their codes', async () => {
    const { fx } = ctx;
    expect((await fx.kunj(['remote', 'token', 'box', '--token-stdin'], { input: 'wrong\n' })).status).toBe(0);
    expect((await fx.kunjJsonError(['ct', 'list', '--remote', 'box'])).code).toBe('remote-unauthorized');
    expect((await fx.kunj(['remote', 'token', 'box', '--token-stdin'], { input: token + '\n' })).status).toBe(0);
    expect((await fx.kunjJsonError(['ct', 'list', '--remote', 'nope'])).code).toBe('remote-unknown');
  });
});
