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
import { ProxyResolver, proxyHttp, proxyRoute } from './proxy';
import { PASSIVE_HEADER, StreamOptions, attachWebSockets, serveBuild, serveCopyIn } from './streams';
import { Authenticator, newToken, singleTokenAuthenticator, tokenMatches } from './token';

export interface ServeOptions {
  backend: ContainerBackend;
  /** One fixed token (client `default`); `authenticate` replaces it */
  token?: string;
  /** Who a bearer token belongs to (named clients, docs/specs/cloud-machines.md); null refuses */
  authenticate?: Authenticator;
  /**
   * A machine's first boot (`kunj serve --allow-pairing` without a token): until `until`, one
   * unauthenticated POST /v1/pair gets a fresh token, handed to `onPaired` to store; every other
   * request is 401 until then. The path to the server must itself be access-controlled.
   */
  pairing?: { until: number; onPaired(token: string): void };
  /** Adds routes and /v1/info fields (the coordinator's machine routes) */
  extend?: (api: ServeExtension) => void;
  /** kunj's version, reported in /v1/info */
  version: string;
  allowPrivileged?: boolean;
  allowRuntimes?: string[];
  /** One line per request (method, route, status, ms) and per refusal; never a body or a token. */
  log?: (line: string) => void;
  /** An exec or logs stream opened or closed (a machine's idle timer counts them) */
  onStream?: (open: boolean) => void;
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
/** `client` is the name the request's token belongs to */
export type Handler = (req: http.IncomingMessage, params: Params, url: URL, client: string) => Promise<unknown>;

export interface ServeExtension {
  route(method: string, path: string, handler: Handler): void;
  /** Extra fields for GET /v1/info */
  info(extra: () => Promise<Partial<InfoJson>>): void;
  /** Serves /v1/machines/<name>/serve/v1/… by passing it to that machine's serve */
  proxy(resolver: ProxyResolver): void;
  log(line: string): void;
}

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
  const infoExtras: Array<() => Promise<Partial<InfoJson>>> = [];
  let proxyResolver: ProxyResolver | undefined;

  const base: Authenticator = opts.authenticate ?? (opts.token ? singleTokenAuthenticator(opts.token) : () => null);
  let pairedToken: string | undefined;
  let pairedNonce = '';
  const authenticate: Authenticator = given => (pairedToken && tokenMatches(given, pairedToken) ? 'paired' : base(given));

  let context: Promise<string> | undefined;
  route('GET', '/v1/info', async () => {
    // Docker-in-Docker is reported only as the flags allow it, so the client refuses before trying
    const dind = backend.features.dockerInDocker.filter(
      mode => (mode === 'privileged' && flags.allowPrivileged) || (mode === 'sysbox' && flags.allowRuntimes.includes('sysbox-runc')));
    // An editor on the laptop cannot attach through the box's Docker; local ports work (the forwarder runs on the laptop)
    const features = { ...backend.features, editorAttach: false, dockerInDocker: dind };
    context ??= backend.contextName().catch(() => 'default');
    const info: InfoJson = { kunj: opts.version, protocol: PROTOCOL_VERSION, features, context: await context };
    for (const extra of infoExtras) Object.assign(info, await extra());
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
    await guard.runSpec(spec);
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
  const unauthorizedAt = new Map<string, number>();
  const logUnauthorized = (what: string, address: string | undefined) => {
    const addr = address ?? '?';
    const now = Date.now();
    const last = unauthorizedAt.get(addr);
    if (last !== undefined && now - last < 60_000) return;
    unauthorizedAt.set(addr, now);
    log(`${what} from ${addr}`);
  };
  const streamOpts: StreamOptions = { backend, guard, authenticate, log, logUnauthorized, proxy: () => proxyResolver, onStream: opts.onStream };
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
    let client = '';
    const finish = (status: number) => log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms${client ? ` (${client})` : ''}${req.headers[PASSIVE_HEADER] ? ' passive' : ''}`);
    res.on('finish', () => finish(res.statusCode));
    // In flight is in use (a long image build or upload has no stream): counted like one, for a machine's idle timer
    if (opts.onStream && !req.headers[PASSIVE_HEADER] && url.pathname !== '/v1/info') {
      opts.onStream(true);
      res.once('close', () => opts.onStream?.(false));
    }
    if (req.method === 'POST' && url.pathname === '/v1/pair') {
      // The caller's nonce makes pairing repeatable for that caller only: a reply lost on the way
      // (a dropped tunnel) must not leave the machine paired with a token nobody stored
      let nonce = '';
      try {
        const body = await readJsonBody(req);
        if (typeof body?.nonce === 'string' && body.nonce.length >= 16 && body.nonce.length <= 128) nonce = body.nonce;
      } catch (err) {
        return sendError(res, err);
      }
      const open = !!opts.pairing && Date.now() < opts.pairing.until;
      if (open && pairedToken && pairedNonce && tokenMatches(nonce, pairedNonce)) return send(res, 200, { token: pairedToken });
      if (!open || pairedToken) {
        return sendError(res, new ServeError(403, 'pairing-closed', 'pairing is closed on this server'));
      }
      const token = newToken();
      try {
        opts.pairing!.onPaired(token);
      } catch (err) {
        return sendError(res, err);
      }
      pairedToken = token;
      pairedNonce = nonce;
      log(`paired with ${req.socket.remoteAddress ?? '?'}`);
      return send(res, 200, { token });
    }
    const who = authenticate(bearerOf(req));
    if (who === null) {
      logUnauthorized('unauthorized request', req.socket.remoteAddress);
      req.resume();
      return sendError(res, new ServeError(401, 'unauthorized', 'unauthorized'));
    }
    const proxied = proxyResolver ? proxyRoute(url.pathname) : null;
    if (proxied) {
      client = who;
      try {
        return proxyHttp(req, res, await proxyResolver!(proxied.name, !!req.headers[PASSIVE_HEADER]), proxied.path + url.search);
      } catch (err) {
        req.resume();
        return sendError(res, err);
      }
    }
    const segments = url.pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = matchRoute(r.pattern, segments);
      if (!params) continue;
      client = who;
      try {
        send(res, 200, await r.handler(req, params, url, who));
      } catch (err) {
        if (err instanceof ServeError && err.code === 'remote-refused') log(`refused ${req.method} ${url.pathname}: ${err.message}`);
        sendError(res, err);
      }
      return;
    }
    req.resume();
    sendError(res, new ServeError(404, 'not-found', `no route ${req.method} ${url.pathname} on kunj serve ${opts.version} (run the same kunj version on both machines)`));
  });

  opts.extend?.({ route, info: extra => infoExtras.push(extra), log, proxy: resolver => (proxyResolver = resolver) });

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
