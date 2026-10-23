// Docker-in-Docker: a branch container with its own dockerd (container.dockerInDocker). Off by
// default. `sysbox` runs the container under the sysbox-runc runtime, which keeps inner containers
// inside the sandbox's user namespace; `privileged` runs it with --privileged, which an escape turns
// into root on the Docker host's VM, so it needs container.allowPrivileged and is refused on Docker
// Desktop, whose VM shares the home directory. Either way the container keeps its capabilities, its
// /var/lib/docker is a per-branch volume, and dockerd is started as root only after the firewall
// helper reported ready (lifecycle.ts). Snapshots never run it.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ContainerBackend, EngineInfo, ExecTimeoutError } from './backend';
import { StartError } from './errors';
import { ImageSource, SANDBOX_IMAGE, assetBuild, assetHash } from './image';
import { KunjConfig } from '../../types';

export type DindMode = 'off' | 'sysbox' | 'privileged';
export const DIND_MODES: DindMode[] = ['off', 'sysbox', 'privileged'];

/** In the DinD image; starts dockerd as root and waits for it (src/container/sandbox-dind/). */
export const DIND_START = '/usr/local/bin/kunj-dind-start';
export const DIND_DATA = '/var/lib/docker';
const SYSBOX_RUNTIME = 'sysbox-runc';
// The start script waits 30 s for dockerd; this only bounds a hung exec
const DIND_START_TIMEOUT_MS = 45000;

/** What `docker pull` reaches: Docker Hub, its CDN, and ghcr.io with its blob host. */
export const DIND_DOMAINS = [
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'index.docker.io',
  'ghcr.io',
  'pkg-containers.githubusercontent.com',
];

/** The image built FROM the sandbox; its tag covers its own context and the base tag, so a new sandbox rebuilds it. */
export const DIND_IMAGE = (version: string) => {
  const base = SANDBOX_IMAGE(version);
  const hash = crypto.createHash('sha1').update(`${assetHash('sandbox-dind')}\n${base}`).digest('hex').slice(0, 12);
  return `kunj-sandbox-dind:${version}-${hash}`;
};

export function dindMode(config: KunjConfig['container']): DindMode {
  const mode = config?.dockerInDocker;
  return mode && DIND_MODES.includes(mode) ? mode : 'off';
}

export function isDockerDesktop(info: Pick<EngineInfo, 'operatingSystem'>): boolean {
  return /docker desktop/i.test(info.operatingSystem);
}

/** What checkDind needs from the daemon: one docker info, one context lookup. */
export async function dindHostInfo(
  backend: ContainerBackend,
  info?: EngineInfo
): Promise<{ runtimes: string[]; context: string; isDockerDesktop: boolean }> {
  const engine = info ?? (await backend.info());
  return { runtimes: engine.runtimes, context: await backend.contextName(), isDockerDesktop: isDockerDesktop(engine) };
}

/** Throws StartError('dind') when the mode cannot or must not run here; called before anything is created. */
export async function checkDind(
  backend: ContainerBackend,
  mode: DindMode,
  cfg: { allowPrivileged: boolean },
  info: { runtimes: string[]; context: string; isDockerDesktop: boolean }
): Promise<void> {
  if (mode === 'off') return;
  if (!backend.features.dockerInDocker.includes(mode)) {
    throw new StartError(`container.dockerInDocker "${mode}" is not supported by this backend; set it to "off"`, 'dind');
  }
  if (mode === 'sysbox') {
    if (!info.runtimes.includes(SYSBOX_RUNTIME)) {
      throw new StartError(
        `container.dockerInDocker is "sysbox", but the Docker daemon (context ${info.context}) has no ${SYSBOX_RUNTIME} runtime; ` +
          'install sysbox on the Docker host (Linux), or set container.dockerInDocker to "privileged" or "off"',
        'dind'
      );
    }
    return;
  }
  if (!cfg.allowPrivileged) {
    throw new StartError(
      'container.dockerInDocker is "privileged", which gives the container root on the Docker host (on a Mac, its VM); ' +
        'set container.allowPrivileged to true to allow it, on a dedicated Docker context (e.g. a Colima profile with file sharing off), ' +
        'or use "sysbox"',
      'dind'
    );
  }
  // Any context: Docker Desktop has one VM, which shares the home directory, whatever the context is called
  if (info.isDockerDesktop) {
    throw new StartError(
      `container.dockerInDocker "privileged" is refused on Docker Desktop (context ${info.context}): its VM shares your home directory. ` +
        'Point container.dockerContext at a dedicated VM (e.g. a Colima profile with file sharing off), or use "sysbox" on a Linux host',
      'dind'
    );
  }
}

/** The DinD image in place of the sandbox; anything else (a devcontainer, container.image, --image) is refused. */
export function dindSource(base: ImageSource, kunjVersion: string): ImageSource {
  if (base.kind !== 'sandbox') {
    throw new StartError(
      `container.dockerInDocker needs the kunj sandbox image in this version, but this start uses the ${base.kind} image ${base.tag}; ` +
        'unset container.image (or --image) and use no devcontainer, or set container.dockerInDocker to "off"',
      'dind'
    );
  }
  return {
    kind: 'sandbox',
    tag: DIND_IMAGE(kunjVersion),
    build: assetBuild('sandbox-dind', { BASE_IMAGE: base.tag }),
    user: base.user,
    base,
  };
}

/** Starts dockerd as root (after READY) and waits for it; a daemon that does not come up is a warning. */
export async function startDockerd(backend: ContainerBackend, id: string, warn: (m: string) => void): Promise<boolean> {
  try {
    const r = await backend.exec(id, [DIND_START], { user: 'root', timeoutMs: DIND_START_TIMEOUT_MS });
    if (r.exitCode === 0) return true;
    const reason = r.stdout.trim().split('\n').pop();
    warn(`Docker inside the container did not start (exit ${r.exitCode}${reason ? `: ${reason}` : ''}); see /var/log/kunj-dockerd.log in the container`);
  } catch (err) {
    const why = err instanceof ExecTimeoutError ? 'timed out' : err instanceof Error ? err.message : String(err);
    warn(`Docker inside the container did not start (${why}); see /var/log/kunj-dockerd.log in the container`);
  }
  return false;
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** A one-line hint when the working tree has a compose file but the container has no Docker. */
export function composeHint(root: string): string | null {
  const file = COMPOSE_FILES.find(f => fs.existsSync(path.join(root, f)));
  if (!file) return null;
  return (
    `${file}: this repository has a compose file, but there is no Docker inside the container; ` +
    'declare its databases as container.services (sidecars), or set container.dockerInDocker'
  );
}
