// The only seam between kunj and a container engine. Lifecycle, port forwarding and the
// command program against ContainerBackend, so a remote backend can replace the local one.

export interface Labels { [key: string]: string }

export interface ContainerInfo {
  id: string;
  name: string;
  state: 'running' | 'exited' | 'created' | 'paused' | 'restarting' | 'dead';
  image: string;
  createdAt: string;
  labels: Labels;
  ports: Array<{ container: number; host: number }>;
}

export interface ImageInfo {
  tag: string;
  id: string;
  createdAt: string;
  labels: Labels;
  size: number;
}

export interface ContainerSpec {
  name: string;
  image: string;
  labels: Labels;
  env: Record<string, string>;
  network: string;
  user?: string;
  workdir: string;
  volumes: Array<{ name: string; path: string }>;
  publish: Array<{ container: number; host: number }>;
  cpus?: string;
  memory?: string;
  /** Added with --cap-add (after capDrop, so `capDrop: ['ALL']` keeps only these). */
  capabilities?: string[];
  capDrop?: string[];
  securityOpt?: string[];
  /** --add-host entries, e.g. host.docker.internal:host-gateway */
  extraHosts?: string[];
  networkOf?: string;
  init?: boolean;
  /** Replaces the image's ENTRYPOINT: [0] is the program, the rest go before `command`. */
  entrypoint?: string[];
  command: string[];
}

export interface ExecIO {
  stdin?: NodeJS.ReadableStream | 'inherit' | 'ignore';
  stdout?: NodeJS.WritableStream | 'inherit';
  stderr?: NodeJS.WritableStream | 'inherit';
  tty?: boolean;
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class ExecTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecTimeoutError';
  }
}

export interface BuildOptions {
  dockerfile?: string;
  buildArgs?: Record<string, string>;
}

export interface ContainerBackend {
  readonly features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  /** Throws Error('Docker is not available: <stderr>') */
  info(): Promise<{ serverVersion: string }>;
  imageExists(tag: string): Promise<boolean>;
  buildImage(tag: string, context: NodeJS.ReadableStream, opts?: BuildOptions): Promise<void>;
  /** Snapshot a container as an image; each label becomes a LABEL instruction. */
  commitContainer(id: string, tag: string, labels: Labels): Promise<void>;
  /** One entry per tag of every image carrying all of `filter`'s labels; untagged images are skipped. */
  listImages(filter: Labels): Promise<ImageInfo[]>;
  /** Idempotent: an image that is already gone is not a failure. */
  removeImage(tag: string): Promise<void>;
  createNetwork(name: string, labels: Labels): Promise<void>;
  createVolume(name: string, labels: Labels): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  run(spec: ContainerSpec): Promise<string>;
  list(filter: Labels): Promise<ContainerInfo[]>;
  /** null when the object does not exist */
  inspectLabels(name: string): Promise<Labels | null>;
  /** stdout is captured unless io.stdout is given; a non-zero exit is returned, not thrown */
  exec(id: string, cmd: string[], io?: ExecIO): Promise<{ exitCode: number; stdout: string }>;
  copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void>;
}
