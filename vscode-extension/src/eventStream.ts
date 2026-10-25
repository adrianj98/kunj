// `kunj events --json` for the workspace's repositories, so container, agent, forward and git
// changes show at once instead of on the next timer tick. One child per window; its stdin is held
// open (kunj events exits when stdin ends, so it dies with the extension host). An exited child is
// started again after a delay that doubles from 2 s to 60 s, back to 2 s once a child lived longer
// than that, so a kunj without `events` costs one short-lived process a minute.

import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { resolveCommand } from './kunjCli';

const MIN_DELAY = 2_000;
const MAX_DELAY = 60_000;
const DEBOUNCE = 1_000;

export type EventReaction = 'ignore' | 'refresh';

// What one NDJSON line (EventJson in src/lib/json-types.ts) means for the view. `sessions` is left
// to the worktree-sessions.json watcher (our own heartbeat writes it); `hello` refreshes only after
// a restart, because events from the gap are lost.
export function eventReaction(line: string, afterRestart: boolean): EventReaction {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return 'ignore';
  }
  if (!event || typeof event !== 'object') return 'ignore';
  const { type, repo } = event as { type?: unknown; repo?: unknown };
  switch (type) {
    case 'hello':
      return afterRestart ? 'refresh' : 'ignore';
    case 'container':
      // Every kunj container on the daemon is reported; one of a repository not watched has no repo
      return repo && typeof repo === 'object' ? 'refresh' : 'ignore';
    case 'git':
    case 'forwards':
    case 'agent':
    case 'backend':
      return 'refresh';
    default:
      return 'ignore';
  }
}

export class EventStream implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private roots: string[] = [];
  private runs = 0;
  private delay = MIN_DELAY;
  private restartTimer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly onChange: () => void, private readonly output: vscode.OutputChannel) {}

  // Watch these repository roots; a different set starts a new child (kunj events resolves them once)
  watch(roots: string[]): void {
    const next = [...new Set(roots)].sort();
    if (this.disposed || next.join('\n') === this.roots.join('\n')) return;
    this.roots = next;
    this.delay = MIN_DELAY;
    this.stopChild();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (next.length > 0) this.launch();
  }

  // Forget the current child (kunj.cliPath changed); the next watch() starts a new one
  reset(): void {
    this.roots = [];
    this.stopChild();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private launch(): void {
    const { command, leadingArgs } = resolveCommand();
    const args = [...leadingArgs, 'events', '--json', ...this.roots.flatMap(root => ['--repo', root])];
    const afterRestart = this.runs++ > 0;
    const startedAt = Date.now();
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true });
    this.child = child;
    this.output.appendLine(`[${new Date().toISOString()}] ${command} ${args.join(' ')}  (live refresh)`);

    let buffer = '';
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (eventReaction(line, afterRestart) === 'refresh') this.changed();
      }
    });
    child.on('error', () => undefined); // a missing kunj: 'close' follows and the backoff applies
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.disposed || this.roots.length === 0) return;
      if (Date.now() - startedAt > MAX_DELAY) this.delay = MIN_DELAY;
      const wait = this.delay;
      this.delay = Math.min(this.delay * 2, MAX_DELAY);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (!this.disposed && !this.child && this.roots.length > 0) this.launch();
      }, wait);
    });
  }

  // Changes come in bursts (a container start is several Docker events): one refresh a second at most
  private changed(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.onChange();
    }, DEBOUNCE);
  }

  private stopChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin?.end();
    // kunj events exits when its stdin ends; make sure of it
    setTimeout(() => child.exitCode === null && child.kill(), 2_000).unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.stopChild();
  }
}
