// Kunj Worktrees - VS Code extension entry point.
//
// Lists git worktrees, shows which ones are open in other windows and lets
// you open, create and remove them. Everything is delegated to the kunj CLI.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KunjCli, KunjCliError, Worktree } from './kunjCli';
import { SessionManager } from './sessionManager';
import { RepoEntry, WorktreeNode, WorktreeProvider, describeSession, samePath, shortenPath } from './worktreeProvider';

let sessions: SessionManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Kunj');
  const cli = new KunjCli(output);
  const provider = new WorktreeProvider(cli, process.pid);
  sessions = new SessionManager(cli, output);

  const view = vscode.window.createTreeView('kunjWorktrees', { treeDataProvider: provider, showCollapseAll: false });
  context.subscriptions.push(output, provider, sessions, view);

  // ---- status bar ------------------------------------------------------
  const statusBar = vscode.window.createStatusBarItem('kunj.worktrees', vscode.StatusBarAlignment.Left, 90);
  statusBar.name = 'Kunj Worktrees';
  statusBar.command = 'kunj.worktrees.pick';
  context.subscriptions.push(statusBar);

  const updateStatusBar = (repos: RepoEntry[]) => {
    const show = vscode.workspace.getConfiguration('kunj.worktrees').get<boolean>('showStatusBar', true);
    const all = repos.flatMap(r => r.worktrees);
    if (!show || all.length === 0) {
      statusBar.hide();
      return;
    }
    const current = all.find(wt => wt.isCurrent) || all.find(wt => isInWorkspace(wt));
    const openElsewhere = all.filter(wt => otherSessions(wt).length > 0).length;
    statusBar.text = `$(git-branch) ${current ? current.name : `${all.length} worktrees`}`;
    statusBar.tooltip = `${all.length} worktree(s), ${openElsewhere} open in other windows. Click to open a worktree.`;
    statusBar.show();
  };
  context.subscriptions.push(provider.onDidLoad(updateStatusBar));

  // ---- refresh triggers --------------------------------------------------
  const refresh = () => provider.refresh();
  let timer: NodeJS.Timeout | undefined;
  const armTimer = () => {
    if (timer) clearInterval(timer);
    const seconds = vscode.workspace.getConfiguration('kunj.worktrees').get<number>('refreshInterval', 30);
    timer = seconds > 0 ? setInterval(refresh, seconds * 1000) : undefined;
  };
  armTimer();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => state.focused && refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    sessions.onDidChange(refresh),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kunj')) {
        armTimer();
        refresh();
      }
    })
  );

  // React immediately when another window registers or ends a session
  try {
    const sessionsDir = vscode.Uri.file(path.join(os.homedir(), '.kunj'));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(sessionsDir, 'worktree-sessions.json'));
    let debounce: NodeJS.Timeout | undefined;
    const onSessionsChanged = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refresh, 300);
    };
    watcher.onDidChange(onSessionsChanged);
    watcher.onDidCreate(onSessionsChanged);
    watcher.onDidDelete(onSessionsChanged);
    context.subscriptions.push(watcher);
  } catch (error) {
    output.appendLine(`Session file watcher unavailable: ${(error as Error).message}`);
  }

  // ---- helpers -----------------------------------------------------------
  const ownPid = process.pid;
  const host = os.hostname();

  function otherSessions(wt: Worktree) {
    return wt.sessions.filter(s => !(s.host === host && s.pid === ownPid));
  }

  function isInWorkspace(wt: Worktree): boolean {
    return (vscode.workspace.workspaceFolders || []).some(f => samePath(f.uri.fsPath, wt.path));
  }

  function primaryCwd(): string | undefined {
    return provider.repositories[0]?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
    try {
      return await vscode.window.withProgress({ location: { viewId: 'kunjWorktrees' }, title }, task);
    } catch (error) {
      const message = error instanceof KunjCliError ? error.message : String((error as Error)?.message || error);
      void vscode.window.showErrorMessage(`Kunj: ${message}`);
      output.appendLine(`Error: ${message}`);
      return undefined;
    } finally {
      refresh();
    }
  }

  // Ask for a node when a command is invoked from the palette / status bar
  async function pickWorktree(placeHolder: string): Promise<WorktreeNode | undefined> {
    await provider.getChildren();
    const entries = provider.allWorktrees;
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Kunj: no worktrees found in this workspace.');
      return undefined;
    }
    const items = entries.map(({ worktree, repo }) => {
      const node = new WorktreeNode(worktree, repo, ownPid);
      const where = node.openHere || isInWorkspace(worktree)
        ? '$(folder-active) this window'
        : node.openElsewhere.length
          ? `$(window) ${node.openElsewhere.map(describeSession).join(', ')}`
          : '';
      return {
        label: `${node.openElsewhere.length ? '$(window) ' : ''}${worktree.name}`,
        description: where,
        detail: shortenPath(worktree.path, repo.repoRoot),
        node,
      };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    return picked?.node;
  }

  function nodeFrom(arg: unknown): WorktreeNode | undefined {
    return arg instanceof WorktreeNode ? arg : undefined;
  }

  async function openWorktree(node: WorktreeNode, mode: 'newWindow' | 'currentWindow' | 'ask' | 'default'): Promise<void> {
    const wt = node.worktree;
    if (!wt.exists) {
      void vscode.window.showWarningMessage(`Kunj: worktree directory is missing: ${wt.path}`);
      return;
    }
    if (node.openHere || isInWorkspace(wt)) {
      void vscode.window.showInformationMessage(`Kunj: ${wt.name} is already open in this window.`);
      return;
    }

    let resolved = mode;
    if (resolved === 'default') {
      resolved = vscode.workspace.getConfiguration('kunj.worktrees').get<'newWindow' | 'currentWindow' | 'ask'>('clickAction', 'newWindow');
    }
    if (resolved === 'ask') {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(empty-window) Open in New Window', value: 'newWindow' as const },
          { label: '$(folder-opened) Open in Current Window', value: 'currentWindow' as const },
        ],
        { placeHolder: `Open ${wt.name}` }
      );
      if (!choice) return;
      resolved = choice.value;
    }

    const uri = vscode.Uri.file(wt.path);
    if (resolved === 'currentWindow') {
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false, forceReuseWindow: true });
      return;
    }

    // When the folder is already open in another VS Code window, opening it
    // without forcing a new window makes VS Code focus that existing window.
    const alreadyOpenInVsCode = node.openElsewhere.some(s => s.editor === 'vscode' && s.host === host);
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !alreadyOpenInVsCode });
  }

  // ---- commands ----------------------------------------------------------
  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('kunj.worktrees.refresh', () => {
    void sessions?.sync();
    refresh();
  });

  register('kunj.worktrees.pick', async () => {
    const node = await pickWorktree('Select a worktree to open');
    if (node) await openWorktree(node, 'default');
  });

  register('kunj.worktrees.open', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to open'));
    if (node) await openWorktree(node, 'default');
  });

  register('kunj.worktrees.openInNewWindow', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to open in a new window'));
    if (node) await openWorktree(node, 'newWindow');
  });

  register('kunj.worktrees.openInCurrentWindow', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to open in this window'));
    if (node) await openWorktree(node, 'currentWindow');
  });

  register('kunj.worktrees.addToWorkspace', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to add to the workspace'));
    if (!node) return;
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(count, 0, { uri: vscode.Uri.file(node.worktree.path), name: node.worktree.name });
  });

  register('kunj.worktrees.openTerminal', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree'));
    if (!node) return;
    const terminal = vscode.window.createTerminal({ name: `kunj: ${node.worktree.name}`, cwd: node.worktree.path });
    terminal.show();
  });

  register('kunj.worktrees.revealInOS', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree'));
    if (node) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.worktree.path));
  });

  register('kunj.worktrees.copyPath', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree'));
    if (!node) return;
    await vscode.env.clipboard.writeText(node.worktree.path);
    void vscode.window.setStatusBarMessage(`Copied ${node.worktree.path}`, 3000);
  });

  register('kunj.worktrees.prune', async () => {
    const cwd = primaryCwd();
    if (!cwd) return;
    const result = await withProgress('Pruning worktrees…', () => cli.pruneWorktrees(cwd));
    if (result) {
      void vscode.window.showInformationMessage(result.output ? `Kunj: ${result.output}` : 'Kunj: nothing to prune.');
    }
  });

  register('kunj.worktrees.add', async () => {
    await provider.getChildren();
    const repos = provider.repositories;
    if (repos.length === 0) {
      void vscode.window.showWarningMessage('Kunj: open a folder inside a git repository first.');
      return;
    }

    let repo = repos[0];
    if (repos.length > 1) {
      const picked = await vscode.window.showQuickPick(
        repos.map(r => ({ label: path.basename(r.repoRoot), description: r.repoRoot, repo: r })),
        { placeHolder: 'Repository for the new worktree' }
      );
      if (!picked) return;
      repo = picked.repo;
    }

    // Branch choice: existing branch without a worktree, or a brand new branch
    const checkedOut = new Set(repo.worktrees.map(wt => wt.branch).filter(Boolean));
    let branches: Array<{ name: string; lastActivity: string | null; description: string | null }> = [];
    try {
      branches = (await cli.listBranches(repo.cwd)).branches;
    } catch (error) {
      output.appendLine(`Could not list branches: ${(error as Error).message}`);
    }

    const NEW = '$(add) Create new branch…';
    const items: vscode.QuickPickItem[] = [
      { label: NEW, alwaysShow: true },
      { label: 'Existing branches', kind: vscode.QuickPickItemKind.Separator },
      ...branches
        .filter(b => !checkedOut.has(b.name))
        .map(b => ({
          label: b.name,
          description: b.lastActivity || undefined,
          detail: b.description || undefined,
        })),
    ];

    const pick = vscode.window.createQuickPick();
    pick.items = items;
    pick.placeholder = 'Branch to check out in the new worktree (type a name to create it)';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;

    const selection = await new Promise<{ branch: string; isNew: boolean } | undefined>(resolve => {
      pick.onDidChangeValue(value => {
        const typed = value.trim();
        const custom = typed && !branches.some(b => b.name === typed) ? [{ label: typed, description: 'create new branch', alwaysShow: true }] : [];
        pick.items = [...custom, ...items];
      });
      pick.onDidAccept(() => {
        const chosen = pick.selectedItems[0];
        const typed = pick.value.trim();
        if (!chosen && !typed) {
          resolve(undefined);
        } else if (chosen?.label === NEW) {
          resolve({ branch: '', isNew: true });
        } else {
          const name = chosen ? chosen.label : typed;
          resolve({ branch: name, isNew: !branches.some(b => b.name === name) });
        }
        pick.hide();
      });
      pick.onDidHide(() => {
        resolve(undefined);
        pick.dispose();
      });
      pick.show();
    });
    if (!selection) return;

    let branch = selection.branch;
    let base: string | undefined;
    if (selection.isNew) {
      if (!branch) {
        const typed = await vscode.window.showInputBox({
          prompt: 'New branch name',
          validateInput: v => (v.trim() ? undefined : 'Branch name is required'),
        });
        if (!typed) return;
        branch = typed.trim();
      }
      const bases = [
        ...repo.worktrees.filter(wt => wt.branch).map(wt => wt.branch as string),
        ...branches.map(b => b.name),
      ].filter((v, i, arr) => arr.indexOf(v) === i);
      const basePick = await vscode.window.showQuickPick(
        [{ label: 'HEAD', description: 'current commit of this repository' }, ...bases.map(b => ({ label: b }))],
        { placeHolder: `Base branch for ${branch}` }
      );
      if (!basePick) return;
      base = basePick.label === 'HEAD' ? undefined : basePick.label;
    }

    const customPath = await vscode.window.showInputBox({
      prompt: 'Worktree folder (leave empty to use the kunj default location)',
      placeHolder: `${path.dirname(repo.repoRoot)}${path.sep}${path.basename(repo.repoRoot)}-worktrees${path.sep}…`,
    });
    if (customPath === undefined) return;

    const result = await withProgress(`Creating worktree for ${branch}…`, () =>
      cli.addWorktree(repo.cwd, branch, { path: customPath.trim() || undefined, newBranch: selection.isNew, base })
    );
    if (!result) return;

    const created = result.worktree;
    const choice = await vscode.window.showInformationMessage(
      `Kunj: worktree for ${branch} created at ${created.path}`,
      'Open in New Window',
      'Open Here',
      'Add to Workspace'
    );
    const node = new WorktreeNode({ ...created, sessions: created.sessions || [], exists: true }, repo, ownPid);
    if (choice === 'Open in New Window') await openWorktree(node, 'newWindow');
    else if (choice === 'Open Here') await openWorktree(node, 'currentWindow');
    else if (choice === 'Add to Workspace') await vscode.commands.executeCommand('kunj.worktrees.addToWorkspace', node);
  });

  register('kunj.worktrees.remove', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to remove'));
    if (!node) return;
    const wt = node.worktree;
    if (wt.isMain) {
      void vscode.window.showWarningMessage('Kunj: the main worktree cannot be removed.');
      return;
    }

    const warnings: string[] = [];
    if (node.openElsewhere.length) warnings.push(`It is open in ${node.openElsewhere.map(describeSession).join(', ')}.`);
    if (wt.status?.dirty) warnings.push(`It has ${wt.status.changedFiles} uncommitted change(s).`);
    const needsForce = warnings.length > 0;

    const answer = await vscode.window.showWarningMessage(
      `Remove worktree "${wt.name}"?\n${wt.path}${warnings.length ? '\n\n' + warnings.join('\n') : ''}`,
      { modal: true },
      needsForce ? 'Force Remove' : 'Remove'
    );
    if (!answer) return;

    let done = false;
    try {
      await vscode.window.withProgress({ location: { viewId: 'kunjWorktrees' }, title: `Removing ${wt.name}…` }, () =>
        cli.removeWorktree(node.repo.cwd, wt.path, needsForce)
      );
      done = true;
    } catch (error) {
      const message = (error as Error).message || String(error);
      // The CLI refuses open or dirty worktrees without --force; offer it explicitly
      if (!needsForce && /uncommitted|--force/i.test(message)) {
        const retry = await vscode.window.showWarningMessage(
          `Kunj: ${message}\n\nForce removal discards uncommitted changes in the worktree.`,
          { modal: true },
          'Force Remove'
        );
        if (retry) {
          done = (await withProgress(`Force removing ${wt.name}…`, () => cli.removeWorktree(node.repo.cwd, wt.path, true))) !== undefined;
        }
      } else {
        void vscode.window.showErrorMessage(`Kunj: ${message}`);
      }
    } finally {
      refresh();
    }
    if (done) void vscode.window.setStatusBarMessage(`Removed worktree ${wt.name}`, 4000);
  });

  // Register this window's folders, then show the tree
  await sessions.sync();
  refresh();
}

export function deactivate(): void {
  sessions?.endAllSync();
  sessions = undefined;
}
