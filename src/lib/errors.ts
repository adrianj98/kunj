// How kunj shows an error to the user. No imports: it sits on the fast path and under every command.
//
// Every error prints as `✗ <message>` and, when there is one, `  <hint>` on the next line. A stack
// trace is printed only with KUNJ_DEBUG=1, because a trace says where kunj failed, not what the user
// can do about it. Raw errors from child processes (git, gh, docker) and from Node are translated
// into what went wrong and what to do next by describeError().

// An expected failure the user can act on: printed without a stack trace, with an optional hint.
export class UserError extends Error {
  constructor(message: string, readonly hint?: string, readonly jsonCode?: string) {
    super(message);
    this.name = 'UserError';
  }
}

export interface DescribedError {
  message: string;
  hint?: string;
  // An error kunj did not expect: the stack trace is worth asking for
  unexpected: boolean;
}

// Errors kunj throws on purpose: their message is already written for the user
const EXPECTED_NAMES = new Set([
  'UserError',
  'HookError',
  'BaseBranchError',
  'StartError',
  'ContainerError',
  'AgentError',
  'EventsError',
  'SecretError',
  'RemoteError',
  'GitHubError',
  'ServeError',
]);

const TOOL_INSTALL: Record<string, string> = {
  git: 'Install git (https://git-scm.com/downloads) and make sure it is on your PATH.',
  gh: 'Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.',
  glab: 'Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run `glab auth login`.',
  docker: 'Install Docker (https://docs.docker.com/get-docker/) and start it.',
  tmux: 'Install tmux (macOS: `brew install tmux`).',
  code: 'Install the `code` command from VS Code (Command Palette → "Shell Command: Install \'code\' command in PATH"), or set worktree.editorCommand.',
};

// The useful line of a child process's output: git and friends print progress before the fatal line
export function gitErrorLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^Command failed\b/i.test(l) && !/^(hint|warning):/i.test(l));
  const fatal = lines.find(l => /^(fatal|error):/i.test(l));
  const line = fatal ?? lines[lines.length - 1];
  return line?.replace(/^(fatal|error):\s*/i, '');
}

// The first word of a failed command line ("git worktree add ..." → "git")
function commandOf(error: { cmd?: unknown; path?: unknown; spawnargs?: unknown; message?: unknown }): string | undefined {
  if (typeof error.path === 'string' && error.path) return error.path.split('/').pop();
  if (typeof error.cmd === 'string') return error.cmd.trim().split(/\s+/)[0]?.split('/').pop();
  const m = typeof error.message === 'string' ? /spawn (\S+) ENOENT/.exec(error.message) : null;
  return m?.[1]?.split('/').pop();
}

// Known git failures, rewritten with what to do next
const GIT_HINTS: Array<[RegExp, (m: RegExpExecArray) => DescribedError]> = [
  [/not a git repository/i, () => ({ message: 'Not inside a git repository.', hint: 'Run this from a repository, or `cd` into one first.', unexpected: false })],
  [/'(.+)' already exists/, m => ({ message: `The path ${m[1]} already exists.`, hint: 'Remove it, or pick another path (see `kunj worktree list` for what is there).', unexpected: false })],
  [/'(.+)' is already (?:checked out|used by worktree) at '(.+)'/, m => ({ message: `Branch ${m[1]} is already checked out at ${m[2]}.`, hint: 'Open that worktree instead, or switch it to another branch first.', unexpected: false })],
  [/invalid reference: (.+)/, m => ({ message: `No branch or commit named ${m[1]}.`, hint: 'Check the name with `git branch -a`, or run `git fetch` if it is only on origin.', unexpected: false })],
  [/pathspec '(.+)' did not match/, m => ({ message: `No branch or file named ${m[1]}.`, hint: 'Check the name with `git branch -a`, or run `git fetch` if it is only on origin.', unexpected: false })],
  [/a branch named '(.+)' already exists/i, m => ({ message: `A branch named ${m[1]} already exists.`, hint: 'Switch to it with `kunj switch`, or choose another name.', unexpected: false })],
  [/(?:Your local changes .* would be overwritten|would be overwritten by checkout)/i, () => ({ message: 'Your uncommitted changes would be overwritten.', hint: 'Commit or stash them first (`kunj stash`), then try again.', unexpected: false })],
  [/Could not read from remote repository|Authentication failed|Permission denied \(publickey\)/i, () => ({ message: 'Could not reach origin: authentication failed.', hint: 'Check your SSH key or credentials with `git fetch` and try again.', unexpected: false })],
  [/Could not resolve host: (\S+)/i, m => ({ message: `Could not reach ${m[1]}.`, hint: 'Check your network connection.', unexpected: false })],
  [/nothing to commit/i, () => ({ message: 'Nothing to commit.', hint: 'Stage changes with `git add` first.', unexpected: false })],
  [/(?:merge conflict|CONFLICT)/i, () => ({ message: 'The operation stopped on a merge conflict.', hint: 'Resolve the conflicts, `git add` the files, then continue.', unexpected: false })],
  [/is locked|index\.lock/i, () => ({ message: 'Another git process is running in this repository.', hint: 'Wait for it to finish; if none is running, delete the .git/index.lock file.', unexpected: false })],
  [/contains modified or untracked files/i, () => ({ message: 'The worktree has uncommitted changes.', hint: 'Commit or stash them, or pass --force to remove it anyway.', unexpected: false })],
];

