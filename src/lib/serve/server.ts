// `kunj serve`: ContainerBackend over HTTP. One route per backend method, a bearer token on every
// request, and the Guard in front of anything that names an object. Thin on purpose: no lifecycle
// logic lives here, the laptop runs that. Streams (exec, logs, events, copy, build) are added in
// their own module and share this server's listener.

import * as http from 'http';
import { AddressInfo } from 'net';
import { URL } from 'url';
import { ContainerBackend, ContainerSpec, Labels, isImageRef } from '../container/backend';
import { Guard, GuardFlags, GuardLookup, backendLookup } from './guard';
import { EngineJson, ErrorBody, InfoJson, PROTOCOL_VERSION, ServeError, parseLabelQuery } from './protocol';
import { bearerOf, readJsonBody } from './http';
import { StreamOptions, attachWebSockets, serveBuild, serveCopyIn } from './streams';
import { tokenMatches } from './token';

export interface ServeOptions {
  backend: ContainerBackend;
  token: string;
  /** kunj's version, reported in /v1/info */
  version: string;
  allowPrivileged?: boolean;
  allowRuntimes?: string[];
  /** One line per request (method, route, status, ms) and per refusal; never a body or a token. */
  log?: (line: string) => void;
  /** How the guard reads labels (default: the backend); tests look the fake up directly */
  guardLookup?: GuardLookup;
}

export interface ServeServer {
  listen(host: string, port: number): Promise<AddressInfo>;
  close(): Promise<void>;
  /** The listener, for the WebSocket upgrade handler. */
  readonly http: http.Server;
  readonly guard: Guard;
}

type Params = Record<string, string>;
type Handler = (req: http.IncomingMessage, params: Params, url: URL) => Promise<unknown>;

interface Route {
  method: string;
  /** Path segments; ':name' captures one (URL-decoded) segment */
  pattern: string[];
  handler: Handler;
}

function matchRoute(pattern: string[], segments: string[]): Params | null {
  if (pattern.length !== segments.length) return null;
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) {
      try {
        params[pattern[i].slice(1)] = decodeURIComponent(segments[i]);
      } catch {
        return null;
      }
    } else if (pattern[i] !== segments[i]) return null;
  }
  return params;
}

function expect<T>(value: unknown, check: (v: unknown) => boolean, what: string): T {
  if (!check(value)) throw new ServeError(400, 'bad-request', `expected ${what}`);
  return value as T;
}

const isString = (v: unknown): boolean => typeof v === 'string';
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
const isLabels = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(isString);

