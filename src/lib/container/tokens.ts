// Tokens found on the host when container.env forwards none: `gh auth token` for a GitHub origin.
// Only ever put in the docker run env-file. Asked lazily, so commands that build no env pay nothing.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KunjConfig } from '../../types';
import { CONTAINER_ENV_DEFAULT } from './defaults';
import { TOKEN_KEYS } from './env';

const GH_TIMEOUT_MS = 10000;

export type GhRunner = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

/** How tokens are looked up on the host (the seam tests replace). */
export interface TokenLookup {
  /** `gh auth token --hostname <host>`; null when gh is missing, logged out or fails */
  gh(host: string): Promise<string | null>;
  /** Whether gh is logged in to this (GitHub Enterprise) host */
  ghKnowsHost(host: string): boolean;
}

export type GithubTokenSource = 'env' | 'gh' | null;

const runExecFile: GhRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout }));
  });

export async function ghAuthToken(host: string, run: GhRunner = runExecFile): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['auth', 'token', '--hostname', host], { timeout: GH_TIMEOUT_MS });
    const token = stdout.trim();
    return token && !/\s/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function ghConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'gh');
  return path.join(os.homedir(), '.config', 'gh');
}

/** Hosts are the top-level keys of gh's hosts.yml. */
export function ghKnowsHost(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.join(ghConfigDir(env), 'hosts.yml'), 'utf8');
  } catch {
    return false;
  }
  const want = host.toLowerCase();
  return text.split('\n').some(line => {
    const m = /^([^\s#:][^:]*):\s*$/.exec(line);
    return !!m && m[1].trim().replace(/^["']|["']$/g, '').toLowerCase() === want;
  });
}

export const hostTokenLookup: TokenLookup = {
  gh: host => ghAuthToken(host),
  ghKnowsHost: host => ghKnowsHost(host),
};

function envNames(config: KunjConfig['container']): string[] {
  return (config?.env ?? CONTAINER_ENV_DEFAULT).map(e => (e.includes('=') ? e.slice(0, e.indexOf('=')) : e));
}

function ghEligible(config: KunjConfig['container'], originHost: string, lookup: TokenLookup): boolean {
  if (config?.useGhToken === false || !envNames(config).includes('GH_TOKEN')) return false;
  const host = originHost.toLowerCase();
  return host === 'github.com' || lookup.ghKnowsHost(host);
}

/**
 * The container env with GH_TOKEN from `gh auth token` added when container.env names GH_TOKEN,
 * the host env gave none of TOKEN_KEYS, container.useGhToken is not false and origin is GitHub.
 */
export async function withHostTokens(
  env: Record<string, string>,
  config: KunjConfig['container'],
  originHost: string,
  lookup: TokenLookup = hostTokenLookup
): Promise<{ env: Record<string, string>; github: GithubTokenSource }> {
  if (TOKEN_KEYS.some(k => env[k])) return { env, github: 'env' };
  if (!ghEligible(config, originHost, lookup)) return { env, github: null };
  const token = await lookup.gh(originHost.toLowerCase());
  return token ? { env: { ...env, GH_TOKEN: token }, github: 'gh' } : { env, github: null };
}

/** `kunj ct token status`: where a new container's GitHub token would come from (never the token). */
export async function githubTokenSource(
  env: Record<string, string>,
  config: KunjConfig['container'],
  originHost: string,
  lookup: TokenLookup = hostTokenLookup
): Promise<{ source: GithubTokenSource; enabled: boolean }> {
  const { github } = await withHostTokens(env, config, originHost, lookup);
  return { source: github, enabled: config?.useGhToken !== false };
}