// What went wrong, in words the user can act on
export function describeError(error: unknown): DescribedError {
  if (!(error instanceof Error)) {
    return { message: String(error), unexpected: true };
  }
  const e = error as Error & { code?: unknown; stderr?: unknown; cmd?: unknown; hint?: unknown };
  const hint = typeof e.hint === 'string' ? e.hint : undefined;

  if (EXPECTED_NAMES.has(e.name)) {
    return { message: e.message, hint, unexpected: false };
  }

  // A program kunj runs is not installed
  if (e.code === 'ENOENT' && (typeof (e as { syscall?: unknown }).syscall === 'string' && String((e as { syscall?: unknown }).syscall).startsWith('spawn'))) {
    // Node gives the same error when the directory a program was asked to run in is gone
    const tool = commandOf(e) ?? 'a required program';
    return {
      message: `Could not run ${tool}: it is not installed or not on your PATH, or the directory it was run in no longer exists.`,
      hint: TOOL_INSTALL[tool],
      unexpected: false,
    };
  }
  // A shell command whose program is missing (exec through /bin/sh)
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const notFound = /^(?:\/bin\/)?(?:ba|z)?sh: (?:line \d+: |\d+: )?(\S+): (?:command )?not found$/m.exec(stderr);
  if (notFound && typeof e.cmd === 'string') {
    const tool = notFound[1].split('/').pop()!;
    return { message: `${tool} is not installed or not on your PATH.`, hint: TOOL_INSTALL[tool], unexpected: false };
  }

  // A failed git (or other) command: explain its error line rather than echo the command
  const text = stderr || e.message;
  if (typeof e.cmd === 'string' || /^Command failed:/.test(e.message)) {
    const line = gitErrorLine(text) ?? e.message;
    for (const [pattern, describe] of GIT_HINTS) {
      const m = pattern.exec(text);
      if (m) return describe(m);
    }
    const cmd = (typeof e.cmd === 'string' ? e.cmd : /^Command failed: (.*)/.exec(e.message)?.[1] ?? '').split('\n')[0];
    const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    return { message: line, hint: short ? `(while running: ${short})` : undefined, unexpected: false };
  }
  for (const [pattern, describe] of GIT_HINTS) {
    const m = pattern.exec(e.message);
    if (m) return { ...describe(m), hint: hint ?? describe(m).hint };
  }

  // Files and network
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    const path = (e as { path?: unknown }).path;
    if (typeof path !== 'string') return { message: e.message, hint: 'Check the file permissions.', unexpected: false };
    return { message: `Permission denied: ${path}.`, hint: 'Check the file permissions.', unexpected: false };
  }
  if (e.code === 'ENOENT') {
    const path = (e as { path?: unknown }).path;
    return { message: typeof path === 'string' ? `File not found: ${path}.` : e.message, hint, unexpected: false };
  }
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') {
    return { message: `Network error (${String(e.code)}): ${e.message}`, hint: 'Check your network connection and try again.', unexpected: false };
  }

  // AWS Bedrock (commit messages, PR descriptions, work logs)
  if (e.name === 'CredentialsProviderError' || /Could not load credentials|security token included in the request is (?:invalid|expired)|ExpiredToken/i.test(e.message)) {
    return {
      message: 'AWS credentials are missing or expired, so the AI features cannot run.',
      hint: 'Run `aws sso login` (or `aws configure`), or set AWS_PROFILE, then try again.',
      unexpected: false,
    };
  }
  if (e.name === 'AccessDeniedException' || /not authorized to perform: bedrock|don't have access to the model/i.test(e.message)) {
    return {
      message: 'Your AWS account cannot use the Bedrock model kunj is configured with.',
      hint: 'Enable model access in the Bedrock console, or change ai.model with `kunj config`.',
      unexpected: false,
    };
  }

  // Inquirer: the user pressed Ctrl-C at a prompt
  if (e.name === 'ExitPromptError' || /User force closed the prompt/.test(e.message)) {
    return { message: 'Cancelled.', unexpected: false };
  }

  return { message: e.message || e.name, hint, unexpected: true };
}

export function debugEnabled(): boolean {
  return !!process.env.KUNJ_DEBUG && process.env.KUNJ_DEBUG !== '0';
}

// The lines printed to stderr for an error
export function formatError(error: unknown): string {
  const d = describeError(error);
  const lines = [`✗ ${d.message}`];
  if (d.hint) lines.push(`  ${d.hint}`);
  if (debugEnabled() && error instanceof Error && error.stack) {
    lines.push('', error.stack);
  } else if (d.unexpected) {
    lines.push('  This looks like a bug in kunj. Run again with KUNJ_DEBUG=1 for details.');
  }
  return lines.join('\n');
}
