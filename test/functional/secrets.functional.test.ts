// The secret manager end to end through the built CLI: `kunj secret` writing the encrypted vault,
// `kunj run`, `kunj agent --no-tmux` and `worktree add` on the host, and `kunj ct start` delivering
// container secrets (env file and rendered files) without a value reaching argv, labels or JSON.
// Opt-in: npm run test:functional.
//
// Every call passes KUNJ_SECRETS_KEY, so the vault is a keychain-kdf file opened with a fixed key and
// the real Keychain is never asked. tmux sessions are not used: a session's command gets the tmux
// server's environment (the developer's HOME and Keychain), not the fixture's.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CLI, CliResult, describeFunctional, hasScript, ptyCommand, RunOptions, useFixture } from './harness';

const KEY = '5e'.repeat(32);

describeFunctional('kunj secret (functional): the vault and its deliveries', () => {
  const ctx = useFixture('secret', { files: { '.gitignore': '.env\nnode_modules/\n' } });

  const value = (name: string): string => `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}`;

  function kunj(args: string[], options: RunOptions = {}): Promise<CliResult> {
    return ctx.fx.kunj(args, { ...options, env: { KUNJ_SECRETS_KEY: KEY, ...options.env } });
  }

  async function set(name: string, secret: string, flags: string[] = []): Promise<void> {
    const r = await kunj(['secret', 'set', name, ...flags], { input: secret });
    expect(r.stderr).not.toContain(secret);
    expect(r.stdout).not.toContain(secret);
    expect(r.status).toBe(0);
  }

  function vaults(): string[] {
    const kunjDir = path.join(ctx.fx.home, '.kunj');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'secrets.enc') found.push(p);
      }
    };
    walk(kunjDir);
    return found;
  }

  beforeEach(() => {
    for (const v of vaults()) fs.rmSync(v);
  });

  describe('the vault', () => {
    it('stores values encrypted, 0600, and never prints them except from get', async () => {
      const db = value('DB_URL');
      const gh = value('GH_TOKEN');
      await set('DB_URL', db);
      await set('GH_TOKEN', gh, ['--global']);

      const files = vaults();
      expect(files).toHaveLength(2);
      for (const f of files) {
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
        const raw = fs.readFileSync(f, 'utf8');
        expect(raw).not.toContain(db);
        expect(raw).not.toContain(gh);
        expect(JSON.parse(raw)).toMatchObject({ version: 1, kdf: 'keychain' });
      }

      const list = await kunj(['secret', 'list', '--json']);
      expect(list.status).toBe(0);
      expect(list.stdout).not.toContain(db);
      expect(list.stdout).not.toContain(gh);
      const names = (JSON.parse(list.stdout).secrets as Array<{ name: string; scope: string }>).map(s => `${s.scope}:${s.name}`);
      expect(names.sort()).toEqual(['global:GH_TOKEN', 'repo:DB_URL']);

      const get = await kunj(['secret', 'get', 'DB_URL']);
      expect(get.stdout).toBe(`${db}\n`);
      const getJson = await kunj(['secret', 'get', 'DB_URL', '--json']);
      expect(getJson.status).not.toBe(0);
      expect(getJson.stdout + getJson.stderr).not.toContain(db);
    });

    it('a wrong key is secrets-locked and leaves the vault as it was', async () => {
      await set('DB_URL', value('DB_URL'));
      const [file] = vaults();
      const before = fs.readFileSync(file);
      const r = await kunj(['secret', 'set', 'OTHER'], { input: 'x', env: { KUNJ_SECRETS_KEY: '11'.repeat(32) } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/does not decrypt|secrets-corrupt|locked/i);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
    });

    it('outside a repository only --global is accepted', async () => {
      const outside = path.join(ctx.fx.scratch, 'not-a-repo');
      fs.mkdirSync(outside, { recursive: true });
      const r = await kunj(['secret', 'set', 'DB_URL', '--branch', 'feature'], { input: 'x', cwd: outside });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not in a git repository/i);
      expect(vaults()).toEqual([]);
    });
  });

  describe('host', () => {
    it('kunj run gets host secrets, the branch one over the repo one, and not container-only ones', async () => {
      const repo = value('API');
      const branch = value('API');
      const containerOnly = value('CT');
      await set('API', repo);
      await set('API', branch, ['--branch', 'main']);
      await set('CT_ONLY', containerOnly, ['--targets', 'container']);

      const r = await kunj(['run', '--', 'sh', '-c', 'printf "%s|%s" "$API" "${CT_ONLY-unset}"']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${branch}|unset`);
      const other = await kunj(['run', '--branch', 'feature', '--', 'sh', '-c', 'printf %s "$API"']);
      expect(other.stdout).toBe(repo);
      // the exit code is the command's
      expect((await kunj(['run', '--', 'sh', '-c', 'exit 5'])).status).toBe(5);
    });

    (hasScript ? it : it.skip)('kunj agent without tmux runs the agent with the host secrets', async () => {
      const token = value('TOKEN');
      await set('AGENT_TOKEN', token, ['--targets', 'host']);
      const marker = path.join(ctx.fx.scratch, 'agent-env');
      // kunj agent attaches, so it needs a terminal: `script`, whose stdin must not be a socket (macOS
      // script fails tcgetattr on one), so not fx.spawn's pipe
      const argv = ptyCommand([process.execPath, CLI, 'agent', 'main', '--no-tmux', '--command', `printf %s "$AGENT_TOKEN" > '${marker}'`]);
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd: ctx.fx.clone,
        env: ctx.fx.env({ KUNJ_SECRETS_KEY: KEY, SHELL: '/bin/sh' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(fs.readFileSync(marker, 'utf8')).toBe(token);
    });

    it('worktree add renders file deliveries into the new worktree, 0600, and refuses a file git does not ignore', async () => {
      const db = value('DB');
      await set('DB_URL', db, ['--file', '.env']);
      const added = await kunj(['worktree', 'add', 'ft-secret-wt', '-c', '--json', '--no-hooks']);
      expect(added.status).toBe(0);
      expect(added.stdout).not.toContain(db);
      const wt = JSON.parse(added.stdout).worktree.path as string;
      expect(JSON.parse(added.stdout).secretFiles).toEqual([".env"]);
      const env = path.join(wt, '.env');
      expect(fs.readFileSync(env, 'utf8')).toContain(`DB_URL="${db}"`);
      expect(fs.statSync(env).mode & 0o777).toBe(0o600);
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8', env: ctx.fx.env() })).toBe('');

      await set('TRACKED', 'x', ['--file', 'config/app.conf']);
      const apply = await kunj(['secret', 'apply'], { cwd: wt });
      expect(apply.status).not.toBe(0);
      expect(apply.stderr).toMatch(/not ignored|not-ignored|ignore/i);
      expect(fs.existsSync(path.join(wt, 'config', 'app.conf'))).toBe(false);
    });
  });

  describe('containers', () => {
    it('ct start delivers container secrets by env file and rendered file, never in argv, labels or JSON', async () => {
      const { fx } = ctx;
      const branch = 'ft-secret-ct';
      const db = value('DB');
      const file = value('FILE');
      const hostOnly = value('HOST');
      const global = value('GLOBAL');
      await set('DB_URL', db, ['--targets', 'container']);
      await set('APP_KEY', file, ['--targets', 'container', '--no-env', '--file', 'config/app.env']);
      await set('HOST_ONLY', hostOnly, ['--targets', 'host']);
      await set('GLOBAL_KEY', global, ['--global', '--targets', 'container']);

      // A docker on PATH that records every command line kunj runs, then runs the real one
      const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
      const bin = path.join(fx.scratch, 'bin');
      const log = path.join(fx.scratch, 'docker-argv.log');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realDocker}' "$@"\n`, { mode: 0o755 });
      const env = { KUNJ_SECRETS_KEY: KEY, PATH: `${bin}:${process.env.PATH}` };

      const started = await fx.start(branch, [], { env });
      expect(JSON.stringify(started)).not.toContain(db);

      const seen = await fx.sh(branch, 'printf "%s|%s|%s|%s" "$DB_URL" "$GLOBAL_KEY" "${HOST_ONLY-unset}" "${APP_KEY-unset}"', { env });
      expect(seen.stdout).toBe(`${db}|${global}|unset|unset`);

      const rendered = await fx.sh(branch, 'cat config/app.env; stat -c "%a %U" config/app.env; git status --porcelain; cat .git/info/exclude', { env });
      expect(rendered.stdout).toContain(`APP_KEY="${file}"`);
      expect(rendered.stdout).toContain('600 dev');
      expect(rendered.stdout).toContain('/config/app.env');
      expect(rendered.stdout).not.toMatch(/^\?\? /m);

      for (const name of [started.names.container, started.names.helper]) {
        const labels = JSON.stringify(fx.inspect(name, '.Config.Labels'));
        for (const v of [db, file, global, hostOnly]) expect(labels).not.toContain(v);
      }
      expect(JSON.stringify(fx.inspect(started.names.helper, '.Config.Env'))).not.toContain(db);
      const argv = fs.readFileSync(log, 'utf8');
      for (const v of [db, file, global, hostOnly]) expect(argv).not.toContain(v);

      // secretsChanged follows the vault without unlocking it
      const list = async (): Promise<any> => {
        const r = await fx.kunj(['ct', 'list', '--json'], { env: { PATH: env.PATH } });
        return (JSON.parse(r.stdout).containers as any[]).find(c => c.branch === branch);
      };
      expect((await list()).secretsChanged).toBe(false);
      await set('DB_URL', value('DB'), ['--targets', 'container']);
      expect((await list()).secretsChanged).toBe(true);
    });
  });
});
