// The functional suite's harness: the built CLI (dist/index.js) driven as a user would, in a
// throwaway repository with a throwaway origin and a throwaway HOME, against the real Docker daemon.
//
// Each test file gets one Fixture (useFixture): a bare origin served by `git daemon`, a clone of it
// whose origin URL is the one containers use (git://host.docker.internal:<port>/<repo>.git), and a
// HOME of its own, so ~/.kunj, ~/.gitconfig and the forward/bridge registries are the fixture's. The
// host reaches origin through the core.gitProxy in that HOME's git config. After each test, reset()
// stops what the test started and removes every Docker object labelled with the fixture's repo id.
//
// Opt-in only: run with `npm run test:functional` (KUNJ_FUNCTIONAL=1). See global-setup.js.
import { describe, beforeAll, afterEach, afterAll } from '@jest/globals';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerNames, LABEL, containerNames, repoIdFromUrl } from '../../src/lib/container/names';
import { GIT_ENV, containerOriginUrl, docker, git, startGitDaemon, waitFor, writeGitProxy } from '../../src/lib/container/__tests__/git-origin';
import type { StartResult } from '../../src/lib/container/lifecycle';
import type { PrunePlan } from '../../src/lib/container/prune';

export { canConnect, docker, freePort, git, waitFor } from '../../src/lib/container/__tests__/git-origin';

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const CLI = path.join(REPO_ROOT, 'dist', 'index.js');
/** The sandbox image's user. */
export const USER = 'dev';

/** Set by `npm run test:functional`; global-setup.js sets KUNJ_FUNCTIONAL_SKIP when Docker is unreachable. */
export const functionalEnabled = process.env.KUNJ_FUNCTIONAL === '1' && !process.env.KUNJ_FUNCTIONAL_SKIP;
/** describe, or describe.skip unless the suite was asked for and Docker is up. */
export const describeFunctional = functionalEnabled ? describe : describe.skip;

/** `kunj ct start --json` */
export type StartJson = StartResult & { branch: string };
/** `kunj ct prune --json` */
export interface PruneJson {
  success: boolean;
  dryRun: boolean;
  plan: PrunePlan;
  removed: string[];
  failed: string[];
}
/** What `kunj ct ... --json` prints when it fails. */
export interface ErrorOut {
  error: { code: string; message: string };
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Added to (or, with undefined values, removed from) the fixture's environment */
  env?: NodeJS.ProcessEnv;
  input?: string;
  cwd?: string;
  timeoutMs?: number;
}

// Secrets and settings of the developer running the suite never reach the CLI under test
const SCRUBBED = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'TMUX', 'TMUX_PANE',
];

/** The command line that runs argv under a pseudo-terminal (`script`), for agent and attach. */
export function ptyCommand(argv: string[]): string[] {
  if (process.platform === 'darwin') return ['script', '-q', '/dev/null', ...argv];
  const quoted = argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return ['script', '-qfec', quoted, '/dev/null'];
}

export const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;

/** A process left running in the background (forward, mcp, agent), stopped by stop() or the fixture's reset(). */
export class Background {
  stdout = '';
  stderr = '';
  readonly exited: Promise<number | null>;

