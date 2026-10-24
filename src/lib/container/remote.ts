// ContainerBackend over `kunj serve`: every Docker call becomes a request to the server on the
// Docker host (docs/specs/remote-containers.md). Lifecycle, forwarding, services and the rest do not
// know which backend they run on, so errors come back as the text LocalDockerBackend would have
// thrown. Loaded lazily by the command, only when a remote is in use.

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import {
  BackendEvent,
  BuildOptions,
  ContainerBackend,
  ContainerInfo,
  ContainerSpec,
  EngineInfo,
  ExecIO,
  ImageInfo,
  Labels,
  LabelledObject,
  LogOptions,
} from './backend';
import { ErrorBody, InfoJson, PROTOCOL_VERSION, labelQuery } from '../serve/protocol';

export type RemoteErrorCode = 'remote-unreachable' | 'remote-unauthorized' | 'remote-protocol' | 'remote-refused';

/** A failure of the remote itself (not of Docker behind it); `jsonCode` is printed by --json. */
export class RemoteError extends Error {
  constructor(message: string, readonly code: RemoteErrorCode) {
    super(message);
    this.name = 'RemoteError';
  }

  get jsonCode(): RemoteErrorCode {
    return this.code;
  }
}

export interface RemoteOptions {
  /** http://127.0.0.1:<port> (a tunnel) or https://… (the user's TLS) */
  baseUrl: string;
  token: string;
  /** How the remote is called in messages (its name in remotes.json) */
  name?: string;
}

interface Reply {
  status: number;
  body: any;
}

export class RemoteKunjBackend implements ContainerBackend {
  private readonly url: URL;
  private readonly name: string;
  private info_?: InfoJson;

  constructor(private readonly opts: RemoteOptions) {
    this.url = new URL(opts.baseUrl);
    this.name = opts.name ?? this.url.host;
  }

  /** Fetches /v1/info once; `features` is valid after this resolves. The command awaits it. */
  async ready(): Promise<InfoJson> {
    if (!this.info_) {
      const info = (await this.json('GET', '/v1/info')) as InfoJson;
      if (info.protocol !== PROTOCOL_VERSION) {
        throw new RemoteError(
          `remote ${this.name} speaks protocol ${info.protocol}, this kunj speaks ${PROTOCOL_VERSION}: update ${info.protocol < PROTOCOL_VERSION ? 'kunj serve on the remote' : 'kunj here'}`,
          'remote-protocol',
        );
      }
      this.info_ = info;
    }
    return this.info_;
  }

  get features(): ContainerBackend['features'] {
    if (!this.info_) throw new Error(`remote ${this.name}: features read before ready()`);
    return this.info_.features;
  }

  /** The server's kunj version, after ready(). */
  get serverVersion(): string | undefined {
    return this.info_?.kunj;
  }

  // ---- transport ---------------------------------------------------------------------------

