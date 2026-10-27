import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  parseBlueprint,
  resolveBlueprint,
  lockfileIds,
  blueprintHash,
  snapshotTag,
  blueprintLabels,
  blueprintRef,
} from '../blueprint';

// Fixture repositories and subprocesses: slow when the machine is busy
jest.setTimeout(30000);

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
}

describe('parseBlueprint', () => {
  it('parses tools/setup/maintain and reports ignored keys', () => {
    const bp = parseBlueprint(
      `{ // c\n "tools": {"node": "24", "apt": ["jq"], "bun": true}, "setup": ["a"], "maintain": ["b"], "notes": "n", "zeta": 1, "alpha": 2, }`,
      'x.json'
    );
    expect(bp.tools).toEqual({ node: '24', apt: ['jq'], bun: true });
    expect(bp.setup).toEqual(['a']);
    expect(bp.maintain).toEqual(['b']);
    expect(bp.lockfiles).toEqual([]);
    expect(bp.notes).toBe('n');
    expect(bp.ignoredKeys).toEqual(['alpha', 'zeta']);
  });

  it('takes "sandbox" or an image reference as image', () => {
    expect(parseBlueprint('{"image": "sandbox"}', 'x.json').image).toBe('sandbox');
    expect(parseBlueprint('{"image": "ghcr.io/o/img:1"}', 'x.json').image).toBe('ghcr.io/o/img:1');
    expect(parseBlueprint('{}', 'x.json').image).toBeUndefined();
    for (const bad of ['"-rf"', '"a b"', '1']) {
      expect(() => parseBlueprint(`{"image": ${bad}}`, 'x.json')).toThrow('x.json: image must be "sandbox" or an image reference');
    }
  });

  it('rejects non-array setup with the key named', () => {
    expect(() => parseBlueprint('{"setup": "yarn"}', 'x.json')).toThrow('x.json: setup must be an array of strings');
  });

  it('rejects preset names outside [a-z0-9-]', () => {
    expect(() => parseBlueprint('{"tools": {"Node_JS": "1"}}', 'x.json')).toThrow(
      'x.json: tools.Node_JS is not a valid preset name'
    );
  });

  it('rejects tool values that could become options or paths in a root preset', () => {
    const parse = (tools: unknown) => () => parseBlueprint(JSON.stringify({ tools }), 'x.json');
    expect(parse({ apt: ['-oDPkg::Pre-Invoke::=id'] })).toThrow('x.json: tools.apt contains an invalid value "-oDPkg::Pre-Invoke::=id"');
    expect(parse({ apt: ['/opt/kunj/seed/x.deb'] })).toThrow('x.json: tools.apt contains an invalid value "/opt/kunj/seed/x.deb"');
    expect(parse({ java: '../../../usr/bin' })).toThrow('x.json: tools.java contains an invalid value "../../../usr/bin"');
    expect(parse({ python: '--help' })).toThrow('x.json: tools.python contains an invalid value "--help"');
    expect(parse({ apt: [' '] })).toThrow('x.json: tools.apt contains an invalid value " "');
    expect(parse({ node: '  ' })).toThrow('x.json: tools.node contains an invalid value ""');
    expect(parse({ apt: ['jq git'] })).toThrow('x.json: tools.apt contains an invalid value "jq git"');
    expect(parse({ playwright: 'chromium $(id)' })).toThrow('x.json: tools.playwright contains an invalid value "$(id)"');
    const ok = { yarn: 'corepack', node: '22.12', go: 'lts', apt: ['jq', 'libc6:arm64', 'g++'], playwright: 'chromium firefox', bun: true };
    expect(parseBlueprint(JSON.stringify({ tools: ok }), 'x.json').tools).toEqual(ok);
  });

  it('takes aliases as one-line commands under shell-safe names', () => {
    const bp = parseBlueprint('{"aliases": {"sso": "aws sso login --use-device-code", "ll": "ls -la"}}', 'x.json');
    expect(bp.aliases).toEqual({ sso: 'aws sso login --use-device-code', ll: 'ls -la' });
    expect(parseBlueprint('{}', 'x.json').aliases).toBeUndefined();
    expect(parseBlueprint('{"aliases": {}}', 'x.json').aliases).toBeUndefined();
    expect(() => parseBlueprint('{"aliases": ["sso"]}', 'x.json')).toThrow('x.json: aliases must be an object');
    for (const name of ['a b', '-x', 'a=b', 'a;b', '$(id)']) {
      expect(() => parseBlueprint(JSON.stringify({ aliases: { [name]: 'x' } }), 'x.json')).toThrow(`x.json: aliases.${name} is not a valid alias name`);
    }
    for (const value of ['', '  ', 'a\nb', 1]) {
      expect(() => parseBlueprint(JSON.stringify({ aliases: { s: value } }), 'x.json')).toThrow('x.json: aliases.s must be a one-line command');
    }
  });

  it('reads "*" as any version, like true', () => {
    expect(parseBlueprint('{"tools": {"bun": "*", "node": "24"}}', 'x.json').tools).toEqual({ bun: true, node: '24' });
  });
});

