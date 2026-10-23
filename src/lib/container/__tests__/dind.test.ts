import { describe, it, expect } from '@jest/globals';
import { FakeBackend } from './fake-backend';
import { StartError } from '../errors';
import { DIND_DOMAINS, DIND_IMAGE, checkDind, dindHostInfo, dindMode, isDockerDesktop } from '../dind';
import { SANDBOX_IMAGE, assetHash } from '../image';

const LINUX = { runtimes: ['runc'], context: 'default', isDockerDesktop: false };
const SYSBOX = { runtimes: ['runc', 'sysbox-runc'], context: 'default', isDockerDesktop: false };
const DESKTOP = { runtimes: ['runc'], context: 'desktop-linux', isDockerDesktop: true };

async function refusal(p: Promise<void>): Promise<StartError> {
  try {
    await p;
  } catch (err) {
    return err as StartError;
  }
  throw new Error('expected a refusal');
}

describe('checkDind', () => {
  const b = new FakeBackend();

  it('allows off anywhere', async () => {
    await expect(checkDind(b, 'off', { allowPrivileged: false }, DESKTOP)).resolves.toBeUndefined();
  });

  it('refuses sysbox unless the daemon has the sysbox-runc runtime', async () => {
    const err = await refusal(checkDind(b, 'sysbox', { allowPrivileged: false }, LINUX));
    expect(err).toBeInstanceOf(StartError);
    expect(err.code).toBe('dind');
    expect(err.message).toContain('sysbox-runc');
    expect(err.message).toContain('container.dockerInDocker');
    await expect(checkDind(b, 'sysbox', { allowPrivileged: false }, SYSBOX)).resolves.toBeUndefined();
  });

  it('refuses privileged unless allowPrivileged', async () => {
    const err = await refusal(checkDind(b, 'privileged', { allowPrivileged: false }, LINUX));
    expect(err.code).toBe('dind');
    expect(err.message).toContain('container.allowPrivileged');
    await expect(checkDind(b, 'privileged', { allowPrivileged: true }, LINUX)).resolves.toBeUndefined();
    // Colima, OrbStack: a dedicated VM by context
    await expect(checkDind(b, 'privileged', { allowPrivileged: true }, { runtimes: [], context: 'colima-dind', isDockerDesktop: false })).resolves.toBeUndefined();
  });

  it('refuses privileged on Docker Desktop even with allowPrivileged, whatever the context is called', async () => {
    for (const context of ['desktop-linux', 'default', 'my-desktop']) {
      const err = await refusal(checkDind(b, 'privileged', { allowPrivileged: true }, { ...DESKTOP, context }));
      expect(err.code).toBe('dind');
      expect(err.message).toContain('Docker Desktop');
      expect(err.message).toContain('container.dockerContext');
    }
  });

  it('refuses a mode the backend does not support', async () => {
    const remote = new FakeBackend();
    (remote.features as { dockerInDocker: string[] }).dockerInDocker = [];
    const err = await refusal(checkDind(remote, 'sysbox', { allowPrivileged: false }, SYSBOX));
    expect(err.code).toBe('dind');
  });
});

describe('dind helpers', () => {
  it('dindMode reads the setting and treats anything unknown as off', () => {
    expect(dindMode(undefined)).toBe('off');
    expect(dindMode({ dockerInDocker: 'sysbox' })).toBe('sysbox');
    expect(dindMode({ dockerInDocker: 'privileged' })).toBe('privileged');
    expect(dindMode({ dockerInDocker: 'yes' as never })).toBe('off');
  });

  it('isDockerDesktop goes by the operating system docker info reports', () => {
    expect(isDockerDesktop({ operatingSystem: 'Docker Desktop' })).toBe(true);
    expect(isDockerDesktop({ operatingSystem: 'Ubuntu 24.04.1 LTS' })).toBe(false);
    expect(isDockerDesktop({ operatingSystem: 'OrbStack' })).toBe(false);
  });

  it('dindHostInfo asks the backend for runtimes and the context', async () => {
    const b = new FakeBackend();
    b.infoResult = { serverVersion: '27', runtimes: ['runc', 'sysbox-runc'], operatingSystem: 'Docker Desktop' };
    b.context = 'desktop-linux';
    expect(await dindHostInfo(b)).toEqual({ runtimes: ['runc', 'sysbox-runc'], context: 'desktop-linux', isDockerDesktop: true });
  });

  it('the DinD image tag covers its own build context and the base tag', () => {
    expect(DIND_IMAGE('1.0.0')).toMatch(/^kunj-sandbox-dind:1\.0\.0-[0-9a-f]{12}$/);
    expect(DIND_IMAGE('1.0.0')).not.toBe(DIND_IMAGE('1.0.1').replace('1.0.1', '1.0.0'));
    expect(DIND_IMAGE('1.0.0').endsWith(assetHash('sandbox-dind'))).toBe(false);
    expect(SANDBOX_IMAGE('1.0.0')).not.toBe(DIND_IMAGE('1.0.0'));
  });

  it('allowlists Docker Hub, its CDN and ghcr', () => {
    expect(DIND_DOMAINS).toEqual([
      'registry-1.docker.io',
      'auth.docker.io',
      'production.cloudflare.docker.com',
      'index.docker.io',
      'ghcr.io',
      'pkg-containers.githubusercontent.com',
    ]);
  });
});
