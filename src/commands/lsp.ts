// kunj lsp: the language servers the workspace app runs for its editor tabs
// (docs/specs/language-servers.md). `list` says which are configured and installed; `run` starts one
// in a worktree with stdio passed straight through (the app talks LSP to it). On the fast path.

import { spawn } from 'child_process';
import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadResolvedConfig } from '../lib/config';
import { UserError } from '../lib/errors';
import { getCurrentBranch } from '../lib/git';
import { findWorktreeIn, listWorktreesDetailed } from '../lib/worktree';
import { excludeCachePaths, findProgram, resolveLspLifecycle, resolveLspServers } from '../lib/lsp';
import type { LspListJson } from '../lib/json-types';

interface LspOptions {
  json?: boolean;
  branch?: string;
}

export class LspCommand extends BaseCommand {
  constructor() {
    super({
      name: 'lsp',
      description: "Language servers for the workspace app's editor (list, run)",
      arguments: '[action] [language]',
      options: [
        { flags: '-b, --branch <branch>', description: '[run] The worktree to run the server in (default: the current one)' },
      ],
      helpText: [
        'Actions:',
        '  list               the configured servers, whether each is installed, and the lifecycle settings',
        '  run <language>     run the server in the worktree, stdio passed through (the workspace app does this)',
        '',
        'Servers are lsp.servers.<language> in the config: { "command": [...], "extensions": [...],',
        '"restart": "cached" | "cold", "cachePaths": [...] }, merged over kunj\'s defaults (typescript,',
        'swift, go, cpp). The app starts one when an editor tab opens and stops it when idle',
        '(lsp.idleStopMinutes.*, lsp.closedStopMinutes, lsp.maxServers).',
      ].join('\n'),
    });
  }

  async execute(action?: any, language?: any, options: LspOptions = {}): Promise<void> {
    const args: unknown[] = [action, language, options];
    const optIndex = args.findIndex(a => a !== undefined && a !== null && typeof a === 'object');
    const opts = (optIndex === -1 ? {} : args[optIndex]) as LspOptions;
    const positionals = (optIndex === -1 ? args : args.slice(0, optIndex)).filter((a): a is string => typeof a === 'string');
    if (opts.json) this.jsonMode = true;
    const verb = positionals[0] ?? 'list';
    const config = await loadResolvedConfig(process.cwd());
    const lsp = ((config as unknown as Record<string, unknown>).lsp ?? {}) as Record<string, unknown>;
    const servers = resolveLspServers(lsp.servers);

    if (verb === 'list') {
      const json: LspListJson = {
        servers: Object.entries(servers).map(([name, s]) => {
          const found = findProgram(s.command[0]);
          return { language: name, command: s.command, extensions: s.extensions, restart: s.restart, cachePaths: s.cachePaths,
                   installed: found !== null, ...(found ? { path: found } : {}), ...(s.install ? { install: s.install } : {}) };
        }),
        ...resolveLspLifecycle(lsp),
      };
      if (this.jsonMode) {
        this.outputJSON(json);
        return;
      }
      for (const s of json.servers) {
        const state = s.installed ? chalk.green('installed') : chalk.yellow('not installed');
        console.log(`${chalk.bold(s.language.padEnd(12))} ${s.command.join(' ')}  ${state}  ${chalk.dim(`${s.restart}; .${s.extensions.join(' .')}`)}`);
        if (!s.installed && s.install) console.log(chalk.dim(`             install: ${s.install}`));
      }
      return;
    }

    if (verb !== 'run') throw new UserError(`Unknown lsp action '${verb}'.`, 'Use `kunj lsp list` or `kunj lsp run <language>`.');
    const name = positionals[1];
    const server = name ? servers[name] : undefined;
    if (!name || !server) {
      throw new UserError(`No language server is configured for '${name ?? ''}'.`, `Configured: ${Object.keys(servers).join(', ')} (see \`kunj lsp list\`).`, 'lsp-unknown');
    }
    const program = findProgram(server.command[0]);
    if (!program) {
      throw new UserError(`${server.command[0]} (the ${name} language server) is not installed.`, server.install ? `Install it: ${server.install}` : 'Install it, or set lsp.servers.' + name + '.command.', 'lsp-missing');
    }
    const listing = await listWorktreesDetailed({ includeStatus: false, includePullRequests: false });
    const branch = opts.branch ?? (await getCurrentBranch());
    const wt = branch ? findWorktreeIn(listing.worktrees, branch) : null;
    if (!wt || !wt.exists || wt.bare) {
      throw new UserError(`No worktree for ${branch || 'the current directory'}.`, 'See `kunj worktree list`.', 'no-worktree');
    }
    try {
      excludeCachePaths(listing.gitCommonDir, server.cachePaths);
    } catch (error) {
      process.stderr.write(`⚠ Could not add ${name}'s cache to info/exclude: ${(error as Error).message}\n`);
    }
    // stdio straight through: this process only waits, and passes signals on
    const child = spawn(program, server.command.slice(1), { cwd: wt.path, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(s, forward(s));
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  }
}
