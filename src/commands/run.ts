// kunj run [--branch b] -- <cmd…>: run a host command with the host-targeted secrets in its
// environment, file deliveries rendered into this worktree first. Values never go into argv: `kunj agent`
// and `kunj worktree shell --session` start their tmux command under this (hostRunArgv).
// On the fast path (src/commands/fast.ts): keep top-level imports light.

import { BaseCommand } from '../lib/command';
import { getCurrentBranch } from '../lib/git';
import { getCurrentWorktreePath } from '../lib/worktree';
import { hostSecrets, runAttached, UnlockSeam } from '../lib/secrets/host';

interface RunOptions {
  json?: boolean;
  branch?: string;
}

// Test seams; each defaults to git and the key provider settings.
export interface RunCommandDeps {
  unlock?: UnlockSeam;
  currentBranch?: () => Promise<string>;
  // null: not in a git worktree (no file is rendered)
  worktreeRoot?: () => Promise<string | null>;
}

export class RunCommand extends BaseCommand {
  constructor(private readonly deps: RunCommandDeps = {}) {
    super({
      name: 'run',
      description: 'Run a command with the host secrets in its environment',
      arguments: '<command...>',
      options: [{ flags: '--branch <branch>', description: 'Resolve the secrets of this branch (default: the current one)' }],
      helpText: [
        'Put -- before the command so its own options are not read as kunj\'s:',
        '  kunj run -- npm run dev',
        '  kunj run --branch feature/x -- $SHELL -l',
        '',
        'The command gets the global, repo and branch secrets whose targets include host and that are',
        'delivered as environment variables. File deliveries are written into this worktree first (a file',
        'git does not ignore is skipped with a warning). The exit code is the command\'s.',
      ].join('\n'),
    });
  }

  async execute(command?: any, options?: any): Promise<void> {
    const argv: string[] = Array.isArray(command) ? command : [];
    const opts: RunOptions = (options && typeof options === 'object' ? options : {}) as RunOptions;
    if (argv.length === 0) throw new Error('No command given: kunj run -- <command…>');

    const branch = opts.branch || (await (this.deps.currentBranch ?? getCurrentBranch)()) || undefined;
    const root = await (this.deps.worktreeRoot ?? (() => getCurrentWorktreePath()))();
    const { env } = await hostSecrets({
      branch,
      root,
      unlock: this.deps.unlock,
      warn: (message) => process.stderr.write(`⚠ ${message}\n`),
    });
    process.exitCode = await runAttached(argv, { ...process.env, ...env });
  }
}
