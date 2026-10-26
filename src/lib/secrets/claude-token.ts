// The Claude Code token for containers (CLAUDE_CODE_OAUTH_TOKEN): taken from what `claude setup-token`
// prints, checked for shape, and validated with one `claude -p` that has only this token as its
// credential. The token goes to claude in its environment, never argv, and no message repeats it.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLAUDE_TOKEN_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';
const PREFIX = 'sk-ant-oat01-';
// A long-lived token is the prefix and 95 characters; used only to rejoin one the terminal wrapped
const TOKEN_LENGTH = 108;
const TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+/;
const CHECK_TIMEOUT_MS = 120_000;
// Other credentials claude would use instead of the token, so a broken token could pass
const OTHER_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CONFIG_DIR'];

/** Terminal output without escape sequences and carriage returns. */
function plain(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '');
}

/**
 * The token `claude setup-token` printed, rejoined when the terminal wrapped it (a following line made
 * only of token characters continues it while it is shorter than a token); the last one when it was
 * drawn more than once; null when there is none.
 */
export function extractClaudeToken(output: string): string | null {
  const lines = plain(output).split('\n');
  let found: string | null = null;
  lines.forEach((line, i) => {
    const at = line.indexOf(PREFIX);
    if (at === -1) return;
    let token = (TOKEN_CHARS.exec(line.slice(at)) ?? [''])[0];
    const endsLine = line.slice(at + token.length).trim() === '';
    for (let j = i + 1; endsLine && token.length < TOKEN_LENGTH && j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || !/^[A-Za-z0-9_-]+$/.test(next) || token.length + next.length > TOKEN_LENGTH) break;
      token += next;
    }
    found = token;
  });
  return found;
}

/** Why a stored value cannot be a Claude Code token, without repeating it; null when it can. */
export function claudeTokenProblem(value: string): string | null {
  if (!value) return 'The value is empty';
  if (TOKEN.test(value)) return null;
  const tokens = value.match(/sk-ant-oat01-[A-Za-z0-9_-]+/g) ?? [];
  if (tokens.length > 1) return `The value holds ${tokens.length} tokens (pasted more than once?); store one`;
  if (tokens.length === 1 && value.trim() === tokens[0]) return 'The value has whitespace around the token';
  return `The value is not a Claude Code token (${PREFIX}…, from \`claude setup-token\`)`;
}

export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>;

const runClaude: ClaudeRunner = (args, env) =>
  new Promise((resolve) => {
    let out = '';
    const child = spawn('claude', args, { env, cwd: env.CLAUDE_CONFIG_DIR, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout: '' });
    });
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out });
    });
  });

export interface ClaudeTokenCheck {
  /** null when it could not be told (claude missing or no answer) */
  valid: boolean | null;
  message: string;
}

/**
 * Ask Claude Code once with this token as its only credential: other API keys are dropped and the
 * config dir is a throwaway one, so the Mac's own login cannot make a broken token pass.
 */
export async function checkClaudeToken(token: string, deps: { run?: ClaudeRunner; env?: NodeJS.ProcessEnv } = {}): Promise<ClaudeTokenCheck> {
  const problem = claudeTokenProblem(token);
  if (problem) return { valid: false, message: problem };
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env) };
  for (const key of OTHER_CREDENTIALS) delete env[key];
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-claude-check-'));
  env.CLAUDE_CONFIG_DIR = configDir;
  env[CLAUDE_TOKEN_NAME] = token;
  try {
    const r = await (deps.run ?? runClaude)(['-p', 'Reply with the single word OK', '--model', 'haiku', '--output-format', 'json'], env);
    if (r.code === 127) return { valid: null, message: 'claude is not installed, so the token could not be checked' };
    let answer: { is_error?: boolean; result?: unknown };
    try {
      answer = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
    } catch {
      return { valid: null, message: `claude did not answer (exit ${r.code}), so the token could not be checked` };
    }
    if (r.code === 0 && answer.is_error === false) return { valid: true, message: 'The token works' };
    const said = String(answer.result ?? '').split('\n')[0].split(token).join('…').trim();
    return { valid: false, message: said || `claude failed (exit ${r.code})` };
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

/** `claude setup-token` under a pseudo-terminal (`script`), so kunj can read what it prints. */
export function setupTokenCommand(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['script', '-q', '/dev/null', 'claude', 'setup-token'];
  return ['script', '-qfec', 'claude setup-token', '/dev/null'];
}

/**
 * Runs `claude setup-token` on this terminal (its output is shown as it comes) and returns what it
 * printed and its exit code.
 */
export function captureSetupToken(): Promise<{ code: number; output: string }> {
  const [cmd, ...args] = setupTokenCommand();
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'] });
    child.on('error', (err: NodeJS.ErrnoException) => resolve({ code: err.code === 'ENOENT' ? 127 : 1, output }));
    child.stdout.on('data', (d: Buffer) => {
      process.stdout.write(d);
      output += d.toString('utf8');
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
