// kunj events: a change stream for the workspace app, one line per change (NDJSON with --json).
// The watching is in src/lib/events.ts; this command picks the repositories, prints, and stops
// on SIGINT/SIGTERM or when stdin ends (its parent went away).
// Keep top-level imports light: this command is on the fast path (src/commands/fast.ts).

import * as path from 'path';
import { BaseCommand } from '../lib/command';
import { getGlobalKunjDir, loadResolvedConfig } from '../lib/config';
import { repoVariables } from '../lib/config-vars';
import { watchEvents } from '../lib/events';
import { KnownRepoInfo, listRepos } from '../lib/repos';
import { getGitCommonDir } from '../lib/worktree';
import { LocalDockerBackend } from '../lib/container/docker';
import { getVersion } from '../lib/version';
import type { EventJson } from '../lib/json-types';

interface EventsOptions {
  json?: boolean;
  repo?: string[];
}

export class EventsError extends Error {
  readonly jsonCode = 'not-a-repo';
  constructor(message: string) {
    super(message);
    this.name = 'EventsError';
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

// Without paths: every known, visible repository that still exists
async function resolveRepos(paths: string[] | undefined): Promise<KnownRepoInfo[]> {
  const known = listRepos({ includeHidden: true });
  if (!paths || paths.length === 0) return known.filter(r => !r.hidden && r.exists);
  const repos: KnownRepoInfo[] = [];
  for (const p of paths) {
    const dir = path.resolve(p);
    let repo = known.find(r => samePath(r.root, dir) || samePath(r.gitCommonDir, dir));
    if (!repo) {
      let commonDir: string;
      try {
        commonDir = await getGitCommonDir(dir);
      } catch {
        throw new EventsError(`Not a git repository: ${dir}`);
      }
      const { repoRoot, repoName } = repoVariables(commonDir);
      repo = known.find(r => samePath(r.gitCommonDir, commonDir)) ?? {
        root: repoRoot, gitCommonDir: commonDir, name: repoName, bare: repoRoot === commonDir,
        addedAt: '', lastSeen: '', exists: true,
      };
    }
    if (!repos.some(r => samePath(r.gitCommonDir, repo!.gitCommonDir))) repos.push(repo);
  }
  return repos;
}

export function formatEvent(e: EventJson): string {
  const time = new Date(e.at).toTimeString().slice(0, 8);
  let rest: string;
  switch (e.type) {
    case 'hello':
      rest = `${e.version} watching ${e.repos} ${e.repos === 1 ? 'repository' : 'repositories'}`;
      break;
    case 'container':
      rest = `${e.repo?.name ?? '-'} ${e.branch ?? '-'} ${e.action} ${e.container}`;
      break;
    case 'agent':
      rest = `${e.session} ${e.running ? 'started' : 'ended'}`;
      break;
    case 'backend':
      rest = [e.status, e.message].filter(Boolean).join(' ');
      break;
    default:
      rest = e.repo?.name ?? '';
  }
  return `${time} ${e.type} ${rest}`.trimEnd();
}

export class EventsCommand extends BaseCommand {
  constructor() {
    super({
      name: 'events',
      description: 'Stream changes to worktrees, containers and agents, one line each',
      options: [{ flags: '--repo <path...>', description: 'Watch only these repositories (default: every known one)' }],
      helpText: [
        'Prints a hello line, then one line per change: git (refs, HEAD, index), sessions, forwards,',
        'repos (files in ~/.kunj), container (Docker events, and action "status" from a 10 s poll),',
        'agent (tmux sessions), backend. A 10 s poll also reports worktree changes (git status).',
        'With --json each line is one JSON object. Stops on Ctrl-C or when stdin closes.',
      ].join('\n'),
    });
  }

  async execute(options: EventsOptions = {}): Promise<void> {
    if (options.json) this.jsonMode = true;
    const repos = await resolveRepos(options.repo);
    const config = await loadResolvedConfig();
    const backend = new LocalDockerBackend({ context: config.container?.dockerContext || undefined });

    const controller = new AbortController();
    const stop = () => controller.abort();
    const stdin = process.stdin;
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.stdout.on('error', stop); // the reader went away (EPIPE)
    stdin.on('end', stop);
    stdin.on('error', stop);
    stdin.resume(); // 'end' only fires on a flowing stream

    const print = (e: EventJson) => {
      process.stdout.write((this.jsonMode ? JSON.stringify(e) : formatEvent(e)) + '\n');
    };
    try {
      // hello once the sources are armed: a change made after it is reported
      const onReady = () => print({ type: 'hello', version: getVersion(), repos: repos.length, at: new Date().toISOString() });
      await watchEvents({ repos, kunjDir: getGlobalKunjDir(), backend, onEvent: print, onReady, signal: controller.signal });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdout.off('error', stop);
      stdin.off('end', stop);
      stdin.off('error', stop);
      stdin.pause();
    }
  }
}
