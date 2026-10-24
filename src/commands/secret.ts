// kunj secret: manage the encrypted secret store (src/lib/secrets/). Values come from a hidden prompt or
// stdin, never argv, and are printed only by `get` and `env`, which refuse --json.
// On the fast path (src/commands/fast.ts): keep top-level imports light, no inquirer.

import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getGlobalKunjDir, getKunjDir } from '../lib/config';
import { getCurrentBranch } from '../lib/git';
import { getCurrentWorktreePath, listWorktrees } from '../lib/worktree';
import { deleteKeptFile, getKeepDir, hasKeptFile } from '../lib/keep';
import { parseDotenv, isSecretName } from '../lib/secrets/dotenv';
import { SecretError } from '../lib/secrets/errors';
import { getUnlock, GetUnlockOptions, hiddenPrompt } from '../lib/secrets/keyprovider';
import { configuredMode, envOf, openVaults, resolveSecrets, SecretTarget } from '../lib/secrets/resolve';
import { renderFiles, writeHostFiles } from '../lib/secrets/deliver';
import { readVault, SecretEntry, vaultFiles, vaultKdf, writeVault } from '../lib/secrets/vault';
import type { SecretApplyJson, SecretImportJson, SecretListJson, SecretWriteJson } from '../lib/json-types';

interface SecretOptions {
  json?: boolean;
  branch?: string | boolean;
  global?: boolean;
  targets?: string;
  file?: string;
  env?: boolean;
  target?: string;
  yes?: boolean;
  delete?: boolean;
  all?: boolean;
  force?: boolean;
}

// The import that moves this repository's kept .env into the vault (`~` for the home directory),
// or undefined when there is no kept .env. Shared with `kunj setup`.
export function keptEnvImportCommand(home: string = os.homedir()): string | undefined {
  if (!hasKeptFile('.env')) return undefined;
  const kept = path.join(getKeepDir(), '.env');
  const shown = kept.startsWith(home + path.sep) ? '~' + kept.slice(home.length) : kept;
  return `kunj secret import ${shown} --delete`;
}

type Scope = { global: true } | { global: false; branch?: string };
type ScopeName = SecretListJson['secrets'][number]['scope'];

// Test seams; each defaults to the process, the terminal, git and the key provider settings.
export interface SecretCommandDeps {
  unlock?: Partial<Pick<GetUnlockOptions, 'mode' | 'env' | 'platform' | 'run' | 'prompt' | 'tty'>>;
  isTTY?: () => boolean;
  stdin?: () => Promise<string>;
  hiddenPrompt?: (message: string) => Promise<string>;
  confirm?: (message: string) => Promise<boolean>;
  currentBranch?: () => Promise<string>;
  worktreeRoot?: () => Promise<string>;
  worktrees?: () => Promise<Array<{ path: string; branch: string | null }>>;
  cwd?: () => string;
  home?: () => string;
}

const ACTIONS = ['set', 'import', 'list', 'get', 'rm', 'env', 'apply'];
const TARGETS: SecretTarget[] = ['host', 'container'];

export class SecretCommand extends BaseCommand {
  constructor(private readonly deps: SecretCommandDeps = {}) {
    super({
      name: 'secret',
      description: 'Manage encrypted secrets and where they are delivered',
      arguments: '[action] [args...]',
      options: [
        { flags: '--branch [branch]', description: 'Branch scope (without a name: the current branch)' },
        { flags: '--global', description: 'The global store (environment variables only)' },
        { flags: '--targets <list>', description: '[set, import] host, container or host,container (default both)' },
        { flags: '--file <path>', description: '[set, import] Also render into this file, relative to the worktree (import: default .env)' },
        { flags: '--no-env', description: '[set, import] Do not deliver as an environment variable' },
        { flags: '--target <target>', description: '[env] host (default) or container' },
        { flags: '--yes', description: '[import] Do not ask for confirmation' },
        { flags: '--delete', description: '[import] Delete the source file (and its keep copy) afterwards' },
        { flags: '-a, --all', description: '[apply] Render into every worktree' },
        { flags: '--force', description: '[apply] Write files that git does not ignore' },
      ],
      helpText: [
        'Actions:',
        '  set NAME           store a value (hidden prompt, or stdin when piped; never an argument)',
        '  import <file>      import a .env file (default: repo scope, host and container, env plus .env)',
        '  list               names, scope, targets and delivery; never values',
        '  get NAME           print one value (refused with --json)',
        '  rm NAME            remove one (of the scope given by --global / --branch)',
        '  env                resolved secrets as export lines, for eval (refused with --json)',
        '  apply [-a]         render file deliveries into this worktree (or every one)',
        '',
        'Secrets are stored at repo scope unless --global or --branch is given. Reads (get, env, apply)',
        'resolve global, then repo, then the branch (the current one unless --branch names another).',
      ].join('\n'),
    });
  }

