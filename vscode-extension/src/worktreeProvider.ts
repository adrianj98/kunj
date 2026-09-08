// Tree view of git worktrees, grouped by repository when the workspace spans
// more than one repo. All data comes from `kunj worktree list --json`.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KunjCli, KunjCliError, PullRequest, Worktree, WorktreeListResult, WorktreeSession } from './kunjCli';

export interface RepoEntry {
  repoRoot: string;
  cwd: string; // a folder inside the repo we can run the CLI from
  worktrees: Worktree[];
}

export class RepoNode extends vscode.TreeItem {
  constructor(readonly repo: RepoEntry) {
    super(path.basename(repo.repoRoot), vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'repo';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = shortenHome(repo.repoRoot);
    this.tooltip = repo.repoRoot;
  }
}

export class WorktreeNode extends vscode.TreeItem {
  readonly openElsewhere: WorktreeSession[];
  readonly openHere: boolean;

  constructor(readonly worktree: Worktree, readonly repo: RepoEntry, ownPid: number) {
    super(worktree.name, vscode.TreeItemCollapsibleState.None);

    const host = os.hostname();
    this.openHere = worktree.sessions.some(s => s.host === host && s.pid === ownPid);
    this.openElsewhere = worktree.sessions.filter(s => !(s.host === host && s.pid === ownPid));

    const inWorkspace = (vscode.workspace.workspaceFolders || []).some(f => samePath(f.uri.fsPath, worktree.path));
    const flags = ['worktree'];
    if (worktree.isMain) flags.push('main');
    if (worktree.exists) flags.push('exists');
    if (inWorkspace || this.openHere) flags.push('current', 'inworkspace');
    if (this.openElsewhere.length > 0) flags.push('open');
    if (worktree.status?.dirty) flags.push('dirty');
    if (worktree.locked) flags.push('locked');
    if (worktree.prunable || !worktree.exists) flags.push('prunable');
    if (worktree.pullRequest) flags.push('pr');
    if (worktree.branch && !worktree.pullRequest) flags.push('nopr');
    this.contextValue = flags.join(' ');

    this.id = `${repo.repoRoot}::${worktree.path}`;
    this.iconPath = this.pickIcon(inWorkspace);
    this.description = this.buildDescription(inWorkspace);
    this.tooltip = this.buildTooltip(inWorkspace);
    this.resourceUri = undefined;

    if (worktree.exists) {
      this.command = {
        command: 'kunj.worktrees.open',
        title: 'Open Worktree',
        arguments: [this],
      };
    }
  }

  private pickIcon(inWorkspace: boolean): vscode.ThemeIcon {
    const wt = this.worktree;
    if (!wt.exists || wt.prunable) {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    }
    if (inWorkspace || this.openHere) {
      return new vscode.ThemeIcon('folder-active', new vscode.ThemeColor('charts.green'));
    }
    if (this.openElsewhere.length > 0) {
      return new vscode.ThemeIcon('window', new vscode.ThemeColor('charts.blue'));
    }
    if (wt.locked) {
      return new vscode.ThemeIcon('lock');
    }
    if (wt.detached) {
      return new vscode.ThemeIcon('git-commit');
    }
    return new vscode.ThemeIcon(wt.isMain ? 'repo' : 'git-branch');
  }

  private buildDescription(inWorkspace: boolean): string {
    const wt = this.worktree;
    const parts: string[] = [];

    if (inWorkspace || this.openHere) {
      parts.push('this window');
    } else if (this.openElsewhere.length === 1) {
      parts.push(`open: ${describeSession(this.openElsewhere[0])}`);
    } else if (this.openElsewhere.length > 1) {
      parts.push(`open in ${this.openElsewhere.length} windows`);
    }

    if (wt.status) {
      if (wt.status.dirty) parts.push(`✎ ${wt.status.changedFiles}`);
      const sync: string[] = [];
      if (wt.status.ahead) sync.push(`↑${wt.status.ahead}`);
      if (wt.status.behind) sync.push(`↓${wt.status.behind}`);
      if (sync.length) parts.push(sync.join(' '));
    }

    if (wt.pullRequest) parts.push(prBadge(wt.pullRequest));

    if (!wt.exists) parts.push('missing');
    else if (wt.prunable) parts.push('prunable');
    if (wt.locked) parts.push('locked');

    const showPath = vscode.workspace.getConfiguration('kunj.worktrees').get<boolean>('showPath', true);
    if (showPath) parts.push(shortenPath(wt.path, this.repo.repoRoot));

    return parts.join('  ·  ');
  }

