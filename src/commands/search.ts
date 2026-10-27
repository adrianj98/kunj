// Search command - search a repository's worktrees and more (src/lib/search.ts).
//
//   kunj search <pattern> [paths...]          file contents of every worktree of the repository
//   kunj search <pattern> --in branches       ... of branches without a worktree (committed trees)
//   kunj search <pattern> --in containers     ... of the running branch containers (/workspace)
//   kunj search <pattern> --in commits,logs   commit messages and the work logs
//   kunj search <pattern> --all               every scope
//
// The workspace app and the VS Code extension read `kunj search ... --json` (SearchJson).

import chalk from 'chalk';
import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { listWorktreesDetailed } from '../lib/worktree';
import type { WorktreeInfo } from '../lib/worktree';
import { getWorkLogDir } from '../lib/work-log';
import {
  SEARCH_SCOPES, branchRefs, gitOutput, grepRefs, grepWorktree, mapLimit, searchCommits, searchRegExp, searchWorkLogs,
} from '../lib/search';
import type { CommitMatch, LogMatch, SearchQuery, SearchScope } from '../lib/search';
import type { SearchJson, SearchSourceJson } from '../lib/json-types';

interface SearchOptions {
  json?: boolean;
  in?: string;
  all?: boolean;
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  wordRegexp?: boolean;
  branch?: string;
  current?: boolean;
  origin?: boolean;
  maxCount?: string;
  regexp?: string;
}

const DEFAULT_MAX_COUNT = 200;
// Worktrees searched at once
const WORKTREE_CONCURRENCY = 6;
// `--in containers` stops waiting for Docker after this long
const CONTAINER_SEARCH_TIMEOUT_MS = 90_000;

export class SearchCommand extends BaseCommand {
  constructor() {
    super({
      name: 'search',
      description: 'Search the files of every worktree (and branches, containers, commits, work logs)',
      arguments: '[pattern] [paths...]',
      options: [
        { flags: '-e, --regexp <pattern>', description: 'The pattern (for one that starts with -); every argument is then a path' },
        { flags: '--in <scopes>', description: `Comma-separated scopes to search: ${SEARCH_SCOPES.join(', ')} (default: worktrees)` },
        { flags: '-a, --all', description: 'Search every scope' },
        { flags: '-i, --ignore-case', description: 'Ignore case' },
        { flags: '-F, --fixed-strings', description: 'The pattern is a fixed string, not an extended regex' },
        { flags: '-w, --word-regexp', description: 'Match whole words only' },
        { flags: '-b, --branch <names>', description: 'Only these branches (comma-separated), in every scope' },
        { flags: '--current', description: 'Only the current worktree' },
        { flags: '--origin', description: "[branches] Also origin's branches that have no local branch" },
        { flags: '-m, --max-count <n>', description: `Matches kept per worktree, branch or container, and commits and log lines in all (default ${DEFAULT_MAX_COUNT})` },
      ],
      helpText: () =>
        [
          'Scopes:',
          '  worktrees    every worktree, uncommitted and untracked files included (.gitignore is respected)',
          '  branches     committed tree of each local branch without a worktree (--origin adds origin-only ones)',
          '  containers   /workspace of each running branch container (stopped ones are not started)',
          '  commits      commit messages on all branches',
          '  logs         the work logs (kunj log)',
          '',
          'Paths are git pathspecs, e.g. kunj search TODO src/ "*.md"',
          'A pattern that starts with - goes after -e: kunj search -e -foo',
        ].join('\n'),
    });
  }

  async execute(pattern: string | undefined, paths: string[] | SearchOptions = [], options: SearchOptions = {}): Promise<void> {
    // Commander passes (pattern, paths, options, command); without paths the options shift left
    if (!Array.isArray(paths)) {
      options = paths;
      paths = [];
    }
    // -e: the pattern comes from the option and the first argument is a path too
    if (options.regexp !== undefined) {
      if (pattern !== undefined) paths = [pattern, ...paths];
      pattern = options.regexp;
    }
    if (pattern === undefined) throw new Error('Give a pattern to search for: kunj search <pattern> [paths...]');
    const query: SearchQuery = {
      pattern,
      ignoreCase: options.ignoreCase === true,
      fixed: options.fixedStrings === true,
      word: options.wordRegexp === true,
      paths,
      maxCount: parseMaxCount(options.maxCount),
    };
    const scopes = parseScopes(options);
    const branches = (options.branch ?? '').split(',').map(b => b.trim()).filter(Boolean);
    const result = await this.search(query, scopes, branches, options);
    if (this.jsonMode) this.outputJSON(result);
    else printResult(result);
  }

