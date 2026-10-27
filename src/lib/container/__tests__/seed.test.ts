import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  inspectOrigin,
  originPort,
  parseOrigin,
  stripUserinfo,
  refExistsOnOrigin,
  pushBranch,
  hostGitIdentity,
  seedScript,
  SEED_MARKER,
  SEED_MARKER_EXCLUDE,
  SeedInput,
} from '../seed';

// Fixture repositories and subprocesses: slow when the machine is busy
jest.setTimeout(30000);

const posixOnly = process.platform === 'win32' ? it.skip : it;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
}

function commit(cwd: string, name: string): void {
  fs.writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', name);
}

describe('origin checks', () => {
  let tmp: string;
  let clone: string;
  let origin: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-seed-'));
    origin = path.join(tmp, 'origin.git');
    clone = path.join(tmp, 'clone');
    git(tmp, 'init', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', origin, clone);
    git(clone, 'checkout', '-b', 'main');
    commit(clone, 'a');
    git(clone, 'push', '-u', 'origin', 'main');
    process.env.GIT_AUTHOR_NAME = ENV.GIT_AUTHOR_NAME;
    process.env.GIT_AUTHOR_EMAIL = ENV.GIT_AUTHOR_EMAIL;
    process.env.GIT_COMMITTER_NAME = ENV.GIT_COMMITTER_NAME;
    process.env.GIT_COMMITTER_EMAIL = ENV.GIT_COMMITTER_EMAIL;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  posixOnly('inspectOrigin counts unpushed commits against a bare origin', async () => {
    commit(clone, 'b');
    git(clone, 'push', 'origin', 'main');
    commit(clone, 'c');
    const state = await inspectOrigin('main', clone);
    expect(state.originUrl).toBe(origin);
    expect(state.branchOnOrigin).toBe(true);
    expect(state.unpushed).toBe(1);
    expect(state.isSsh).toBe(false);
  });

  posixOnly('inspectOrigin reports a branch missing on origin', async () => {
    git(clone, 'checkout', '-b', 'topic');
    commit(clone, 'x');
    const state = await inspectOrigin('topic', clone);
    expect(state.branchOnOrigin).toBe(false);
    expect(state.unpushed).toBe(2);
  });

  posixOnly('inspectOrigin throws without an origin remote', async () => {
    git(clone, 'remote', 'remove', 'origin');
    await expect(inspectOrigin('main', clone)).rejects.toThrow('No origin remote');
  });

  posixOnly('refExistsOnOrigin and pushBranch', async () => {
    expect(await refExistsOnOrigin('main', clone)).toBe(true);
    expect(await refExistsOnOrigin('nope', clone)).toBe(false);
    git(clone, 'checkout', '-b', 'topic');
    commit(clone, 'x');
    await pushBranch('topic', clone);
    expect(await refExistsOnOrigin('topic', clone)).toBe(true);
  });

  posixOnly('refExistsOnOrigin finds tags and fully qualified refs', async () => {
    git(clone, 'tag', 'v1');
    git(clone, 'push', 'origin', 'v1');
    expect(await refExistsOnOrigin('v1', clone)).toBe(true);
    expect(await refExistsOnOrigin('refs/tags/v1', clone)).toBe(true);
    expect(await refExistsOnOrigin('refs/heads/main', clone)).toBe(true);
    expect(await refExistsOnOrigin('refs/heads/v1', clone)).toBe(false);
  });

  posixOnly('a file named like the branch does not confuse inspectOrigin', async () => {
    git(clone, 'checkout', '-b', 'topic');
    commit(clone, 'x');
    fs.writeFileSync(path.join(clone, 'topic'), 'file');
    const state = await inspectOrigin('topic', clone);
    expect(state.branchOnOrigin).toBe(false);
    expect(state.unpushed).toBe(2);
  });

  posixOnly('network git calls run non-interactively with a timeout-safe env', async () => {
    const fake = path.join(tmp, 'fakebin');
    const log = path.join(tmp, 'env.log');
    fs.mkdirSync(fake);
    fs.writeFileSync(
      path.join(fake, 'git'),
      `#!/bin/sh\nif [ "$1" = remote ]; then echo ssh://git@example.com/r.git; exit 0; fi\n` +
        `case "$1" in fetch|ls-remote|push) echo "$1 $GIT_TERMINAL_PROMPT [$GIT_ASKPASS] [$SSH_ASKPASS] $GIT_SSH_COMMAND" >> ${log};; esac\nexit 1\n`,
      { mode: 0o755 }
    );
    const saved = { PATH: process.env.PATH, ssh: process.env.GIT_SSH_COMMAND, ask: process.env.GIT_ASKPASS };
    process.env.PATH = `${fake}${path.delimiter}${saved.PATH}`;
    delete process.env.GIT_SSH_COMMAND;
    process.env.GIT_ASKPASS = '/some/askpass';
    try {
      await inspectOrigin('main', clone);
      await refExistsOnOrigin('main', clone).catch(() => undefined);
      await pushBranch('main', clone).catch(() => undefined);
      process.env.GIT_SSH_COMMAND = 'ssh -i key';
      await pushBranch('main', clone).catch(() => undefined);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.ssh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = saved.ssh;
      if (saved.ask === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = saved.ask;
    }
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toEqual([
      'fetch 0 [] [] ssh -o BatchMode=yes',
      'ls-remote 0 [] [] ssh -o BatchMode=yes',
      'push 0 [] [] ssh -o BatchMode=yes',
      'push 0 [] [] ssh -i key',
    ]);
  });

  posixOnly('refExistsOnOrigin throws when origin is unreachable', async () => {
    git(clone, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    await expect(refExistsOnOrigin('main', clone)).rejects.toThrow();
  });

  posixOnly('hostGitIdentity reads user.name and user.email', async () => {
    git(clone, 'config', 'user.name', 'Ada');
    git(clone, 'config', 'user.email', 'ada@example.com');
    expect(await hostGitIdentity(clone)).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });
});

describe('inspectOrigin url parsing', () => {
  let dir: string;
  const savedSsh = process.env.GIT_SSH_COMMAND;
  beforeEach(() => {
    process.env.GIT_SSH_COMMAND = 'false'; // the fetch must fail fast, not reach the network
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-seed-url-'));
    git(dir, 'init', '-b', 'main');
  });
  afterEach(() => {
    if (savedSsh === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = savedSsh;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, string, boolean]> = [
    ['git@github.com:me/r.git', 'github.com', true],
    ['ssh://git@example.com:2222/me/r.git', 'example.com', true],
    ['https://user@127.0.0.1:9/me/r.git', '127.0.0.1', false],
  ];
  posixOnly('never returns the credentials in the remote URL', async () => {
    git(dir, 'remote', 'add', 'origin', 'https://user:s3cret@127.0.0.1:9/me/r.git');
    const state = await inspectOrigin('main', dir);
    expect(state.originUrl).toBe('https://127.0.0.1:9/me/r.git');
    expect(state.credentialHost).toBe('127.0.0.1:9');
    expect(JSON.stringify(state)).not.toContain('s3cret');
  });

  for (const [url, host, ssh] of cases) {
    posixOnly(`parses ${url}`, async () => {
      git(dir, 'remote', 'add', 'origin', url);
      const state = await inspectOrigin('main', dir);
      expect(state.originHost).toBe(host);
      expect(state.isSsh).toBe(ssh);
      expect(state.branchOnOrigin).toBe(false);
      expect(state.unpushed).toBe(0);
    });
  }
});

describe('stripUserinfo and parseOrigin', () => {
  it('drops credentials from URL origins, keeping an ssh user name', () => {
    expect(stripUserinfo('https://user:tok@en@github.com/me/r.git')).toBe('https://github.com/me/r.git');
    expect(stripUserinfo('https://x-access-token@github.com/me/r.git')).toBe('https://github.com/me/r.git');
    expect(stripUserinfo('ssh://git:pw@example.com:2222/me/r.git')).toBe('ssh://git@example.com:2222/me/r.git');
    expect(stripUserinfo('git@github.com:me/r.git')).toBe('git@github.com:me/r.git');
    expect(stripUserinfo('https://github.com/me/r.git')).toBe('https://github.com/me/r.git');
  });

  it('gives the credential host with a non-default port, the firewall host without', () => {
    expect(parseOrigin('https://host:8443/x.git')).toEqual({ host: 'host', credentialHost: 'host:8443', isSsh: false });
    expect(parseOrigin('https://host/x.git')).toEqual({ host: 'host', credentialHost: 'host', isSsh: false });
    expect(parseOrigin('https://host:443/x.git')).toEqual({ host: 'host', credentialHost: 'host', isSsh: false });
    expect(parseOrigin('git@host:x.git')).toEqual({ host: 'host', credentialHost: 'host', isSsh: true });
  });
});

describe('originPort', () => {
  it('uses the URL port, else the scheme default, else 0', () => {
    expect(originPort('git://host.docker.internal:52337/r.git')).toBe(52337);
    expect(originPort('https://example.com:8443/r.git')).toBe(8443);
    expect(originPort('https://github.com/me/r.git')).toBe(443);
    expect(originPort('http://example.com/r.git')).toBe(80);
    expect(originPort('git://example.com/r.git')).toBe(9418);
    expect(originPort('ssh://git@example.com:2222/me/r.git')).toBe(2222);
    expect(originPort('ssh://git@example.com/me/r.git')).toBe(22);
    expect(originPort('git@github.com:me/r.git')).toBe(22);
    expect(originPort('/srv/r.git')).toBe(0);
    expect(originPort('file:///srv/r.git')).toBe(0);
  });
});

describe('seedScript', () => {
  const base: SeedInput = {
    originUrl: 'git@github.com:me/r.git',
    originHost: 'github.com',
    branch: 'feat',
    create: false,
    userName: 'Ada',
    userEmail: 'ada@example.com',
    hasToken: false,
  };

  it('quotes the branch', () => {
    const s = seedScript({ ...base, branch: 'x$(id)' });
    expect(s).toContain("'x$(id)'");
    // every occurrence sits inside single quotes
    expect(s.replace(/'[^']*'/g, '')).not.toContain('x$(id)');
  });

  it('uses switch -c with --no-track for create', () => {
    const s = seedScript({ ...base, create: true, base: 'main' });
    expect(s).toContain("git fetch origin 'main'");
    expect(s).toContain("git switch -c 'feat' --no-track 'origin/main'");
    expect(s).toContain("git show-ref -q --verify 'refs/heads/feat'");
    // never a bare switch that could pick up a remote-tracking ref
    expect(s).not.toMatch(/git switch 'feat' 2>/);
  });

  it('switches to an existing branch otherwise', () => {
    const s = seedScript(base);
    expect(s).toContain("git fetch origin '+refs/heads/feat:refs/remotes/origin/feat'");
    expect(s).toContain("git switch 'feat'");
    expect(s).not.toContain('--no-track');
  });

  it('every seed path ends with the remote-tracking ref of the branch', () => {
    const ref = "'refs/remotes/origin/feat'";
    // clone from origin, and a snapshot copy: fetched into the ref
    for (const input of [base, { ...base, seedFrom: '/opt/kunj/seed' }]) {
      const s = seedScript(input);
      expect(s).toContain("git fetch origin '+refs/heads/feat:refs/remotes/origin/feat'");
      expect(s.indexOf('git fetch origin')).toBeLessThan(s.indexOf('git switch'));
    }
    // a bundle: no fetch, so the ref is made from the checked-out head when the clone lacks it
    const b = seedScript({ ...base, bundlePath: '/tmp/o.bundle' });
    expect(b).not.toContain('git fetch');
    expect(b).toContain(`git rev-parse -q --verify ${ref} >/dev/null || git update-ref ${ref} HEAD`);
    expect(b.indexOf('git switch')).toBeLessThan(b.indexOf('git update-ref'));
  });

  it('a snapshot copy drops stale remote-tracking refs before checkout (all but the base)', () => {
    const drop = (s: string) => s.split('\n').find(l => l.includes('for-each-ref'))!;
    const existing = seedScript({ ...base, seedFrom: '/opt/kunj/seed' });
    expect(drop(existing)).toContain('if [ -f .kunj-fresh ]');
    expect(drop(existing)).toContain("grep -vxF ''");
    expect(drop(existing)).toContain('update-ref --no-deref -d');
    expect(existing.indexOf('for-each-ref')).toBeLessThan(existing.indexOf('git fetch origin'));
    const created = seedScript({ ...base, create: true, base: 'main', seedFrom: '/opt/kunj/seed' });
    expect(drop(created)).toContain("grep -vxF 'refs/remotes/origin/main'");
    expect(created.indexOf('for-each-ref')).toBeLessThan(created.indexOf('git switch'));
    // other paths have nothing stale to drop
    expect(seedScript(base)).not.toContain('for-each-ref');
    expect(seedScript({ ...base, bundlePath: '/tmp/o.bundle' })).not.toContain('for-each-ref');
  });

  it('configures insteadOf only with a token', () => {
    const without = seedScript(base);
    expect(without).not.toContain('insteadOf');
    expect(without).not.toContain('credential.helper');
    const withToken = seedScript({ ...base, hasToken: true, credentialHelper: '/home/node/.kunj/bin/git-credential-kunj' });
    expect(withToken).toContain("credential.helper '/home/node/.kunj/bin/git-credential-kunj'");
    expect(() => seedScript({ ...base, hasToken: true })).toThrow(/credential helper/);
    expect(withToken).toContain("'url.https://github.com/.insteadOf' 'git@github.com:'");
    expect(withToken).toContain("'url.https://github.com/.insteadOf' 'ssh://git@github.com/'");
    expect(withToken).not.toContain('KUNJ_CREDENTIAL_HOST');
  });

  it('refuses an origin without a host', () => {
    expect(() => seedScript({ ...base, originUrl: '/srv/r.git', originHost: '' })).toThrow(
      'Origin has no host; a container can only clone from a remote origin'
    );
  });

  it('skips empty identity, guards the clone and marks the seed', () => {
    const s = seedScript({ ...base, userName: '', userEmail: '' });
    expect(s).not.toContain('user.name');
    expect(s.startsWith('set -e\n')).toBe(true);
    expect(s).toContain('push.autoSetupRemote true');
    expect(s).toContain('if [ ! -d /workspace/.git ]; then git clone --recurse-submodules');
    expect(s).toContain(`touch ${SEED_MARKER}`);
    expect(s).toContain(SEED_MARKER_EXCLUDE);
  });

  it('seedFrom copies the seed, resets origin and still switches', () => {
    const s = seedScript({ ...base, seedFrom: '/opt/kunj/seed' });
    expect(s).toContain('if [ ! -d /workspace/.git ] || [ -f /workspace/.kunj-copying ]; then');
    expect(s).toContain("cp -a '/opt/kunj/seed/.' /workspace/");
    expect(s).not.toContain('git clone');
    expect(s).toContain("git remote set-url origin 'git@github.com:me/r.git'");
    expect(s.indexOf('set-url')).toBeLessThan(s.indexOf('git fetch'));
    // The seed's own copy of the branch is moved to origin's
    expect(s).toContain("if [ -f .kunj-fresh ]; then git switch -C 'feat' 'origin/feat'; else git switch 'feat'; fi");
    expect(s).toContain('echo .kunj-copying >> .git/info/exclude');
    expect(s).toContain(`touch ${SEED_MARKER}`);
    // Without a seed nothing changes
    expect(seedScript(base)).toContain("git switch 'feat'\n");
  });

  posixOnly('seedFrom resets origin', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-seed-from-'));
    try {
      const origin = path.join(tmp, 'origin.git');
      const seedDir = path.join(tmp, 'seed');
      git(tmp, 'init', '--bare', '-b', 'main', origin);
      git(tmp, 'clone', origin, seedDir);
      git(seedDir, 'checkout', '-b', 'main');
      commit(seedDir, 'a');
      git(seedDir, 'push', 'origin', 'main');
      fs.writeFileSync(path.join(seedDir, 'installed'), 'deps');
      // The snapshot's workspace had been seeded itself
      fs.writeFileSync(path.join(seedDir, '.kunj-seeded'), '');
      // The snapshot was taken with another URL for the same repository
      git(seedDir, 'remote', 'set-url', 'origin', 'https://elsewhere.invalid/r.git');
      // ...and origin moved on after the snapshot
      const other = path.join(tmp, 'other');
      git(tmp, 'clone', origin, other);
      commit(other, 'b');
      git(other, 'push', 'origin', 'main');
      const originHead = git(origin, 'rev-parse', 'main');

      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      const env = { ...ENV, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
      const run = (ws: string, input: Partial<SeedInput>) => {
        const script = seedScript({ ...base, originUrl: origin, seedFrom: seedDir, ...input }).split('/workspace').join(ws);
        for (let i = 0; i < 2; i++) {
          const r = spawnSync('sh', ['-c', script], { env, encoding: 'utf8' });
          expect(r.stderr).not.toMatch(/fatal/);
          expect(r.status).toBe(0);
        }
      };

      // A new branch from main, over what a copy cut short left behind
      const ws = path.join(tmp, 'ws');
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'partial'), '');
      fs.writeFileSync(path.join(ws, '.kunj-copying'), '');
      run(ws, { create: true, base: 'main', branch: 'new' });
      expect(git(ws, 'remote', 'get-url', 'origin')).toBe(origin);
      expect(git(ws, 'branch', '--show-current')).toBe('new');
      expect(git(ws, 'rev-parse', 'HEAD')).toBe(originHead);
      expect(fs.readFileSync(path.join(ws, 'installed'), 'utf8')).toBe('deps');
      expect(fs.existsSync(path.join(ws, 'partial'))).toBe(false);
      expect(fs.existsSync(path.join(ws, '.kunj-copying'))).toBe(false);
      expect(fs.existsSync(path.join(ws, '.kunj-fresh'))).toBe(false);
      // Only the fixture's untracked file: the marker and sentinels are excluded
      expect(git(ws, 'status', '--porcelain')).toBe('?? installed');
      expect(fs.existsSync(path.join(ws, '.kunj-seeded'))).toBe(true);

      // The default branch itself, which the seed already has at the snapshot's commit
      const ws2 = path.join(tmp, 'ws2');
      fs.mkdirSync(ws2);
      run(ws2, { create: false, branch: 'main' });
      expect(git(ws2, 'branch', '--show-current')).toBe('main');
      expect(git(ws2, 'rev-parse', 'HEAD')).toBe(originHead);
      expect(git(ws2, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
      expect(git(ws2, 'remote', 'get-url', 'origin')).toBe(origin);

      // A checkout without the marker (git clean -x removed it) is the user's: never wiped or reset
      const ws3 = path.join(tmp, 'ws3');
      git(tmp, 'clone', '-q', origin, ws3);
      git(ws3, 'reset', '-q', '--hard', 'HEAD~1');
      commit(ws3, 'local');
      const local = git(ws3, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(ws3, 'a'), 'edited');
      fs.writeFileSync(path.join(ws3, 'untracked'), 'mine');
      run(ws3, { create: false, branch: 'main' });
      expect(git(ws3, 'rev-parse', 'HEAD')).toBe(local);
      expect(fs.readFileSync(path.join(ws3, 'a'), 'utf8')).toBe('edited');
      expect(fs.readFileSync(path.join(ws3, 'untracked'), 'utf8')).toBe('mine');
      expect(fs.existsSync(path.join(ws3, 'installed'))).toBe(false);
      expect(fs.existsSync(path.join(ws3, '.kunj-seeded'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('checks out LFS pointers from a bundle or a snapshot copy, and the copy pulls the content', () => {
    const fromBundle = seedScript({ ...base, branch: 'main', bundlePath: '/b' });
    expect(fromBundle).toContain('export GIT_LFS_SKIP_SMUDGE=1');
    expect(fromBundle).not.toContain('git lfs pull');
    const fromSnapshot = seedScript({ ...base, seedFrom: '/opt/kunj/seed' });
    expect(fromSnapshot.indexOf('export GIT_LFS_SKIP_SMUDGE=1')).toBeLessThan(fromSnapshot.indexOf('git switch'));
    expect(fromSnapshot).toContain('GIT_LFS_SKIP_SMUDGE=0 git lfs pull ||');
    expect(seedScript(base)).not.toContain('GIT_LFS_SKIP_SMUDGE');
  });

  it('bundlePath clones the bundle without fetching and refuses create', () => {
    const s = seedScript({ ...base, branch: 'main', bundlePath: '/tmp/kunj-origin.bundle' });
    expect(s).toContain("if [ ! -d /workspace/.git ]; then git clone --no-checkout -b 'main' '/tmp/kunj-origin.bundle' /workspace; fi");
    expect(s).toContain("git remote set-url origin 'git@github.com:me/r.git'");
    expect(s).not.toContain('git fetch');
    expect(s).not.toContain('credential.helper');
    expect(() => seedScript({ ...base, create: true, base: 'main', bundlePath: '/b' })).toThrow('existing branch');
    // A snapshot seed wins over a bundle
    expect(seedScript({ ...base, seedFrom: '/opt/kunj/seed', bundlePath: '/b' })).not.toContain("'/b'");
  });

  posixOnly('seedScript with bundlePath clones from the bundle, sets origin and switches', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-seed-bundle-'));
    try {
      const origin = path.join(tmp, 'origin.git');
      const src = path.join(tmp, 'src');
      git(tmp, 'init', '--bare', '-b', 'main', origin);
      git(tmp, 'clone', origin, src);
      git(src, 'checkout', '-b', 'main');
      commit(src, 'a');
      git(src, 'push', 'origin', 'main');
      const bundle = path.join(tmp, 'origin.bundle');
      git(origin, 'bundle', 'create', bundle, 'refs/heads/main');
      const originHead = git(origin, 'rev-parse', 'main');

      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      const ws = path.join(tmp, 'ws');
      // Unreachable: the clone and switch must not touch the network
      const originUrl = 'https://unreachable.invalid/me/r.git';
      const script = seedScript({ ...base, originUrl, originHost: 'unreachable.invalid', branch: 'main', bundlePath: bundle })
        .split('/workspace')
        .join(ws);
      const env = { ...ENV, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
      for (let i = 0; i < 2; i++) {
        const r = spawnSync('sh', ['-c', script], { env, encoding: 'utf8' });
        expect(r.stderr).not.toMatch(/fatal/);
        expect(r.status).toBe(0);
      }
      expect(git(ws, 'remote', 'get-url', 'origin')).toBe(originUrl);
      expect(git(ws, 'branch', '--show-current')).toBe('main');
      expect(git(ws, 'rev-parse', 'HEAD')).toBe(originHead);
      expect(git(ws, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
      expect(fs.readFileSync(path.join(ws, 'a'), 'utf8')).toBe('a');
      expect(git(ws, 'status', '--porcelain')).toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  posixOnly('runs end to end against a local origin and is re-runnable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-seed-run-'));
    try {
      const origin = path.join(tmp, 'origin.git');
      const src = path.join(tmp, 'src');
      git(tmp, 'init', '--bare', '-b', 'main', origin);
      git(tmp, 'clone', origin, src);
      git(src, 'checkout', '-b', 'main');
      commit(src, 'a');
      git(src, 'push', 'origin', 'main');
      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      // /workspace is hard-coded; rewrite it to a temp dir to exercise the script
      const ws = path.join(tmp, 'ws');
      const script = seedScript({ ...base, originUrl: origin, create: true, base: 'main', branch: 'new' })
        .split('/workspace').join(ws);
      const env = { ...ENV, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
      for (let i = 0; i < 2; i++) {
        const r = spawnSync('sh', ['-c', script], { env, encoding: 'utf8' });
        expect(r.status).toBe(0);
      }
      expect(git(ws, 'branch', '--show-current')).toBe('new');
      expect(fs.existsSync(path.join(ws, '.kunj-seeded'))).toBe(true);
      expect(git(ws, 'status', '--porcelain')).toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('git-credential-kunj', () => {
  const helper = path.resolve(__dirname, '../../../container/sandbox/git-credential-kunj');
  function ask(host: string): string {
    const r = spawnSync('sh', [helper, 'get'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, GH_TOKEN: 't', KUNJ_CREDENTIAL_HOST: 'github.com' },
      encoding: 'utf8',
    });
    return r.stdout;
  }

  posixOnly('answers only for KUNJ_CREDENTIAL_HOST', () => {
    expect(ask('github.com')).toContain('password=t');
    expect(ask('evil.example')).not.toContain('password=');
  });
});
