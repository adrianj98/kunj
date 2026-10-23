import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BackendEvent,
  BuildOptions,
  ContainerBackend,
  ContainerInfo,
  ContainerSpec,
  EngineInfo,
  ExecIO,
  ExecTimeoutError,
  ImageInfo,
  Labels,
  LabelledObject,
  LogOptions,
  isImageRef,
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
  // The image is the first positional: anything starting with '-' would be taken as a flag
  if (!isImageRef(spec.image)) throw new Error(`Refusing to run "${spec.image}": not a valid image reference`);
  const args = ['run', '-d', '--name', spec.name];
  if (spec.init !== false) args.push('--init');
  args.push(...labelArgs(spec.labels));
  args.push('--env-file', envFile);
  // A helper shares the main container's network namespace instead of joining the network
  args.push('--network', spec.networkOf ? `container:${spec.networkOf}` : spec.network);
  for (const a of spec.aliases ?? []) args.push('--network-alias', a);
  for (const h of spec.extraHosts ?? []) args.push('--add-host', h);
  if (spec.user) args.push('--user', spec.user);
  if (spec.workdir) args.push('--workdir', spec.workdir);
  for (const v of spec.volumes) args.push('-v', `${v.name}:${v.path}`);
  // Loopback only: a published port must not be reachable from the LAN
  for (const p of spec.publish) args.push('-p', `127.0.0.1:${p.host}:${p.container}`);
  if (spec.cpus) args.push('--cpus', spec.cpus);
  if (spec.memory) args.push('--memory', spec.memory);
  // Drops first: Docker applies --cap-add on top of --cap-drop ALL
  for (const cap of spec.capDrop ?? []) args.push('--cap-drop', cap);
  for (const cap of spec.capabilities ?? []) args.push('--cap-add', cap);
  for (const opt of spec.securityOpt ?? []) args.push('--security-opt', opt);
  if (spec.runtime) args.push('--runtime', spec.runtime);
  if (spec.privileged) args.push('--privileged');
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

/** Parse `docker image ls --format '{{json .}}'` output; untagged images are skipped. */
export function parseImageLs(lines: string): Array<{ id: string; tag: string }> {
  return jsonLines(lines)
    .filter(o => o.Repository && o.Repository !== '<none>' && o.Tag && o.Tag !== '<none>')
    .map(o => ({ id: o.ID, tag: `${o.Repository}:${o.Tag}` }));
}

/** Parse `docker image inspect --format '{{json .}}'` output: one entry per tag of each image. */
export function parseImageInspect(json: string): ImageInfo[] {
  return jsonLines(json).flatMap(o =>
    ((o.RepoTags ?? []) as string[])
      .filter(t => t && !t.startsWith('<none>'))
      .map(tag => ({ tag, id: o.Id, createdAt: o.Created, labels: o.Config?.Labels ?? {}, size: o.Size ?? 0 })));
}

/** One line of `docker events --format '{{json .}}'`; null when it is not a container event. */
export function parseDockerEvent(line: string): BackendEvent | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const attributes = o?.Actor?.Attributes;
  if (typeof o?.Action !== 'string' || typeof attributes?.name !== 'string') return null;
  const labels: Labels = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (k.startsWith('kunj.') && typeof v === 'string') labels[k] = v;
  }
  const ms = typeof o.timeNano === 'number' ? Math.floor(o.timeNano / 1e6) : typeof o.time === 'number' ? o.time * 1000 : Date.now();
  return { action: o.Action, name: attributes.name, labels, at: new Date(ms).toISOString() };
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

interface SpawnOpts {
  input?: NodeJS.ReadableStream;
  echo?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// What `docker compose config` may see of our environment: enough to find the daemon, nothing a
// compose file could read into a service (COMPOSE_* would also change which files are read)
const COMPOSE_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

/**
 * `docker compose config` arguments: stdin as the file, an empty project directory (no .env), no
 * interpolation, and (when compose knows the flag) no env_file contents resolved into environment.
 */
export function composeConfigArgs(projectDir: string, noEnvResolution = true): string[] {
  return ['compose', '--project-directory', projectDir, '-p', 'kunj-import', '-f', '-', 'config', '--format', 'json', '--no-interpolate',
    ...(noEnvResolution ? ['--no-env-resolution'] : [])];
}

export class LocalDockerBackend implements ContainerBackend {
  readonly features = { localPorts: true, editorAttach: true, dockerInDocker: ['sysbox', 'privileged'] as Array<'sysbox' | 'privileged'> };
  private readonly context?: string;
  private readonly dockerPath: string;

  constructor(options: { context?: string; dockerPath?: string } = {}) {
    this.context = options.context;
    this.dockerPath = options.dockerPath ?? 'docker';
  }