  constructor(readonly child: ChildProcess) {
    child.stdout?.on('data', d => (this.stdout += d.toString()));
    child.stderr?.on('data', d => (this.stderr += d.toString()));
    this.exited = new Promise(resolve => {
      if (child.exitCode !== null) resolve(child.exitCode);
      child.once('exit', code => resolve(code));
      child.once('error', () => resolve(null));
    });
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  /** The first stdout line (whole lines only) that matches. */
  async line(match: (line: string) => boolean, what: string, timeoutMs = 60_000): Promise<string> {
    let found: string | undefined;
    await waitFor(() => {
      found = this.stdout.split('\n').slice(0, -1).find(match);
      if (!found && this.child.exitCode !== null) {
        throw new Error(`exited (${this.child.exitCode}) before ${what}; stderr: ${this.stderr.slice(-2000)}`);
      }
      return !!found;
    }, what, timeoutMs);
    return found!;
  }

  /** stdout as one JSON document (outputJSON pretty-prints), once it is complete. */
  async json<T = any>(what: string, timeoutMs = 60_000): Promise<T> {
    let value: T | undefined;
    await waitFor(() => {
      try {
        value = JSON.parse(this.stdout) as T;
        return true;
      } catch {
        if (this.child.exitCode !== null) {
          throw new Error(`exited (${this.child.exitCode}) before ${what}; stdout: ${this.stdout} stderr: ${this.stderr.slice(-2000)}`);
        }
        return false;
      }
    }, what, timeoutMs);
    return value as T;
  }

  /** Every complete stdout line that parses as JSON. */
  jsonLines<T = any>(): T[] {
    return this.stdout
      .split('\n')
      .slice(0, -1)
      .flatMap(l => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  }

  /** SIGTERM to its process group, then SIGKILL if it has not gone after a few seconds. */
  async stop(): Promise<number | null> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      killGroup(this.pid, 'SIGTERM');
      const timer = setTimeout(() => killGroup(this.pid, 'SIGKILL'), 5000);
      await this.exited;
      clearTimeout(timer);
    }
    return this.child.exitCode;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface FixtureOptions {
  /** Files committed on main before anything else (path -> content) */
  files?: Record<string, string>;
}

export class Fixture {
  readonly tmp: string;
  readonly home: string;
  readonly bare: string;
  readonly clone: string;
  /** Scratch space for marker files, fake binaries and the like; emptied by reset() */
  readonly scratch: string;
  readonly repoName: string;
  originUrl = '';
  repoId = '';
  port = 0;
  private daemon?: ChildProcess;
  private background: Background[] = [];
  private gitEnv: NodeJS.ProcessEnv;

  private constructor(prefix: string) {
    this.tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-ft-')));
    this.repoName = `ft-${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    this.home = path.join(this.tmp, 'home');
    this.bare = path.join(this.tmp, 'origin', `${this.repoName}.git`);
    this.clone = path.join(this.tmp, this.repoName);
    this.scratch = path.join(this.tmp, 'scratch');
    fs.mkdirSync(this.home, { recursive: true });
    fs.mkdirSync(this.scratch, { recursive: true });
    fs.mkdirSync(path.dirname(this.bare), { recursive: true });
    this.gitEnv = { ...GIT_ENV, ...this.isolation() };
  }

  static async create(prefix: string, options: FixtureOptions = {}): Promise<Fixture> {
    const fx = new Fixture(prefix);
    try {
      await fx.init(options);
    } catch (err) {
      await fx.dispose();
      throw err;
    }
    return fx;
  }

  private async init(options: FixtureOptions): Promise<void> {
    // The throwaway HOME's git config: an identity and the proxy to the daemon on 127.0.0.1
    const proxy = writeGitProxy(path.join(this.tmp, 'git-proxy'));
    fs.writeFileSync(
      path.join(this.home, '.gitconfig'),
      `[user]\n\tname = kunj test\n\temail = test@kunj.invalid\n[core]\n\tgitProxy = ${proxy}\n[init]\n\tdefaultBranch = main\n`
    );

    git(['init', '-q', '--bare', '-b', 'main', this.bare], this.tmp, this.gitEnv);
    git(['config', 'daemon.receivepack', 'true'], this.bare, this.gitEnv);
    const seed = path.join(this.tmp, 'seed');
    git(['clone', '-q', this.bare, seed], this.tmp, this.gitEnv);
    fs.writeFileSync(path.join(seed, 'README.md'), `# ${this.repoName}\n`);
    for (const [file, content] of Object.entries(options.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), content);
    }
    git(['add', '.'], seed, this.gitEnv);
    git(['commit', '-qm', 'initial'], seed, this.gitEnv);
    git(['push', '-q', 'origin', 'HEAD:main'], seed, this.gitEnv);
    fs.rmSync(seed, { recursive: true, force: true });

    const started = await startGitDaemon(path.dirname(this.bare));
    this.port = started.port;
    this.daemon = started.daemon;
    this.originUrl = containerOriginUrl(this.port, this.repoName);
    this.repoId = repoIdFromUrl(this.originUrl);

    // The user's checkout: origin is the URL the containers use, reached from here through the proxy
    git(['clone', '-q', this.bare, this.clone], this.tmp, this.gitEnv);
    git(['remote', 'set-url', 'origin', this.originUrl], this.clone, this.gitEnv);
    git(['fetch', '-q', 'origin'], this.clone, this.gitEnv);
    this.writeConfig({});
  }

  /** What isolates the CLI and git from the developer's own setup. */
  private isolation(): NodeJS.ProcessEnv {
    return {
      HOME: this.home,
      XDG_CONFIG_HOME: path.join(this.home, '.config'),
      GIT_CONFIG_GLOBAL: path.join(this.home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      // The docker CLI keeps its contexts in ~/.docker: keep using the real one (never ~/.kunj)
      DOCKER_CONFIG: process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker'),
    };
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.isolation(), FORCE_COLOR: '0', NO_COLOR: '1' };
    for (const key of SCRUBBED) delete env[key];
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  /** git in the fixture's environment (its HOME, the proxy). */
  git(args: string[], cwd = this.clone): string {
    return git(args, cwd, this.gitEnv);
  }

  /**
   * The global kunj config (~/.kunj/config.json of the throwaway HOME). Every test starts from the
   * base: no env forwarded, no keep files; `container` is merged over it one level deep.
   */
  writeConfig(config: { container?: Record<string, unknown>; [key: string]: unknown }): void {
    const { container, ...rest } = config;
    const full = { ...rest, container: { env: [], keepFiles: false, ...(container ?? {}) } };
    fs.mkdirSync(path.join(this.home, '.kunj'), { recursive: true });
    fs.writeFileSync(path.join(this.home, '.kunj', 'config.json'), JSON.stringify(full, null, 2) + '\n');
  }

  /** Runs `node dist/index.js <args>` in the clone and waits for it. */
  kunj(args: string[], options: RunOptions = {}): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: options.cwd ?? this.clone,
        env: this.env(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => (stdout += d.toString()));
      child.stderr.on('data', d => (stderr += d.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 540_000);
      child.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', status => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
      child.stdin.end(options.input ?? '');
    });
  }

