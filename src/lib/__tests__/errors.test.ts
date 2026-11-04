import { describeError, formatError, gitErrorLine, UserError } from '../errors';

function execError(cmd: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { cmd, stderr, code: 128 });
}

describe('describeError', () => {
  const env = process.env.KUNJ_DEBUG;
  afterEach(() => {
    if (env === undefined) delete process.env.KUNJ_DEBUG;
    else process.env.KUNJ_DEBUG = env;
  });

  it('prefers git fatal line over its progress line', () => {
    expect(gitErrorLine("Preparing worktree (checking out 'x')\nfatal: 'p' already exists\n")).toBe("'p' already exists");
  });

  it('explains an existing worktree path', () => {
    const d = describeError(execError('git worktree add p x', "Preparing worktree (checking out 'x')\nfatal: 'p' already exists\n"));
    expect(d.message).toBe('The path p already exists.');
    expect(d.hint).toMatch(/pick another path/);
    expect(d.unexpected).toBe(false);
  });

  it('names a missing program', () => {
    const e = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT', syscall: 'spawn tmux', path: 'tmux' });
    const d = describeError(e);
    expect(d.message).toMatch(/^Could not run tmux: it is not installed or not on your PATH, or the directory/);
    expect(d.hint).toMatch(/brew install tmux/);
  });

  it('keeps the message of kunj own errors and their hint', () => {
    const d = describeError(new UserError('No worktree for feature/x.', 'Create one with `kunj worktree add feature/x`.'));
    expect(d).toEqual({ message: 'No worktree for feature/x.', hint: 'Create one with `kunj worktree add feature/x`.', unexpected: false });
  });

  it('shows the git error line of an unknown git failure with the command as hint', () => {
    const d = describeError(execError('git frobnicate', 'git: frobnicate is not a git command'));
    expect(d.message).toBe('git: frobnicate is not a git command');
    expect(d.hint).toBe('(while running: git frobnicate)');
  });

  it('names a program the shell could not find, but not any "x: not found" line', () => {
    expect(describeError(execError('gh pr list', '/bin/sh: gh: command not found')).message).toBe('gh is not installed or not on your PATH.');
    expect(describeError(execError('git show x', 'fatal: ref: not found')).message).toBe('ref: not found');
  });

  it('explains missing AWS credentials', () => {
    const e = new Error('Could not load credentials from any providers');
    e.name = 'CredentialsProviderError';
    expect(describeError(e).hint).toMatch(/aws sso login/);
  });

  it('prints no stack trace unless KUNJ_DEBUG is set', () => {
    delete process.env.KUNJ_DEBUG;
    const out = formatError(new Error('boom'));
    expect(out).toBe('✗ boom\n  This looks like a bug in kunj. Run again with KUNJ_DEBUG=1 for details.');
    process.env.KUNJ_DEBUG = '1';
    expect(formatError(new Error('boom'))).toMatch(/✗ boom\n\nError: boom\n {4}at /);
  });
});
