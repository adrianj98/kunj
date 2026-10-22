import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BuildOptions,
  ContainerBackend,
  ContainerInfo,
  ContainerSpec,
  ExecIO,
  ExecTimeoutError,
  Labels,
} from './backend';

// The only module in kunj that spawns `docker`. Every call is an argv array (never a shell),
// so names, labels and commands cannot be reinterpreted.

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

// ============================================================================
// Pure helpers
// ============================================================================

// Sorted so the argv is stable for a given label set
function labelArgs(labels: Labels): string[] {
  return Object.keys(labels).sort().flatMap(k => ['--label', `${k}=${labels[k]}`]);
}

/** `docker run` arguments for a spec; env goes through `envFile` so no value lands in argv. */
export function runArgs(spec: ContainerSpec, envFile: string): string[] {
  const args = ['run', '-d', '--name', spec.name];
  if (spec.init !== false) args.push('--init');
  args.push(...labelArgs(spec.labels));
  args.push('--env-file', envFile);
  // A helper shares the main container's network namespace instead of joining the network
  args.push('--network', spec.networkOf ? `container:${spec.networkOf}` : spec.network);
  if (spec.user) args.push('--user', spec.user);
  args.push('--workdir', spec.workdir);
  for (const v of spec.volumes) args.push('-v', `${v.name}:${v.path}`);
  // Loopback only: a published port must not be reachable from the LAN
  for (const p of spec.publish) args.push('-p', `127.0.0.1:${p.host}:${p.container}`);
  if (spec.cpus) args.push('--cpus', spec.cpus);
  if (spec.memory) args.push('--memory', spec.memory);
  for (const cap of spec.capabilities ?? []) args.push('--cap-add', cap);
  if (spec.entrypoint?.length) args.push('--entrypoint', spec.entrypoint[0]);
  args.push(spec.image, ...(spec.entrypoint?.slice(1) ?? []), ...spec.command);
  return args;
}

