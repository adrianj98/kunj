// Docker-in-Docker through the built CLI: what this daemon must not run is refused before anything is
// created; a real start only where it can run. Opt-in: npm run test:functional.
//
// A real start needs sysbox-runc on the daemon, or KUNJ_TEST_DIND_PRIVILEGED=1 and a daemon that is
// not Docker Desktop (a throwaway Colima profile, say, selected with DOCKER_CONTEXT). That is decided
// when the tests are defined, so elsewhere it shows as skipped.
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { isDockerDesktop } from '../../src/lib/container/dind';
import type { ContainerListJson } from '../../src/lib/json-types';
import { describeFunctional, functionalEnabled, readMarker, useFixture } from './harness';

let runtimes: string[] = [];
let desktop = false;
if (functionalEnabled) {
  try {
    const engine = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20000 }));
    runtimes = Object.keys(engine.Runtimes ?? {});
    desktop = isDockerDesktop({ operatingSystem: engine.OperatingSystem ?? '' });
  } catch {
    // global-setup has checked Docker; a failure here leaves the real start skipped
  }
}
const hasSysbox = runtimes.includes('sysbox-runc');
const realMode: 'sysbox' | 'privileged' | null = hasSysbox
  ? 'sysbox'
  : process.env.KUNJ_TEST_DIND_PRIVILEGED === '1' && !desktop
    ? 'privileged'
    : null;

describeFunctional('kunj ct (functional): Docker-in-Docker', () => {
  const ctx = useFixture('dind');

  describe('refusals', () => {
    it('privileged without container.allowPrivileged is refused with code dind, before the hook and before anything is created', async () => {
      const { fx } = ctx;
      const marker = path.join(fx.scratch, 'pre-create');
      fx.writeConfig({
        container: { dockerInDocker: 'privileged' },
        hooks: { 'pre-container-create': `touch ${marker}` },
      });
      const err = await fx.kunjJsonError(['ct', 'start', '-c', 'ft-dind-priv']);
      expect(err.code).toBe('dind');
      expect(fx.labelled()).toEqual({ containers: [], volumes: [], networks: [] });
      expect(readMarker(marker)).toBeNull();
    });

    (hasSysbox ? it.skip : it)('sysbox without the sysbox-runc runtime is refused with code dind and nothing is created', async () => {
      const { fx } = ctx;
      fx.writeConfig({ container: { dockerInDocker: 'sysbox' } });
      const err = await fx.kunjJsonError(['ct', 'start', '-c', 'ft-dind-sysbox']);
      expect(err.code).toBe('dind');
      expect(err.message).toMatch(/sysbox/i);
      expect(fx.labelled()).toEqual({ containers: [], volumes: [], networks: [] });
    });

    (desktop ? it : it.skip)('privileged is refused on Docker Desktop even when allowed', async () => {
      const { fx } = ctx;
      fx.writeConfig({ container: { dockerInDocker: 'privileged', allowPrivileged: true } });
      const err = await fx.kunjJsonError(['ct', 'start', '-c', 'ft-dind-desktop']);
      expect(err.code).toBe('dind');
      expect(err.message).toMatch(/Docker Desktop/);
      expect(fx.labelled()).toEqual({ containers: [], volumes: [], networks: [] });
    });
  });

  describe('a real start', () => {
    (realMode ? it : it.skip)('runs docker inside, with /var/lib/docker on the branch volume', async () => {
      const { fx } = ctx;
      const branch = 'ft-dind';
      fx.writeConfig({ container: { dockerInDocker: realMode, ...(realMode === 'privileged' ? { allowPrivileged: true } : {}) } });
      const started = await fx.start(branch);
      expect(started.dind).toBe(realMode);

      const run = await fx.exec(branch, ['docker', 'run', '--rm', 'alpine:3.20', 'true']);
      expect(run.status).toBe(0);
      const mounts = fx.inspect<Array<{ Name?: string; Destination: string }>>(started.names.container, '.Mounts');
      expect(mounts.find(m => m.Destination === '/var/lib/docker')?.Name).toBe(started.names.dockerVolume);

      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.containers.find(c => c.branch === branch)?.dind).toBe(realMode);

      await fx.kunjJson(['ct', 'remove', branch, '--force']);
      expect(fx.labelled(branch)).toEqual({ containers: [], volumes: [], networks: [] });
    });
  });
});
