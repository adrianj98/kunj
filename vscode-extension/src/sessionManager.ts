// Registers this VS Code window with `kunj worktree session` so that other
// windows (and the CLI itself) can tell which worktrees are currently open.
//
// A session is keyed by (host, pid, path). The pid is this window's extension
// host process, which lives exactly as long as the window does, so the CLI can
// prune sessions from windows that were closed without a clean deactivate.

import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { KunjCli, KunjCliError } from './kunjCli';

const HEARTBEAT_MS = 5 * 60 * 1000;

export class SessionManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly registered = new Map<string, string>(); // folder path -> session id
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly cli: KunjCli, private readonly output: vscode.OutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('kunj.worktrees.trackSessions') || e.affectsConfiguration('kunj.cliPath')) {
          void this.sync();
        }
      })
    );
    this.heartbeat = setInterval(() => void this.sync(), HEARTBEAT_MS);
  }

  get pid(): number {
    return process.pid;
  }

  get sessionIds(): string[] {
    return Array.from(this.registered.values());
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('kunj.worktrees').get<boolean>('trackSessions', true);
  }

  private get label(): string {
    return vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || 'window';
  }

  // Register every workspace folder that lives in a git repository and
  // unregister folders that were removed from the workspace.
  async sync(): Promise<void> {
    const folders = this.enabled ? (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file') : [];
    const wanted = new Set(folders.map(f => f.uri.fsPath));
    let changed = false;

    for (const [folderPath, id] of Array.from(this.registered.entries())) {
      if (!wanted.has(folderPath)) {
        await this.end(folderPath, id);
        this.registered.delete(folderPath);
        changed = true;
      }
    }

    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;
      try {
        const result = await this.cli.startSession(folderPath, {
          path: folderPath,
          pid: this.pid,
          label: this.label,
          id: this.registered.get(folderPath),
        });
        if (this.registered.get(folderPath) !== result.session.id) {
          this.registered.set(folderPath, result.session.id);
          changed = true;
        }
      } catch (error) {
        if (error instanceof KunjCliError && (error.code === 'not-a-repo' || error.code === 'not-found')) {
          continue; // plain folder, or CLI missing: nothing to register
        }
        this.output.appendLine(`Failed to register session for ${folderPath}: ${(error as Error).message}`);
      }
    }

    if (changed) this.onDidChangeEmitter.fire();
  }

  private async end(folderPath: string, id: string): Promise<void> {
    try {
      await this.cli.endSession(folderPath, { id });
    } catch (error) {
      this.output.appendLine(`Failed to end session ${id}: ${(error as Error).message}`);
    }
  }

  // Synchronous best-effort cleanup for deactivate(), which may not wait for promises.
  endAllSync(): void {
    if (this.registered.size === 0) return;
    const configured = (vscode.workspace.getConfiguration('kunj').get<string>('cliPath') || 'kunj').trim();
    const [command, ...leading] = configured.split(/\s+/);
    for (const [folderPath, id] of this.registered) {
      try {
        execFileSync(command, [...leading, 'worktree', 'session', 'end', '--id', id, '--json'], {
          cwd: folderPath,
          timeout: 3000,
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
      } catch {
        // The CLI prunes dead pids anyway
      }
    }
    this.registered.clear();
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.endAllSync();
    this.disposables.forEach(d => d.dispose());
    this.onDidChangeEmitter.dispose();
  }
}
