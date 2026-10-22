// In-memory ContainerBackend for lifecycle and port-forwarding tests. Records every call;
// exec results are programmed by the joined command.
import { ContainerBackend, ContainerInfo, ContainerSpec, ExecIO, ExecTimeoutError, Labels } from '../backend';

export type ExecResult = { exitCode: number; stdout: string };

export class FakeBackend implements ContainerBackend {
  readonly features = { localPorts: true, editorAttach: false, dockerInDocker: [] as Array<'sysbox' | 'privileged'> };
  calls: Array<{ method: string; args: unknown[] }> = [];
  /** Keyed by cmd.join(' '); unlisted commands exit 0 with no output. */
  execResults = new Map<string, ExecResult>();
  /** Keyed by cmd.join(' '): the exec rejects with this error (e.g. a helper that exited). */
  execErrors = new Map<string, Error>();
  /** Commands that reject with ExecTimeoutError when run with a timeoutMs; '__hang__' matches every command. */
  hangOn = new Set<string>();
  /** Method name that throws. */
  failOn?: string;
  existing: ContainerInfo[] = [];
  images = new Set<string>();
  /** Pipe io.stdin to io.stdout uppercased. */
  echoUpper = false;
  /** stdin contents captured per exec call, in call order (undefined when no stream was given). */
  stdinData: Array<string | undefined> = [];
  /** Per exec call with a stdin stream, in call order: whether that stream has ended. */
  stdinEnded: boolean[] = [];
  private nextId = 1;

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failOn === method) throw new Error(`${method} failed`);
  }

  methods(): string[] {
    return this.calls.map(c => c.method);
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter(c => c.method === method).map(c => c.args);
  }

  async info(): Promise<{ serverVersion: string }> {
    this.record('info', []);
    return { serverVersion: 'fake' };
  }

  async imageExists(tag: string): Promise<boolean> {
    this.record('imageExists', [tag]);
    return this.images.has(tag);
  }

  async buildImage(tag: string, _context: NodeJS.ReadableStream, opts?: unknown): Promise<void> {
    this.record('buildImage', [tag, opts]);
    this.images.add(tag);
  }

  async createNetwork(name: string, labels: Labels): Promise<void> {
    this.record('createNetwork', [name, labels]);
  }

  async createVolume(name: string, labels: Labels): Promise<void> {
    this.record('createVolume', [name, labels]);
  }

  async run(spec: ContainerSpec): Promise<string> {
    this.record('run', [spec]);
    return `id-${this.nextId++}`;
  }

  async list(filter: Labels): Promise<ContainerInfo[]> {
    this.record('list', [filter]);
    return this.existing.filter(c => Object.keys(filter).every(k => c.labels[k] === filter[k]));
  }

  async inspectLabels(name: string): Promise<Labels | null> {
    this.record('inspectLabels', [name]);
    return this.existing.find(c => c.name === name)?.labels ?? null;
  }

  async exec(id: string, cmd: string[], io: ExecIO = {}): Promise<ExecResult> {
    this.record('exec', [id, cmd, io]);
    const key = cmd.join(' ');
    const stdin = typeof io.stdin === 'object' ? io.stdin : undefined;
    let input: string | undefined;
    if (stdin) {
      const index = this.stdinEnded.push(false) - 1;
      input = await readAll(stdin);
      this.stdinEnded[index] = true;
    }
    this.stdinData.push(input);
    if (io.timeoutMs !== undefined && (this.hangOn.has(key) || this.hangOn.has('__hang__'))) {
      throw new ExecTimeoutError(`docker exec timed out after ${io.timeoutMs} ms`);
    }
    const error = this.execErrors.get(key);
    if (error) throw error;
    if (this.echoUpper && input !== undefined && io.stdout && io.stdout !== 'inherit') {
      io.stdout.write(input.toUpperCase());
    }
    return this.execResults.get(key) ?? { exitCode: 0, stdout: '' };
  }

  async copyIn(id: string, dir: string, _tar: NodeJS.ReadableStream): Promise<void> {
    this.record('copyIn', [id, dir]);
  }

  async start(id: string): Promise<void> {
    this.record('start', [id]);
  }

  async stop(id: string): Promise<void> {
    this.record('stop', [id]);
  }

  async remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void> {
    this.record('remove', [ids]);
  }
}

// Like LocalDockerBackend, which pipes stdin into `docker exec`: attaches no 'error' listener and
// finishes only on 'end', so a stream that is destroyed without ending leaves the exec running.
function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    stream.on('data', (d: Buffer | string) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}