function jsonLines(text: string): any[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

// ps prints labels as "k=v,k=v"; values containing commas are mangled, which is why
// list() takes labels from inspect instead
function parseLabelString(s: string | undefined): Labels {
  const labels: Labels = {};
  for (const pair of (s ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

/** Parse `docker ps --format '{{json .}}'` output (one object per line). */
export function parsePsJson(lines: string): ContainerInfo[] {
  return jsonLines(lines).map(o => ({
    id: o.ID,
    name: o.Names,
    state: o.State,
    image: o.Image,
    createdAt: o.CreatedAt,
    labels: parseLabelString(o.Labels),
    ports: [],
  }));
}

/** Parse `docker inspect --format '{{json .}}'` output (one object per line). */
export function parseInspect(json: string): ContainerInfo[] {
  return jsonLines(json).map(o => {
    const ports: ContainerInfo['ports'] = [];
    for (const [key, bindings] of Object.entries<any>(o.NetworkSettings?.Ports ?? {})) {
      // null means exposed but not published
      for (const b of bindings ?? []) {
        const port = { container: parseInt(key, 10), host: parseInt(b.HostPort, 10) };
        // IPv4 and IPv6 bindings of one port are listed separately
        if (!ports.some(p => p.container === port.container && p.host === port.host)) ports.push(port);
      }
    }
    return {
      id: o.Id,
      name: String(o.Name ?? '').replace(/^\//, ''),
      state: o.State?.Status,
      image: o.Config?.Image,
      createdAt: o.Created,
      labels: o.Config?.Labels ?? {},
      ports,
    };
  });
}

function firstLine(out: Output): string {
  return out.stderr.trim().split('\n')[0] || `exit code ${out.code}`;
}

// BuildKit writes its progress to stderr, so the first line is "#0 building with ..." and the
// cause is the last "ERROR..." line
function buildErrorLine(out: Output): string {
  const lines = out.stderr.split('\n').map(l => l.trim()).filter(Boolean);
  return [...lines].reverse().find(l => l.startsWith('ERROR')) ?? lines[lines.length - 1] ?? `exit code ${out.code}`;
}

// Docker's own failures (container gone or stopped) exit 1 like the command could, so they are
// told apart by the daemon's message
const DOCKER_EXEC_ERROR = /^Error response from daemon:|^Error: No such container/;

// "docker volume rm" reads better in an error than "docker volume"
function subcommand(args: string[]): string {
  return ['volume', 'network', 'image'].includes(args[0]) ? `${args[0]} ${args[1]}` : args[0];
}

// ============================================================================
// Local docker CLI backend
// ============================================================================

export class LocalDockerBackend implements ContainerBackend {
  readonly features = { localPorts: true, editorAttach: true, dockerInDocker: [] as Array<'sysbox' | 'privileged'> };
  private readonly context?: string;
  private readonly dockerPath: string;

  constructor(options: { context?: string; dockerPath?: string } = {}) {
    this.context = options.context;
    this.dockerPath = options.dockerPath ?? 'docker';
  }

  private argv(args: string[]): string[] {
    return this.context ? ['--context', this.context, ...args] : args;
  }

  /** Run docker to completion. `echo` sends both output streams to our stderr (keeps --json stdout clean). */
  private spawnDocker(args: string[], opts: { input?: NodeJS.ReadableStream; echo?: boolean } = {}): Promise<Output> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.dockerPath, this.argv(args), { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout!.on('data', (d: Buffer) => (opts.echo ? process.stderr.write(d) : stdout.push(d)));
      child.stderr!.on('data', (d: Buffer) => {
        if (opts.echo) process.stderr.write(d);
        stderr.push(d);
      });
      if (opts.input) {
        // docker exiting early closes the pipe; the exit code reports the real failure
        child.stdin!.on('error', () => {});
        opts.input.on('error', err => {
          child.kill();
          reject(err);
        });
        opts.input.pipe(child.stdin!);
      }
      child.on('error', reject);
      child.on('close', (code: number | null) =>
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    });
  }

  private async checked(args: string[], opts: { input?: NodeJS.ReadableStream; echo?: boolean } = {}): Promise<Output> {
    const out = await this.spawnDocker(args, opts);
    if (out.code !== 0) {
      const line = args[0] === 'build' ? buildErrorLine(out) : firstLine(out);
      throw new Error(`docker ${subcommand(args)} failed: ${line}`);
    }
    return out;
  }

  async info(): Promise<{ serverVersion: string }> {
    let out: Output;
    try {
      out = await this.spawnDocker(['info', '--format', '{{.ServerVersion}}']);
    } catch (err) {
      throw new Error(`Docker is not available: ${(err as Error).message}`);
    }
    if (out.code !== 0) throw new Error(`Docker is not available: ${firstLine(out)}`);
    return { serverVersion: out.stdout.trim() };
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.spawnDocker(['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0;
  }

  async buildImage(tag: string, context: NodeJS.ReadableStream, opts: BuildOptions = {}): Promise<void> {
    const args = ['build', '-t', tag];
    if (opts.dockerfile) args.push('-f', opts.dockerfile);
    for (const [k, v] of Object.entries(opts.buildArgs ?? {})) args.push('--build-arg', `${k}=${v}`);
    args.push('-');
    await this.checked(args, { input: context, echo: true });
  }

  async createNetwork(name: string, labels: Labels): Promise<void> {
    await this.checked(['network', 'create', ...labelArgs(labels), name]);
  }

  async createVolume(name: string, labels: Labels): Promise<void> {
    await this.checked(['volume', 'create', ...labelArgs(labels), name]);
  }

  async run(spec: ContainerSpec): Promise<string> {
    for (const [k, v] of Object.entries(spec.env)) {
      // --env-file is line based, so a newline would split the value into another variable
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new Error(`Environment variable ${k} contains a newline`);
    }
    // A file rather than -e so secrets never appear in `ps` output
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-env-'));
    try {
      const file = path.join(dir, 'env');
      const lines = Object.entries(spec.env).map(([k, v]) => `${k}=${v}\n`).join('');
      fs.writeFileSync(file, lines, { mode: 0o600 });
      return (await this.checked(runArgs(spec, file))).stdout.trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Two subprocesses per listing whatever the number of containers: ps for the matching ids,
  // then one inspect for exact labels and published ports
  async list(filter: Labels): Promise<ContainerInfo[]> {
    const filters = Object.keys(filter).flatMap(k => ['--filter', `label=${k}=${filter[k]}`]);
    const ps = await this.checked(['ps', '-a', '--no-trunc', '--format', '{{json .}}', ...filters]);
    const ids = parsePsJson(ps.stdout).map(c => c.id);
    if (ids.length === 0) return [];
    return parseInspect((await this.checked(['inspect', '--format', '{{json .}}', ...ids])).stdout);
  }

  async inspectLabels(name: string): Promise<Labels | null> {
    const out = await this.spawnDocker(['inspect', '--format', '{{json .Config.Labels}}', name]);
    if (out.code !== 0) return null;
    return JSON.parse(out.stdout.trim() || 'null') ?? {};
  }

  exec(id: string, cmd: string[], io: ExecIO = {}): Promise<{ exitCode: number; stdout: string }> {
    const stdinStream = typeof io.stdin === 'object' ? io.stdin : undefined;
    const args = ['exec'];
    if (stdinStream || io.stdin === 'inherit') args.push('-i');
    if (io.tty) args.push('-t');
    if (io.user) args.push('-u', io.user);
    if (io.workdir) args.push('-w', io.workdir);
    for (const [k, v] of Object.entries(io.env ?? {})) args.push('-e', `${k}=${v}`);
    args.push(id, ...cmd);

    // 'inherit' hands docker our real fds, which a TTY session needs
    const stdio: Array<'inherit' | 'pipe' | 'ignore'> = [
      io.stdin === 'inherit' ? 'inherit' : stdinStream ? 'pipe' : 'ignore',
      io.stdout === 'inherit' ? 'inherit' : 'pipe',
      io.stderr === 'inherit' ? 'inherit' : 'pipe',
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(this.dockerPath, this.argv(args), { stdio });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stdinStream && child.stdin) stdinStream.unpipe(child.stdin);
        fn();
      };

      if (child.stdout) {
        if (io.stdout && io.stdout !== 'inherit') child.stdout.pipe(io.stdout, { end: false });
        else child.stdout.on('data', (d: Buffer) => stdout.push(d));
      }
      if (child.stderr) {
        if (io.stderr && io.stderr !== 'inherit') child.stderr.pipe(io.stderr, { end: false });
        else child.stderr.on('data', (d: Buffer) => stderr.push(d));
      }
      if (stdinStream && child.stdin) {
        child.stdin.on('error', () => {});
        stdinStream.pipe(child.stdin);
      }
      if (io.timeoutMs !== undefined) {
        const ms = io.timeoutMs;
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(() => reject(new ExecTimeoutError(`docker exec timed out after ${ms} ms`)));
        }, ms);
      }
      child.on('error', err =>
        finish(() => {
          const detail = Buffer.concat(stderr).toString().trim().split('\n')[0];
          reject(new Error(`docker exec failed to start: ${err.message}${detail ? ` (${detail})` : ''}`));
        }));
      // The command's own exit code is the result, not an error; 126/127 (not executable / not
      // found) are the command's too
      child.on('close', (code: number | null) =>
        finish(() => {
          const exitCode = code ?? 1;
          const first = Buffer.concat(stderr).toString().trim().split('\n')[0];
          if (!io.stderr && exitCode !== 0 && exitCode !== 126 && exitCode !== 127 && DOCKER_EXEC_ERROR.test(first)) {
            reject(new Error(`docker exec failed: ${first}`));
            return;
          }
          resolve({ exitCode, stdout: Buffer.concat(stdout).toString() });
        }));
    });
  }

  async copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void> {
    await this.checked(['cp', '-', `${id}:${dir}`], { input: tar });
  }

  async start(id: string): Promise<void> {
    await this.checked(['start', id]);
  }

  async stop(id: string): Promise<void> {
    await this.checked(['stop', id]);
  }

  // Idempotent: an object that is already gone is not a failure
  async remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void> {
    const steps: Array<[string[], string[] | undefined]> = [
      [['rm', '-f'], ids.containers],
      [['volume', 'rm'], ids.volumes],
      [['network', 'rm'], ids.networks],
    ];
    for (const [cmd, names] of steps) {
      if (!names || names.length === 0) continue;
      const args = [...cmd, ...names];
      const out = await this.spawnDocker(args);
      if (out.code === 0) continue;
      const lines = out.stderr.trim().split('\n').filter(Boolean);
      const allGone = lines.length > 0 && lines.every(l => /no such|not found/i.test(l));
      if (!allGone) throw new Error(`docker ${subcommand(args)} failed: ${firstLine(out)}`);
    }
  }
}
