// Runs a FakeBackend behind a real `kunj serve` on a loopback port and hands tests a backend whose
// ContainerBackend methods cross the wire (RemoteKunjBackend) while its FakeBackend fields
// (existing, calls, execResults, …) are the fake's own, so a test written for the fake sets up and
// asserts exactly as before. `testBackend()` is the plain fake unless KUNJ_TEST_REMOTE=1
// (`npm run test:remote`), which runs the same suites over the wire.

import { afterAll, it } from '@jest/globals';
import * as http from 'http';
import { ContainerBackend, Labels } from '../backend';
import { RemoteKunjBackend } from '../remote';
import { GuardLookup } from '../../serve/guard';
import { ServeServer, createServeServer } from '../../serve/server';
import { FakeBackend } from './fake-backend';

export const HARNESS_TOKEN = 'harness-token';

const BACKEND_METHODS: Array<keyof ContainerBackend> = [
  'info', 'contextName', 'imageExists', 'buildImage', 'commitContainer', 'listImages', 'removeImage',
  'createNetwork', 'createVolume', 'volumeExists', 'listVolumes', 'listNetworks', 'run', 'list',
  'inspectLabels', 'containerState', 'containerRun', 'exec', 'copyIn', 'start', 'stop', 'remove',
  'composeConfig', 'logs', 'events',
];

/** Reads the fake's labels without going through its recorded methods, so `calls` stays the test's. */
function fakeLookup(current: () => FakeBackend): GuardLookup {
  return {
    container: async id => {
      const fake = current();
      const c = fake.existing.find(c => c.name === id || c.id === id);
      return c ? c.labels : null;
    },
    // A volume the test added without labels is a shortcut for one kunj made: not someone else's
    volumes: async () => [...current().volumeLabels].map(([name, labels]) => ({ name, labels })),
    networks: async () => [...current().networks].map(([name, labels]) => ({ name, labels })),
  };
}

export interface Harness {
  fake: FakeBackend;
  remote: RemoteKunjBackend;
  server: ServeServer;
  port: number;
  close(): Promise<void>;
}

/** A server over `fake` (a new one unless given) and a ready RemoteKunjBackend talking to it. */
export async function startHarness(fake = new FakeBackend(), serverOpts: { allowPrivileged?: boolean; allowRuntimes?: string[] } = {}): Promise<Harness> {
  const server = createServeServer({ backend: fake, token: HARNESS_TOKEN, version: 'test', guardLookup: fakeLookup(() => fake), ...serverOpts });
  const { port } = await server.listen('127.0.0.1', 0);
  const remote = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${port}`, token: HARNESS_TOKEN, name: 'harness' });
  await remote.ready();
  return { fake, remote, server, port, close: () => server.close() };
}

export const REMOTE_TESTS = process.env.KUNJ_TEST_REMOTE === '1';

// One server per test file (one Jest module registry), started on the first wired call. The server
// sees whichever fake was wired last, which is how the fake-based suites use their backends: one
// at a time. Registered for closing at load time, because hooks cannot be added from inside a test.
let shared: Promise<{ server: ServeServer; port: number }> | undefined;
const holder: { current: FakeBackend } = { current: new FakeBackend() };

if (REMOTE_TESTS) {
  afterAll(async () => {
    http.globalAgent.destroy();
    if (shared) await (await shared).server.close();
  });
}

function sharedServer(): Promise<{ server: ServeServer; port: number }> {
  if (!shared) {
    // The server runs the fake's own methods (the prototype's): a method a test replaced on the
    // instance is the test's and runs on the client side, else it would call itself over the wire
    const proxyBackend = new Proxy({} as ContainerBackend, {
      get: (_t, key) => {
        const value = (FakeBackend.prototype as any)[key] ?? (holder.current as any)[key];
        return typeof value === 'function' ? value.bind(holder.current) : value;
      },
    });
    const server = createServeServer({
      backend: proxyBackend,
      token: HARNESS_TOKEN,
      version: 'test',
      allowPrivileged: true,
      allowRuntimes: ['sysbox-runc'],
      guardLookup: fakeLookup(() => holder.current),
    });
    shared = server.listen('127.0.0.1', 0).then(async a => {
      server.http.unref();
      // The server asks the Docker context once, on its first /v1/info: ask it now, while the backend
      // is still the placeholder, so no test's fake records that contextName call
      await new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${a.port}`, token: HARNESS_TOKEN, name: 'harness' }).ready();
      return { server, port: a.port };
    });
  }
  return shared;
}

/**
 * `fake` with its backend methods routed over the shared server. Sync, because tests build their
 * backend synchronously: the first wire call waits for the server.
 */
export function wireBackend(fake: FakeBackend): FakeBackend {
  let remote: Promise<RemoteKunjBackend> | undefined;
  const connect = async () => {
    const { port } = await sharedServer();
    holder.current = fake;
    if (!remote) {
      remote = (async () => {
        const r = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${port}`, token: HARNESS_TOKEN, name: 'harness' });
        await r.ready();
        return r;
      })();
    }
    return remote;
  };
  return new Proxy(fake, {
    get: (target, key, receiver) => {
      if (key === 'features') return fake.features;
      // A method the test replaced on the instance (jest.spyOn, fake.exec = …) is the test's: local
      if (typeof key === 'string' && (BACKEND_METHODS as string[]).includes(key) && !Object.prototype.hasOwnProperty.call(target, key)) {
        return async (...args: unknown[]) => {
          const r = await connect();
          return (r as any)[key](...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * A test that holds only with the fake in-process: it compares the stream objects the backend was
 * handed, or asserts on a call the moment a function returns. Over the wire the server has its own
 * streams and records the call when the request arrives.
 */
export const itLocal: typeof it = REMOTE_TESTS ? (it.skip as typeof it) : it;

/** A FakeBackend, wired over the protocol when KUNJ_TEST_REMOTE=1. */
export function testBackend(): FakeBackend {
  const fake = new FakeBackend();
  return REMOTE_TESTS ? wireBackend(fake) : fake;
}

export type { Labels };
