import { agentSessionName, agentRunning, agentArgv } from '../agent-session';

test('session names are tmux-safe and distinguish feature/x from feature-x', () => {
  const a = agentSessionName('app', 'github.com/acme/app', 'feature/v1.2:hotfix');
  const b = agentSessionName('app', 'github.com/acme/app', 'feature-v1-2-hotfix');
  expect(a).toMatch(/^kunj-[A-Za-z0-9_-]+$/);
  expect(a).not.toContain('.');
  expect(a).not.toContain(':');
  expect(a).not.toEqual(b);
});

test('agentRunning is null without tmux', () => {
  expect(agentRunning(null, 'kunj-x')).toBeNull();
  expect(agentRunning(['kunj-x'], 'kunj-x')).toBe(true);
  expect(agentRunning([], 'kunj-x')).toBe(false);
});

test('agentArgv attaches or creates and sets window-size latest', () => {
  expect(agentArgv('kunj-x', '/wt', 'claude')).toEqual(['tmux', '-u', 'new-session', '-A', '-s', 'kunj-x', '-c', '/wt', 'claude', ';', 'set-option', '-t', 'kunj-x', 'window-size', 'latest']);
});
