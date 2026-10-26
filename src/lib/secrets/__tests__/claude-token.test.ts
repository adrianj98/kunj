import { checkClaudeToken, claudeTokenProblem, ClaudeRunner, extractClaudeToken, setupTokenCommand } from '../claude-token';

const TOKEN = 'sk-ant-oat01-' + 'Ab3_-x'.repeat(15) + 'Qz12A'; // 108 characters, like a real one

describe('extractClaudeToken', () => {
  test('finds the token in colored terminal output', () => {
    const out = `\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\x1b[1m${TOKEN}\x1b[22m\r\n\r\nStore this token securely.\r\n`;
    expect(extractClaudeToken(out)).toBe(TOKEN);
  });

  test('joins a token the terminal wrapped over several lines, and stops at the next word', () => {
    const out = `Your OAuth token:\r\n${TOKEN.slice(0, 80)}\r\n${TOKEN.slice(80)}\r\nStore this token securely.\r\n`;
    expect(extractClaudeToken(out)).toBe(TOKEN);
  });

  test('joins a wrapped token that is indented', () => {
    const out = `  ${TOKEN.slice(0, 60)}\r\n  ${TOKEN.slice(60)}\r\n\r\nUse it as CLAUDE_CODE_OAUTH_TOKEN\r\n`;
    expect(extractClaudeToken(out)).toBe(TOKEN);
  });

  test('a token printed twice (a redraw) is one token, not two glued together', () => {
    expect(extractClaudeToken(`${TOKEN}\r\n\x1b[2K\x1b[1A${TOKEN}\r\n`)).toBe(TOKEN);
  });

  test('null when there is none', () => {
    expect(extractClaudeToken('Error: login cancelled\r\n')).toBeNull();
    expect(extractClaudeToken('')).toBeNull();
  });
});

describe('claudeTokenProblem', () => {
  test('a single token has none', () => {
    expect(claudeTokenProblem(TOKEN)).toBeNull();
  });

  test('a token pasted twice is named as such, without its value', () => {
    const problem = claudeTokenProblem(`${TOKEN} ${TOKEN}`)!;
    expect(problem).toMatch(/2 tokens/);
    expect(problem).not.toContain(TOKEN.slice(13, 30));
  });

  test('other values are not a Claude Code token', () => {
    expect(claudeTokenProblem('sk-ant-api03-abc')).toMatch(/not a Claude Code token/);
    expect(claudeTokenProblem(`${TOKEN}\n`)).toMatch(/whitespace/);
    expect(claudeTokenProblem('')).toMatch(/empty/);
  });
});

describe('checkClaudeToken', () => {
  test('runs claude -p with only the token as credential and a throwaway config dir', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: ClaudeRunner = async (args, env) => {
      calls.push({ args, env });
      return { code: 0, stdout: JSON.stringify({ is_error: false, result: 'OK' }) };
    };
    const r = await checkClaudeToken(TOKEN, { run, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/real' } });
    expect(r).toEqual({ valid: true, message: 'The token works' });
    const [{ args, env }] = calls;
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json']));
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).not.toBe('/real');
    expect(env.PATH).toBe('/bin');
  });

  test('an API error is invalid with claude\'s message, which never echoes the token', async () => {
    const run: ClaudeRunner = async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: `Failed to authenticate. API Error: 401 OAuth access token is invalid. ${TOKEN}` }) });
    const r = await checkClaudeToken(TOKEN, { run, env: {} });
    expect(r.valid).toBe(false);
    expect(r.message).toContain('401 OAuth access token is invalid');
    expect(r.message).not.toContain(TOKEN);
  });

  test('a malformed value is invalid without asking claude', async () => {
    const run = jest.fn<ReturnType<ClaudeRunner>, Parameters<ClaudeRunner>>();
    const r = await checkClaudeToken(`${TOKEN} ${TOKEN}`, { run, env: {} });
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/2 tokens/);
    expect(run).not.toHaveBeenCalled();
  });

  test('claude missing, or output that is not its JSON, is unknown (null), not invalid', async () => {
    expect((await checkClaudeToken(TOKEN, { run: async () => ({ code: 127, stdout: '' }), env: {} })).valid).toBeNull();
    expect((await checkClaudeToken(TOKEN, { run: async () => ({ code: 1, stdout: 'Segmentation fault' }), env: {} })).valid).toBeNull();
  });
});

describe('setupTokenCommand', () => {
  test('runs claude setup-token under script, the macOS and the util-linux way', () => {
    expect(setupTokenCommand('darwin')).toEqual(['script', '-q', '/dev/null', 'claude', 'setup-token']);
    expect(setupTokenCommand('linux')).toEqual(['script', '-qfec', 'claude setup-token', '/dev/null']);
  });
});
