import { parseStatus, STATUS_SCRIPT } from '../env';

describe('parseStatus', () => {
  const oid = '# branch.oid ' + 'a'.repeat(40) + '\n';

  it('reads the agent sessions and the state their Claude Code hooks wrote', () => {
    const s = parseStatus('tmux=0\nsession=agent running\nsession=agent-two waiting\nsession=agent-x \n' + oid);
    expect(s.agentRunning).toBe(true);
    expect(s.agentState).toBe('waiting');
    expect(s.agentSessions).toEqual([
      { session: 'agent', id: null, state: 'running' },
      { session: 'agent-two', id: 'two', state: 'waiting' },
      { session: 'agent-x', id: 'x' },
    ]);
    expect(s.head).toBe('a'.repeat(40));
    expect(s.dirty).toBe(false);
  });

  it('is running when any agent session runs, and the state is running unless one waits', () => {
    const s = parseStatus('tmux=0\nsession=agent-two running\n' + oid);
    expect(s.agentRunning).toBe(true);
    expect(s.agentState).toBe('running');
  });

  it('no agent session: not running, no state; tmux missing: unknown', () => {
    expect(parseStatus('tmux=0\n' + oid)).toMatchObject({ agentRunning: false, agentState: null, agentSessions: [] });
    expect(parseStatus('tmux=1\n' + oid)).toMatchObject({ agentRunning: false, agentState: null, agentSessions: [] });
    const missing = parseStatus('tmux=127\n' + oid);
    expect(missing.agentRunning).toBeNull();
    expect(missing.agentSessions).toBeUndefined();
  });

  it('ignores unknown state values and session names that are not agent sessions', () => {
    const s = parseStatus('tmux=0\nsession=agent bogus\nsession=agent-a:b waiting\nsession=agents waiting\n' + oid);
    expect(s.agentSessions).toEqual([{ session: 'agent', id: null }]);
    expect(s.agentState).toBeNull();
    expect(s.dirty).toBe(false);
  });

  it('the status script lists the agent and agent-* sessions with their state files', () => {
    expect(STATUS_SCRIPT).toContain('tmux list-sessions');
    expect(STATUS_SCRIPT).toContain('/tmp/kunj-agent-state');
    expect(STATUS_SCRIPT).toContain('/tmp/kunj-agent-state-${n#agent-}');
  });
});

describe('the plan records in the status', () => {
  it('reads their size and does not take the line for a changed file', () => {
    const { parseStatus } = jest.requireActual<typeof import('../env')>('../env');
    const status = parseStatus('tmux=0\nsession=agent running\nplan=1234\n# branch.oid abc\n# branch.ab +0 -0\n');
    expect(status.planBytes).toBe(1234);
    expect(status.dirty).toBe(false);
    expect(parseStatus('tmux=1\n# branch.oid abc\n').planBytes).toBeUndefined();
  });

  it('the script prints the size of the records, 0 when there are none', () => {
    const { STATUS_SCRIPT } = jest.requireActual<typeof import('../env')>('../env');
    expect(STATUS_SCRIPT).toContain('echo "plan=$(cat /tmp/kunj-agent-plan /tmp/kunj-agent-plan-* 2>/dev/null | wc -c | tr -d \' \')"');
  });
});
