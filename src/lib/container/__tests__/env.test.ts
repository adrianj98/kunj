import { parseStatus, STATUS_SCRIPT } from '../env';

describe('parseStatus', () => {
  it('reads the agent state written by the Claude Code hooks', () => {
    const s = parseStatus('tmux=0\nstate=waiting\n# branch.oid ' + 'a'.repeat(40) + '\n');
    expect(s.agentRunning).toBe(true);
    expect(s.agentState).toBe('waiting');
  });

  it('gives null without a state line or with an unknown value', () => {
    expect(parseStatus('tmux=1\n# branch.oid abc\n').agentState).toBeNull();
    expect(parseStatus('tmux=0\nstate=\n').agentState).toBeNull();
    expect(parseStatus('tmux=0\nstate=bogus\n').agentState).toBeNull();
  });

  it('the status script prints the state file only while the agent session exists', () => {
    expect(STATUS_SCRIPT).toContain('/tmp/kunj-agent-state');
    expect(STATUS_SCRIPT).toMatch(/tmux has-session -t agent[^;]*&&[^;]*kunj-agent-state/);
  });

  it('parseStatus ignores a leftover state when no agent session runs', () => {
    expect(parseStatus('tmux=1\nstate=waiting\n').agentState).toBeNull();
  });
});