  private argv(args: string[]): string[] {
    return this.context ? ['--context', this.context, ...args] : args;
  }

  // Every docker child still running, so a long-lived caller (kunj events) can end hung ones on exit
  private readonly children = new Set<ChildProcess>();

  private spawnChild(args: string[], options: SpawnOptions): ChildProcess {
    const child = spawn(this.dockerPath, this.argv(args), options);
    this.children.add(child);
    const forget = () => this.children.delete(child);
    child.on('close', forget);
    child.on('error', forget);
    return child;
  }

  /** End the docker processes still running (a hung `docker info` would otherwise keep us alive). */
  killChildren(): void {
    for (const child of this.children) child.kill('SIGTERM');
    this.children.clear();
  }

  /** Run docker to completion. `echo` sends both output streams to our stderr (keeps --json stdout clean). */
  private spawnDocker(args: string[], opts: SpawnOpts = {}): Promise<Output> {
    return new Promise((resolve, reject) => {
      const child = this.spawnChild(args, {
        stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
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

  private async checked(args: string[], opts: SpawnOpts = {}): Promise<Output> {
    const out = await this.spawnDocker(args, opts);
    if (out.code !== 0) {
      const line = args[0] === 'build' ? buildErrorLine(out) : firstLine(out);
      throw new Error(`docker ${subcommand(args)} failed: ${line}`);
    }
    return out;
  }

  async info(): Promise<EngineInfo> {
    let out: Output;
    try {
      out = await this.spawnDocker(['info', '--format', '{{json .}}']);
    } catch (err) {
      throw new Error(`Docker is not available: ${(err as Error).message}`);
    }
    if (out.code !== 0) throw new Error(`Docker is not available: ${firstLine(out)}`);
    let info: any;
    try {
      info = JSON.parse(out.stdout);
    } catch {
      throw new Error(`Docker is not available: docker info printed no JSON`);
    }
    // An unreachable daemon can still exit 0 with only the client's half filled in
    const serverError = (info.ServerErrors ?? [])[0];
    if (serverError || !info.ServerVersion) throw new Error(`Docker is not available: ${serverError ?? 'no server version'}`);
    return {
      serverVersion: String(info.ServerVersion),
      runtimes: Object.keys(info.Runtimes ?? {}),
      operatingSystem: String(info.OperatingSystem ?? ''),
    };
  }

  async contextName(): Promise<string> {
    if (this.context) return this.context;
    return (await this.checked(['context', 'show'])).stdout.trim();
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

  async commitContainer(id: string, tag: string, labels: Labels, extra: string[] = []): Promise<void> {
    // --change takes Dockerfile syntax, so keys and values are double-quoted with JSON escapes
    const changes = Object.keys(labels).sort().flatMap(k => ['--change', `LABEL ${JSON.stringify(k)}=${JSON.stringify(labels[k])}`]);
    await this.checked(['commit', ...changes, ...extra.flatMap(c => ['--change', c]), id, tag]);
  }

  // Two subprocesses whatever the number of images: ls for the matching ids, then one inspect
  // for exact labels, size and every tag
  async listImages(filter: Labels, opts: { references?: string[] } = {}): Promise<ImageInfo[]> {
    const filters = Object.keys(filter).flatMap(k => ['--filter', `label=${k}=${filter[k]}`]);
    // Several reference filters match any of them
    for (const r of opts.references ?? []) filters.push('--filter', `reference=${r}`);
    const ls = await this.checked(['image', 'ls', '--no-trunc', '--format', '{{json .}}', ...filters]);
    const ids = [...new Set(parseImageLs(ls.stdout).map(i => i.id))];
    if (ids.length === 0) return [];
    return parseImageInspect((await this.checked(['image', 'inspect', '--format', '{{json .}}', ...ids])).stdout);
  }

  async removeImage(tag: string): Promise<void> {
    const out = await this.spawnDocker(['image', 'rm', tag]);
    if (out.code === 0 || /No such image/i.test(out.stderr)) return;
    throw new Error(`docker image rm failed: ${firstLine(out)}`);
  }

  async createNetwork(name: string, labels: Labels): Promise<void> {
    await this.checked(['network', 'create', ...labelArgs(labels), name]);
  }

  async createVolume(name: string, labels: Labels): Promise<void> {
    await this.checked(['volume', 'create', ...labelArgs(labels), name]);
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.spawnDocker(['volume', 'inspect', '--format', '{{.Name}}', name])).code === 0;
  }

  async listVolumes(filter: Labels): Promise<LabelledObject[]> {
    return this.listLabelled('volume', ['-q'], filter);
  }

  async listNetworks(filter: Labels): Promise<LabelledObject[]> {
    return this.listLabelled('network', ['-q', '--no-trunc'], filter);
  }

  // ls for the names, then one inspect for exact labels: ls prints labels as "k=v,k=v", which
  // mangles a branch name containing a comma
  private async listLabelled(kind: 'volume' | 'network', lsFlags: string[], filter: Labels): Promise<LabelledObject[]> {
    const filters = Object.keys(filter).flatMap(k => ['--filter', `label=${k}=${filter[k]}`]);
    const ls = await this.checked([kind, 'ls', ...lsFlags, ...filters]);
    const ids = ls.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const inspect = await this.checked([kind, 'inspect', '--format', '{{json .}}', ...ids]);
    // Volumes call it CreatedAt, networks Created
    return jsonLines(inspect.stdout).map(o => ({ name: String(o.Name), labels: o.Labels ?? {}, createdAt: o.CreatedAt ?? o.Created }));
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

  async containerState(id: string): Promise<ContainerInfo['state'] | null> {
    const out = await this.spawnDocker(['inspect', '--format', '{{.State.Status}}', id]);
    if (out.code !== 0) return null;
    return out.stdout.trim() as ContainerInfo['state'];
  }

  async containerRun(id: string): Promise<{ state: ContainerInfo['state']; startedAt: string } | null> {
    const out = await this.spawnDocker(['inspect', '--format', '{{.State.Status}} {{.State.StartedAt}}', id]);
    if (out.code !== 0) return null;
    const [state, startedAt = ''] = out.stdout.trim().split(' ');
    return { state: state as ContainerInfo['state'], startedAt };
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
      const child = this.spawnChild(args, { stdio });
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

  async composeConfig(yamlText: string): Promise<any> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-compose-'));
    try {
      const env: NodeJS.ProcessEnv = {};
      for (const k of COMPOSE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
      const run = (noEnvResolution: boolean) =>
        this.checked(composeConfigArgs(dir, noEnvResolution), { input: Readable.from([yamlText]), cwd: dir, env });
      let out: Output;
      try {
        out = await run(true);
      } catch (err) {
        // An older compose without the flag; env_file is refused before compose sees the file anyway
        if (!/unknown flag.*no-env-resolution/i.test(err instanceof Error ? err.message : String(err))) throw err;
        out = await run(false);
      }
      return JSON.parse(out.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  logs(id: string, opts: LogOptions = {}): Promise<void> {
    const args = ['logs'];
    if (opts.follow) args.push('--follow');
    if (opts.tail !== undefined) args.push('--tail', String(opts.tail));
    args.push(id);
    const { onLine } = opts;
    return new Promise((resolve, reject) => {
      const child = this.spawnChild(args, { stdio: ['ignore', onLine ? 'pipe' : 'inherit', onLine ? 'pipe' : 'inherit'] });
      if (onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          let pending = '';
          child[stream]!.setEncoding('utf8');
          child[stream]!.on('data', (chunk: string) => {
            const lines = (pending + chunk).split('\n');
            pending = lines.pop()!;
            for (const line of lines) onLine(stream, line.replace(/\r$/, ''));
          });
          child[stream]!.on('end', () => {
            if (pending) onLine(stream, pending.replace(/\r$/, ''));
          });
        }
      }
      child.on('error', reject);
      child.on('close', (code: number | null) => (code === 0 || code === null ? resolve() : reject(new Error(`docker logs failed: exit code ${code}`))));
    });
  }

  events(filter: Labels, onEvent: (e: BackendEvent) => void, signal: AbortSignal): Promise<void> {
    const args = ['events', '--format', '{{json .}}', '--filter', 'type=container'];
    for (const [k, v] of Object.entries(filter)) args.push('--filter', v === '' ? `label=${k}` : `label=${k}=${v}`);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve();
      const child = this.spawnChild(args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const onAbort = () => child.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      let pending = '';
      const stderr: Buffer[] = [];
      child.stdout!.on('data', (d: Buffer) => {
        const lines = (pending + d.toString()).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseDockerEvent(line);
          if (event) onEvent(event);
        }
      });
      child.stderr!.on('data', (d: Buffer) => stderr.push(d));
      child.on('error', err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('close', (code: number | null) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return resolve();
        reject(new Error(`docker events failed: ${firstLine({ code: code ?? 1, stdout: '', stderr: Buffer.concat(stderr).toString() })}`));
      });
    });
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
      // Docker 29's CLI adds an `exit status 1` line after the daemon's errors
      const lines = out.stderr.trim().split('\n').filter(l => l && !/^exit status \d+$/.test(l.trim()));
      const allGone = lines.length > 0 && lines.every(l => /no such|not found/i.test(l));
      if (!allGone) throw new Error(`docker ${subcommand(args)} failed: ${firstLine(out)}`);
    }
  }
}
