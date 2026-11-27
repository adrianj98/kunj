// The teleport guard and the idle suspend run real sh, git and tmux (the tmux tests skip without it)
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  IDLE_SUSPEND_HOOK, TELEPORT_FAILED_MARK, TELEPORT_GUARD_SCRIPT, agentSuspendedFile, claudeHookSettings,
  teleportOutcome, withTeleportGuard,
} from '../agent-session';
import { hookSafe } from '../agent-plan';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const tmuxIt = hasTmux ? it : it.skip;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoOn(branch: string): string {
  const dir = tmp('kunj-tp-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return check();
}

describe('teleport guard', () => {
  it('wraps the command for /bin/sh with the placeholder branch quoted', () => {
    expect(withTeleportGuard("claude --teleport s --settings '{}'", "a'b"))
      .toBe(`/bin/sh -c '${TELEPORT_GUARD_SCRIPT.replace(/'/g, `'\\''`)}' kunj-teleport 'a'\\''b' claude --teleport s --settings '{}'`);
  });

  it('keeps a failed teleport on screen with the mark and passes the exit code through', () => {
    const dir = repoOn('teleport-x');
    const run = spawnSync('/bin/sh', ['-c', withTeleportGuard('sh -c "echo Session not found: s1; exit 3"', 'teleport-x')],
      { cwd: dir, encoding: 'utf8', input: '\n' });
    expect(run.status).toBe(3);
    expect(run.stdout).toContain('Session not found: s1');
    expect(run.stdout).toContain(`${TELEPORT_FAILED_MARK} 3; this worktree stays on teleport-x.`);
  });

  it('deletes the placeholder once claude switched the worktree, keeping one with work of its own', async () => {
    const dir = repoOn('teleport-x');
    const kept = repoOn('teleport-y');
    git(kept, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'own work');
    // claude stands in: it checks out the web branch (made from main) and returns; the guard's watcher stays behind
    const teleport = (cwd: string, placeholder: string) =>
      spawnSync('/bin/sh', ['-c', withTeleportGuard('git checkout -q -b claude/web main', placeholder)], { cwd });
    teleport(dir, 'teleport-x');
    teleport(kept, 'teleport-y');
    expect(await until(() => spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/teleport-x'], { cwd: dir }).status !== 0, 9000)).toBe(true);
    expect(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/teleport-y'], { cwd: kept }).status).toBe(0);
  }, 15000);

  it('says nothing when claude succeeds', () => {
    const dir = repoOn('teleport-x');
    const run = spawnSync('/bin/sh', ['-c', withTeleportGuard('true', 'teleport-x')], { cwd: dir, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain(TELEPORT_FAILED_MARK);
  });
});

describe('teleportOutcome', () => {
  const sessions: string[] = [];
  afterEach(() => {
    for (const s of sessions.splice(0)) spawnSync('tmux', ['kill-session', '-t', `=${s}`]);
  });

  function session(cwd: string, command: string): string {
    const name = `kunjtest-tp-${process.pid}-${sessions.length}`;
    sessions.push(name);
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '160', '-y', '30', '-c', cwd, command]);
    return name;
  }

  tmuxIt('is switched once the worktree is on another branch', async () => {
    const dir = repoOn('teleport-x');
    const s = session(dir, 'sleep 30');
    git(dir, 'checkout', '-q', '-b', 'claude/web-work');
    expect(await teleportOutcome(s, dir, 'teleport-x', 3000, 50)).toEqual({ state: 'switched', branch: 'claude/web-work' });
  });

  tmuxIt('is failed with claude\'s last lines when the guard shows its mark', async () => {
    const dir = repoOn('teleport-x');
    const s = session(dir, withTeleportGuard('sh -c "echo Session not found: s1; exit 1"', 'teleport-x'));
    expect(await teleportOutcome(s, dir, 'teleport-x', 5000, 50)).toEqual({ state: 'failed', message: 'Session not found: s1' });
  });

  tmuxIt('is pending when nothing happened in time, and failed when the session is gone', async () => {
    const dir = repoOn('teleport-x');
    const s = session(dir, 'sleep 30');
    expect((await teleportOutcome(s, dir, 'teleport-x', 200, 50)).state).toBe('pending');
    expect(await teleportOutcome('kunjtest-no-such-session', dir, 'teleport-x', 200, 50))
      .toEqual({ state: 'failed', message: 'The agent session ended before the teleport finished.' });
  });
});

describe('idle suspend', () => {
  it('is a Stop and Notification hook, with no single quote', () => {
    const hooks = JSON.parse(claudeHookSettings()).hooks;
    expect(hooks.Stop.map((h: any) => h.hooks[0].command)).toContain(hookSafe(IDLE_SUSPEND_HOOK));
    expect(hooks.Notification.map((h: any) => h.hooks[0].command)).toContain(hookSafe(IDLE_SUSPEND_HOOK));
    expect(IDLE_SUSPEND_HOOK).not.toContain("'");
  });

  function runHook(env: Record<string, string>): void {
    const run = spawnSync('/bin/sh', ['-c', hookSafe(IDLE_SUSPEND_HOOK)], { env: { ...process.env, ...env }, stdio: 'ignore', timeout: 3000 });
    expect(run.status).toBe(0);
  }

  const sessions: string[] = [];
  afterEach(() => {
    for (const s of sessions.splice(0)) spawnSync('tmux', ['kill-session', '-t', `=${s}`]);
  });

  function paneOf(): { name: string; pane: string } {
    const name = `kunjtest-idle-${process.pid}-${sessions.length}`;
    sessions.push(name);
    execFileSync('tmux', ['new-session', '-d', '-s', name, 'sleep 60']);
    return { name, pane: execFileSync('tmux', ['display', '-p', '-t', `=${name}:`, '#{pane_id}'], { encoding: 'utf8' }).trim() };
  }

  const alive = (name: string) => spawnSync('tmux', ['has-session', '-t', `=${name}`]).status === 0;

  tmuxIt('ends a session still waiting after the delay and marks it suspended', async () => {
    const state = path.join(tmp('kunj-idle-'), 's');
    fs.writeFileSync(state, 'waiting');
    const { name, pane } = paneOf();
    runHook({ KUNJ_AGENT_STATE: state, KUNJ_AGENT_SUSPEND_AFTER: '1', TMUX_PANE: pane });
    expect(alive(name)).toBe(true);
    expect(await until(() => !alive(name))).toBe(true);
    expect(fs.existsSync(agentSuspendedFile(state))).toBe(true);
    expect(fs.existsSync(state)).toBe(false);
  });

  tmuxIt('leaves it running when it got input meanwhile, or when it is off', async () => {
    const dir = tmp('kunj-idle-');
    const busy = path.join(dir, 'busy');
    fs.writeFileSync(busy, 'waiting');
    const a = paneOf();
    runHook({ KUNJ_AGENT_STATE: busy, KUNJ_AGENT_SUSPEND_AFTER: '1', TMUX_PANE: a.pane });
    fs.writeFileSync(busy, 'running');
    const off = path.join(dir, 'off');
    fs.writeFileSync(off, 'waiting');
    const b = paneOf();
    runHook({ KUNJ_AGENT_STATE: off, KUNJ_AGENT_SUSPEND_AFTER: '0', TMUX_PANE: b.pane });
    await new Promise(r => setTimeout(r, 2000));
    expect(alive(a.name)).toBe(true);
    expect(alive(b.name)).toBe(true);
    expect(fs.existsSync(agentSuspendedFile(busy))).toBe(false);
    expect(fs.existsSync(agentSuspendedFile(off))).toBe(false);
  });

  tmuxIt('a later waiting spell replaces an earlier sleeper', async () => {
    const state = path.join(tmp('kunj-idle-'), 's');
    fs.writeFileSync(state, 'waiting');
    const { name, pane } = paneOf();
    runHook({ KUNJ_AGENT_STATE: state, KUNJ_AGENT_SUSPEND_AFTER: '1', TMUX_PANE: pane });
    await new Promise(r => setTimeout(r, 300));
    runHook({ KUNJ_AGENT_STATE: state, KUNJ_AGENT_SUSPEND_AFTER: '3', TMUX_PANE: pane });
    await new Promise(r => setTimeout(r, 1500));
    expect(alive(name)).toBe(true);
    expect(await until(() => !alive(name), 4000)).toBe(true);
  });
});
