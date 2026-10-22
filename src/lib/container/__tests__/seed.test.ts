import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  inspectOrigin,
  refExistsOnOrigin,
  pushBranch,
  hostGitIdentity,
  seedScript,
  SEED_MARKER,
  SEED_MARKER_EXCLUDE,
  SeedInput,
} from '../seed';

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
    expect(s).not.toMatch(/[^']x\$\(id\)[^']/);
  });

  it('uses switch -c with --no-track for create', () => {
    const s = seedScript({ ...base, create: true, base: 'main' });
    expect(s).toContain("git fetch origin 'main'");
    expect(s).toContain("git switch -c 'feat' --no-track 'origin/main'");
    expect(s).toContain("git switch 'feat' 2>/dev/null ||");
  });

  it('switches to an existing branch otherwise', () => {
    const s = seedScript(base);
    expect(s).toContain("git fetch origin 'feat'");
    expect(s).toContain("git switch 'feat'");
    expect(s).not.toContain('--no-track');
  });

  it('configures insteadOf only with a token', () => {
    const without = seedScript(base);
    expect(without).not.toContain('insteadOf');
    expect(without).not.toContain('credential.helper');
    const withToken = seedScript({ ...base, hasToken: true });
    expect(withToken).toContain('credential.helper /usr/local/bin/git-credential-kunj');
    expect(withToken).toContain("'url.https://github.com/.insteadOf' 'git@github.com:'");
    expect(withToken).not.toContain('KUNJ_CREDENTIAL_HOST');
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
