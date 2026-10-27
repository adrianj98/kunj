// Sessions command - kunj's tmux sessions (src/lib/sessions.ts), for finding and ending orphans.
//
//   kunj sessions [list] [--containers] [--idle-hours <n>]   every kunj agent and shell session
//   kunj sessions kill <name...> [--container <name>]        end sessions by name
//   kunj sessions kill --orphans                             end every orphaned host session
//
// The workspace app's Sessions window reads `kunj sessions list --containers --json`.

import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { killTmuxSessionIfExists } from '../lib/agent-session';
import { repoIdentity } from '../lib/repo-identity';
import { listRepos } from '../lib/repos';
import {
  CONTAINER_SESSION,
  DEFAULT_IDLE_HOURS,
  KILL_IF_DETACHED_SCRIPT,
  hostSessionAttached,
  SESSIONS_SCRIPT,
  containerSessions,
  hostSessions,
  isKunjHostSession,
  sortSessions,
} from '../lib/sessions';
import type { SessionsJson, SessionsKillJson, TmuxSessionJson } from '../lib/json-types';

interface SessionsOptions {
  containers?: boolean;
  idleHours?: string;
  orphans?: boolean;
  container?: string;
  ifDetached?: boolean;
  json?: boolean;
}

const ACTIONS = ['list', 'kill'];
const CONTAINERS_TIMEOUT_MS = 15000;

export class SessionsCommand extends BaseCommand {
  constructor() {
    super({
      name: 'sessions',
      description: "List and end kunj's tmux sessions (agents and shells), with what is attached and their CPU and memory",
      arguments: '[action] [names...]',
      options: [
        { flags: '--containers', description: '[list] Also the sessions inside running branch containers' },
        { flags: '--idle-hours <n>', description: `[list] Hours without activity or a terminal before a session counts as idle (default ${DEFAULT_IDLE_HOURS})` },
        { flags: '--orphans', description: '[kill] Every orphaned host session (worktree gone, or idle)' },
        { flags: '--container <name>', description: '[kill] The names are sessions in this branch container' },
        { flags: '--if-detached', description: '[kill] Leave a session running when a terminal is attached to it now (--orphans always does)' },
      ],
      helpText: () =>
        [
          'Actions:',
          '  list (default)   Every kunj session: worktree or container, attached terminals, CPU, memory, orphan state',
          '  kill <name...>   End sessions; only names kunj gives (kunj-*, kunjsh-*, or agent*/sh-* in a container)',
          '',
          'Orphans: worktree-gone (its worktree was removed) or idle (no terminal attached and no activity',
          'for --idle-hours). CPU is ps\'s percentage, 100 = one core.',
        ].join('\n'),
    });
  }

  async execute(...args: unknown[]): Promise<void> {
    const optIndex = args.findIndex(a => a !== null && typeof a === 'object' && !Array.isArray(a));
    const options = (optIndex === -1 ? {} : args[optIndex]) as SessionsOptions;
    if (options.json) this.jsonMode = true;
    const positionals = (optIndex === -1 ? args : args.slice(0, optIndex)).flatMap(a => (Array.isArray(a) ? a : [a])).filter((a): a is string => typeof a === 'string');
    let verb = 'list';
    if (positionals[0] && ACTIONS.includes(positionals[0])) verb = positionals.shift() as string;
    else if (positionals.length) throw new Error(`Unknown sessions action '${positionals[0]}'. Expected one of: ${ACTIONS.join(', ')}`);

    if (verb === 'kill') return this.kill(positionals, options);
    return this.list(options);
  }