describe('resolution', () => {
  let tmp: string;
  let origin: string;
  let clone: string;
  let kunjDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-bp-'));
    origin = path.join(tmp, 'origin.git');
    clone = path.join(tmp, 'clone');
    kunjDir = path.join(tmp, 'kunj');
    fs.mkdirSync(kunjDir);
    git(tmp, 'init', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', origin, clone);
    git(clone, 'checkout', '-b', 'main');
    fs.writeFileSync(path.join(clone, 'README'), 'x');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'init');
    git(clone, 'push', '-u', 'origin', 'main');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resolves repo file from origin default, falls back to host, then null', async () => {
    expect(await resolveBlueprint({ cwd: clone, repoKunjDir: kunjDir, defaultBranch: 'main' })).toBeNull();

    fs.writeFileSync(path.join(kunjDir, 'blueprint.json'), '{"setup":["host"]}');
    const host = await resolveBlueprint({ cwd: clone, repoKunjDir: kunjDir, defaultBranch: 'main' });
    expect(host?.source).toBe('host');
    expect(host?.blueprint.setup).toEqual(['host']);

    fs.mkdirSync(path.join(clone, '.kunj'));
    fs.writeFileSync(path.join(clone, '.kunj/blueprint.json'), '{"setup":["repo"]}');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'bp');
    git(clone, 'push', 'origin', 'main');
    git(clone, 'fetch', 'origin');
    const repo = await resolveBlueprint({ cwd: clone, repoKunjDir: kunjDir, defaultBranch: 'main' });
    expect(repo?.source).toBe('repo');
    expect(repo?.ref).toBe('origin/main');
    expect(repo?.blueprint.setup).toEqual(['repo']);

    const over = path.join(tmp, 'o.json');
    fs.writeFileSync(over, '{"setup":["file"]}');
    const file = await resolveBlueprint({ cwd: clone, repoKunjDir: kunjDir, defaultBranch: 'main', override: over });
    expect(file?.source).toBe('file');
    expect(file?.blueprint.setup).toEqual(['file']);
  });

  it('worktree file wins over origin and host; the override still wins over it', async () => {
    fs.writeFileSync(path.join(kunjDir, 'blueprint.json'), '{"setup":["host"]}');
    fs.mkdirSync(path.join(clone, '.kunj'));
    fs.writeFileSync(path.join(clone, '.kunj/blueprint.json'), '{"setup":["repo"]}');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'bp');
    git(clone, 'push', 'origin', 'main');
    // Edited but neither committed nor pushed
    fs.writeFileSync(path.join(clone, '.kunj/blueprint.json'), '{"setup":["worktree"]}');

    const wt = await resolveBlueprint({ cwd: clone, repoRoot: clone, repoKunjDir: kunjDir, defaultBranch: 'main' });
    expect(wt).toMatchObject({ source: 'worktree', path: path.join(clone, '.kunj/blueprint.json'), text: '{"setup":["worktree"]}' });
    expect(wt?.ref).toBeUndefined();
    expect(wt?.blueprint.setup).toEqual(['worktree']);

    // Without repoRoot (or without the file there) origin is next
    expect((await resolveBlueprint({ cwd: clone, repoKunjDir: kunjDir, defaultBranch: 'main' }))?.source).toBe('repo');
    expect((await resolveBlueprint({ cwd: clone, repoRoot: tmp, repoKunjDir: kunjDir, defaultBranch: 'main' }))?.source).toBe('repo');

    const over = path.join(tmp, 'o.json');
    fs.writeFileSync(over, '{"setup":["file"]}');
    expect((await resolveBlueprint({ cwd: clone, repoRoot: clone, repoKunjDir: kunjDir, override: over }))?.source).toBe('file');
  });

  it('lockfileIds skips absent files', async () => {
    fs.writeFileSync(path.join(clone, 'yarn.lock'), 'l');
    fs.writeFileSync(path.join(clone, 'requirements-dev.txt'), 'r');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'locks');
    const explicit = await lockfileIds(['yarn.lock', 'nope.lock'], 'HEAD', clone);
    expect(explicit.map(l => l.path)).toEqual(['yarn.lock']);
    expect(explicit[0].id).toMatch(/^[0-9a-f]{40}$/);
    const defaults = await lockfileIds([], 'HEAD', clone);
    expect(defaults.map(l => l.path).sort()).toEqual(['requirements-dev.txt', 'yarn.lock']);
  });
});

describe('hash and names', () => {
  const base = { text: 'a', lockfiles: [{ path: 'yarn.lock', id: '1' }], baseImage: 'img', presetHashes: ['p'] };

  it('hash changes with text, lockfile id, base image and preset hash', () => {
    const h = blueprintHash(base);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(blueprintHash(base)).toBe(h);
    expect(blueprintHash({ ...base, text: 'b' })).not.toBe(h);
    expect(blueprintHash({ ...base, lockfiles: [{ path: 'yarn.lock', id: '2' }] })).not.toBe(h);
    expect(blueprintHash({ ...base, baseImage: 'other' })).not.toBe(h);
    expect(blueprintHash({ ...base, presetHashes: ['q'] })).not.toBe(h);
  });

  it('snapshotTag lowercases', () => {
    expect(snapshotTag('My_Repo', 'abc')).toBe('kunj-blueprint-my_repo:abc');
  });

  it('blueprintLabels carries the identity', () => {
    const l = blueprintLabels({ repoId: 'r', hash: 'h', ref: 'origin/main', base: 'b', user: 'u', now: new Date(0) });
    expect(l).toEqual({
      'kunj.repo': 'r',
      'kunj.blueprint.hash': 'h',
      'kunj.blueprint.ref': 'origin/main',
      'kunj.blueprint.base': 'b',
      'kunj.blueprint.user': 'u',
      'kunj.blueprint.createdAt': '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('blueprintRef', () => {
  it("uses the blueprint's ref, else origin/<default>, else HEAD", () => {
    expect(blueprintRef({ ref: 'origin/main' }, 'develop')).toBe('origin/main');
    expect(blueprintRef({}, 'develop')).toBe('origin/develop');
    expect(blueprintRef({}, 'origin/develop')).toBe('origin/develop');
    expect(blueprintRef({}, undefined)).toBe('HEAD');
    expect(blueprintRef({}, '')).toBe('HEAD');
  });
});
