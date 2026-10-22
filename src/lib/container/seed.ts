import { execFile } from 'child_process';
import { promisify } from 'util';
import { shellQuote } from '../config-vars';

const execFileAsync = promisify(execFile);

export const SEED_MARKER = '/workspace/.kunj-seeded';
export const SEED_MARKER_EXCLUDE = '.kunj-seeded';
/** Present from before a seed copy starts until it is complete: only then is /workspace wiped. */
export const SEED_COPYING = '.kunj-copying';
/** Present from a complete seed copy until its branch is moved to origin's. */
export const SEED_FRESH = '.kunj-fresh';

export interface OriginState {
  /** origin's URL without credentials (see stripUserinfo) */
  originUrl: string;
  /** Bare host name, for the firewall */
  originHost: string;
  /** What git sends as `host=` to a credential helper: host:port when the URL has a port */
  credentialHost: string;
  branchOnOrigin: boolean;
  unpushed: number;
  isSsh: boolean;
}

const NETWORK_TIMEOUT_MS = 30000;

// Network git calls must never wait on a prompt (terminal, askpass helpers, ssh)
function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function succeeds(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/;

/**
 * Drop credentials from a remote URL (`https://user:token@host/...`), so a token kept in the host's
 * remote never reaches the container, an exec argv or an error message. An ssh:// URL keeps its
 * user name (git@), which the insteadOf rewrite matches; scp-like URLs have no password to drop.
 */
export function stripUserinfo(url: string): string {
  // Greedy: a password may itself contain '@' before the host
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i.exec(url);
  if (!m) return url;
  const rest = url.slice(m[0].length);
  if (/^ssh:/i.test(m[1])) {
    const user = m[2].split(':')[0];
    return `${m[1]}${user ? `${user}@` : ''}${rest}`;
  }
  return m[1] + rest;
}

export function parseOrigin(url: string): { host: string; credentialHost: string; isSsh: boolean } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      // URL.host omits the scheme's default port, as git does
      return { host: u.hostname, credentialHost: u.host, isSsh: u.protocol === 'ssh:' };
    } catch {
      return { host: '', credentialHost: '', isSsh: false };
    }
  }
  const scp = SCP_LIKE.exec(url);
  return scp ? { host: scp[1], credentialHost: scp[1], isSsh: true } : { host: '', credentialHost: '', isSsh: false };
}

const DEFAULT_PORTS: Record<string, number> = { 'https:': 443, 'http:': 80, 'ssh:': 22, 'git:': 9418 };

/** The TCP port git connects to for origin; 0 when the URL has none (a local path). */
export function originPort(url: string): number {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol] ?? 0;
    } catch {
      return 0;
    }
  }
  return SCP_LIKE.test(url) ? 22 : 0;
}

export async function inspectOrigin(branch: string, cwd: string): Promise<OriginState> {
  let rawUrl: string;
  try {
    rawUrl = await git(['remote', 'get-url', 'origin'], cwd);
  } catch {
    throw new Error('No origin remote');
  }
  if (!rawUrl) throw new Error('No origin remote');
  const originUrl = stripUserinfo(rawUrl);
  const { host, credentialHost, isSsh } = parseOrigin(originUrl);

  // a failed fetch (offline, branch not on origin) is not an error here
  try {
    await execFileAsync(
      'git',
      ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd, env: nonInteractiveEnv(), timeout: NETWORK_TIMEOUT_MS }
    );
  } catch {
    // ignored
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  const localRef = `refs/heads/${branch}`;
  const branchOnOrigin = await succeeds(['rev-parse', '--verify', '-q', remoteRef], cwd);
  const local = await succeeds(['rev-parse', '--verify', '-q', localRef], cwd);

  let unpushed = 0;
  if (local) {
    const range = branchOnOrigin ? `${remoteRef}..${localRef}` : localRef;
    unpushed = parseInt(await git(['rev-list', '--count', range, '--'], cwd), 10) || 0;
  }
  return { originUrl, originHost: host, credentialHost, branchOnOrigin, unpushed, isSsh };
}

async function lsRemoteHas(ref: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-remote', '--exit-code', 'origin', ref], {
      cwd,
      env: nonInteractiveEnv(),
      timeout: NETWORK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 2) return false;
    throw err;
  }
}

// A bare name is looked up as a branch, then as a tag; refs/... is checked as given.
// exit 0 -> exists, exit 2 -> no matching ref, anything else (network, auth) is an error
export async function refExistsOnOrigin(ref: string, cwd: string): Promise<boolean> {
  if (ref.startsWith('refs/')) return lsRemoteHas(ref, cwd);
  return (await lsRemoteHas(`refs/heads/${ref}`, cwd)) || (await lsRemoteHas(`refs/tags/${ref}`, cwd));
}

