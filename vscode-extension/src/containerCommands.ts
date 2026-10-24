// Commands for branch containers (`kunj ct`) in the Worktrees view. A container row behaves
// like a worktree row: open it in the editor, open a terminal or an agent in it, see its PR.
// Long or interactive commands (start, remove, prune, forward) run in a terminal, quick ones
// (stop, open, auto-forward) through the CLI's JSON.

import * as vscode from 'vscode';
import { BranchContainer, KunjCli, KunjCliError, resolveCommand } from './kunjCli';
import { ContainerNode, PortNode, WorktreeProvider, prBadge } from './worktreeProvider';

export interface ContainerCommandDeps {
  cli: KunjCli;
  provider: WorktreeProvider;
  output: vscode.OutputChannel;
  refresh: () => void;
}

// Quote one argument for the terminal's shell (POSIX; containers need Docker on macOS or Linux)
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// kunj.cliPath split the way the CLI wrapper splits it ("node /path/index.js", or a quoted path
// with spaces), every part quoted for the shell
export function kunjCommandLine(args: string[]): string {
  const { command, leadingArgs } = resolveCommand();
  return [command, ...leadingArgs, ...args].map(shellArg).join(' ');
}

// An interactive terminal: the user stays in it (shell, agent, a foreground forward)
export function runInTerminal(name: string, cwd: string, line: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show();
  terminal.sendText(line);
  return terminal;
}

// A one-shot command in a terminal that closes itself when it succeeds and stays open (waiting
// for Enter) when it fails, so its output can be read; the view refreshes when it closes
export function runToCompletion(name: string, cwd: string, line: string, onDone: () => void): void {
  const script = `${line}; status=$?; if [ $status -ne 0 ]; then echo; printf 'kunj exited with %s; press Enter to close' "$status"; read _; fi; exit $status`;
  const terminal = vscode.window.createTerminal({ name, cwd, shellPath: '/bin/sh', shellArgs: ['-c', script] });
  terminal.show();
  const sub = vscode.window.onDidCloseTerminal(closed => {
    if (closed !== terminal) return;
    sub.dispose();
    onDone();
  });
}

