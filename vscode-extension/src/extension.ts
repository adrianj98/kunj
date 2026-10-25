// Kunj Worktrees - VS Code extension entry point.
//
// Lists git worktrees, shows which ones are open in other windows and lets
// you open, create and remove them. Everything is delegated to the kunj CLI.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { KunjCli, KunjCliError, Worktree } from './kunjCli';
import { SessionManager } from './sessionManager';
import { EventStream } from './eventStream';
import { kunjCommandLine, registerContainerCommands, runInTerminal, runToCompletion } from './containerCommands';
import { RepoEntry, WorktreeNode, WorktreeProvider, describeSession, prBadge, samePath, shortenPath } from './worktreeProvider';

let sessions: SessionManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Kunj');
  const cli = new KunjCli(output);
  const provider = new WorktreeProvider(cli, process.pid);
  sessions = new SessionManager(cli, output);

  const view = vscode.window.createTreeView('kunjWorktrees', { treeDataProvider: provider, showCollapseAll: false, canSelectMany: true });
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

  // Container, agent, forward and git changes as they happen, for the repositories in the view
  const events = new EventStream(refresh, output);
  context.subscriptions.push(events, provider.onDidLoad(repos => events.watch(repos.map(r => r.repoRoot))));

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(state => state.focused && refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    sessions.onDidChange(refresh),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kunj')) {
        if (e.affectsConfiguration('kunj.cliPath')) events.reset();
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
      // Our own heartbeat writes the file too; only other windows' changes matter
      if (sessions && Date.now() - sessions.lastWriteAt < 2000) return;
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
      const pr = worktree.pullRequest ? `$(git-pull-request) ${prBadge(worktree.pullRequest)}` : '';
      return {
        label: `${node.openElsewhere.length ? '$(window) ' : ''}${worktree.name}`,
        description: [where, pr].filter(Boolean).join('  '),
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

  registerContainerCommands(context, { cli, provider, output, refresh });

  // `kunj agent` in the worktree: the same host tmux session the workspace app and the CLI use
  register('kunj.worktrees.agent', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to run the agent in'));
    if (!node || !node.worktree.exists) return;
    runInTerminal(`kunj agent: ${node.worktree.name}`, node.worktree.path, kunjCommandLine(['agent']));
  });

  register('kunj.worktrees.refresh', () => {
    void sessions?.sync();
    provider.refresh(true); // manual refresh also re-fetches pull requests
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

  register('kunj.worktrees.openPullRequest', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to open its pull request'));
    if (!node) return;
    let pr = node.worktree.pullRequest || null;
    if (!pr && node.worktree.branch) {
      // Not in the cached listing (lookup disabled or PR just created): ask the CLI directly
      const result = await withProgress(`Looking up pull request for ${node.worktree.name}…`, () =>
        cli.getPullRequest(node.repo.cwd, node.worktree.path)
      );
      pr = result?.pullRequest || null;
    }
    if (!pr) {
      const create = await vscode.window.showInformationMessage(
        `Kunj: no pull request found for ${node.worktree.name}.`,
        'Create Pull Request'
      );
      if (create) await vscode.commands.executeCommand('kunj.worktrees.createPullRequest', node);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(pr.url));
  });

  register('kunj.worktrees.copyPullRequestUrl', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree'));
    const pr = node?.worktree.pullRequest;
    if (!node || !pr) return;
    await vscode.env.clipboard.writeText(pr.url);
    void vscode.window.setStatusBarMessage(`Copied ${pr.url}`, 3000);
  });

  // `kunj pr` is interactive (AI description, prompts), so run it in a terminal
  register('kunj.worktrees.createPullRequest', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickWorktree('Select a worktree to create a pull request for'));
    if (!node) return;
    const cliPath = (vscode.workspace.getConfiguration('kunj').get<string>('cliPath') || 'kunj').trim();
    const terminal = vscode.window.createTerminal({ name: `kunj pr: ${node.worktree.name}`, cwd: node.worktree.path });
    terminal.show();
    terminal.sendText(`${cliPath} pr`);
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

    const showContainers = vscode.workspace.getConfiguration('kunj.worktrees').get<boolean>('showContainers', true);
    if (showContainers) {
      const where = await vscode.window.showQuickPick(
        [
          { label: '$(folder) Worktree', description: 'a checkout on this machine', value: 'worktree' as const },
          { label: '$(package) Container', description: 'a sandboxed clone in Docker (kunj ct start)', value: 'container' as const },
        ],
        { placeHolder: `Where should ${branch} live?` }
      );
      if (!where) return;
      if (where.value === 'container') {
        // Building the image and seeding the clone takes a while and may ask questions: a terminal
        const args = ['ct', 'start', branch, ...(selection.isNew ? ['-c'] : []), ...(base ? ['--base', base] : [])];
        runToCompletion(`kunj ct start: ${branch}`, repo.cwd, kunjCommandLine(args), refresh);
        return;
      }
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

  // From the tree VS Code passes the clicked node and, with several selected, all of them;
  // from the palette nothing, so offer a multi-select pick
  register('kunj.worktrees.remove', async (arg?: unknown, selected?: unknown) => {
    let nodes: WorktreeNode[];
    const clicked = nodeFrom(arg);
    if (clicked) {
      const many = Array.isArray(selected) ? selected.filter((n): n is WorktreeNode => n instanceof WorktreeNode) : [];
      nodes = many.some(n => n.id === clicked.id) ? many : [clicked];
    } else {
      nodes = await pickWorktreesToRemove();
    }
    if (nodes.length === 0) return;

    // The main worktree cannot go, and removing the one open in this window would pull it out from under us
    const skipped = nodes.filter(n => n.worktree.isMain || n.openHere || isInWorkspace(n.worktree));
    nodes = nodes.filter(n => !skipped.includes(n));
    if (nodes.length === 0) {
      void vscode.window.showWarningMessage('Kunj: the main worktree and worktrees open in this window cannot be removed.');
      return;
    }

    const warningsFor = (node: WorktreeNode) => {
      const wt = node.worktree;
      const warnings: string[] = [];
      if (node.openElsewhere.length) warnings.push(`windows open in ${node.openElsewhere.map(describeSession).join(', ')}`);
      if (wt.status?.dirty) warnings.push(`${wt.status.changedFiles} uncommitted change(s)`);
      return warnings;
    };
    const needsForce = (node: WorktreeNode) => warningsFor(node).length > 0;
    const anyForce = nodes.some(needsForce);

    let prompt: string;
    if (nodes.length === 1) {
      const warnings = warningsFor(nodes[0]);
      prompt = `Remove worktree "${nodes[0].worktree.name}"?\n${nodes[0].worktree.path}${warnings.length ? `\n\nIt has ${warnings.join(' and ')}.` : ''}`;
    } else {
      const lines = nodes.map(n => {
        const warnings = warningsFor(n);
        return `• ${n.worktree.name}${warnings.length ? ` (${warnings.join(', ')})` : ''}`;
      });
      prompt = `Remove ${nodes.length} worktrees?\n\n${lines.join('\n')}`;
    }
    if (skipped.length) prompt += `\n\nSkipping ${skipped.map(n => n.worktree.name).join(', ')} (main or open in this window).`;

    const answer = await vscode.window.showWarningMessage(prompt, { modal: true }, anyForce ? 'Force Remove' : 'Remove');
    if (!answer) return;

    const removed: string[] = [];
    const refused: WorktreeNode[] = [];
    const failed: string[] = [];
    try {
      await vscode.window.withProgress({ location: { viewId: 'kunjWorktrees' }, title: 'Removing worktrees…' }, async progress => {
        for (const node of nodes) {
          progress.report({ message: node.worktree.name });
          try {
            await cli.removeWorktree(node.repo.cwd, node.worktree.path, needsForce(node));
            removed.push(node.worktree.name);
          } catch (error) {
            const message = (error as Error).message || String(error);
            // The CLI refuses open or dirty worktrees without --force; offer it explicitly below
            if (!needsForce(node) && /uncommitted|--force/i.test(message)) refused.push(node);
            else failed.push(`${node.worktree.name}: ${message}`);
            output.appendLine(`Error removing ${node.worktree.path}: ${message}`);
          }
        }
      });

      if (refused.length) {
        const names = refused.map(n => n.worktree.name).join(', ');
        const retry = await vscode.window.showWarningMessage(
          `Kunj: git refused to remove ${names} because of uncommitted changes.\n\nForce removal discards uncommitted changes in the worktree.`,
          { modal: true },
          'Force Remove'
        );
        if (retry) {
          for (const node of refused) {
            const ok = await withProgress(`Force removing ${node.worktree.name}…`, () => cli.removeWorktree(node.repo.cwd, node.worktree.path, true));
            if (ok !== undefined) removed.push(node.worktree.name);
          }
        }
      }
    } finally {
      refresh();
    }
    if (failed.length) void vscode.window.showErrorMessage(`Kunj: ${failed.join('\n')}`);
    if (removed.length) {
      void vscode.window.setStatusBarMessage(
        removed.length === 1 ? `Removed worktree ${removed[0]}` : `Removed ${removed.length} worktrees`,
        4000
      );
    }
  });

  async function pickWorktreesToRemove(): Promise<WorktreeNode[]> {
    await provider.getChildren();
    const items = provider.allWorktrees
      .map(({ worktree, repo }) => new WorktreeNode(worktree, repo, ownPid))
      .filter(node => !node.worktree.isMain && !node.openHere && !isInWorkspace(node.worktree))
      .map(node => {
        const wt = node.worktree;
        const notes = [
          node.openElsewhere.length ? `$(window) ${node.openElsewhere.map(describeSession).join(', ')}` : '',
          wt.status?.dirty ? `$(edit) ${wt.status.changedFiles}` : '',
          wt.pullRequest ? `$(git-pull-request) ${prBadge(wt.pullRequest)}` : '',
        ];
        return { label: wt.name, description: notes.filter(Boolean).join('  '), detail: shortenPath(wt.path, node.repo.repoRoot), node };
      });
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Kunj: no worktrees that can be removed.');
      return [];
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the worktrees to remove',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return (picked || []).map(item => item.node);
  }

  // Register this window's folders; the tree loads once when the view first asks for children
  await sessions.sync();
}

export function deactivate(): void {
  sessions?.endAllSync();
  sessions = undefined;
}