  private buildTooltip(inWorkspace: boolean): vscode.MarkdownString {
    const wt = this.worktree;
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**${wt.name}**${wt.isMain ? ' _(main worktree)_' : ''}\n\n`);
    md.appendMarkdown(`$(folder) \`${wt.path}\`\n\n`);
    if (wt.head) md.appendMarkdown(`$(git-commit) \`${wt.head.slice(0, 10)}\`${wt.detached ? ' (detached)' : ''}\n\n`);

    if (wt.status) {
      const bits = [wt.status.dirty ? `${wt.status.changedFiles} uncommitted change(s)` : 'clean'];
      if (wt.status.upstream) {
        bits.push(`upstream ${wt.status.upstream} (↑${wt.status.ahead ?? 0} ↓${wt.status.behind ?? 0})`);
      }
      md.appendMarkdown(`$(git-compare) ${bits.join(', ')}\n\n`);
    }

    if (wt.pullRequest) {
      const pr = wt.pullRequest;
      const bits = [prState(pr)];
      if (pr.checks) bits.push(`checks ${pr.checks}`);
      if (pr.reviewDecision) bits.push(pr.reviewDecision.toLowerCase().replace(/_/g, ' '));
      md.appendMarkdown(`$(git-pull-request) [#${pr.number} ${escapeMd(pr.title)}](${pr.url}) — ${bits.join(', ')}\n\n`);
      md.isTrusted = true;
    }

    if (inWorkspace || this.openHere) {
      md.appendMarkdown(`$(window) Open in **this** window\n\n`);
    }
    for (const s of this.openElsewhere) {
      md.appendMarkdown(`$(window) Open in ${describeSession(s)} on ${s.host} (pid ${s.pid})\n\n`);
    }
    if (wt.locked) md.appendMarkdown(`$(lock) Locked${wt.lockedReason ? `: ${wt.lockedReason}` : ''}\n\n`);
    if (wt.prunable) md.appendMarkdown(`$(warning) Prunable${wt.prunableReason ? `: ${wt.prunableReason}` : ''}\n\n`);
    if (!wt.exists) md.appendMarkdown(`$(warning) Directory is missing\n\n`);
    return md;
  }
}

export class MessageNode extends vscode.TreeItem {
  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

type Node = RepoNode | WorktreeNode | MessageNode;

export class WorktreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly onDidLoadEmitter = new vscode.EventEmitter<RepoEntry[]>();
  readonly onDidLoad = this.onDidLoadEmitter.event;

  private repos: RepoEntry[] = [];
  private lastError: KunjCliError | undefined;
  private loading: Promise<RepoEntry[]> | undefined;
  private forceFresh = false;
  // Remembered so folders of the same repository cost one CLI call, not one each
  private readonly folderRepoRoots = new Map<string, string>();

  constructor(private readonly cli: KunjCli, private readonly ownPid: number) {}

  get repositories(): RepoEntry[] {
    return this.repos;
  }

  get allWorktrees(): Array<{ worktree: Worktree; repo: RepoEntry }> {
    return this.repos.flatMap(repo => repo.worktrees.map(worktree => ({ worktree, repo })));
  }

  // `fresh` bypasses the CLI's pull request cache (used by the manual refresh button)
  refresh(fresh = false): void {
    this.forceFresh = this.forceFresh || fresh;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof RepoNode) {
      return element.repo.worktrees.map(wt => new WorktreeNode(wt, element.repo, this.ownPid));
    }
    if (element) return [];

