// Host delivery: the host-targeted secrets of a branch as environment variables, with their file
// deliveries rendered into a worktree first. Shared by `kunj run`, the tmux-less paths of
// `kunj agent` and `kunj worktree shell`, and `kunj worktree add`. Values only ever go into a child's
// environment or a git-ignored file, never into argv.

import { spawn } from 'child_process';
import * as os from 'os';
import type { GetUnlockOptions } from './keyprovider';
import { envOf, loadSecrets } from './resolve';
import { renderFiles, writeHostFiles } from './deliver';

// The same seam shape as SecretCommandDeps.unlock
export type UnlockSeam = Partial<Pick<GetUnlockOptions, 'mode' | 'env' | 'platform' | 'run' | 'prompt' | 'tty'>>;

export interface HostSecretsOptions {
  // undefined: no branch layer (the caller passes the branch; loadSecrets does not look it up)
  branch?: string;
  // The worktree to render file deliveries into; none are rendered without one
  root?: string | null;
  unlock?: UnlockSeam;
  // A file that cannot be written (not ignored, a bad path) is reported here, never thrown
  warn?: (message: string) => void;
}

// Unlocking errors (secrets-locked, secrets-corrupt) are thrown: the caller decides whether they are fatal.
export async function hostSecrets(opts: HostSecretsOptions): Promise<{ env: Record<string, string>; files: string[] }> {
  const entries = await loadSecrets({ ...opts.unlock, branch: opts.branch, target: 'host' });
  let files: string[] = [];
  const rendered = renderFiles(entries);
  if (opts.root && rendered.size > 0) {
    try {
      files = await writeHostFiles(opts.root, rendered, {});
    } catch (error) {
      opts.warn?.(`Secret files not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { env: envOf(entries), files };
}

// Runs argv attached to this terminal with `env`; resolves with its exit code (killed by a signal:
// 128 + the signal number, as a shell reports it; not found: 127). Ctrl-C and Ctrl-\ reach the child
// from the terminal, so this process ignores them while it waits; SIGTERM and SIGHUP are passed on.
export function runAttached(argv: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: 'inherit' });
    const ignore = () => undefined;
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const handlers: Array<[NodeJS.Signals, (signal: NodeJS.Signals) => void]> = [
      ['SIGINT', ignore],
      ['SIGQUIT', ignore],
      ['SIGTERM', forward],
      ['SIGHUP', forward],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = (code: number) => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      resolve(code);
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      process.stderr.write(`✗ ${argv[0]}: ${error.code === 'ENOENT' ? 'command not found' : error.message}\n`);
      done(error.code === 'ENOENT' ? 127 : 126);
    });
    child.on('exit', (code, signal) => {
      done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
    });
  });
}