  /** kunj with --json that must succeed; its stdout parsed. */
  async kunjJson<T = any>(args: string[], options: RunOptions = {}): Promise<T> {
    const r = await this.kunj([...args, '--json'], options);
    if (r.status !== 0) {
      throw new Error(`kunj ${args.join(' ')} --json exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr.slice(-4000)}`);
    }
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new Error(`kunj ${args.join(' ')} --json printed no JSON: ${r.stdout}\nstderr: ${r.stderr.slice(-4000)}`);
    }
  }

  /** kunj with --json that must fail; its error object. */
  async kunjJsonError(args: string[], options: RunOptions = {}): Promise<ErrorOut['error']> {
    const r = await this.kunj([...args, '--json'], options);
    if (r.status === 0) throw new Error(`kunj ${args.join(' ')} --json succeeded: ${r.stdout}`);
    return (JSON.parse(r.stdout) as ErrorOut).error;
  }

  /** `kunj ct start -c <branch> --json`, which must succeed. */
  start(branch: string, extra: string[] = [], options: RunOptions = {}): Promise<StartJson> {
    return this.kunjJson<StartJson>(['ct', 'start', '-c', branch, ...extra], options);
  }

  /** `kunj ct exec <branch> -- <command...>` */
  exec(branch: string, command: string[], options: RunOptions = {}): Promise<CliResult> {
    return this.kunj(['ct', 'exec', branch, '--', ...command], options);
  }

  /** `kunj ct exec <branch> -- sh -c <script>` */
  sh(branch: string, script: string, options: RunOptions = {}): Promise<CliResult> {
    return this.exec(branch, ['sh', '-c', script], options);
  }

  /** Starts kunj in the background in its own process group (optionally under a pseudo-terminal). */
  spawn(args: string[], options: RunOptions & { pty?: boolean } = {}): Background {
    const argv = [process.execPath, CLI, ...args];
    const [cmd, ...rest] = options.pty ? ptyCommand(argv) : argv;
    const child = spawn(cmd, rest, {
      cwd: options.cwd ?? this.clone,
      env: this.env(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const bg = new Background(child);
    this.background.push(bg);
    return bg;
  }

  names(branch: string): ContainerNames {
    return containerNames(this.repoName, this.repoId, branch);
  }

  /** IDs of the containers, volumes and networks labelled with this repository (and branch). */
  labelled(branch?: string): { containers: string[]; volumes: string[]; networks: string[] } {
    const filters = ['--filter', `label=${LABEL.repo}=${this.repoId}`, ...(branch ? ['--filter', `label=${LABEL.branch}=${branch}`] : [])];
    const lines = (s: string) => s.split('\n').filter(Boolean);
    return {
      containers: lines(docker(['ps', '-aq', ...filters])),
      volumes: lines(docker(['volume', 'ls', '-q', ...filters])),
      networks: lines(docker(['network', 'ls', '-q', ...filters])),
    };
  }

  /** `docker inspect --format '{{json <path>}}' <name>` parsed. */
  inspect<T = any>(name: string, jsonPath: string): T {
    return JSON.parse(docker(['inspect', '--format', `{{json ${jsonPath}}}`, name])) as T;
  }

  /** Commits files on main in the clone and pushes them to origin. */
  commitToMain(files: Record<string, string>, message: string): void {
    this.git(['checkout', '-q', 'main']);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(this.clone, file)), { recursive: true });
      fs.writeFileSync(path.join(this.clone, file), content);
    }
    this.git(['add', '.']);
    this.git(['commit', '-qm', message]);
    this.git(['push', '-q', 'origin', 'HEAD:main']);
  }

  /** Deletes a branch on origin, as a merged pull request would. */
  deleteOnOrigin(branch: string): void {
    git(['update-ref', '-d', `refs/heads/${branch}`], this.bare, this.gitEnv);
  }

  /** origin's commit for a branch, or '' when it has none. */
  originHead(branch: string): string {
    try {
      return git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], this.bare, this.gitEnv);
    } catch {
      return '';
    }
  }

  private registry(file: string): Array<{ pid: number }> {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.home, '.kunj', file), 'utf8'));
      const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
      return records.filter((r: unknown): r is { pid: number } => typeof (r as { pid?: unknown })?.pid === 'number');
    } catch {
      return [];
    }
  }

  /** Live pids in the fixture's forward and bridge registries (detached forwarders and bridges). */
  registeredPids(): number[] {
    const pids = [...this.registry('container-forwards.json'), ...this.registry('container-bridges.json')].map(r => r.pid);
    return [...new Set(pids)].filter(p => p > 0 && pidAlive(p));
  }

  /** Raw records of ~/.kunj/container-forwards.json. */
  forwardRecords(): Array<{ pid: number; container: string; port: number; hostPort: number }> {
    return this.registry('container-forwards.json') as Array<{ pid: number; container: string; port: number; hostPort: number }>;
  }

  /**
   * Everything a test may have left: background kunj processes, detached forwarders and bridges,
   * every container, volume and network labelled with this repository, and its snapshot images.
   * Each step on its own, so one failure never leaks the rest. The config goes back to the base.
   */
  async reset(): Promise<void> {
    const attempt = async (what: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        process.stderr.write(`functional cleanup: ${what} failed: ${(err as Error).message}\n`);
      }
    };
    await attempt('stopping background processes', () => Promise.all(this.background.map(b => b.stop())));
    this.background = [];
    await attempt('stopping registered forwarders and bridges', async () => {
      for (const pid of this.registeredPids()) killGroup(pid, 'SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      for (const pid of this.registeredPids()) killGroup(pid, 'SIGKILL');
      for (const file of ['container-forwards.json', 'container-bridges.json']) {
        fs.rmSync(path.join(this.home, '.kunj', file), { force: true });
      }
    });
    if (this.repoId) {
      let left = { containers: [] as string[], volumes: [] as string[], networks: [] as string[] };
      await attempt('listing labelled objects', () => (left = this.labelled()));
      if (left.containers.length) await attempt('removing containers', () => docker(['rm', '-f', ...left.containers]));
      if (left.volumes.length) await attempt('removing volumes', () => docker(['volume', 'rm', '-f', ...left.volumes]));
      if (left.networks.length) await attempt('removing networks', () => docker(['network', 'rm', ...left.networks]));
      await attempt('removing snapshot images', () => {
        // -a: a snapshot rebuilt under the same tag leaves the old image dangling, which -q alone hides
        const images = docker(['images', '-aq', '--filter', `label=${LABEL.repo}=${this.repoId}`]).split('\n').filter(Boolean);
        if (images.length) docker(['rmi', '-f', ...new Set(images)]);
      });
    }
    await attempt('emptying the scratch directory', () => {
      fs.rmSync(this.scratch, { recursive: true, force: true });
      fs.mkdirSync(this.scratch, { recursive: true });
    });
    await attempt('restoring the config', () => this.writeConfig({}));
  }

  async dispose(): Promise<void> {
    await this.reset();
    try {
      this.daemon?.kill();
    } catch {
      // gone
    }
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

/**
 * One Fixture for the enclosing describe: created before its tests, reset after each test (even a
 * failed one) and disposed of after the last.
 */
export function useFixture(prefix: string, options: FixtureOptions = {}): { readonly fx: Fixture } {
  const holder: { fx?: Fixture } = {};
  beforeAll(async () => {
    holder.fx = await Fixture.create(prefix, options);
  });
  afterEach(async () => {
    await holder.fx?.reset();
  });
  afterAll(async () => {
    await holder.fx?.dispose();
  });
  return {
    get fx(): Fixture {
      if (!holder.fx) throw new Error('The functional fixture was not created (see the beforeAll error)');
      return holder.fx;
    },
  };
}

/** A tiny file the test writes and the CLI's hooks or fake binaries append to. */
export function readMarker(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
