import { createHash } from 'crypto';
import { branchToDirName } from '../worktree';

// Normalise a remote URL (or local path) so ssh and https forms of one repo give the same id
export function repoIdFromUrl(url: string): string {
  let id = url.trim().toLowerCase();
  id = id.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]+@/, '');
  // scp-like host:path -> host/path (a leading "/" or "." means a local path, which has no host)
  id = id.replace(/^([^/:]+):(?!\/\/)/, '$1/');
  return id.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

// branchToDirName collapses feature/x and feature-x, and repo names are not unique,
// so every name carries a short hash of the full repo id and branch
export function nameHash(repoId: string, branch: string): string {
  return createHash('sha1').update(`${repoId}\n${branch}`).digest('hex').slice(0, 6);
}

export interface ContainerNames {
  container: string;
  helper: string;
  workspaceVolume: string;
  homeVolume: string;
  /** The inner dockerd's /var/lib/docker (Docker-in-Docker only) */
  dockerVolume: string;
  network: string;
}

// Docker names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*; branchToDirName leaves #, @, unicode etc. in
export function dockerSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[^a-zA-Z0-9]+/, '').replace(/[-.]+$/, '');
}

// Cap on the readable "<repo>-<branch>" part, so "<container>-net-helper" stays under 64 chars
const MAX_READABLE = 40;

export function containerNames(repoName: string, repoId: string, branch: string): ContainerNames {
  const readable = dockerSafe(`${dockerSafe(repoName)}-${dockerSafe(branchToDirName(branch))}`).slice(0, MAX_READABLE).replace(/[-.]+$/, '');
  return namesOfContainer(`kunj-${readable}-${nameHash(repoId, branch)}`);
}

/** The names that go with a branch container, from its own name (survives a renamed repository). */
export function namesOfContainer(container: string): ContainerNames {
  return {
    container,
    helper: `${container}-net-helper`,
    workspaceVolume: `${container}-ws`,
    homeVolume: `${container}-home`,
    dockerVolume: `${container}-docker`,
    network: `${container}-net`,
  };
}

export const LABEL = {
  repo: 'kunj.repo',
  branch: 'kunj.branch',
  base: 'kunj.base',
  version: 'kunj.version',
  options: 'kunj.options',
  role: 'kunj.role', // 'main' | 'helper' | 'service'
  service: 'kunj.service', // a service container's name in its blueprint, config or compose file
  blueprintHash: 'kunj.blueprint.hash',
  blueprintRef: 'kunj.blueprint.ref',
  blueprintBase: 'kunj.blueprint.base',
  blueprintUser: 'kunj.blueprint.user',
  blueprintCreatedAt: 'kunj.blueprint.createdAt',
  // The vault stamp (vaultStamp) when the container was created: a hash of ciphertext, never a value
  secrets: 'kunj.secrets',
} as const;

export function labelsFor(repoId: string, branch: string, extra: Record<string, string> = {}): Record<string, string> {
  return { [LABEL.repo]: repoId, [LABEL.branch]: branch, ...extra };
}

// Exact comparison: the hashed name alone could in theory collide, the labels cannot
export function labelsMatch(labels: Record<string, string> | undefined, repoId: string, branch: string): boolean {
  return !!labels && labels[LABEL.repo] === repoId && labels[LABEL.branch] === branch;
}

/** A container's kunj.options label as an object ({} when absent or unreadable). */
export function optionsLabel(labels: Record<string, string> | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(labels?.[LABEL.options] ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A branch container, not its network helper or a service (containers from before kunj.role go by name). */
export function isMain(c: { name: string; labels: Record<string, string> }): boolean {
  const role = c.labels[LABEL.role];
  return role ? role === 'main' : !c.name.endsWith('-net-helper');
}
