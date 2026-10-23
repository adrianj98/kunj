// A sidecar service reachable by name from its own branch container only, and its logs, through the
// built CLI. Opt-in: npm run test:functional.
//
// The service is busybox `nc` in alpine rather than Postgres: a few MB to pull instead of ~100, it is
// healthy in a second instead of after initdb, and it still exercises everything kunj does for a
// service (its own container on the branch network, a network alias, a health check, logs).
// The in-process Docker suite already runs a real Postgres.
import { describe, it, expect } from '@jest/globals';
import type { ContainerListJson } from '../../src/lib/json-types';
import { describeFunctional, useFixture } from './harness';

const SERVICES = {
  echo: {
    image: 'alpine:3.20',
    command: ['sh', '-c', 'echo ft-svc-ready; while true; do echo pong | nc -l -p 7000; done'],
    port: 7000,
    healthcheck: 'netstat -ltn | grep -q :7000',
  },
};
// From a branch container: connect to echo:7000 and read its greeting
const REACH = `timeout 5 bash -c 'exec 3<>/dev/tcp/echo/7000; head -c 4 <&3'`;

describeFunctional('kunj ct (functional): services', () => {
  const ctx = useFixture('svc');

  describe('a service', () => {
    it('is reachable by name from its branch container, not from another branch\'s, and has logs', async () => {
      const { fx } = ctx;
      fx.writeConfig({ container: { services: SERVICES } });
      const a = await fx.start('ft-svc-a');
      expect(a.services).toEqual(['echo']);

      // Another branch without services, on its own network
      fx.writeConfig({});
      const b = await fx.start('ft-svc-b');
      expect(b.services ?? []).toEqual([]);

      const reached = await fx.sh('ft-svc-a', REACH);
      expect(reached.status).toBe(0);
      expect(reached.stdout).toBe('pong');

      expect((await fx.sh('ft-svc-b', REACH)).status).not.toBe(0);
      const svcName = `${a.names.container}-svc-echo`;
      const ip = fx.inspect<Record<string, { IPAddress: string }>>(svcName, '.NetworkSettings.Networks');
      const address = Object.values(ip)[0]?.IPAddress;
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect((await fx.sh('ft-svc-b', `timeout 5 bash -c '</dev/tcp/${address}/7000'`)).status).not.toBe(0);

      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.containers.find(c => c.branch === 'ft-svc-a')?.services).toEqual([
        expect.objectContaining({ name: 'echo', state: 'running', port: 7000 }),
      ]);
      expect(list.containers.find(c => c.branch === 'ft-svc-b')?.services).toEqual([]);

      const logs = await fx.kunj(['ct', 'logs', 'ft-svc-a', 'echo']);
      expect(logs.status).toBe(0);
      expect(logs.stdout + logs.stderr).toContain('ft-svc-ready');

      // remove takes the service with it
      await fx.kunjJson(['ct', 'remove', 'ft-svc-a', '--force']);
      expect(fx.labelled('ft-svc-a')).toEqual({ containers: [], volumes: [], networks: [] });
    });
  });
});