  private request(method: string, path: string, body?: string): Promise<Reply> {
    const target = new URL(path, this.url);
    const lib = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}` };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(body));
      }
      const req = lib.request(target, { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: any = undefined;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              return reject(new RemoteError(`remote ${this.name} answered ${res.statusCode} with something that is not kunj serve`, 'remote-protocol'));
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      });
      req.on('error', (err: NodeJS.ErrnoException) =>
        reject(new RemoteError(`Docker is not available: remote ${this.name} is unreachable (${err.code ?? err.message})`, 'remote-unreachable')));
      req.end(body);
    });
  }

  /** A unary call: the parsed body on 200, else the mapped error. */
  private async json(method: string, path: string, body?: unknown): Promise<any> {
    const reply = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body));
    if (reply.status === 200) return reply.body;
    throw this.errorOf(reply);
  }

  private errorOf(reply: Reply): Error {
    const error = (reply.body as ErrorBody | undefined)?.error;
    const message = error?.message ?? `HTTP ${reply.status}`;
    if (reply.status === 401) return new RemoteError(`remote ${this.name} refused the token (kunj remote token ${this.name} to replace it)`, 'remote-unauthorized');
    if (error?.code === 'remote-refused') return new RemoteError(`remote ${this.name} refused: ${message}`, 'remote-refused');
    if (error?.code === 'backend') return new Error(message);
    return new RemoteError(`remote ${this.name}: ${message}`, 'remote-protocol');
  }

  // ---- ContainerBackend --------------------------------------------------------------------

  async info(): Promise<EngineInfo> {
    const { context: _context, ...engine } = await this.json('GET', '/v1/engine');
    return engine;
  }

  async contextName(): Promise<string> {
    return (await this.json('GET', '/v1/engine')).context;
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.json('GET', `/v1/images/${encodeURIComponent(tag)}`)).exists;
  }

  async buildImage(_tag: string, _context: NodeJS.ReadableStream, _opts?: BuildOptions): Promise<void> {
    throw new Error('remote buildImage: not implemented yet');
  }

  async commitContainer(id: string, tag: string, labels: Labels, changes?: string[]): Promise<void> {
    await this.json('POST', `/v1/containers/${encodeURIComponent(id)}/commit`, { tag, labels, changes });
  }

  async listImages(filter: Labels, opts?: { references?: string[] }): Promise<ImageInfo[]> {
    const params = new URLSearchParams(labelQuery(filter));
    for (const r of opts?.references ?? []) params.append('reference', r);
    return this.json('GET', `/v1/images?${params}`);
  }

  async removeImage(tag: string): Promise<void> {
    await this.json('DELETE', `/v1/images/${encodeURIComponent(tag)}`);
  }

  async createNetwork(name: string, labels: Labels): Promise<void> {
    await this.json('POST', '/v1/networks', { name, labels });
  }

  async createVolume(name: string, labels: Labels): Promise<void> {
    await this.json('POST', '/v1/volumes', { name, labels });
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.json('GET', `/v1/volumes/${encodeURIComponent(name)}`)).exists;
  }

  async listVolumes(filter: Labels): Promise<LabelledObject[]> {
    return this.json('GET', `/v1/volumes?${labelQuery(filter)}`);
  }

  async listNetworks(filter: Labels): Promise<LabelledObject[]> {
    return this.json('GET', `/v1/networks?${labelQuery(filter)}`);
  }

  async run(spec: ContainerSpec): Promise<string> {
    return (await this.json('POST', '/v1/containers', spec)).id;
  }

  async list(filter: Labels): Promise<ContainerInfo[]> {
    return this.json('GET', `/v1/containers?${labelQuery(filter)}`);
  }

  async inspectLabels(name: string): Promise<Labels | null> {
    return (await this.json('GET', `/v1/containers/${encodeURIComponent(name)}/labels`)).labels;
  }

  async containerState(id: string): Promise<ContainerInfo['state'] | null> {
    return (await this.containerRun(id))?.state ?? null;
  }

  async containerRun(id: string): Promise<{ state: ContainerInfo['state']; startedAt: string } | null> {
    const body = await this.json('GET', `/v1/containers/${encodeURIComponent(id)}/state`);
    return body.state === null ? null : { state: body.state, startedAt: body.startedAt };
  }

  async exec(_id: string, _cmd: string[], _io?: ExecIO): Promise<{ exitCode: number; stdout: string }> {
    throw new Error('remote exec: not implemented yet');
  }

  async copyIn(_id: string, _dir: string, _tar: NodeJS.ReadableStream): Promise<void> {
    throw new Error('remote copyIn: not implemented yet');
  }

  async start(id: string): Promise<void> {
    await this.json('POST', `/v1/containers/${encodeURIComponent(id)}/start`);
  }

  async stop(id: string): Promise<void> {
    await this.json('POST', `/v1/containers/${encodeURIComponent(id)}/stop`);
  }

  async remove(ids: { containers?: string[]; volumes?: string[]; networks?: string[] }): Promise<void> {
    await this.json('POST', '/v1/remove', ids);
  }

  async composeConfig(yamlText: string): Promise<any> {
    return (await this.json('POST', '/v1/compose/config', { yaml: yamlText })).config;
  }

  async logs(_id: string, _opts?: LogOptions): Promise<void> {
    throw new Error('remote logs: not implemented yet');
  }

  async events(_filter: Labels, _onEvent: (e: BackendEvent) => void, _signal: AbortSignal): Promise<void> {
    throw new Error('remote events: not implemented yet');
  }
}
