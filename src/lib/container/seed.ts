import { execFile } from 'child_process';
import { promisify } from 'util';
import { shellQuote } from '../config-vars';

const execFileAsync = promisify(execFile);

export const SEED_MARKER = '/workspace/.kunj-seeded';
export const SEED_MARKER_EXCLUDE = '.kunj-seeded';

export interface OriginState {
  originUrl: string;
  originHost: string;
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

function parseOrigin(url: string): { host: string; isSsh: boolean } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return { host: new URL(url).hostname, isSsh: new URL(url).protocol === 'ssh:' };
    } catch {
      return { host: '', isSsh: false };
    }
  }
  const scp = SCP_LIKE.exec(url);
  return scp ? { host: scp[1], isSsh: true } : { host: '', isSsh: false };
}

export async function inspectOrigin(branch: string, cwd: string): Promise<OriginState> {
  let originUrl: string;
  try {
    originUrl = await git(['remote', 'get-url', 'origin'], cwd);
  } catch {
    throw new Error('No origin remote');
  }
  if (!originUrl) throw new Error('No origin remote');
  const { host, isSsh } = parseOrigin(originUrl);

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
  return { originUrl, originHost: host, branchOnOrigin, unpushed, isSsh };
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
    lines.push('git config --global credential.helper /usr/local/bin/git-credential-kunj');
    lines.push(
      `git config --global ${q(`url.https://${input.originHost}/.insteadOf`)} ${q(`git@${input.originHost}:`)}`
    );
    lines.push(
      `git config --global --add ${q(`url.https://${input.originHost}/.insteadOf`)} ${q(`ssh://git@${input.originHost}/`)}`
    );
  }
  lines.push(`if [ ! -d /workspace/.git ]; then git clone --recurse-submodules ${q(input.originUrl)} /workspace; fi`);
  lines.push('cd /workspace');
  const branch = q(input.branch);
  if (input.create) {
    const base = q(input.base ?? '');
    lines.push(`git fetch origin ${base}`);
    lines.push(`git switch ${branch} 2>/dev/null || git switch -c ${branch} --no-track ${q(`origin/${input.base ?? ''}`)}`);
  } else {
    lines.push(`git fetch origin ${branch}`);
    lines.push(`git switch ${branch}`);
  }
  lines.push(`grep -qx ${SEED_MARKER_EXCLUDE} .git/info/exclude 2>/dev/null || echo ${SEED_MARKER_EXCLUDE} >> .git/info/exclude`);
  lines.push(`touch ${SEED_MARKER}`);
  return lines.join('\n') + '\n';
}
