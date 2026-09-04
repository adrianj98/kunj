// Worktree command - list, create, remove and open git worktrees.
//
// Also tracks "editor sessions" so tools such as the Kunj VS Code extension
// can show which worktrees are currently open in other windows.
//
//   kunj worktree                         list worktrees
//   kunj worktree add <branch> [path]     create a worktree
//   kunj worktree remove <target>         remove a worktree
//   kunj worktree prune                   prune stale worktree records
//   kunj worktree open <target>           open a worktree in your editor
//   kunj worktree pr <target>             show / open the pull request for a worktree
//   kunj worktree session start|end|list  editor session tracking
//
// Every action supports --json for machine consumption.

import chalk from 'chalk';
import { exec } from 'child_process';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { checkGitRepo } from '../lib/git';
import { loadConfig } from '../lib/config';
import {
  addWorktree,
  findWorktree,
  getPullRequestForBranch,
  lastPullRequestLookup,
  PullRequestInfo,
  getDefaultWorktreePath,
  getMainWorktreePath,
  getCurrentWorktreePath,
  listWorktrees,
  loadActiveSessions,
  pruneWorktrees,
  registerSession,
  removeWorktree,
  unregisterSession,
  WorktreeInfo,
  WorktreeSession,
} from '../lib/worktree';

interface WorktreeOptions {
  status?: boolean;
  pr?: boolean;
  web?: boolean;
  newBranch?: boolean;
  base?: string;
  force?: boolean;
  path?: string;
  pid?: string;
  editor?: string;
  label?: string;
  id?: string;
  newWindow?: boolean;
}

const ACTIONS = ['list', 'add', 'remove', 'prune', 'open', 'session', 'path', 'pr'];

export class WorktreeCommand extends BaseCommand {
  constructor() {
    super({
      name: 'worktree',
      description: 'Manage git worktrees and see which ones are open in an editor',
      arguments: '[action] [target] [extra]',
      ui: {
        category: 'data',
        widget: 'table',
        label: 'Worktrees',
        icon: 'folder-tree',
        refreshInterval: 30,
        defaultArgs: ['list'],
        dataKey: 'worktrees',
        order: 14,
        columns: [
          { key: 'name', label: 'Branch' },
          { key: 'path', label: 'Path' },
          { key: 'isCurrent', label: 'Current' },
          { key: 'openCount', label: 'Open in' },
          { key: 'changedFiles', label: 'Changes' },
          { key: 'prLabel', label: 'PR' },
        ],
      },
      options: [
        { flags: '--no-status', description: 'Skip per-worktree git status (faster listing)' },
        { flags: '--no-pr', description: '[list] Skip pull request lookup (gh / glab)' },
        { flags: '-w, --web', description: '[pr] Open the pull request in the browser' },
        { flags: '-b, --new-branch', description: '[add] Create a new branch for the worktree' },
        { flags: '--base <ref>', description: '[add] Base ref for the new branch (with -b)' },
        { flags: '-p, --path <dir>', description: '[add|session] Explicit worktree path' },
        { flags: '-f, --force', description: '[add|remove] Force the git operation' },
        { flags: '-n, --new-window', description: '[open] Open in a new editor window' },
        { flags: '--pid <pid>', description: '[session] Owning process id' },
        { flags: '--editor <name>', description: '[session] Editor name (e.g. vscode)' },
        { flags: '--label <text>', description: '[session] Human readable window label' },
        { flags: '--id <id>', description: '[session] Session id' },
      ],
    });
  }

