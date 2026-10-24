// ContainerBackend over `kunj serve`: every Docker call becomes a request to the server on the
// Docker host (docs/specs/remote-containers.md). Lifecycle, forwarding, services and the rest do not
// know which backend they run on, so errors come back as the text LocalDockerBackend would have
// thrown. Loaded lazily by the command, only when a remote is in use.

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import WebSocket, { RawData } from 'ws';
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
} from './backend';
import { CHANNEL, ErrorBody, ExecControl, ExecRequest, HIGH_WATER, InfoJson, PROTOCOL_VERSION, decodeFrame, encodeFrame, labelQuery, parseControl } from '../serve/protocol';

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
    return this.json('GET', '/v1/engine');
  }

  async contextName(): Promise<string> {
    return (await this.json('GET', '/v1/engine/context')).context;
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.json('GET', `/v1/images/${encodeURIComponent(tag)}`)).exists;
  }

  async buildImage(tag: string, context: NodeJS.ReadableStream, opts: BuildOptions = {}): Promise<void> {
    await this.upload('POST', `/v1/images/${encodeURIComponent(tag)}/build`, context, { 'x-kunj-build': JSON.stringify(opts) });
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

  exec(id: string, cmd: string[], io: ExecIO = {}): Promise<{ exitCode: number; stdout: string }> {
    if (io.tty) return Promise.reject(new Error('remote TTY exec: not implemented yet'));
    return this.execStream(id, cmd, io);
  }

  async copyIn(id: string, dir: string, tar: NodeJS.ReadableStream): Promise<void> {
    const params = new URLSearchParams({ dir });
    await this.upload('POST', `/v1/containers/${encodeURIComponent(id)}/copy?${params}`, tar);
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

  logs(id: string, opts: LogOptions = {}): Promise<void> {
    const params = new URLSearchParams();
    if (opts.follow) params.set('follow', '1');
    if (opts.tail !== undefined) params.set('tail', String(opts.tail));
    const onLine = opts.onLine ?? ((stream: 'stdout' | 'stderr', line: string) => process[stream].write(line + '\n'));
    return new Promise((resolve, reject) => {
      const ws = this.socket(`/v1/containers/${encodeURIComponent(id)}/logs?${params}`);
      let failed: Error | undefined;
      ws.on('message', (data: RawData, binary: boolean) => {
        if (binary) return;
        const text = rawToString(data);
        const control = tryControl(text);
        if (control && 'error' in control) {
          failed = new Error(control.error);
          return;
        }
        const line = JSON.parse(text) as { stream: 'stdout' | 'stderr'; line: string };
        onLine(line.stream, line.line);
      });
      ws.on('error', err => reject(this.wsError(err)));
      ws.on('close', () => (failed ? reject(failed) : resolve()));
    });
  }

  events(filter: Labels, onEvent: (e: BackendEvent) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve();
      const ws = this.socket(`/v1/events?${labelQuery(filter)}`);
      const onAbort = () => ws.close();
      signal.addEventListener('abort', onAbort, { once: true });
      let failed: Error | undefined;
      ws.on('message', (data: RawData, binary: boolean) => {
        if (binary) return;
        const text = rawToString(data);
        const control = tryControl(text);
        if (control && 'error' in control) {
          failed = new Error(`docker events failed: ${control.error}`);
          return;
        }
        onEvent(JSON.parse(text) as BackendEvent);
      });
      ws.on('error', err => {
        signal.removeEventListener('abort', onAbort);
        reject(this.wsError(err));
      });
      ws.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return resolve();
        reject(failed ?? new Error('docker events failed: the remote closed the event stream'));
      });
    });
  }

  // ---- streams -----------------------------------------------------------------------------

  private socket(path: string): WebSocket {
    const target = new URL(path, this.url);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(target, { headers: { authorization: `Bearer ${this.opts.token}` }, maxPayload: 16 * 1024 * 1024 });
  }

  private wsError(err: Error & { code?: string }): Error {
    // ws reports a refused upgrade as "Unexpected server response: 401"
    const m = /Unexpected server response: (\d+)/.exec(err.message);
    if (m?.[1] === '401') return new RemoteError(`remote ${this.name} refused the token (kunj remote token ${this.name} to replace it)`, 'remote-unauthorized');
    if (m) return new RemoteError(`remote ${this.name}: HTTP ${m[1]} on a stream`, 'remote-protocol');
    return new RemoteError(`Docker is not available: remote ${this.name} is unreachable (${err.code ?? err.message})`, 'remote-unreachable');
  }

  /** A request whose body is a stream (a tar); the reply is JSON like a unary call. */
  private upload(method: string, path: string, body: NodeJS.ReadableStream, extraHeaders: Record<string, string> = {}): Promise<any> {
    const target = new URL(path, this.url);
    const lib = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/octet-stream', ...extraHeaders };
      const req = lib.request(target, { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: any;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            return reject(new RemoteError(`remote ${this.name} answered ${res.statusCode} with something that is not kunj serve`, 'remote-protocol'));
          }
          if (res.statusCode === 200) resolve(parsed);
          else reject(this.errorOf({ status: res.statusCode ?? 0, body: parsed }));
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) =>
        reject(new RemoteError(`Docker is not available: remote ${this.name} is unreachable (${err.code ?? err.message})`, 'remote-unreachable')));
      body.on('error', err => req.destroy(err as Error));
      body.pipe(req);
    });
  }

  /**
   * A non-TTY exec: the request as the first text frame, stdin as channel-0 frames (EOF as an empty
   * one), stdout and stderr back as frames, `exit` or `error` to finish. Without io.stdout the output
   * is collected and returned, as the local backend does.
   */
  private execStream(id: string, cmd: string[], io: ExecIO): Promise<{ exitCode: number; stdout: string }> {
    const stdinStream: NodeJS.ReadableStream | undefined =
      typeof io.stdin === 'object' ? io.stdin : io.stdin === 'inherit' ? process.stdin : undefined;
    const stdout: NodeJS.WritableStream | undefined = io.stdout === 'inherit' ? process.stdout : io.stdout;
    const stderr: NodeJS.WritableStream | undefined = io.stderr === 'inherit' ? process.stderr : io.stderr;
    const request: ExecRequest = {
      cmd,
      user: io.user,
      workdir: io.workdir,
      env: io.env,
      tty: false,
      stdin: !!stdinStream,
      timeoutMs: io.timeoutMs,
    };
    return new Promise((resolve, reject) => {
      const ws = this.socket(`/v1/containers/${encodeURIComponent(id)}/exec`);
      const collected: Buffer[] = [];
      let settled = false;
      let exitCode: number | undefined;
      let failure: Error | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (stdinStream) {
          stdinStream.off('data', onStdinData);
          stdinStream.off('end', onStdinEnd);
          stdinStream.off('error', onStdinEnd);
        }
        fn();
      };

      // stdin → frames; the source waits for each frame to reach the socket (send's callback)
      const onStdinData = (chunk: Buffer | string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        if (ws.bufferedAmount > HIGH_WATER) stdinStream!.pause();
        ws.send(encodeFrame(CHANNEL.stdin, bytes), { binary: true }, () => {
          if (ws.bufferedAmount <= HIGH_WATER && !settled) stdinStream!.resume();
        });
      };
      const onStdinEnd = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(CHANNEL.stdin, ''), { binary: true });
      };

      // frames → io streams; the socket waits while a stream is behind
      const deliver = (target: NodeJS.WritableStream | undefined, bytes: Buffer, collect: boolean) => {
        if (!target) {
          if (collect) collected.push(bytes);
          return;
        }
        if (!target.write(bytes)) {
          ws.pause();
          target.once('drain', () => ws.resume());
        }
      };

      ws.on('open', () => {
        ws.send(JSON.stringify(request));
        if (stdinStream) {
          stdinStream.on('data', onStdinData);
          stdinStream.once('end', onStdinEnd);
          stdinStream.once('error', onStdinEnd);
          stdinStream.resume();
        }
      });
      ws.on('message', (data: RawData, binary: boolean) => {
        if (binary) {
          const { channel, data: bytes } = decodeFrame(rawToBuffer(data));
          if (channel === CHANNEL.stdout) deliver(stdout, bytes, true);
          else if (channel === CHANNEL.stderr) deliver(stderr, bytes, false);
          return;
        }
        const control = parseControl(rawToString(data));
        if ('exit' in control) exitCode = control.exit;
        else if ('error' in control) {
          failure = control.error === 'timeout'
            ? new ExecTimeoutError(`docker exec timed out after ${io.timeoutMs} ms`)
            : new Error(control.error);
        }
      });
      ws.on('error', err => finish(() => reject(this.wsError(err))));
      ws.on('close', () =>
        finish(() => {
          if (failure) return reject(failure);
          if (exitCode === undefined) return reject(new Error('exec ended: connection closed'));
          resolve({ exitCode, stdout: Buffer.concat(collected).toString() });
        }));
    });
  }
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rawToString(data: RawData): string {
  return rawToBuffer(data).toString();
}

/** A control message, or undefined when the text is some other JSON (a log line, an event). */
function tryControl(text: string): ExecControl | undefined {
  try {
    return parseControl(text);
  } catch {
    return undefined;
  }
}

