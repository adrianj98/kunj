import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentArgv, agentIdOf, isClaudeCommand, parseTaggedSessionLine, withAgentPrompt } from '../agent-session';
import { installSkill } from '../skills';

describe('kunj agent start --detach / --open-in-app / --prompt-file', () => {
  it('detach starts with -d, never -A, and open-in-app sets @kunj_open', () => {
    const argv = agentArgv('kunj-a-b-123456-a-handoff', '/w', ['sh'], {}, { detach: true, openInApp: true, worktree: '/w' });
    expect(argv.slice(0, 4)).toEqual(['tmux', '-u', 'new-session', '-d']);
    expect(argv).not.toContain('-A');
    expect(argv.join(' ')).toContain('set-option -t kunj-a-b-123456-a-handoff @kunj_open app');
    expect(agentArgv('s', '/w', ['sh'], {})).toContain('-A');
    expect(agentArgv('s', '/w', ['sh'], {}).join(' ')).not.toContain('@kunj_open');
  });

  it('the prompt is the quoted copy read by the shell, only for claude', () => {
    expect(withAgentPrompt('claude --x', "/h/it's/p.md")).toBe(`claude --x "$(cat '/h/it'\\''s/p.md')"`);
    expect(withAgentPrompt('claude', null)).toBe('claude');
    expect(isClaudeCommand('/usr/local/bin/claude --flag')).toBe(true);
    expect(isClaudeCommand('agy')).toBe(false);
  });

  it('reads the open flag and the id of a session', () => {
    expect(parseTaggedSessionLine('kunj-a-b-123456\t/w/x\tapp')).toEqual({ name: 'kunj-a-b-123456', worktree: '/w/x', open: 'app' });
    expect(parseTaggedSessionLine('kunj-a-b-123456\t/w/x\t')).toEqual({ name: 'kunj-a-b-123456', worktree: '/w/x', open: '' });
    expect(parseTaggedSessionLine('main\t\t')).toEqual({ name: 'main', worktree: '', open: '' });
    expect(parseTaggedSessionLine('main')).toEqual({ name: 'main', worktree: '' });
    expect(agentIdOf('kunj-app-x-abc123-a-handoff')).toBe('handoff');
    expect(agentIdOf('kunj-app-x-abc123')).toBeNull();
    expect(agentIdOf('kunjsh-app-x-abc123-sh-1')).toBeUndefined();
  });
});

describe('kunj install skill', () => {
  function dirs() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-skill-'));
    const from = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(from, 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(from, 'handoff', 'SKILL.md'), 'v1');
    return { tmp, from, to: path.join(tmp, 'home', '.claude', 'skills') };
  }

  it('copies the skill with a marker, and replaces its own copy', () => {
    const { from, to } = dirs();
    expect(installSkill('handoff', { version: '1.0.0', from, to })).toMatchObject({ replaced: false });
    expect(fs.readFileSync(path.join(to, 'handoff', 'SKILL.md'), 'utf8')).toBe('v1');
    fs.writeFileSync(path.join(from, 'handoff', 'SKILL.md'), 'v2');
    expect(installSkill('handoff', { version: '1.0.1', from, to })).toMatchObject({ replaced: true });
    expect(fs.readFileSync(path.join(to, 'handoff', 'SKILL.md'), 'utf8')).toBe('v2');
    expect(fs.readFileSync(path.join(to, 'handoff', '.kunj-version'), 'utf8')).toBe('1.0.1\n');
  });

  it('never overwrites a skill the user wrote without force', () => {
    const { from, to } = dirs();
    fs.mkdirSync(path.join(to, 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(to, 'handoff', 'SKILL.md'), 'mine');
    expect(() => installSkill('handoff', { version: '1', from, to })).toThrow(/not installed by kunj/);
    expect(fs.readFileSync(path.join(to, 'handoff', 'SKILL.md'), 'utf8')).toBe('mine');
    installSkill('handoff', { version: '1', from, to, force: true });
    expect(fs.readFileSync(path.join(to, 'handoff', 'SKILL.md'), 'utf8')).toBe('v1');
  });

  it('the package ships the handoff skill', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', '..', 'skills', 'handoff', 'SKILL.md'))).toBe(true);
  });
});