  async execute(action?: any, args?: any, options?: any): Promise<void> {
    // Commander passes (action, args[], options, command); tests may pass fewer.
    const opts: SecretOptions = [action, args, options].find((a) => a && typeof a === 'object' && !Array.isArray(a)) ?? {};
    const verb = typeof action === 'string' ? action : 'list';
    const rest: string[] = Array.isArray(args) ? args : [];
    if (opts.json) this.jsonMode = true;

    switch (verb) {
      case 'set':
        return this.set(rest[0], opts);
      case 'import':
        return this.import(rest[0], opts);
      case 'list':
        return this.list(opts);
      case 'get':
        return this.get(rest[0], opts);
      case 'rm':
        return this.rm(rest[0], opts);
      case 'env':
        return this.env(opts);
      case 'apply':
        return this.apply(opts);
      default:
        throw new Error(`Unknown action ${JSON.stringify(verb)}; one of ${ACTIONS.join(', ')}`);
    }
  }

  private async set(name: string | undefined, opts: SecretOptions): Promise<void> {
    checkName(name);
    const scope = await this.writeScope(opts);
    const shape = deliveryShape(scope, opts, undefined);
    const value = await this.readValue(name);
    const entry: SecretEntry = { name, value, ...scopeField(scope), ...shape, updatedAt: new Date().toISOString() };
    await this.modify(scope, (entries) => [...entries.filter((e) => !sameSlot(e, name, scope)), entry]);
    if (this.jsonMode) this.outputJSON(writeJson(name, scope) satisfies SecretWriteJson);
    else this.log(chalk.green(`✓ Stored ${name} (${scopeLabel(scope)})`));
  }

  private async import(file: string | undefined, opts: SecretOptions): Promise<void> {
    if (!file) throw new Error('Usage: kunj secret import <file>');
    const scope = await this.writeScope(opts);
    const shape = deliveryShape(scope, opts, '.env');
    const source = path.resolve(this.cwd(), file);
    if (!fs.existsSync(source)) throw new Error(`File not found: ${file}`);
    let parsed: Array<{ name: string; value: string }>;
    try {
      parsed = parseDotenv(fs.readFileSync(source, 'utf8'));
    } catch (err) {
      // parseDotenv's messages name the line, never the text (which may be a value).
      throw new SecretError(`${file}: ${(err as Error).message}`, 'bad-dotenv');
    }
    if (parsed.length === 0) {
      if (this.jsonMode) this.outputJSON({ imported: [] } satisfies SecretImportJson);
      else this.log(chalk.yellow(`No secrets in ${file}`));
      return;
    }

    const names = parsed.map((p) => p.name);
    const updatedAt = new Date().toISOString();
    let confirmed = true;
    await this.modify(scope, async (entries) => {
      if (!this.jsonMode && !opts.yes && this.isTTY()) {
        this.log(`Import into ${scopeLabel(scope)}:`);
        for (const n of names) this.log(`  ${n}  ${entries.some((e) => sameSlot(e, n, scope)) ? chalk.yellow('replace') : chalk.green('add')}`);
        confirmed = await this.confirm(`Import ${names.length} secret(s)?`);
        if (!confirmed) return null;
      }
      const kept = entries.filter((e) => !names.some((n) => sameSlot(e, n, scope)));
      return [...kept, ...parsed.map((p): SecretEntry => ({ name: p.name, value: p.value, ...scopeField(scope), ...shape, updatedAt }))];
    });
    if (!confirmed) {
      this.log('Nothing imported');
      return;
    }

    if (opts.delete) await this.deleteSource(source);
    if (this.jsonMode) this.outputJSON({ imported: names } satisfies SecretImportJson);
    else {
      this.log(chalk.green(`✓ Imported ${names.length} secret(s) into ${scopeLabel(scope)}: ${names.join(', ')}`));
      if (opts.delete) this.log(chalk.gray(`  deleted ${file}`));
    }
  }

