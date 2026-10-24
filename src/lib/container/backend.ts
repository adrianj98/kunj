// The only seam between kunj and a container engine. Lifecycle, port forwarding and the
// command program against ContainerBackend, so a remote backend can replace the local one.

export interface Labels { [key: string]: string }

/** An image reference as docker run takes it: never empty, never starting with '-' (it would be read as a flag), no spaces. */
export const IMAGE_REF = /^[a-z0-9][a-z0-9._/:@-]*$/i;

export function isImageRef(ref: string): boolean {
  return IMAGE_REF.test(ref);
}

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

/** A volume or network: its name and exact labels. */
export interface LabelledObject {
  name: string;
  labels: Labels;
  /** When it was created (ISO time), if the engine says */
  createdAt?: string;
}

export interface ContainerSpec {
  name: string;
  image: string;
  labels: Labels;
  env: Record<string, string>;
  network: string;
  /** --network-alias entries: names other containers on `network` reach this one by */
  aliases?: string[];
  user?: string;
  /** '' keeps the image's WORKDIR */
  workdir: string;
  volumes: Array<{ name: string; path: string }>;
  publish: Array<{ container: number; host: number }>;
  cpus?: string;
  memory?: string;
  /** Added with --cap-add (after capDrop, so `capDrop: ['ALL']` keeps only these). */
  capabilities?: string[];
  capDrop?: string[];
  securityOpt?: string[];
  /** --runtime, e.g. sysbox-runc for Docker-in-Docker */
  runtime?: string;
  /** --privileged: only for Docker-in-Docker's privileged mode, which the caller has checked */
  privileged?: boolean;
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
  /** Aborting ends the exec (the process is killed); the call then rejects with Error('exec aborted') */
  signal?: AbortSignal;
}

/** A TTY exec (shell, attach, agent) for the remote server: the pty's bytes both ways, resize, exit. */
export interface TtyExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface TtySession {
  /** Bytes to the pty (end() is stdin EOF) */
  stdin: NodeJS.WritableStream;
  /** Bytes from the pty: stdout and stderr merged, as a terminal sees them */
  stdout: NodeJS.ReadableStream;
  resize(cols: number, rows: number): Promise<void>;
  /** The exit code once the process ends; rejects when the transport failed */
  wait(): Promise<number>;
  /** Hang up: closes the pty's connection, which is SIGHUP to the process */
  close(): void;
}

export class ExecTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecTimeoutError';
  }
}

/** A container event: `action` as the engine names it (start, die, destroy, exec_start: …), `at` an ISO time. */
export interface BackendEvent {
  action: string;
  name: string;
  labels: Labels;
  at: string;
}

export interface BuildOptions {
  dockerfile?: string;
  buildArgs?: Record<string, string>;
}

/** What `docker info` says about the daemon. */
export interface EngineInfo {
  serverVersion: string;
  /** Names of the runtimes the daemon has, e.g. runc, sysbox-runc */
  runtimes: string[];
  /** e.g. "Docker Desktop", "Ubuntu 24.04.1 LTS", "OrbStack" */
  operatingSystem: string;
}

export interface LogOptions {
  follow?: boolean;
  tail?: number;
  /** Aborting ends a follow; the call then resolves */
  signal?: AbortSignal;
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface ContainerBackend {
  readonly features: { localPorts: boolean; editorAttach: boolean; dockerInDocker: Array<'sysbox' | 'privileged'> };
  /** Throws Error('Docker is not available: <stderr>') */
  info(): Promise<EngineInfo>;
  /** The Docker context in use: the configured one, else `docker context show`. */
  contextName(): Promise<string>;
  imageExists(tag: string): Promise<boolean>;
  buildImage(tag: string, context: NodeJS.ReadableStream, opts?: BuildOptions): Promise<void>;
  /** Snapshot a container as an image; each label becomes a LABEL instruction, each of `changes` (Dockerfile syntax, e.g. ENV) another --change. */
  commitContainer(id: string, tag: string, labels: Labels, changes?: string[]): Promise<void>;
  /** One entry per tag of every image carrying all of `filter`'s labels (and, with `references`, in one
   * of those repositories, e.g. 'kunj-sandbox'); untagged images are skipped. */
  listImages(filter: Labels, opts?: { references?: string[] }): Promise<ImageInfo[]>;
  /** Idempotent: an image that is already gone is not a failure. */
  removeImage(tag: string): Promise<void>;
  createNetwork(name: string, labels: Labels): Promise<void>;
  createVolume(name: string, labels: Labels): Promise<void>;
  volumeExists(name: string): Promise<boolean>;
  /** Volumes carrying all of `filter`'s labels, with their exact labels. */
  listVolumes(filter: Labels): Promise<LabelledObject[]>;
  /** Networks carrying all of `filter`'s labels, with their exact labels. */
  listNetworks(filter: Labels): Promise<LabelledObject[]>;
  run(spec: ContainerSpec): Promise<string>;
  list(filter: Labels): Promise<ContainerInfo[]>;
  /** null when the object does not exist */
  inspectLabels(name: string): Promise<Labels | null>;
  /** The container's state (docker inspect .State.Status); null when it does not exist */
  containerState(id: string): Promise<ContainerInfo['state'] | null>;
  /** The state and when the container last started (.State.StartedAt), which changes on every start; null when it does not exist */
  containerRun(id: string): Promise<{ state: ContainerInfo['state']; startedAt: string } | null>;
  /** stdout is captured unless io.stdout is given; a non-zero exit is returned, not thrown */
  exec(id: string, cmd: string[], io?: ExecIO): Promise<{ exitCode: number; stdout: string }>;
  /**
   * A TTY exec without a terminal of our own (kunj serve's, for a client's shell): the Docker Engine
   * API allocates the pty. Optional: `exec` with tty and 'inherit' is the local way.
   */
  execTty?(id: string, cmd: string[], opts: TtyExecOptions): Promise<TtySession>;
  copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void>;
  /** `docker compose config --format json` of a compose file's text, without interpolating the host's environment. */
  composeConfig(yamlText: string): Promise<any>;
  /** A container's output, streamed to our stdout and stderr; with `follow` until it stops or we are interrupted. */
  /** Streams the output to ours; with `onLine`, one call per line instead, tagged with its stream */
  logs(id: string, opts?: LogOptions): Promise<void>;
  /**
   * Container events carrying `filter`'s labels (a '' value matches any value of that label), until
   * `signal` aborts (then it resolves). Rejects when the engine is unreachable or the stream ends.
   */
  events(filter: Labels, onEvent: (e: BackendEvent) => void, signal: AbortSignal): Promise<void>;
}