  async execute(action?: string, target?: string, extra?: string, options: WorktreeOptions = {}): Promise<void> {
    // Commander passes (action, target, extra, options, command); when fewer
    // positionals are supplied the options object shifts left.
    const args = [action, target, extra];
    const optIndex = args.findIndex(a => a !== undefined && typeof a === 'object');
    if (optIndex !== -1) {
      options = args[optIndex] as unknown as WorktreeOptions;
      args.splice(optIndex);
    }
    [action, target, extra] = args as [string?, string?, string?];

    if (!(await checkGitRepo())) {
      throw new Error('Not a git repository');
    }

    const verb = (action || 'list').toLowerCase();
    if (!ACTIONS.includes(verb)) {
      throw new Error(`Unknown worktree action '${action}'. Expected one of: ${ACTIONS.join(', ')}`);
    }

    switch (verb) {
      case 'list':
        return this.list(options);
      case 'add':
        return this.add(target, extra, options);
      case 'remove':
        return this.remove(target, options);
      case 'prune':
        return this.prune();
      case 'open':
        return this.open(target, options);
      case 'path':
        return this.path(target);
      case 'pr':
        return this.pr(target, options);
      case 'session':
        return this.session(target, options);
    }
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  private async list(options: WorktreeOptions): Promise<void> {
    const worktrees = await listWorktrees({
      includeStatus: options.status !== false,
      includePullRequests: options.pr !== false,
    });
    const mainRoot = await getMainWorktreePath();
    const currentPath = await getCurrentWorktreePath();

    if (this.jsonMode) {
      this.outputJSON({
        repoRoot: mainRoot,
        currentPath,
        pullRequestLookup: lastPullRequestLookup,
        worktrees: worktrees.map(wt => this.toJSON(wt)),
      });
      return;
    }

    console.log(chalk.blue(`Worktrees for ${path.basename(mainRoot)}:`));
    console.log(chalk.gray('─'.repeat(70)));

    for (const wt of worktrees) {
      const marker = wt.isCurrent ? chalk.green('●') : ' ';
      let line = `${marker} ${wt.isCurrent ? chalk.green(wt.name) : chalk.white(wt.name)}`;
      if (wt.isMain) line += chalk.gray(' [main]');
      if (wt.detached) line += chalk.yellow(' [detached]');
      if (wt.locked) line += chalk.magenta(' [locked]');
      if (wt.prunable) line += chalk.red(' [prunable]');
      if (!wt.exists) line += chalk.red(' [missing]');
      console.log(line);
      console.log(chalk.gray(`  │ ${wt.path}`));

      if (wt.status) {
        const parts: string[] = [];
        parts.push(wt.status.dirty ? chalk.yellow(`${wt.status.changedFiles} changed`) : chalk.green('clean'));
        if (wt.status.ahead) parts.push(chalk.cyan(`↑${wt.status.ahead}`));
        if (wt.status.behind) parts.push(chalk.cyan(`↓${wt.status.behind}`));
        console.log(`  │ ${parts.join(' ')}`);
      }

      if (wt.sessions.length > 0) {
        const labels = wt.sessions.map(s => this.describeSession(s)).join(', ');
        console.log(chalk.cyan(`  │ open in: ${labels}`));
      }

      if (wt.pullRequest) {
        console.log(`  │ ${this.describePullRequest(wt.pullRequest)}`);
      }
    }

    console.log('');
    console.log(chalk.gray("Tip: Use 'kunj worktree add <branch>' to create a worktree"));
    console.log(chalk.gray("     Use 'kunj worktree open <branch>' to open one in your editor"));
  }

  private describeSession(session: WorktreeSession): string {
    const editor = session.editor || 'editor';
    return session.label ? `${editor} (${session.label})` : editor;
  }

  private toJSON(wt: WorktreeInfo) {
    return {
      ...wt,
      openCount: wt.sessions.length,
      changedFiles: wt.status ? wt.status.changedFiles : null,
      prLabel: wt.pullRequest ? `#${wt.pullRequest.number} ${wt.pullRequest.state}` : null,
    };
  }

  private describePullRequest(pr: PullRequestInfo): string {
    const stateColor = pr.state === 'open' ? chalk.green : pr.state === 'merged' ? chalk.magenta : chalk.red;
    const parts = [chalk.blue(`PR #${pr.number}`), stateColor(pr.draft && pr.state === 'open' ? 'draft' : pr.state)];
    if (pr.checks) {
      parts.push(pr.checks === 'success' ? chalk.green('checks ✓') : pr.checks === 'failure' ? chalk.red('checks ✗') : chalk.yellow('checks …'));
    }
    if (pr.reviewDecision) parts.push(chalk.gray(pr.reviewDecision.toLowerCase().replace(/_/g, ' ')));
    return `${parts.join(' ')} ${chalk.gray('- ' + pr.title)}`;
  }

  // ---------------------------------------------------------------------
  // pr
  // ---------------------------------------------------------------------

  private async pr(target?: string, options: WorktreeOptions = {}): Promise<void> {
    const wt = await this.resolveTarget(target);
    if (!wt.branch) {
      throw new Error(`Worktree ${wt.path} is detached, so it has no pull request`);
    }
    const pr = await getPullRequestForBranch(wt.branch, wt.exists ? wt.path : undefined);

    if (this.jsonMode) {
      this.outputJSON({ branch: wt.branch, path: wt.path, pullRequest: pr });
      return;
    }

    if (!pr) {
      console.log(chalk.yellow(`No pull request found for '${wt.branch}'`));
      console.log(chalk.gray(`Tip: cd ${wt.path} && kunj pr`));
      return;
    }

    console.log(this.describePullRequest(pr));
    console.log(chalk.gray(`  ${pr.url}`));

    if (options.web) {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
      exec(`${openCmd} '${pr.url.replace(/'/g, "'\\''")}'`);
    }
  }

  // ---------------------------------------------------------------------
  // add
  // ---------------------------------------------------------------------

  private async add(branch?: string, explicitPath?: string, options: WorktreeOptions = {}): Promise<void> {
    if (!branch) {
      throw new Error('Usage: kunj worktree add <branch> [path] [-b] [--base <ref>]');
    }

    const config = loadConfig();
    const targetPath = path.resolve(
      explicitPath || options.path || (await getDefaultWorktreePath(branch, config.worktree?.baseDir))
    );

    // Refuse to create a second worktree for a branch that already has one
    const existing = await findWorktree(branch);
    if (existing && !options.newBranch) {
      throw new Error(`Branch '${branch}' is already checked out in worktree ${existing.path}`);
    }

    this.log(chalk.blue(`Creating worktree for '${branch}' at ${targetPath}...`));

    try {
      await addWorktree({
        branch,
        path: targetPath,
        newBranch: options.newBranch,
        base: options.base,
        force: options.force,
      });
    } catch (error: any) {
      throw new Error(this.cleanGitError(error));
    }

    const created = await findWorktree(targetPath);

    if (this.jsonMode) {
      this.outputJSON({ success: true, worktree: created ? this.toJSON(created) : { path: targetPath, branch } });
      return;
    }

    console.log(chalk.green(`✓ Worktree created at ${targetPath}`));
    console.log(chalk.gray(`Tip: kunj worktree open ${branch}`));
  }

  // ---------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------

  private async remove(target?: string, options: WorktreeOptions = {}): Promise<void> {
    if (!target) {
      throw new Error('Usage: kunj worktree remove <branch|path> [--force]');
    }

    const wt = await findWorktree(target);
    if (!wt) {
      throw new Error(`No worktree found for '${target}'`);
    }
    if (wt.isMain) {
      throw new Error('The main worktree cannot be removed');
    }
    if (wt.isCurrent && !options.force) {
      throw new Error('Refusing to remove the worktree you are currently in (use --force)');
    }
    if (wt.sessions.length > 0 && !options.force) {
      const where = wt.sessions.map(s => this.describeSession(s)).join(', ');
      throw new Error(`Worktree is open in ${where}. Close it first or use --force`);
    }

    this.log(chalk.blue(`Removing worktree ${wt.path}...`));

    try {
      await removeWorktree(wt.path, options.force);
    } catch (error: any) {
      const message = this.cleanGitError(error);
      if (/contains modified or untracked files/i.test(message)) {
        throw new Error(`Worktree has uncommitted changes. Use --force to remove it anyway`);
      }
      throw new Error(message);
    }

    unregisterSession({ path: wt.path });

    if (this.jsonMode) {
      this.outputJSON({ success: true, path: wt.path, branch: wt.branch });
      return;
    }
    console.log(chalk.green(`✓ Removed worktree ${wt.path}`));
  }

  // ---------------------------------------------------------------------
  // prune
  // ---------------------------------------------------------------------

  private async prune(): Promise<void> {
    const output = await pruneWorktrees();
    if (this.jsonMode) {
      this.outputJSON({ success: true, output });
      return;
    }
    console.log(output ? output : chalk.green('✓ Nothing to prune'));
  }

  // ---------------------------------------------------------------------
  // open / path
  // ---------------------------------------------------------------------

  private async resolveTarget(target?: string): Promise<WorktreeInfo> {
    const wt = target ? await findWorktree(target) : await findWorktree(await getMainWorktreePath());
    if (!wt) {
      throw new Error(`No worktree found for '${target}'`);
    }
    return wt;
  }

  private async path(target?: string): Promise<void> {
    const wt = await this.resolveTarget(target);
    if (this.jsonMode) {
      this.outputJSON({ path: wt.path, branch: wt.branch, name: wt.name });
      return;
    }
    process.stdout.write(wt.path + '\n');
  }

  private async open(target?: string, options: WorktreeOptions = {}): Promise<void> {
    const wt = await this.resolveTarget(target);
    if (!wt.exists) {
      throw new Error(`Worktree directory is missing: ${wt.path}`);
    }

    const config = loadConfig();
    const editorCommand = (config.worktree?.editorCommand || 'code').trim();
    const newWindowFlag = options.newWindow && /^code(\s|$)/.test(editorCommand) ? ' -n' : '';
    const command = `${editorCommand}${newWindowFlag} '${wt.path.replace(/'/g, `'\\''`)}'`;

    await new Promise<void>((resolve, reject) => {
      exec(command, error => (error ? reject(new Error(`Failed to run '${command}': ${error.message}`)) : resolve()));
    });

    if (this.jsonMode) {
      this.outputJSON({ success: true, path: wt.path, branch: wt.branch, command });
      return;
    }
    console.log(chalk.green(`✓ Opened ${wt.name} (${wt.path})`));
  }

  // ---------------------------------------------------------------------
  // session
  // ---------------------------------------------------------------------

  private async session(subAction?: string, options: WorktreeOptions = {}): Promise<void> {
    const verb = (subAction || 'list').toLowerCase();

    if (verb === 'list') {
      const sessions = loadActiveSessions();
      if (this.jsonMode) {
        this.outputJSON({ sessions });
        return;
      }
      if (sessions.length === 0) {
        console.log(chalk.gray('No active editor sessions'));
        return;
      }
      for (const s of sessions) {
        console.log(`${chalk.cyan(this.describeSession(s))} ${chalk.gray(`pid ${s.pid}`)} → ${s.path}`);
      }
      return;
    }

    if (verb === 'start' || verb === 'heartbeat') {
      const pid = options.pid ? parseInt(options.pid, 10) : process.ppid;
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('A valid --pid is required');
      }
      const sessionPath = options.path || (await getCurrentWorktreePath());
      if (!sessionPath) {
        throw new Error('Could not determine the worktree path (use --path)');
      }
      const session = registerSession({
        path: sessionPath,
        pid,
        editor: options.editor,
        label: options.label,
        id: options.id,
      });
      if (this.jsonMode) {
        this.outputJSON({ success: true, session });
        return;
      }
      console.log(chalk.green(`✓ Session ${session.id} registered for ${session.path}`));
      return;
    }

    if (verb === 'end' || verb === 'stop') {
      if (!options.id && !options.pid && !options.path) {
        throw new Error('Specify --id, --pid or --path to end a session');
      }
      const removed = unregisterSession({
        id: options.id,
        pid: options.pid ? parseInt(options.pid, 10) : undefined,
        path: options.path,
      });
      if (this.jsonMode) {
        this.outputJSON({ success: true, removed });
        return;
      }
      console.log(chalk.green(`✓ Ended ${removed} session(s)`));
      return;
    }

    throw new Error(`Unknown session action '${subAction}'. Expected: start, end, list`);
  }

  private cleanGitError(error: any): string {
    const raw: string = error?.stderr || error?.message || String(error);
    const lines = raw
      .split('\n')
      .map(l => l.replace(/^(fatal|error):\s*/i, '').trim())
      .filter(l => l && !/^Command failed/i.test(l));
    return lines[0] || 'git worktree command failed';
  }
}
