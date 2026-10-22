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

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function succeeds(args: string[], cwd: string): Promise<boolean> {
  try {
    // never wait on a credential prompt
    await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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

  await succeeds(['fetch', 'origin', branch], cwd);
  const branchOnOrigin = await succeeds(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], cwd);
  const local = await succeeds(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], cwd);

  let unpushed = 0;
  if (local) {
    const range = branchOnOrigin ? [`origin/${branch}..${branch}`] : [branch];
    unpushed = parseInt(await git(['rev-list', '--count', ...range], cwd), 10) || 0;
  }
  return { originUrl, originHost: host, branchOnOrigin, unpushed, isSsh };
}

// exit 0 -> exists, exit 2 -> no matching ref, anything else (network, auth) is an error
export async function refExistsOnOrigin(ref: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-remote', '--exit-code', 'origin', ref], { cwd });
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 2) return false;
    throw err;
  }
}

export async function pushBranch(branch: string, cwd: string): Promise<void> {
  await git(['push', '-u', 'origin', branch], cwd);
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