export function registerContainerCommands(context: vscode.ExtensionContext, deps: ContainerCommandDeps): void {
  const { cli, provider, output, refresh } = deps;
  let credentialsWarned = false;

  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

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

  // From the palette: pick one of the listed containers (optionally only running ones)
  async function pickContainer(placeHolder: string, filter: (c: BranchContainer) => boolean = () => true): Promise<ContainerNode | undefined> {
    await provider.getChildren();
    const entries = provider.allContainers.filter(e => filter(e.container));
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('Kunj: no containers found in this workspace.');
      return undefined;
    }
    const items = entries.map(({ container, repo }) => ({
      label: `$(package) ${container.branch}`,
      description: [container.state, container.pullRequest ? prBadge(container.pullRequest) : ''].filter(Boolean).join('  '),
      node: new ContainerNode(container, repo),
    }));
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.node;
  }

  const nodeFrom = (arg: unknown) => (arg instanceof ContainerNode ? arg : undefined);
  const running = (c: BranchContainer) => c.state === 'running';

  async function openContainer(node: ContainerNode, mode: 'newWindow' | 'currentWindow' | 'ask' | 'default'): Promise<void> {
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
        { placeHolder: `Open the container of ${node.container.branch}` }
      );
      if (!choice) return;
      resolved = choice.value;
    }
    const title = node.running ? `Opening ${node.container.branch}…` : `Starting and opening ${node.container.branch}…`;
    const result = await withProgress(title, () => cli.openContainer(node.repo.cwd, node.container.branch, resolved === 'newWindow'));
    if (!result) return;
    if (result.exec) {
      // worktree.editorCommand is not VS Code-like: kunj prints a shell command instead
      runInTerminal(`kunj ct: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'shell', node.container.branch]));
      return;
    }
    if (result.warning && !credentialsWarned) {
      credentialsWarned = true;
      void vscode.window.showWarningMessage(`Kunj: ${result.warning}`);
    }
  }

  register('kunj.containers.open', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to open'));
    if (node) await openContainer(node, 'default');
  });

  register('kunj.containers.openInNewWindow', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to open in a new window'));
    if (node) await openContainer(node, 'newWindow');
  });

  register('kunj.containers.openInCurrentWindow', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to open in this window'));
    if (node) await openContainer(node, 'currentWindow');
  });

  register('kunj.containers.shell', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container', running));
    if (!node) return;
    runInTerminal(`kunj ct: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'shell', node.container.branch]));
  });

  register('kunj.containers.agent', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to run the agent in'));
    if (!node) return;
    runInTerminal(`kunj agent: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'agent', node.container.branch]));
  });

  register('kunj.containers.start', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to start', c => !running(c)));
    if (!node) return;
    runToCompletion(`kunj ct start: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'start', node.container.branch]), refresh);
  });

  register('kunj.containers.rebuild', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to rebuild'));
    if (!node) return;
    runToCompletion(`kunj ct rebuild: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'start', node.container.branch, '--rebuild']), refresh);
  });

  register('kunj.containers.stop', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to stop', running));
    if (!node) return;
    await withProgress(`Stopping ${node.container.branch}…`, () => cli.stopContainer(node.repo.cwd, node.container.branch));
  });

  // `kunj ct remove` has its own guard (unpushed commits, uncommitted changes) that asks in the terminal
  register('kunj.containers.remove', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to remove'));
    if (!node) return;
    runToCompletion(`kunj ct remove: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'remove', node.container.branch]), refresh);
  });

  register('kunj.containers.forward', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container', running));
    if (!node) return;
    const port = await vscode.window.showInputBox({
      prompt: `Port in the container of ${node.container.branch} to forward (a number, or service:port)`,
      placeHolder: '3000',
      validateInput: v => (/^([A-Za-z0-9_.-]+:)?\d{1,5}$/.test(v.trim()) ? undefined : 'A port number, or service:port'),
    });
    if (!port) return;
    // The forward runs in the foreground until the terminal is closed
    runInTerminal(`kunj forward: ${node.container.branch}`, node.repo.cwd, kunjCommandLine(['ct', 'forward', node.container.branch, port.trim()]));
    setTimeout(refresh, 3000);
  });

  register('kunj.containers.autoForward', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container', running));
    if (!node) return;
    const done = await withProgress(`Forwarding the ports of ${node.container.branch}…`, () => cli.autoForward(node.repo.cwd, node.container.branch));
    if (done !== undefined) void vscode.window.setStatusBarMessage(`Forwarding ports of ${node.container.branch} as they appear`, 4000);
  });

  register('kunj.containers.openPort', async (arg?: unknown) => {
    if (!(arg instanceof PortNode)) return;
    await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${arg.port.host}`));
  });

  register('kunj.containers.copyPortUrl', async (arg?: unknown) => {
    if (!(arg instanceof PortNode)) return;
    const url = `http://localhost:${arg.port.host}`;
    await vscode.env.clipboard.writeText(url);
    void vscode.window.setStatusBarMessage(`Copied ${url}`, 3000);
  });

  register('kunj.containers.openPullRequest', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to open its pull request', c => !!c.pullRequest));
    const pr = node?.container.pullRequest;
    if (pr) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
  });

  register('kunj.containers.copyPullRequestUrl', async (arg?: unknown) => {
    const pr = nodeFrom(arg)?.container.pullRequest;
    if (!pr) return;
    await vscode.env.clipboard.writeText(pr.url);
    void vscode.window.setStatusBarMessage(`Copied ${pr.url}`, 3000);
  });

  // The branch lives on origin (the container pushes there), so the PR is made from origin's branch
  register('kunj.containers.createPullRequest', async (arg?: unknown) => {
    const node = nodeFrom(arg) || (await pickContainer('Select a container to create a pull request for', c => !c.pullRequest));
    if (!node) return;
    runInTerminal(`gh pr: ${node.container.branch}`, node.repo.cwd, ['gh', 'pr', 'create', '--web', '--head', node.container.branch].map(shellArg).join(' '));
  });

  register('kunj.containers.copyName', async (arg?: unknown) => {
    const node = nodeFrom(arg);
    if (!node) return;
    await vscode.env.clipboard.writeText(node.container.name);
    void vscode.window.setStatusBarMessage(`Copied ${node.container.name}`, 3000);
  });

  register('kunj.containers.prune', async () => {
    await provider.getChildren();
    const repo = provider.repositories[0];
    if (!repo) return;
    runToCompletion('kunj ct prune', repo.cwd, kunjCommandLine(['ct', 'prune']), refresh);
  });
}