  async search(q: SearchQuery, scopes: SearchScope[], branches: string[], options: SearchOptions): Promise<SearchJson> {
    if (!q.pattern) throw new Error('Give a pattern to search for');
    const listing = await listWorktreesDetailed({ includeStatus: false });
    const cwd = listing.repoRoot;
    const wanted = (b: string | null | undefined) => branches.length === 0 || (!!b && branches.includes(b));

    const worktrees = scopes.includes('worktrees')
      ? listing.worktrees
          .filter(wt => wt.exists && !wt.bare && wanted(wt.branch) && (!options.current || wt.isCurrent))
          .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (a.branch ?? '').localeCompare(b.branch ?? ''))
      : [];

    const [worktreeSources, branchResult, containerResult, commits, logs] = await Promise.all([
      mapLimit(worktrees, WORKTREE_CONCURRENCY, wt => searchWorktree(wt, q)),
      scopes.includes('branches') ? searchBranches(cwd, listing.worktrees, q, branches, options.origin === true) : null,
      scopes.includes('containers') ? searchContainers(q, branches) : null,
      scopes.includes('commits') ? searchCommits(cwd, q, branches) : undefined,
      scopes.includes('logs') ? searchWorkLogs(getWorkLogDir(), q) : undefined,
    ]);

    const sources = [...worktreeSources, ...(branchResult?.sources ?? []), ...(containerResult?.sources ?? [])].filter(
      s => s.matches.length > 0 || s.error
    );
    return {
      query: { ...q, scopes, branches },
      repoRoot: listing.repoRoot,
      searched: { worktrees: worktrees.length, branches: branchResult?.searched ?? 0, containers: containerResult?.searched ?? 0 },
      sources,
      ...(containerResult ? { containers: containerResult.status } : {}),
      ...(commits ? { commits } : {}),
      ...(logs ? { logs } : {}),
    } satisfies SearchJson;
  }
}

function parseScopes(options: SearchOptions): SearchScope[] {
  if (options.all) return [...SEARCH_SCOPES];
  if (!options.in) return ['worktrees'];
  const scopes = options.in.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const s of scopes) {
    if (!(SEARCH_SCOPES as readonly string[]).includes(s)) {
      throw new Error(`Unknown search scope '${s}'. Expected some of: ${SEARCH_SCOPES.join(', ')}`);
    }
  }
  return SEARCH_SCOPES.filter(s => scopes.includes(s));
}