  private idleHours(options: SessionsOptions): number {
    if (options.idleHours === undefined) return DEFAULT_IDLE_HOURS;
    const n = Number(options.idleHours);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--idle-hours must be a positive number, not ${options.idleHours}`);
    return n;
  }

  async collect(options: SessionsOptions): Promise<SessionsJson> {
    const idleHours = this.idleHours(options);
    const [host, containers] = await Promise.all([hostSessions(idleHours), options.containers ? this.containers(idleHours) : Promise.resolve(undefined)]);
    return {
      tmux: host.tmux,
      idleHours,
      sessions: sortSessions([...host.sessions, ...(containers?.sessions ?? [])]),
      ...(containers ? { containers: containers.status } : {}),
    };
  }

  private async containers(idleHours: number): Promise<{ sessions: TmuxSessionJson[]; status: NonNullable<SessionsJson['containers']> }> {
    // Loaded only with --containers: the container module is large and asks Docker
    const { ContainerCommand } = await import('./container');
    const command = new ContainerCommand();
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          command.abortDockerCalls();
          reject(new Error(`Docker did not answer within ${CONTAINERS_TIMEOUT_MS / 1000}s`));
        }, CONTAINERS_TIMEOUT_MS);
      });
      const results = await Promise.race([command.sessionsExec(SESSIONS_SCRIPT, abort.signal), timeout]);
      const repoById = new Map<string, { name: string; root: string }>();
      for (const r of listRepos().filter(x => x.exists)) {
        const ident = repoIdentity({ commonDir: r.gitCommonDir, repoRoot: r.root });
        repoById.set(ident.id, { name: ident.name, root: r.root });
      }
      const sessions: TmuxSessionJson[] = [];
      const items: NonNullable<SessionsJson['containers']>['items'] = [];
      for (const r of results) {
        const repo = r.repoId ? repoById.get(r.repoId) ?? null : null;
        if (r.stdout === null) {
          items.push({ container: r.container, repo: repo?.name ?? null, branch: r.branch, tmux: 'failed', count: 0 });
          continue;
        }
        const c = containerSessions(r.stdout, { name: r.container, repo, branch: r.branch }, idleHours);
        sessions.push(...c.sessions);
        items.push({ container: r.container, repo: repo?.name ?? null, branch: r.branch, tmux: c.tmux, count: c.sessions.length });
      }
      return { sessions, status: { available: true, items } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { sessions: [], status: { available: false, message, items: [] } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async list(options: SessionsOptions): Promise<void> {
    const json = await this.collect(options);
    if (this.jsonMode) {
      this.outputJSON(json satisfies SessionsJson);
      return;
    }
    if (json.tmux === 'missing') console.log(chalk.yellow('tmux is not installed'));
    if (json.tmux === 'failed') console.log(chalk.yellow('tmux could not be asked'));
    if (!json.sessions.length) {
      console.log(chalk.gray('No kunj sessions.'));
    }
    for (const s of json.sessions) {
      const where = s.container ? `${s.container}` : s.worktree ? `${s.repo?.name ?? '?'} ${s.worktree.branch ?? s.worktree.path}` : `${s.repo?.name ?? '?'} ${chalk.red('(worktree gone)')}`;
      const usage = s.usage ? `${s.usage.cpu.toFixed(1)}% ${formatBytes(s.usage.memoryBytes)}` : '-';
      const attached = s.attached.length ? chalk.green(s.attached.map(a => a.via ?? a.tty).join(', ')) : chalk.gray('detached');
      const orphan = s.orphan ? chalk.yellow(` [${s.orphan}]`) : '';
      console.log(`${chalk.cyan(s.kind.padEnd(5))} ${where}  ${chalk.gray(s.command ?? '')}  ${usage}  ${attached}${orphan}`);
      console.log(chalk.gray(`      ${s.name}`));
    }
    if (json.containers && !json.containers.available) console.log(chalk.yellow(`Containers not asked: ${json.containers.message ?? 'Docker could not be asked'}`));
  }

  private async kill(names: string[], options: SessionsOptions): Promise<void> {
    const result: SessionsKillJson = { killed: [], failed: [] };
    if (options.container) {
      const { ContainerCommand } = await import('./container');
      for (const name of names) {
        if (!CONTAINER_SESSION.test(name)) {
          result.failed.push({ name, container: options.container, error: 'not a kunj session name' });
          continue;
        }
        try {
          await new ContainerCommand().killContainerSession(options.container, name, !!options.ifDetached, KILL_IF_DETACHED_SCRIPT);
          result.killed.push(name);
        } catch (error) {
          result.failed.push({ name, container: options.container, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } else {
      let targets = names;
      if (options.orphans) {
        const host = await hostSessions(this.idleHours(options));
        targets = [...new Set([...names, ...host.sessions.filter(s => s.orphan).map(s => s.name)])];
      }
      if (!targets.length && !options.orphans) throw new Error('Name the sessions to end, or pass --orphans');
      // The listing may be old (the app's is up to 5 s, plus its confirmation): check attachment again
      const ifDetached = !!options.ifDetached || !!options.orphans;
      for (const name of targets) {
        const attached = ifDetached && isKunjHostSession(name) ? await hostSessionAttached(name) : 0;
        if (!isKunjHostSession(name)) {
          result.failed.push({ name, container: null, error: 'not a kunj session name' });
        } else if (attached === null) {
          result.failed.push({ name, container: null, error: 'no such session' });
        } else if (attached > 0) {
          result.failed.push({ name, container: null, error: 'a terminal is attached; left running' });
        } else if (await killTmuxSessionIfExists(name)) {
          result.killed.push(name);
        } else {
          result.failed.push({ name, container: null, error: 'no such session' });
        }
      }
    }
    if (this.jsonMode) {
      this.outputJSON(result satisfies SessionsKillJson);
    } else {
      for (const n of result.killed) console.log(chalk.green(`✓ ended ${n}`));
      for (const f of result.failed) console.log(chalk.red(`✗ ${f.name}: ${f.error}`));
      if (!result.killed.length && !result.failed.length) console.log(chalk.gray('No orphaned sessions.'));
    }
    // --json reports failures in its output and exits 0, as `worktree shell --kill` does
    if (result.failed.length && !this.jsonMode) process.exitCode = 1;
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
