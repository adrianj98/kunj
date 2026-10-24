// Runs a FakeBackend behind a real `kunj serve` on a loopback port and hands tests a backend whose
// ContainerBackend methods cross the wire (RemoteKunjBackend) while its FakeBackend fields
// (existing, calls, execResults, …) are the fake's own, so a test written for the fake sets up and
// asserts exactly as before. `testBackend()` is the plain fake unless KUNJ_TEST_REMOTE=1
// (`npm run test:remote`), which runs the same suites over the wire.

import { afterAll } from '@jest/globals';
import { ContainerBackend } from '../backend';
import { RemoteKunjBackend } from '../remote';
import { ServeServer, createServeServer } from '../../serve/server';
import { FakeBackend } from './fake-backend';

export const HARNESS_TOKEN = 'harness-token';

const BACKEND_METHODS: Array<keyof ContainerBackend> = [
  'info', 'contextName', 'imageExists', 'buildImage', 'commitContainer', 'listImages', 'removeImage',
  'createNetwork', 'createVolume', 'volumeExists', 'listVolumes', 'listNetworks', 'run', 'list',
  'inspectLabels', 'containerState', 'containerRun', 'exec', 'copyIn', 'start', 'stop', 'remove',
  'composeConfig', 'logs', 'events',
];

export interface Harness {
  fake: FakeBackend;
  remote: RemoteKunjBackend;
  server: ServeServer;
  port: number;
  close(): Promise<void>;
}

/** A server over `fake` (a new one unless given) and a ready RemoteKunjBackend talking to it. */
export async function startHarness(fake = new FakeBackend(), serverOpts: { allowPrivileged?: boolean; allowRuntimes?: string[] } = {}): Promise<Harness> {
  const server = createServeServer({ backend: fake, token: HARNESS_TOKEN, version: 'test', ...serverOpts });
  const { port } = await server.listen('127.0.0.1', 0);
  const remote = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${port}`, token: HARNESS_TOKEN, name: 'harness' });
  await remote.ready();
  return { fake, remote, server, port, close: () => server.close() };
}

// One server per test file, started on the first wired backend and closed after the file's tests
let shared: Promise<ServeServer & { port: number }> | undefined;
const fakes = new Map<ServeServer, { current: FakeBackend }>();

function sharedServer(): Promise<ServeServer & { port: number }> {
  if (!shared) {
    const holder = { current: new FakeBackend() };
    // The server sees whichever fake the newest wired backend wraps
    const proxyBackend = new Proxy({} as ContainerBackend, {
      get: (_t, key) => {
        const value = (holder.current as any)[key];
        return typeof value === 'function' ? value.bind(holder.current) : value;
      },
    });
    const server = createServeServer({ backend: proxyBackend, token: HARNESS_TOKEN, version: 'test', allowPrivileged: true, allowRuntimes: ['sysbox-runc'] });
    shared = server.listen('127.0.0.1', 0).then(a => {
      fakes.set(server, holder);
      afterAll(() => server.close());
      return Object.assign(server, { port: a.port });
    });
  }
  return shared;
}

/**
 * `fake` with its backend methods routed over the shared server. Sync, because tests build their
 * backend synchronously: the first wire call waits for the server. Only one wired backend is active
 * at a time per test file (the last one made), which is how the fake-based suites use them.
 */
export function wireBackend(fake: FakeBackend): FakeBackend {
  let remote: Promise<RemoteKunjBackend> | undefined;
  const connect = () => {
    if (!remote) {
      remote = sharedServer().then(async server => {
        fakes.get(server)!.current = fake;
        const r = new RemoteKunjBackend({ baseUrl: `http://127.0.0.1:${server.port}`, token: HARNESS_TOKEN, name: 'harness' });
        await r.ready();
        return r;
      });
    }
    return remote;
  };
  // Each wired backend makes itself the server's fake when first used, so sequential tests work
  return new Proxy(fake, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && (BACKEND_METHODS as string[]).includes(key)) {
        return async (...args: unknown[]) => {
          const r = await connect();
          const server = await sharedServer();
          fakes.get(server)!.current = fake;
          return (r as any)[key](...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

export const REMOTE_TESTS = process.env.KUNJ_TEST_REMOTE === '1';

/** A FakeBackend, wired over the protocol when KUNJ_TEST_REMOTE=1. */
export function testBackend(): FakeBackend {
  const fake = new FakeBackend();
  return REMOTE_TESTS ? wireBackend(fake) : fake;
}
