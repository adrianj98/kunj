import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../lib/agent-session', () => ({
  ...(jest.requireActual('../../lib/agent-session') as object),
  killTmuxSessionIfExists: jest.fn(async (name: string) => name !== 'kunj-gone'),
}));
jest.mock('../../lib/sessions', () => ({
  ...(jest.requireActual('../../lib/sessions') as object),
  hostSessionAttached: jest.fn(async (name: string) => (name === 'kunj-busy' ? 1 : name === 'kunj-gone' ? null : 0)),
  hostSessions: jest.fn(async () => ({
    tmux: 'ok',
    sessions: [
      { name: 'kunj-orphan', orphan: 'worktree-gone' },
      { name: 'kunjsh-idle', orphan: 'idle' },
      { name: 'kunj-live', orphan: null },
      { name: 'kunj-busy', orphan: 'idle' },
    ],
  })),
}));

import { SessionsCommand } from '../sessions';
import { killTmuxSessionIfExists } from '../../lib/agent-session';

let out: string;
beforeEach(() => {
  out = '';
  jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  (killTmuxSessionIfExists as jest.Mock).mockClear();
  process.exitCode = 0;
});

describe('kunj sessions kill', () => {
  it('ends kunj sessions only; other names are refused, a missing one fails', async () => {
    await new SessionsCommand().execute('kill', ['kunj-a', 'work', 'kunj-gone'], { json: true });
    expect(JSON.parse(out)).toEqual({
      killed: ['kunj-a'],
      failed: [
        { name: 'work', container: null, error: 'not a kunj session name' },
        { name: 'kunj-gone', container: null, error: 'no such session' },
      ],
    });
    expect((killTmuxSessionIfExists as jest.Mock).mock.calls.map(c => c[0])).toEqual(['kunj-a', 'kunj-gone']);
    expect(process.exitCode).toBe(0);
  });

  it('--orphans ends every orphaned host session, but not one a terminal attached to since the listing', async () => {
    await new SessionsCommand().execute('kill', [], { json: true, orphans: true });
    expect(JSON.parse(out)).toEqual({
      killed: ['kunj-orphan', 'kunjsh-idle'],
      failed: [{ name: 'kunj-busy', container: null, error: 'a terminal is attached; left running' }],
    });
    expect((killTmuxSessionIfExists as jest.Mock).mock.calls.map(c => c[0])).toEqual(['kunj-orphan', 'kunjsh-idle']);
  });

  it('--if-detached re-checks named sessions', async () => {
    await new SessionsCommand().execute('kill', ['kunj-busy', 'kunj-a'], { json: true, ifDetached: true });
    expect(JSON.parse(out)).toEqual({ killed: ['kunj-a'], failed: [{ name: 'kunj-busy', container: null, error: 'a terminal is attached; left running' }] });
    expect(process.exitCode).toBe(0);
  });

  it('a container session name must be one kunj gives', async () => {
    await new SessionsCommand().execute('kill', ['bash'], { json: true, container: 'kunj-app-x-1' });
    expect(JSON.parse(out).failed).toEqual([{ name: 'bash', container: 'kunj-app-x-1', error: 'not a kunj session name' }]);
  });

  it('without names or --orphans it asks for them', async () => {
    await expect(new SessionsCommand().execute('kill', [], {})).rejects.toThrow('Name the sessions to end, or pass --orphans');
  });

  it('refuses a bad --idle-hours and an unknown action', async () => {
    await expect(new SessionsCommand().execute('list', [], { idleHours: '-1' })).rejects.toThrow('--idle-hours must be a positive number');
    await expect(new SessionsCommand().execute('nuke', [], {})).rejects.toThrow("Unknown sessions action 'nuke'");
  });
});