  private async list(opts: SecretOptions): Promise<void> {
    if (opts.global && opts.branch !== undefined) throw new Error('--global and --branch cannot be combined');
    const branch = opts.branch === undefined ? undefined : await this.branchArg(opts.branch);
    const { global, repo } = await this.open();
    const rows: SecretListJson['secrets'] = [];
    const row = (e: SecretEntry, scope: ScopeName) => ({
      name: e.name,
      scope,
      ...(scope === 'branch' ? { branch: e.scope?.branch } : {}),
      targets: e.targets,
      delivery: scope === 'global' ? { env: e.delivery.env } : e.delivery,
      updatedAt: e.updatedAt,
    });
    if (branch === undefined) for (const e of sortEntries(global)) rows.push(row(e, 'global'));
    if (!opts.global) {
      const sorted = sortEntries(repo);
      if (branch === undefined) for (const e of sorted) if (!e.scope?.branch) rows.push(row(e, 'repo'));
      for (const e of sorted) if (e.scope?.branch && (branch === undefined || e.scope.branch === branch)) rows.push(row(e, 'branch'));
    }

    if (this.jsonMode) {
      this.outputJSON({ secrets: rows } satisfies SecretListJson);
      return;
    }
    // Migration: a repo with no secrets of its own but a plaintext keep .env is told how to move it.
    const hint = branch === undefined && !opts.global && repo.length === 0 ? keptEnvImportCommand(this.deps.home ? this.deps.home() : undefined) : undefined;
    if (rows.length === 0) this.log(chalk.gray('No secrets'));
    if (hint) this.log(chalk.yellow(`Found a kept .env: ${hint}`));
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) {
      const where = r.scope === 'branch' ? `branch ${r.branch}` : r.scope;
      const delivery = [r.delivery.env ? 'env' : '', r.delivery.file ? `file ${r.delivery.file}` : ''].filter(Boolean).join(', ');
      this.log(`${r.name.padEnd(width)}  ${chalk.cyan(where)}  ${r.targets.join(',')}  ${chalk.gray(delivery)}`);
    }
  }

  private async get(name: string | undefined, opts: SecretOptions): Promise<void> {
    // A value in JSON output ends up in app logs; get is for scripts.
    if (opts.json) throw new Error('kunj secret get prints a value and does not take --json');
    checkName(name);
    if (opts.global && opts.branch !== undefined) throw new Error('--global and --branch cannot be combined');
    const branch = opts.global ? undefined : await this.readBranch(opts.branch);
    const { global, repo } = await this.open();
    const found = opts.global
      ? global.find((e) => e.name === name)
      : (branch !== undefined ? repo.find((e) => e.name === name && e.scope?.branch === branch) : undefined) ??
        repo.find((e) => e.name === name && !e.scope?.branch) ??
        global.find((e) => e.name === name);
    if (!found) throw notFound(name, opts.global ? { global: true } : { global: false, branch });
    process.stdout.write(found.value + '\n');
  }

  private async rm(name: string | undefined, opts: SecretOptions): Promise<void> {
    checkName(name);
    const scope = await this.writeScope(opts);
    const file = this.fileOf(scope);
    if (!vaultKdf(file)) throw notFound(name, scope);
    await this.modify(scope, (entries) => {
      if (!entries.some((e) => sameSlot(e, name, scope))) throw notFound(name, scope);
      return entries.filter((e) => !sameSlot(e, name, scope));
    });
    if (this.jsonMode) this.outputJSON(writeJson(name, scope) satisfies SecretWriteJson);
    else this.log(chalk.green(`✓ Removed ${name} (${scopeLabel(scope)})`));
  }

  private async env(opts: SecretOptions): Promise<void> {
    if (opts.json) throw new Error('kunj secret env prints values and does not take --json');
    const target = (opts.target ?? 'host') as SecretTarget;
    if (!TARGETS.includes(target)) throw new Error(`--target must be host or container`);
    const branch = await this.readBranch(opts.branch);
    const { global, repo } = await this.open();
    const env = envOf(resolveSecrets(global, repo, branch, target));
    for (const [name, value] of Object.entries(env)) process.stdout.write(`export ${name}='${value.replace(/'/g, `'\\''`)}'\n`);
  }

  private async apply(opts: SecretOptions): Promise<void> {
    const targets = opts.all
      ? await (this.deps.worktrees ?? defaultWorktrees)()
      : [{ path: await this.worktreeRoot(), branch: (await this.readBranch(opts.branch)) ?? null }];
    // Opened once, so -a asks for a passphrase once; each worktree resolves with its own branch.
    const { global, repo } = await this.open();
    const summary: SecretApplyJson['applied'] = {};
    for (const t of targets) {
      if (!fs.existsSync(t.path)) {
        if (!this.jsonMode) console.error(chalk.yellow(`Skipping missing worktree ${t.path}`));
        continue;
      }
      const files = renderFiles(resolveSecrets(global, repo, t.branch ?? undefined, 'host'));
      const written = files.size ? await writeHostFiles(t.path, files, { force: opts.force }) : [];
      summary[t.path] = written;
      this.log(chalk.green(`✓ Rendered ${written.length} secret file(s) into ${chalk.gray(t.path)}`));
      for (const f of written) this.log(chalk.gray(`  - ${f}`));
    }
    if (this.jsonMode) this.outputJSON({ applied: summary } satisfies SecretApplyJson);
  }

  // --- helpers ---

  private async writeScope(opts: SecretOptions): Promise<Scope> {
    if (opts.global && opts.branch !== undefined) throw new Error('--global and --branch cannot be combined');
    if (opts.global) return { global: true };
    if (opts.branch === undefined) return { global: false };
    return { global: false, branch: await this.branchArg(opts.branch) };
  }

  // --branch with a name, or with none (the current branch).
  private async branchArg(branch: string | boolean): Promise<string> {
    if (typeof branch === 'string' && branch) return branch;
    const current = await this.currentBranch();
    if (!current) throw new Error('No current branch (detached HEAD?); pass --branch <name>');
    return current;
  }

  // The branch layer of a read: --branch, else the current branch (none when detached).
  private async readBranch(branch: string | boolean | undefined): Promise<string | undefined> {
    if (typeof branch === 'string' && branch) return branch;
    return (await this.currentBranch()) || undefined;
  }

  private currentBranch(): Promise<string> {
    return (this.deps.currentBranch ?? getCurrentBranch)();
  }

  private async worktreeRoot(): Promise<string> {
    if (this.deps.worktreeRoot) return this.deps.worktreeRoot();
    return (await getCurrentWorktreePath()) ?? this.cwd();
  }

  private cwd(): string {
    return this.deps.cwd ? this.deps.cwd() : process.cwd();
  }

  private isTTY(): boolean {
    return this.deps.isTTY ? this.deps.isTTY() : !!process.stdin.isTTY;
  }

  private files(): { global: string; repo: string } {
    return vaultFiles(getKunjDir(), getGlobalKunjDir());
  }

  private fileOf(scope: Scope): string {
    const files = this.files();
    return scope.global ? files.global : files.repo;
  }

  private open() {
    const u = this.deps.unlock ?? {};
    return openVaults({ ...u, kunjDir: getKunjDir(), globalDir: getGlobalKunjDir() });
  }

  // Read-modify-write of the vault file of a scope. `change` returning null leaves the file alone.
  // Only when neither vault file exists may getUnlock make a new key; a new file next to an existing
  // one takes that one's kdf (and key).
  private async modify(scope: Scope, change: (entries: SecretEntry[]) => SecretEntry[] | null | Promise<SecretEntry[] | null>): Promise<void> {
    const files = this.files();
    const file = scope.global ? files.global : files.repo;
    const other = scope.global ? files.repo : files.global;
    const own = vaultKdf(file);
    const existingKdf = own ?? vaultKdf(other);
    const u = this.deps.unlock ?? {};
    const unlock = await getUnlock({
      mode: u.mode ?? (await configuredMode()),
      env: u.env ?? process.env,
      platform: u.platform ?? process.platform,
      run: u.run,
      prompt: u.prompt,
      tty: u.tty,
      existingKdf,
      create: true,
    });
    const entries = own ? await readVault(file, unlock) : [];
    const next = await change(entries);
    if (next) await writeVault(file, sortEntries(next), unlock);
  }

  private async readValue(name: string): Promise<string> {
    if (this.isTTY()) {
      const ask = this.deps.hiddenPrompt ?? ((m: string) => hiddenPrompt(m));
      try {
        return await ask(`Value for ${name}: `);
      } catch {
        throw new Error('No value given');
      }
    }
    const raw = await (this.deps.stdin ?? readStdin)();
    return raw.replace(/\r?\n$/, '');
  }

  private async confirm(message: string): Promise<boolean> {
    if (this.deps.confirm) return this.deps.confirm(message);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readline = require('readline') as typeof import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
      let answered = false;
      rl.on('close', () => {
        if (!answered) resolve(false);
      });
      rl.question(`${message} [y/N] `, (answer) => {
        answered = true;
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  }

  // --delete: the source goes, and so does its keep copy, so a new worktree does not get the
  // plaintext file back. A source inside the keep store is removed through it. A symlink is removed
  // itself, never the file it points to, unless that file is in the keep store.
  private async deleteSource(source: string): Promise<void> {
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    // The named path with its directories resolved, but not its last component.
    const abs = path.join(real(path.dirname(source)), path.basename(source));
    const inKeep = path.relative(real(getKeepDir()), real(source));
    if (inKeep && !inKeep.startsWith('..') && !path.isAbsolute(inKeep)) {
      deleteKeptFile(inKeep.split(path.sep).join('/'));
    }
    fs.rmSync(abs, { force: true });
    let root: string;
    try {
      root = real(await this.worktreeRoot());
    } catch {
      return;
    }
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const relative = rel.split(path.sep).join('/');
    if (hasKeptFile(relative)) deleteKeptFile(relative);
  }
}

function checkName(name: string | undefined): asserts name is string {
  if (!name) throw new Error('A secret name is required');
  if (!isSecretName(name)) throw new SecretError(`Invalid secret name ${JSON.stringify(name)}: names must match [A-Za-z_][A-Za-z0-9_]*`, 'bad-name');
}

// targets and delivery of a new entry, from --targets, --file and --no-env.
function deliveryShape(scope: Scope, opts: SecretOptions, defaultFile: string | undefined): Pick<SecretEntry, 'targets' | 'delivery'> {
  const targets = parseTargets(opts.targets);
  if (scope.global && opts.file) throw new Error('Global secrets are env only: --file needs repo or branch scope');
  const file = scope.global ? undefined : opts.file ?? defaultFile;
  if (file !== undefined) checkFilePath(file);
  const env = opts.env !== false;
  if (!env && !file) throw new Error('--no-env without --file leaves nothing to deliver');
  return { targets, delivery: { env, ...(file ? { file } : {}) } };
}

function parseTargets(value: string | undefined): SecretEntry['targets'] {
  if (value === undefined) return ['host', 'container'];
  const list = value.split(',').map((t) => t.trim()).filter(Boolean);
  if (list.length === 0 || list.some((t) => !TARGETS.includes(t as SecretTarget))) {
    throw new Error('--targets must be host, container or host,container');
  }
  return TARGETS.filter((t) => list.includes(t));
}

// The full check (symlinks, git ignore) happens when the file is rendered; this refuses the obvious.
function checkFilePath(file: string): void {
  const parts = file.split(/[\\/]/);
  if (!file || path.isAbsolute(file) || parts.some((p) => p === '..') || parts.every((p) => p === '' || p === '.') || parts.some((p) => p.toLowerCase() === '.git')) {
    throw new Error(`--file must be a path inside the worktree (not inside .git): ${file}`);
  }
}

function scopeField(scope: Scope): Pick<SecretEntry, 'scope'> {
  return !scope.global && scope.branch ? { scope: { branch: scope.branch } } : {};
}

function sameSlot(e: SecretEntry, name: string, scope: Scope): boolean {
  if (e.name !== name) return false;
  if (scope.global) return true;
  return (e.scope?.branch ?? undefined) === scope.branch;
}

function scopeLabel(scope: Scope): string {
  return scope.global ? 'global' : scope.branch ? `branch ${scope.branch}` : 'repo';
}

function writeJson(name: string, scope: Scope): SecretWriteJson {
  if (scope.global) return { success: true, name, scope: 'global' };
  return scope.branch ? { success: true, name, scope: 'branch', branch: scope.branch } : { success: true, name, scope: 'repo' };
}

function notFound(name: string, scope: Scope): SecretError {
  return new SecretError(`No secret ${name} (${scopeLabel(scope)})`, 'secret-not-found');
}

// By name, the repo entry before branch ones, branches in order: a stable file and listing.
function sortEntries(entries: SecretEntry[]): SecretEntry[] {
  const key = (e: SecretEntry) => `${e.name}\u0000${e.scope?.branch ?? ''}`;
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

async function defaultWorktrees(): Promise<Array<{ path: string; branch: string | null }>> {
  return (await listWorktrees({ includeStatus: false, includePullRequests: false }))
    .filter((w) => !w.bare)
    .map((w) => ({ path: w.path, branch: w.branch }));
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