export async function pushBranch(branch: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
    cwd,
    env: nonInteractiveEnv(),
  });
}

export async function hostGitIdentity(cwd: string): Promise<{ name: string; email: string }> {
  const read = async (key: string): Promise<string> => {
    try {
      return await git(['config', key], cwd);
    } catch {
      return '';
    }
  };
  return { name: await read('user.name'), email: await read('user.email') };
}

export interface SeedInput {
  originUrl: string;
  originHost: string;
  branch: string;
  create: boolean;
  base?: string;
  userName: string;
  userEmail: string;
  hasToken: boolean;
  /** Absolute path of git-credential-kunj inside the container; required with a token */
  credentialHelper?: string;
  /** A checkout already in the image (a blueprint snapshot's seed) to copy instead of cloning */
  seedFrom?: string;
}

// POSIX sh for the container's sandbox user. Safe to re-run after a partial failure.
export function seedScript(input: SeedInput): string {
  if (!input.originHost) {
    throw new Error('Origin has no host; a container can only clone from a remote origin');
  }
  const q = shellQuote;
  const lines: string[] = ['set -e'];
  if (input.userName) lines.push(`git config --global user.name ${q(input.userName)}`);
  if (input.userEmail) lines.push(`git config --global user.email ${q(input.userEmail)}`);
  lines.push('git config --global push.autoSetupRemote true');
  if (input.hasToken) {
    if (!input.credentialHelper) throw new Error('No credential helper path for the token');
    lines.push(`git config --global credential.helper ${q(input.credentialHelper)}`);
    lines.push(
      `git config --global ${q(`url.https://${input.originHost}/.insteadOf`)} ${q(`git@${input.originHost}:`)}`
    );
    lines.push(
      `git config --global --add ${q(`url.https://${input.originHost}/.insteadOf`)} ${q(`ssh://git@${input.originHost}/`)}`
    );
  }
  if (input.seedFrom) {
    // Only an empty workspace or a copy of ours cut short is replaced, never a checkout (the seed
    // marker is an ignored file `git clean -x` removes, so it cannot decide this)
    lines.push(`if [ ! -d /workspace/.git ] || [ -f /workspace/${SEED_COPYING} ]; then`);
    lines.push(`  touch /workspace/${SEED_COPYING}`);
    lines.push(`  find /workspace -mindepth 1 -maxdepth 1 ! -name ${SEED_COPYING} -exec rm -rf {} +`);
    lines.push(`  cp -a ${q(`${input.seedFrom}/.`)} /workspace/`);
    // The snapshot's workspace was seeded; this one is not until the end of this script
    lines.push(`  rm -f ${SEED_MARKER}`);
    lines.push(`  touch /workspace/${SEED_FRESH}`);
    lines.push(`  rm -f /workspace/${SEED_COPYING}`);
    lines.push('fi');
    lines.push('cd /workspace');
    // The snapshot may have cloned another URL for the same repository (ssh vs https)
    lines.push(`git remote set-url origin ${q(input.originUrl)}`);
  } else {
    lines.push(`if [ ! -d /workspace/.git ]; then git clone --recurse-submodules ${q(input.originUrl)} /workspace; fi`);
    lines.push('cd /workspace');
  }
  const branch = q(input.branch);
  if (input.create) {
    const base = q(input.base ?? '');
    lines.push(`git fetch origin ${base}`);
    lines.push(`git switch ${branch} 2>/dev/null || git switch -c ${branch} --no-track ${q(`origin/${input.base ?? ''}`)}`);
  } else {
    lines.push(`git fetch origin ${branch}`);
    if (input.seedFrom) {
      // A fresh copy's branch is at the snapshot's commit: move it to origin's. Any other checkout
      // is the user's and is only switched to.
      lines.push(`if [ -f ${SEED_FRESH} ]; then git switch -C ${branch} ${q(`origin/${input.branch}`)}; else git switch ${branch}; fi`);
    } else {
      lines.push(`git switch ${branch}`);
    }
  }
  if (input.seedFrom) lines.push(`rm -f ${SEED_FRESH}`);
  for (const name of input.seedFrom ? [SEED_MARKER_EXCLUDE, SEED_COPYING, SEED_FRESH] : [SEED_MARKER_EXCLUDE]) {
    lines.push(`grep -qx ${name} .git/info/exclude 2>/dev/null || echo ${name} >> .git/info/exclude`);
  }
  lines.push(`touch ${SEED_MARKER}`);
  return lines.join('\n') + '\n';
}
