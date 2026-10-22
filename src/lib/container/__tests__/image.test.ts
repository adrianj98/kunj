import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { Readable } from 'stream';
import {
  resolveImage,
  resolveHelperImage,
  imageHash,
  ensureImage,
  sandboxAssetsDir,
  tarDirectory,
  tarEntries,
  SANDBOX_IMAGE,
  NETHELPER_IMAGE,
  ImageSource,
} from '../image';
import { ContainerBackend } from '../backend';
import { DevcontainerSpec } from '../devcontainer';

const posixOnly = process.platform === 'win32' ? it.skip : it;

function spec(over: Partial<DevcontainerSpec>): DevcontainerSpec {
  return { containerEnv: {}, forwardPorts: [], hasComposeFile: false, ignoredKeys: [], ...over };
}

const archive = () => Readable.from([Buffer.from('ctx')]);

function devcontainer(s: DevcontainerSpec) {
  return { spec: s, treeId: 'tree1', archive, dockerfileText: 'FROM alpine\n' };
}

/** Pipe a stream into `tar <args>` and resolve with its stdout. */
function runTar(stream: NodeJS.ReadableStream, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args);
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`tar ${code}: ${err}`))));
    stream.pipe(child.stdin);
  });
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-image-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('image', () => {
  it('resolveImage prefers setting, then devcontainer, then sandbox', () => {
    const dc = devcontainer(spec({ build: { dockerfile: '.devcontainer/Dockerfile', context: '.devcontainer', args: { A: '1' } } }));

    const fromSetting = resolveImage({ setting: 'my/image:1', devcontainer: dc, repoName: 'repo', kunjVersion: '1.2.3' });
    expect(fromSetting.kind).toBe('setting');
    expect(fromSetting.tag).toBe('my/image:1');
    expect(fromSetting.build).toBeUndefined();
    expect(fromSetting.user).toBe('');

    const fromDc = resolveImage({ setting: '', devcontainer: dc, repoName: 'repo', kunjVersion: '1.2.3' });
    expect(fromDc.kind).toBe('devcontainer');
    expect(fromDc.tag).toBe(`kunj-repo:${imageHash('FROM alpine\n', 'tree1', { A: '1' })}`);
    expect(fromDc.build?.dockerfile).toBe('Dockerfile');
    expect(fromDc.build?.buildArgs).toEqual({ A: '1' });
    expect(fromDc.build?.contextTar).toBe(archive);
    expect(fromDc.spec).toBe(dc.spec);

    const fromSandbox = resolveImage({ setting: '', devcontainer: null, repoName: 'repo', kunjVersion: '1.2.3' });
    expect(fromSandbox.kind).toBe('sandbox');
    expect(fromSandbox.tag).toBe('kunj-sandbox:1.2.3');
    expect(fromSandbox.tag).toBe(SANDBOX_IMAGE('1.2.3'));
    expect(fromSandbox.build?.dockerfile).toBe('Dockerfile');
    expect(fromSandbox.user).toBe('dev');
  });

  it('uses a devcontainer image as is, and falls back to the sandbox without image or build', () => {
    const withImage = resolveImage({ setting: '', devcontainer: devcontainer(spec({ image: 'node:22' })), repoName: 'r', kunjVersion: '1' });
    expect(withImage).toMatchObject({ kind: 'devcontainer', tag: 'node:22' });
    expect(withImage.build).toBeUndefined();

    const empty = resolveImage({ setting: '', devcontainer: devcontainer(spec({})), repoName: 'r', kunjVersion: '1' });
    expect(empty.kind).toBe('sandbox');
  });

  it('builds a root-context devcontainer with the dockerfile path relative to the context', () => {
    const dc = devcontainer(spec({ build: { dockerfile: '.devcontainer/Dockerfile', context: '.', args: {} } }));
    const src = resolveImage({ setting: '', devcontainer: dc, repoName: 'r', kunjVersion: '1' });
    expect(src.build?.dockerfile).toBe('.devcontainer/Dockerfile');
  });

  it('rejects a devcontainer dockerfile outside the build context', () => {
    const dc = devcontainer(spec({ build: { dockerfile: 'Dockerfile', context: 'sub', args: {} } }));
    expect(() => resolveImage({ setting: '', devcontainer: dc, repoName: 'r', kunjVersion: '1' })).toThrow(/inside build.context/);
  });

  it('imageHash changes with dockerfile, tree id and args', () => {
    const base = imageHash('FROM a', 't1', { X: '1' });
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    expect(imageHash('FROM a', 't1', { X: '1' })).toBe(base);
    expect(imageHash('FROM b', 't1', { X: '1' })).not.toBe(base);
    expect(imageHash('FROM a', 't2', { X: '1' })).not.toBe(base);
    expect(imageHash('FROM a', 't1', { X: '2' })).not.toBe(base);
    expect(imageHash('FROM a', 't1', {})).not.toBe(base);
    // argument order does not matter
    expect(imageHash('F', 't', { A: '1', B: '2' })).toBe(imageHash('F', 't', { B: '2', A: '1' }));
  });

  it("devcontainer image user comes from remoteUser else the image's own USER", () => {
    const withUser = resolveImage({ setting: '', devcontainer: devcontainer(spec({ image: 'x', remoteUser: 'vscode' })), repoName: 'r', kunjVersion: '1' });
    expect(withUser.user).toBe('vscode');
    const without = resolveImage({ setting: '', devcontainer: devcontainer(spec({ image: 'x' })), repoName: 'r', kunjVersion: '1' });
    expect(without.user).toBe('');
  });

  it('resolveHelperImage builds the network helper from its assets', () => {
    const helper = resolveHelperImage('2.0.0');
    expect(helper.tag).toBe('kunj-nethelper:2.0.0');
    expect(helper.tag).toBe(NETHELPER_IMAGE('2.0.0'));
    expect(helper.build?.dockerfile).toBe('Dockerfile');
  });

  it('sandboxAssetsDir contains the sandbox and nethelper build contexts', () => {
    expect(fs.existsSync(path.join(sandboxAssetsDir(), 'sandbox', 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxAssetsDir(), 'sandbox', 'git-credential-kunj'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxAssetsDir(), 'nethelper', 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(sandboxAssetsDir(), 'nethelper', 'firewall.sh'))).toBe(true);
  });

  posixOnly('tarDirectory produces entries readable by tar -t', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(dir, 'sub', 'b.sh'), '#!/bin/sh\necho b\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'sub', 'deep', 'empty'), '');
    const longDir = path.join(dir, 'l'.repeat(70), 'm'.repeat(70));
    fs.mkdirSync(longDir, { recursive: true });
    fs.writeFileSync(path.join(longDir, 'long-file.txt'), 'long');

    const listed = (await runTar(tarDirectory(dir), ['-t'])).split('\n').filter(Boolean).map(n => n.replace(/\/$/, ''));
    const longRel = `${'l'.repeat(70)}/${'m'.repeat(70)}`;
    expect(listed.sort()).toEqual(
      ['a.txt', 'sub', 'sub/b.sh', 'sub/deep', 'sub/deep/empty', 'l'.repeat(70), longRel, `${longRel}/long-file.txt`].sort(),
    );

    const out = tmp();
    await runTar(tarDirectory(dir), ['-x', '-C', out]);
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(path.join(out, 'sub', 'b.sh'), 'utf8')).toBe('#!/bin/sh\necho b\n');
    expect(fs.statSync(path.join(out, 'sub', 'b.sh')).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(out, 'sub', 'deep', 'empty'), 'utf8')).toBe('');
    expect(fs.readFileSync(path.join(out, longRel, 'long-file.txt'), 'utf8')).toBe('long');
  });

  posixOnly('tarEntries writes in-memory files with their modes', async () => {
    const out = tmp();
    await runTar(
      tarEntries([
        { path: '.env', content: 'SECRET=1\n', mode: 0o600 },
        { path: 'config/local.json', content: Buffer.from('{}') },
      ]),
      ['-x', '-C', out],
    );
    expect(fs.readFileSync(path.join(out, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(fs.statSync(path.join(out, '.env')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(out, 'config', 'local.json'), 'utf8')).toBe('{}');
  });

  it('tarEntries rejects names longer than ustar can hold', () => {
    expect(() => tarEntries([{ path: 'x'.repeat(300), content: '' }])).toThrow(/too long/);
  });

  posixOnly('git-credential-kunj answers only for the credential host', () => {
    const helper = path.join(sandboxAssetsDir(), 'sandbox', 'git-credential-kunj');
    const run = (arg: string, input: string, env: Record<string, string>) =>
      spawnSync('sh', [helper, arg], { input, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    const ask = 'protocol=https\nhost=github.com\n\n';

    expect(run('get', ask, { KUNJ_CREDENTIAL_HOST: 'github.com', GH_TOKEN: 't1' }).stdout).toBe('username=x-access-token\npassword=t1\n');
    expect(run('get', ask, { KUNJ_CREDENTIAL_HOST: 'github.com', GITHUB_TOKEN: 't2' }).stdout).toBe('username=x-access-token\npassword=t2\n');
    expect(run('get', ask, { KUNJ_CREDENTIAL_HOST: 'github.com', GITLAB_TOKEN: 't3' }).stdout).toBe('username=oauth2\npassword=t3\n');
    expect(run('get', 'host=evil.example\n', { KUNJ_CREDENTIAL_HOST: 'github.com', GH_TOKEN: 't1' }).stdout).toBe('');
    expect(run('get', ask, { GH_TOKEN: 't1' }).stdout).toBe('');
    expect(run('get', ask, { KUNJ_CREDENTIAL_HOST: 'github.com' }).stdout).toBe('');
    const store = run('store', ask, { KUNJ_CREDENTIAL_HOST: 'github.com', GH_TOKEN: 't1' });
    expect(store.status).toBe(0);
    expect(store.stdout).toBe('');
  });

  describe('ensureImage', () => {
    function backend(exists: boolean) {
      return {
        imageExists: jest.fn(async (_tag: string) => exists),
        buildImage: jest.fn(async (_tag: string, _ctx: NodeJS.ReadableStream, _opts?: unknown) => undefined),
      } as unknown as ContainerBackend & { imageExists: jest.Mock; buildImage: jest.Mock };
    }
    const source: ImageSource = {
      kind: 'devcontainer',
      tag: 'kunj-r:abc',
      user: '',
      build: { contextTar: archive, dockerfile: 'Dockerfile', buildArgs: { A: '1' } },
    };

    it('reuses an existing image', async () => {
      const b = backend(true);
      const warn = jest.fn();
      await expect(ensureImage(b, source, warn)).resolves.toBe('kunj-r:abc');
      expect(b.buildImage).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('builds a missing image and warns first', async () => {
      const b = backend(false);
      const warn = jest.fn();
      await expect(ensureImage(b, source, warn)).resolves.toBe('kunj-r:abc');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Building image kunj-r:abc'));
      expect(b.buildImage).toHaveBeenCalledWith('kunj-r:abc', expect.anything(), { dockerfile: 'Dockerfile', buildArgs: { A: '1' } });
    });

    it('throws for a missing image it cannot build', async () => {
      const b = backend(false);
      await expect(ensureImage(b, { kind: 'setting', tag: 'nope:1', user: '' }, () => undefined)).rejects.toThrow(
        'Image not found: nope:1 (pull it or set container.image)',
      );
    });
  });
});
