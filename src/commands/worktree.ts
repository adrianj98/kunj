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
//   kunj worktree keep [add|apply|delete|list]  files copied into every worktree
//
// Every action supports --json for machine consumption.

import chalk from 'chalk';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { loadConfig } from '../lib/config';
import {
  addWorktree,
  findWorktree,
  getPullRequestForBranch,
  listWorktreesDetailed,
  DEFAULT_PR_MAX_AGE_SECONDS,
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
  openWorktree,
} from '../lib/worktree';
import {
  applyKeptFiles,
  deleteKeptFile,
  getKeepDir,
  keepFile,
  listKeptFiles,
  toRelativeKeepPath,
} from '../lib/keep';

interface WorktreeOptions {
  all?: boolean;
  status?: boolean;
  pr?: boolean;
  fresh?: boolean;
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

const ACTIONS = ['list', 'add', 'remove', 'prune', 'open', 'session', 'path', 'pr', 'keep'];

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
        { flags: '--fresh', description: `[list|pr] Bypass the ${DEFAULT_PR_MAX_AGE_SECONDS}s pull request cache` },
        { flags: '-w, --web', description: '[pr] Open the pull request in the browser' },
        { flags: '-b, --new-branch', description: '[add] Create a new branch for the worktree' },
        { flags: '--base <ref>', description: '[add] Base ref for the new branch (with -b)' },
        { flags: '-p, --path <dir>', description: '[add|session] Explicit worktree path' },
        { flags: '-f, --force', description: '[add|remove] Force the git operation' },
        { flags: '-n, --new-window', description: '[open] Open in a new editor window' },
        { flags: '-a, --all', description: '[keep apply] Apply keep files to every worktree' },
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
      case 'keep':
        return this.keep(target, extra, options);
      case 'session':
        return this.session(target, options);
    }
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  private async list(options: WorktreeOptions): Promise<void> {
    const listing = await listWorktreesDetailed({
      includeStatus: options.status !== false,
      includePullRequests: options.pr !== false,
      pullRequestMaxAge: options.fresh ? 0 : DEFAULT_PR_MAX_AGE_SECONDS,
    });
    const { worktrees, repoRoot: mainRoot, currentPath } = listing;

    if (this.jsonMode) {
      this.outputJSON({
        repoRoot: mainRoot,
        currentPath,
        pullRequestLookup: listing.pullRequestLookup,
        pullRequestsFromCache: listing.pullRequestsFromCache,
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
    const pr = await getPullRequestForBranch(wt.branch, wt.exists ? wt.path : undefined, options.fresh ? 0 : DEFAULT_PR_MAX_AGE_SECONDS);

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

    // Raw config here: getDefaultWorktreePath expands ${...} itself, reusing the
    // git call it already makes rather than paying for a second one
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

    let keptFiles: string[] = [];
    try {
      ({ keptFiles } = await addWorktree({
        branch,
        path: targetPath,
        newBranch: options.newBranch,
        base: options.base,
        force: options.force,
      }));
    } catch (error: any) {
      throw new Error(this.cleanGitError(error));
    }

    const created = await findWorktree(targetPath);

    if (this.jsonMode) {
      this.outputJSON({
        success: true,
        worktree: created ? this.toJSON(created) : { path: targetPath, branch },
        keptFiles,
      });
      return;
    }

    console.log(chalk.green(`✓ Worktree created at ${targetPath}`));
    if (keptFiles.length > 0) {
      console.log(chalk.gray(`  Restored ${keptFiles.length} keep file(s): ${keptFiles.join(', ')}`));
    }
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
    const editorCommand = config.worktree?.editorCommand ?? 'code';
    const opened = await openWorktree(editorCommand, wt.path, {
      newWindow: options.newWindow,
      existing: true,
    });

    if (this.jsonMode) {
      this.outputJSON({ success: opened, path: wt.path, branch: wt.branch, editorCommand });
      return;
    }
    if (!opened) {
      // Editor opening is disabled; the path is still useful on its own
      console.log(wt.path);
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

  // ---------------------------------------------------------------------
  // keep - files kept outside git (e.g. .env) and copied into every worktree
  // ---------------------------------------------------------------------

  private async keep(subAction?: string, target?: string, options: WorktreeOptions = {}): Promise<void> {
    const verb = (subAction || '').toLowerCase();
    const files = target ? [target] : [];

    switch (verb) {
      case 'add':
        return this.keepAdd(files);
      case 'apply':
        return this.keepApply(!!options.all);
      case 'delete':
      case 'remove':
        return this.keepDelete(files);
      case 'list':
        return this.keepList();
      case '':
        return this.keepMenu();
      default:
        // Anything else is treated as a file to keep: `kunj worktree keep .env`
        return this.keepAdd([subAction as string, ...files]);
    }
  }

  // Root of the worktree the user is currently in
  private async keepRoot(): Promise<string> {
    const current = await getCurrentWorktreePath();
    return current || process.cwd();
  }

  private async keepAdd(files: string[]): Promise<void> {
    if (files.length === 0) {
      throw new Error('Usage: kunj worktree keep add <file>');
    }
    const root = await this.keepRoot();
    const saved: string[] = [];
    for (const file of files) {
      const relative = toRelativeKeepPath(file, root);
      const dest = keepFile(relative, root);
      saved.push(relative);
      this.log(chalk.green(`✓ Kept ${relative}`) + chalk.gray(`  → ${dest}`));
    }
    if (this.jsonMode) {
      this.outputJSON({ kept: saved, keepDir: getKeepDir() });
    }
  }

  private async keepApply(all: boolean): Promise<void> {
    const files = listKeptFiles();
    if (files.length === 0) {
      this.log(chalk.yellow('No keep files to apply'));
      if (this.jsonMode) this.outputJSON({ applied: {} });
      return;
    }

    const targets = all ? (await listWorktrees()).map(w => w.path) : [await this.keepRoot()];
    const summary: Record<string, string[]> = {};
    for (const target of targets) {
      if (!fs.existsSync(target)) {
        this.log(chalk.yellow(`Skipping missing worktree ${target}`));
        continue;
      }
      const applied = applyKeptFiles(target);
      summary[target] = applied;
      this.log(chalk.green(`✓ Applied ${applied.length} keep file(s) to ${chalk.gray(target)}`));
      applied.forEach(f => this.log(chalk.gray(`  - ${f}`)));
    }
    if (this.jsonMode) {
      this.outputJSON({ applied: summary });
    }
  }

  private async keepDelete(files: string[]): Promise<void> {
    if (files.length === 0) {
      throw new Error('Usage: kunj worktree keep delete <file>');
    }
    const root = await this.keepRoot();
    const deleted: string[] = [];
    for (const file of files) {
      // Accept either the stored relative path or a path on disk
      let relative = file.replace(/\\/g, '/');
      try {
        relative = toRelativeKeepPath(file, root);
      } catch {
        // not inside the worktree; treat as a keep-relative path
      }
      if (deleteKeptFile(relative)) {
        deleted.push(relative);
        this.log(chalk.green(`✓ Removed ${relative} from keep`));
      } else {
        this.log(chalk.yellow(`Not in keep: ${relative}`));
      }
    }
    if (this.jsonMode) {
      this.outputJSON({ deleted });
    }
  }

  private keepList(): void {
    const files = listKeptFiles();
    if (this.jsonMode) {
      this.outputJSON({ keepDir: getKeepDir(), files });
      return;
    }
    if (files.length === 0) {
      this.log(chalk.gray(`No keep files (store: ${getKeepDir()})`));
      return;
    }
    this.log(chalk.cyan(`\n📌 Keep files (${files.length}) in ${chalk.gray(getKeepDir())}:\n`));
    files.forEach(f => this.log(`  ${f}`));
    this.log('');
  }

  private async keepMenu(): Promise<void> {
    if (this.jsonMode) {
      this.keepList();
      return;
    }
    // Loaded here, not at the top: inquirer costs ~0.2s to import and this is
    // the only interactive path in a module the editor calls many times a minute
    const inquirer = (await import('inquirer')).default;
    // Loop until the user cancels
    while (true) {
      const files = listKeptFiles();
      this.log(chalk.cyan(`\n📌 Keep files: ${files.length}  ${chalk.gray(getKeepDir())}`));
      files.slice(0, 15).forEach(f => this.log(chalk.gray(`  - ${f}`)));
      if (files.length > 15) this.log(chalk.gray(`  ... and ${files.length - 15} more`));

      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: 'Add a file to keep', value: 'add' },
            { name: 'Apply keep files to this worktree', value: 'apply' },
            { name: 'Apply keep files to all worktrees', value: 'applyAll' },
            { name: 'Delete a keep file', value: 'delete' },
            { name: 'Show keep files', value: 'list' },
            { name: chalk.gray('Done'), value: 'done' },
          ],
        },
      ]);

      switch (action) {
        case 'add': {
          const { file } = await inquirer.prompt([
            {
              type: 'input',
              name: 'file',
              message: 'File path (relative to the worktree root):',
              validate: (input: string) => (input.trim() ? true : 'A file path is required'),
            },
          ]);
          try {
            await this.keepAdd([file.trim()]);
          } catch (error: any) {
            console.error(chalk.red(error.message));
          }
          break;
        }
        case 'apply':
          await this.keepApply(false);
          break;
        case 'applyAll':
          await this.keepApply(true);
          break;
        case 'delete': {
          if (files.length === 0) {
            this.log(chalk.yellow('Nothing to delete'));
            break;
          }
          const { selected } = await inquirer.prompt([
            {
              type: 'checkbox',
              name: 'selected',
              message: 'Select keep files to delete:',
              choices: files.map(f => ({ name: f, value: f })),
            },
          ]);
          if (selected.length > 0) {
            const { confirm } = await inquirer.prompt([
              { type: 'confirm', name: 'confirm', message: `Delete ${selected.length} keep file(s)?`, default: false },
            ]);
            if (confirm) {
              await this.keepDelete(selected);
            }
          }
          break;
        }
        case 'list':
          this.keepList();
          break;
        default:
          return;
      }
    }
  }
}
