// In-memory ContainerBackend for lifecycle and port-forwarding tests. Records every call;
// exec results are programmed by the joined command.
import { ContainerBackend, ContainerInfo, ContainerSpec, ExecIO, ExecTimeoutError, ImageInfo, Labels } from '../backend';

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
  /** Tags that exist without being committed snapshots; buildImage adds to it. */
  existingImages = new Set<string>();
  /** Committed (blueprint) images; commitContainer appends. */
  images: ImageInfo[] = [];
  /** Volumes that exist; createVolume adds to it. */
  volumes = new Set<string>();
  /** Labels of volumes, by name (createVolume records them); unlisted volumes have none. */
  volumeLabels = new Map<string, Labels>();
  /** Networks that exist, with their labels; createNetwork adds to it. */
  networks = new Map<string, Labels>();
  /** composeConfig results keyed by the compose text; unlisted texts give an empty project. */
  composeConfigs = new Map<string, unknown>();
  /** containerState results by id; unlisted ids are 'running'. */
  states = new Map<string, ContainerInfo['state'] | null>();
  /** Pipe io.stdin to io.stdout uppercased. */
  echoUpper = false;
  /** stdin contents captured per exec call, in call order (undefined when no stream was given). */
  stdinData: Array<string | undefined> = [];
  /** Per exec call with a stdin stream, in call order: whether that stream has ended. */
  stdinEnded: boolean[] = [];
  private nextId = 1;
  private nextImageId = 1;

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
    return this.existingImages.has(tag) || this.images.some(i => i.tag === tag);
  }

  async buildImage(tag: string, _context: NodeJS.ReadableStream, opts?: unknown): Promise<void> {
    this.record('buildImage', [tag, opts]);
    this.existingImages.add(tag);
  }

  async commitContainer(id: string, tag: string, labels: Labels, changes?: string[]): Promise<void> {
    this.record('commitContainer', [id, tag, labels, changes]);
    this.images.push({ tag, id: `img-${this.nextImageId++}`, createdAt: new Date().toISOString(), labels, size: 0 });
  }

  async listImages(filter: Labels, opts?: { references?: string[] }): Promise<ImageInfo[]> {
    this.record('listImages', opts ? [filter, opts] : [filter]);
    return this.images.filter(i =>
      Object.keys(filter).every(k => i.labels[k] === filter[k]) &&
      (!opts?.references || opts.references.includes(i.tag.slice(0, i.tag.lastIndexOf(':')))));
  }

  async removeImage(tag: string): Promise<void> {
    this.record('removeImage', [tag]);
    this.images = this.images.filter(i => i.tag !== tag);
    this.existingImages.delete(tag);
  }

  async createNetwork(name: string, labels: Labels): Promise<void> {
    this.record('createNetwork', [name, labels]);
    this.networks.set(name, labels);
  }

  async createVolume(name: string, labels: Labels): Promise<void> {
    this.record('createVolume', [name, labels]);
    this.volumes.add(name);
    this.volumeLabels.set(name, labels);
  }

  async volumeExists(name: string): Promise<boolean> {
    this.record('volumeExists', [name]);
    return this.volumes.has(name);
  }

  async listVolumes(filter: Labels): Promise<Array<{ name: string; labels: Labels }>> {
    this.record('listVolumes', [filter]);
    return [...this.volumes]
      .map(name => ({ name, labels: this.volumeLabels.get(name) ?? {} }))
      .filter(v => Object.keys(filter).every(k => v.labels[k] === filter[k]));
  }

  async listNetworks(filter: Labels): Promise<Array<{ name: string; labels: Labels }>> {
    this.record('listNetworks', [filter]);
    return [...this.networks]
      .map(([name, labels]) => ({ name, labels }))
      .filter(v => Object.keys(filter).every(k => v.labels[k] === filter[k]));
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

  async containerState(id: string): Promise<ContainerInfo['state'] | null> {
    this.record('containerState', [id]);
    return this.states.has(id) ? this.states.get(id)! : 'running';
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

  async composeConfig(yamlText: string): Promise<any> {
    this.record('composeConfig', [yamlText]);
    const result = this.composeConfigs.get(yamlText);
    if (result instanceof Error) throw result;
    return result ?? { services: {} };
  }

  async logs(id: string, opts?: { follow?: boolean; tail?: number }): Promise<void> {
    this.record('logs', [id, opts]);
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