export function createServeServer(opts: ServeOptions): ServeServer {
  const { backend } = opts;
  const flags: GuardFlags = { allowPrivileged: !!opts.allowPrivileged, allowRuntimes: opts.allowRuntimes ?? [] };
  const guard = new Guard(opts.guardLookup ?? backendLookup(backend), flags);
  const log = opts.log ?? (() => {});

  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) =>
    routes.push({ method, pattern: path.split('/').filter(Boolean), handler });

  let context: Promise<string> | undefined;
  route('GET', '/v1/info', async () => {
    // Docker-in-Docker is reported only as the flags allow it, so the client refuses before trying
    const dind = backend.features.dockerInDocker.filter(
      mode => (mode === 'privileged' && flags.allowPrivileged) || (mode === 'sysbox' && flags.allowRuntimes.includes('sysbox-runc')));
    // An editor on the laptop cannot attach through the box's Docker; local ports work (the forwarder runs on the laptop)
    const features = { ...backend.features, editorAttach: false, dockerInDocker: dind };
    context ??= backend.contextName().catch(() => 'default');
    const info: InfoJson = { kunj: opts.version, protocol: PROTOCOL_VERSION, features, context: await context };
    return info;
  });

  route('GET', '/v1/engine', async () => {
    const out: EngineJson = await backend.info();
    return out;
  });
  route('GET', '/v1/engine/context', async () => ({ context: await backend.contextName() }));

  // ---- images ----
  route('GET', '/v1/images', async (_req, _p, url) => {
    const filter = parseLabelQuery(url.searchParams);
    const references = url.searchParams.getAll('reference');
    return backend.listImages(filter, references.length ? { references } : undefined);
  });
  route('GET', '/v1/images/:tag', async (_req, p) => {
    if (!isImageRef(p.tag)) throw new ServeError(400, 'bad-request', 'expected an image reference');
    return { exists: await backend.imageExists(p.tag) };
  });
  route('DELETE', '/v1/images/:tag', async (_req, p) => {
    guard.image(p.tag);
    await backend.removeImage(p.tag);
    return {};
  });

  // ---- networks and volumes ----
  route('POST', '/v1/networks', async req => {
    const body = await readJsonBody(req);
    const name = expect<string>(body.name, isString, 'name');
    const labels = expect<Labels>(body.labels, isLabels, 'labels');
    guard.createLabels('network', labels);
    await backend.createNetwork(name, labels);
    return {};
  });
  route('GET', '/v1/networks', async (_req, _p, url) => {
    return backend.listNetworks(parseLabelQuery(url.searchParams));
  });
  route('POST', '/v1/volumes', async req => {
    const body = await readJsonBody(req);
    const name = expect<string>(body.name, isString, 'name');
    const labels = expect<Labels>(body.labels, isLabels, 'labels');
    guard.createLabels('volume', labels);
    await backend.createVolume(name, labels);
    return {};
  });
  route('GET', '/v1/volumes', async (_req, _p, url) => {
    return backend.listVolumes(parseLabelQuery(url.searchParams));
  });
  route('GET', '/v1/volumes/:name', async (_req, p) => ({ exists: await backend.volumeExists(p.name) }));

  // ---- containers ----
  route('POST', '/v1/containers', async req => {
    const spec = (await readJsonBody(req)) as ContainerSpec;
    expect(spec.name, isString, 'name');
    expect(spec.image, v => isString(v) && isImageRef(v as string), 'an image reference');
    expect(spec.labels, isLabels, 'labels');
    expect(spec.env, isLabels, 'env');
    expect(spec.command, isStringArray, 'command');
    spec.publish = Array.isArray(spec.publish) ? spec.publish : [];
    spec.volumes = Array.isArray(spec.volumes) ? spec.volumes : [];
    guard.runSpec(spec);
    guard.forget(spec.name);
    return { id: await backend.run(spec) };
  });
  route('GET', '/v1/containers', async (_req, _p, url) => {
    return backend.list(parseLabelQuery(url.searchParams));
  });
  // Unguarded: reading a foreign container's labels is how lifecycle reports a name collision
  route('GET', '/v1/containers/:id/labels', async (_req, p) => ({ labels: await backend.inspectLabels(p.id) }));
  route('GET', '/v1/containers/:id/state', async (_req, p) => {
    await guard.container(p.id);
    const run = await backend.containerRun(p.id);
    return run ?? { state: null };
  });
  route('POST', '/v1/containers/:id/start', async (_req, p) => {
    await guard.container(p.id);
    await backend.start(p.id);
    return {};
  });
  route('POST', '/v1/containers/:id/stop', async (_req, p) => {
    await guard.container(p.id);
    await backend.stop(p.id);
    return {};
  });
  route('POST', '/v1/containers/:id/commit', async (req, p) => {
    const body = await readJsonBody(req);
    const tag = expect<string>(body.tag, isString, 'tag');
    const labels = expect<Labels>(body.labels, isLabels, 'labels');
    const changes = body.changes === undefined ? undefined : expect<string[]>(body.changes, isStringArray, 'changes');
    guard.image(tag);
    await guard.container(p.id);
    await backend.commitContainer(p.id, tag, labels, changes);
    return {};
  });
  route('POST', '/v1/remove', async req => {
    const body = await readJsonBody(req);
    const ids: { containers?: string[]; volumes?: string[]; networks?: string[] } = {};
    for (const key of ['containers', 'volumes', 'networks'] as const) {
      if (body[key] !== undefined) ids[key] = expect<string[]>(body[key], isStringArray, key);
    }
    await guard.removeIds(ids);
    await backend.remove(ids);
    for (const id of ids.containers ?? []) guard.forget(id);
    return {};
  });

  // ---- streaming bodies ----
  const streamOpts: StreamOptions = { backend, guard, token: opts.token, log };
  route('POST', '/v1/containers/:id/copy', (req, p, url) => serveCopyIn(req, p.id, url, streamOpts));
  route('POST', '/v1/images/:tag/build', (req, p) => serveBuild(req, p.tag, streamOpts));

  // ---- compose ----
  route('POST', '/v1/compose/config', async req => {
    const body = await readJsonBody(req);
    const yaml = expect<string>(body.yaml, isString, 'yaml');
    return { config: await backend.composeConfig(yaml) };
  });

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body ?? {});
    const headers: http.OutgoingHttpHeaders = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
    if (status === 413) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(text);
  };

  const sendError = (res: http.ServerResponse, err: unknown) => {
    if (err instanceof ServeError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      return send(res, err.status, body);
    }
    // A backend error: the message is what the local backend would have thrown, passed on verbatim
    const message = err instanceof Error ? err.message : String(err);
    const body: ErrorBody = { error: { code: 'backend', message } };
    send(res, 500, body);
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://kunj.invalid');
    const finish = (status: number) => log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    res.on('finish', () => finish(res.statusCode));
    if (!tokenMatches(bearerOf(req), opts.token)) {
      log(`unauthorized request from ${req.socket.remoteAddress ?? '?'}`);
      req.resume();
      return sendError(res, new ServeError(401, 'unauthorized', 'unauthorized'));
    }
    const segments = url.pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = matchRoute(r.pattern, segments);
      if (!params) continue;
      try {
        send(res, 200, await r.handler(req, params, url));
      } catch (err) {
        if (err instanceof ServeError && err.code === 'remote-refused') log(`refused ${req.method} ${url.pathname}: ${err.message}`);
        sendError(res, err);
      }
      return;
    }
    req.resume();
    sendError(res, new ServeError(404, 'not-found', `no route ${req.method} ${url.pathname}`));
  });

  const sockets = attachWebSockets(server, streamOpts);

  return {
    http: server,
    guard,
    listen: (host, port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        sockets.close();
        server.closeAllConnections?.();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}
