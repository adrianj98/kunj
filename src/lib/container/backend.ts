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

/** What `docker info` says about the daemon. */
export interface EngineInfo {
  serverVersion: string;
  /** Names of the runtimes the daemon has, e.g. runc, sysbox-runc */
  runtimes: string[];
  /** e.g. "Docker Desktop", "Ubuntu 24.04.1 LTS", "OrbStack" */
  operatingSystem: string;
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
  /** stdout is captured unless io.stdout is given; a non-zero exit is returned, not thrown */
  exec(id: string, cmd: string[], io?: ExecIO): Promise<{ exitCode: number; stdout: string }>;
  copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void>;
  /** `docker compose config --format json` of a compose file's text, without interpolating the host's environment. */
  composeConfig(yamlText: string): Promise<any>;
  /** A container's output, streamed to our stdout and stderr; with `follow` until it stops or we are interrupted. */
  logs(id: string, opts?: { follow?: boolean; tail?: number }): Promise<void>;
}