function parseMaxCount(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_COUNT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--max-count must be a positive integer, not '${value}'`);
  return n;
}

async function searchWorktree(wt: WorktreeInfo, q: SearchQuery): Promise<SearchSourceJson> {
  const r = await grepWorktree(wt.path, q);
  return { kind: 'worktree', branch: wt.branch ?? null, path: wt.path, isCurrent: wt.isCurrent, ...r };
}

async function searchBranches(
  cwd: string,
  worktrees: WorktreeInfo[],
  q: SearchQuery,
  branches: string[],
  origin: boolean
): Promise<{ sources: SearchSourceJson[]; searched: number }> {
  const withWorktree = new Set(worktrees.map(wt => wt.branch).filter((b): b is string => !!b));
  const refnames = await gitOutput(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  const refs = branchRefs(refnames, withWorktree, origin).filter(r => branches.length === 0 || branches.includes(r.branch));
  const { results, error } = await grepRefs(cwd, refs.map(r => r.ref), q);
  const sources: SearchSourceJson[] = [];
  for (const r of refs) {
    const found = results.get(r.ref);
    if (found) sources.push({ kind: 'branch', branch: r.branch, ref: r.ref, remote: r.remote, ...found });
  }
  // One git call for every branch: its failure is reported once
  if (error) sources.push({ kind: 'branch', branch: null, matches: [], truncated: false, error });
  return { sources, searched: refs.length };
}

async function searchContainers(
  q: SearchQuery,
  branches: string[]
): Promise<{ sources: SearchSourceJson[]; searched: number; status: NonNullable<SearchJson['containers']> }> {
  // Loaded only for this scope: the container module is large and asks Docker
  const { ContainerCommand } = await import('./container');
  const command = new ContainerCommand();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        command.abortDockerCalls();
        reject(new Error(`Docker did not answer within ${CONTAINER_SEARCH_TIMEOUT_MS / 1000}s`));
      }, CONTAINER_SEARCH_TIMEOUT_MS);
    });
    const r = await Promise.race([command.searchJson(q, branches), timeout]);
    return { sources: r.sources, searched: r.searched, status: { available: true, stopped: r.stopped } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sources: [], searched: 0, status: { available: false, message, stopped: [] } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- text output -----------------------------------------------------------------------------

function printResult(result: SearchJson): void {
  const re = searchRegExp(result.query);
  const highlight = (text: string) => (re ? text.replace(re, m => chalk.red.bold(m)) : text);
  let total = 0;

  for (const source of result.sources) {
    console.log(sourceHeader(source));
    if (source.error) console.log(chalk.yellow(`  ${source.error}`));
    let file: string | null = null;
    for (const m of source.matches) {
      if (m.path !== file) {
        file = m.path;
        console.log(`  ${chalk.magenta(m.path)}`);
      }
      console.log(`    ${chalk.green(String(m.line).padStart(5))}${chalk.gray(':')}${highlight(m.text)}`);
    }
    if (source.truncated) console.log(chalk.gray(`  … more matches (raise --max-count)`));
    total += source.matches.length;
    console.log('');
  }

  if (result.containers) {
    const c = result.containers;
    if (!c.available) console.log(chalk.yellow(`Containers not searched: ${c.message ?? 'Docker could not be asked'}\n`));
    else if (c.stopped.length) console.log(chalk.gray(`Containers not running (not searched): ${c.stopped.join(', ')}\n`));
  }

  if (result.commits) {
    printCommits(result.commits, highlight);
    total += result.commits.length;
  }
  if (result.logs) {
    printLogs(result.logs, highlight);
    total += result.logs.length;
  }

  const { worktrees, branches, containers } = result.searched;
  const searched = [
    result.query.scopes.includes('worktrees') ? plural(worktrees, 'worktree') : '',
    result.query.scopes.includes('branches') ? plural(branches, 'branch', 'branches') : '',
    result.query.scopes.includes('containers') ? plural(containers, 'container') : '',
  ].filter(Boolean);
  const where = searched.length ? ` (searched ${searched.join(', ')})` : '';
  console.log(total === 0 ? chalk.gray(`No matches${where}`) : chalk.gray(`${plural(total, 'match', 'matches')}${where}`));
}

function sourceHeader(source: SearchSourceJson): string {
  const branch = chalk.bold(source.branch ?? '(detached)');
  switch (source.kind) {
    case 'worktree':
      return `${chalk.cyan('●')} ${branch}  ${chalk.gray(`${source.isCurrent ? 'current worktree' : 'worktree'} · ${tildify(source.path ?? '')}`)}`;
    case 'branch':
      if (source.branch === null) return `${chalk.cyan('○')} ${chalk.bold('branches')}`;
      return `${chalk.cyan('○')} ${branch}  ${chalk.gray(source.remote ? 'origin branch' : 'branch')}`;
    case 'container':
      return `${chalk.blue('◆')} ${branch}  ${chalk.gray(`container · ${source.container}`)}`;
  }
}

function printCommits(commits: CommitMatch[], highlight: (s: string) => string): void {
  console.log(`${chalk.cyan('◇')} ${chalk.bold('commits')}`);
  if (commits.length === 0) console.log(chalk.gray('  none'));
  for (const c of commits) {
    console.log(`  ${chalk.yellow(c.sha.slice(0, 7))} ${chalk.gray(c.date.slice(0, 10))} ${c.line === 1 ? highlight(c.subject) : c.subject}`);
    if (c.line > 1) console.log(`          ${highlight(c.text)}`);
  }
  console.log('');
}

function printLogs(logs: LogMatch[], highlight: (s: string) => string): void {
  console.log(`${chalk.cyan('◇')} ${chalk.bold('work logs')}`);
  if (logs.length === 0) console.log(chalk.gray('  none'));
  for (const l of logs) console.log(`  ${chalk.green(l.date)}${chalk.gray(':')}${highlight(l.text)}`);
  console.log('');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function tildify(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