    const repos = await this.load();
    if (this.lastError) {
      if (this.lastError.code === 'not-found' || this.lastError.code === 'not-a-repo') {
        return []; // the viewsWelcome content explains what to do
      }
      return [new MessageNode(this.lastError.message, 'error')];
    }
    if (repos.length === 0) return [];
    if (repos.length === 1) {
      return repos[0].worktrees.map(wt => new WorktreeNode(wt, repos[0], this.ownPid));
    }
    return repos.map(repo => new RepoNode(repo));
  }

  // Query the CLI for every workspace folder, de-duplicated by repository root.
  private load(): Promise<RepoEntry[]> {
    if (this.loading) return this.loading;
    this.loading = this.doLoad().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async doLoad(): Promise<RepoEntry[]> {
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
    const config = vscode.workspace.getConfiguration('kunj.worktrees');
    const includeStatus = config.get<boolean>('showStatus', true);
    const includePullRequests = config.get<boolean>('showPullRequests', true);
    const fresh = this.forceFresh;
    this.forceFresh = false;
    const repos = new Map<string, RepoEntry>();
    let firstError: KunjCliError | undefined;
    let sawRepo = false;

    for (const folder of folders) {
      const cwd = folder.uri.fsPath;
      const knownRoot = this.folderRepoRoots.get(cwd);
      if (knownRoot && repos.has(knownRoot)) {
        continue; // same repository as a folder we already listed this round
      }
      try {
        const result: WorktreeListResult = await this.cli.listWorktrees(cwd, includeStatus, includePullRequests, fresh);
        sawRepo = true;
        const key = normalize(result.repoRoot);
        this.folderRepoRoots.set(cwd, key);
        if (!repos.has(key)) {
          repos.set(key, { repoRoot: result.repoRoot, cwd, worktrees: result.worktrees });
        }
      } catch (error) {
        if (error instanceof KunjCliError) {
          if (error.code === 'not-found') {
            firstError = error;
            break;
          }
          if (error.code === 'not-a-repo') continue;
          firstError = firstError || error;
        } else {
          firstError = firstError || new KunjCliError(String(error), 'command-failed', []);
        }
      }
    }

    this.repos = Array.from(repos.values());
    this.lastError = firstError && (firstError.code === 'not-found' || !sawRepo) ? firstError : undefined;

    await vscode.commands.executeCommand('setContext', 'kunj.cliMissing', firstError?.code === 'not-found');
    await vscode.commands.executeCommand('setContext', 'kunj.noRepo', !sawRepo && firstError?.code !== 'not-found');

    this.onDidLoadEmitter.fire(this.repos);
    return this.repos;
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    this.onDidLoadEmitter.dispose();
  }
}

// ---- helpers -----------------------------------------------------------

export function prState(pr: PullRequest): string {
  return pr.state === 'open' && pr.draft ? 'draft' : pr.state;
}

// Compact PR badge for the tree description, e.g. "#42 ✓", "#42 ✗", "#42 merged"
export function prBadge(pr: PullRequest): string {
  const check = pr.checks === 'success' ? ' ✓' : pr.checks === 'failure' ? ' ✗' : pr.checks === 'pending' ? ' …' : '';
  if (pr.state === 'open') return `#${pr.number}${pr.draft ? ' draft' : ''}${check}`;
  return `#${pr.number} ${pr.state}`;
}

function escapeMd(text: string): string {
  return text.replace(/[\[\]`*_]/g, m => '\\' + m);
}

export function describeSession(session: WorktreeSession): string {
  const editor = session.editor === 'vscode' ? 'VS Code' : session.editor;
  return session.label ? `${editor} “${session.label}”` : editor;
}

export function shortenHome(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}

// Show paths relative to the parent of the repo root when possible
export function shortenPath(p: string, repoRoot: string): string {
  const parent = path.dirname(repoRoot);
  if (p.startsWith(parent + path.sep)) {
    return p.slice(parent.length + 1);
  }
  return shortenHome(p);
}

export function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}
