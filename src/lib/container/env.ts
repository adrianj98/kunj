// Pure helpers for the container lifecycle: what environment a container and its network helper
// get, and parsing what `git` prints inside a container.
import { ConfigVariables, expandVariables } from '../config-vars';
import { KunjConfig } from '../../types';
import { CONTAINER_ENV_DEFAULT } from './defaults';

const BEDROCK_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE'];
export const TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN'];
export const CLAUDE_AUTH_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK'];

export function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true)$/i.test(value.trim());
}

// Only what container.env names reaches the container; the AWS keys ride along with Bedrock, which
// cannot work without them, and nothing else is forwarded implicitly
export function forwardedEnv(config: KunjConfig['container'], hostEnv: NodeJS.ProcessEnv, vars: ConfigVariables): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of config?.env ?? CONTAINER_ENV_DEFAULT) {
    const eq = entry.indexOf('=');
    if (eq > 0) {
      env[entry.slice(0, eq)] = expandVariables(entry.slice(eq + 1), vars);
    } else if (eq === -1 && hostEnv[entry]) {
      env[entry] = hostEnv[entry] as string;
    }
  }
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) {
    for (const key of BEDROCK_KEYS) {
      if (hostEnv[key]) env[key] = hostEnv[key] as string;
    }
  }
  return env;
}

export function firewallMode(config: KunjConfig['container']): 'default' | 'allowlist' {
  return config?.network?.allow?.length ? 'allowlist' : 'default';
}

/** Environment read by src/container/nethelper/firewall.sh. */
export function firewallEnv(
  config: KunjConfig['container'],
  subnet: string,
  originHost: string,
  bedrockRegion: string | undefined,
  originPort = 0
): Record<string, string> {
  const domains = [...(config?.network?.allow ?? [])];
  if (bedrockRegion) domains.push(`bedrock-runtime.${bedrockRegion}.amazonaws.com`);
  return {
    KUNJ_FW_MODE: firewallMode(config),
    KUNJ_FW_ALLOW_HOST: config?.network?.allowHost ? '1' : '0',
    KUNJ_FW_DOMAINS: domains.join(' '),
    KUNJ_FW_GITHUB: /(^|\.)github\.com$/i.test(originHost) ? '1' : '0',
    KUNJ_FW_ORIGIN_HOST: originHost,
    KUNJ_FW_ORIGIN_PORT: originPort ? String(originPort) : '',
    KUNJ_FW_SUBNET: subnet,
  };
}

export interface ContainerStatus {
  agentRunning: boolean | null;
  head: string | null;
  ahead: number | null;
  dirty: boolean | null;
  status: 'ok' | 'timeout' | 'error' | 'stopped';
}

export function emptyStatus(status: ContainerStatus['status']): ContainerStatus {
  return { agentRunning: null, head: null, ahead: null, dirty: null, status };
}

/** Parse `tmux=<code>` followed by `git status --porcelain=v2 --branch`. */
export function parseStatus(stdout: string): ContainerStatus {
  const result: ContainerStatus = { agentRunning: null, head: null, ahead: null, dirty: false, status: 'ok' };
  for (const line of stdout.split('\n')) {
    const tmux = /^tmux=(\d+)$/.exec(line);
    if (tmux) {
      result.agentRunning = tmux[1] === '0' ? true : tmux[1] === '1' ? false : null;
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      result.head = oid === '(initial)' ? null : oid;
    } else if (line.startsWith('# branch.ab ')) {
      const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (ab) result.ahead = parseInt(ab[1], 10);
    } else if (line.trim() && !line.startsWith('#')) {
      result.dirty = true;
    }
  }
  return result;
}

export interface RemoveGuard {
  unpushedRefs: string[];
  stashes: number;
  dirty: boolean;
  originReachable: boolean;
}

/** Parse the sections printed by the remove guard script (see lifecycle.ts). */
export function parseGuard(stdout: string): Omit<RemoveGuard, 'originReachable'> {
  const guard = { unpushedRefs: [] as string[], stashes: 0, dirty: false };
  let section = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('@@')) {
      section = line.slice(2).trim();
      continue;
    }
    if (!line.trim()) continue;
    if (section === 'refs') {
      // No count means rev-list failed: fail closed
      const m = /^(\S+)(?: (\d+))?$/.exec(line.trim());
      const ref = m ? m[1] : line.trim().split(' ')[0];
      if (!m || m[2] === undefined || parseInt(m[2], 10) > 0) guard.unpushedRefs.push(ref);
    } else if (section === 'stash') {
      guard.stashes = parseInt(line.trim(), 10) || 0;
    } else if (section === 'status' && !line.startsWith('#')) {
      guard.dirty = true;
    }
  }
  return guard;
}

export function describeGuard(guard: RemoveGuard): string[] {
  const problems: string[] = [];
  if (guard.unpushedRefs.length) {
    problems.push(`unpushed commits on ${guard.unpushedRefs.map(r => r.replace(/^refs\/heads\//, '')).join(', ')}`);
  }
  if (guard.stashes) problems.push(`${guard.stashes} stash${guard.stashes === 1 ? '' : 'es'}`);
  if (guard.dirty) problems.push('uncommitted changes');
  if (!guard.originReachable) problems.push('origin is unreachable, so pushed work cannot be checked');
  return problems;
}
