import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { ExecIO } from '../backend';
import { parseBlueprint } from '../blueprint';
import {
  applyPersonal,
  deletablePath,
  describePersonal,
  isEmptyPersonal,
  mergePersonal,
  mergeSettings,
  parsePersonal,
  personalStamp,
  planPersonal,
  resolvePersonal,
  RC_PATH,
  RECORD_PATH,
  STAMP_PATH,
  ResolvedPersonal,
} from '../personal';
import { FakeBackend } from './fake-backend';
import { testBackend } from './remote-harness';

jest.setTimeout(30000);

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-personal-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

/** The files in a tar stream (via the system tar): path → content, plus modes */
async function untar(data: string): Promise<{ files: Record<string, string>; modes: Record<string, number> }> {
  const out = tmp();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-x', '-C', out]);
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
    child.stdin.end(Buffer.from(data, 'latin1'));
  });
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(out, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const stat = fs.statSync(path.join(out, r));
      if (stat.isDirectory()) walk(r);
      else {
        files[r] = fs.readFileSync(path.join(out, r), 'utf8');
        modes[r] = stat.mode & 0o777;
      }
    }
  };
  walk('');
  return { files, modes };
}

/** A fixture home with a Claude config directory and some dotfiles */
function fixtureHome(): { home: string; claudeDir: string } {
  const home = tmp();
  const claudeDir = path.join(home, '.claude');
  write(path.join(claudeDir, 'CLAUDE.md'), '# me\n');
  write(path.join(claudeDir, 'skills', 'handoff', 'SKILL.md'), 'handoff\n');
  write(path.join(claudeDir, 'skills', 'handoff', 'scripts', 'go.sh'), '#!/bin/sh\n', 0o755);
  write(path.join(claudeDir, 'skills', 'review', 'SKILL.md'), 'review\n');
  write(path.join(claudeDir, 'agents', 'planner.md'), 'planner\n');
  write(path.join(claudeDir, 'commands', 'standup.md'), 'standup\n');
  write(path.join(claudeDir, 'commands', 'nested', 'deep.md'), 'deep\n');
  write(path.join(claudeDir, 'settings.json'), '{"hooks": {"x": 1}, "model": "sonnet"}\n');
  write(path.join(claudeDir, '.credentials.json'), 'secret\n');
  write(path.join(home, '.vimrc'), 'set nu\n', 0o600);
  write(path.join(home, '.config', 'nvim', 'init.lua'), 'lua\n');
  return { home, claudeDir };
}

function resolved(bp: object, over: Partial<ResolvedPersonal> = {}): ResolvedPersonal {
  const { home, claudeDir } = fixtureHome();
  return { blueprint: parsePersonal(JSON.stringify(bp), 'p.json', 'global'), sources: [{ path: 'p.json', scope: 'global' }], home, claudeDir, ...over };
}

describe('parsePersonal', () => {
  it('parses every key and reports unknown ones as ignored', () => {
    const bp = parsePersonal(
      `{ // c
        "git": {"pull.rebase": "true", "alias.lg": "log --graph"},
        "claude": {"claudeMd": true, "skills": ["handoff"], "agents": true, "settings": {"model": "opus", "permissions": {"deny": ["Bash(rm *)"]}}},
        "shell": {"rc": "export X=1"},
        "files": ["~/.vimrc", {"from": "~/.config/nvim", "to": ".config/nvim"}],
        "aliases": {"t": "npm test"},
        "zeta": 1,
      }`,
      'p.json',
      'global'
    );
    expect(bp.git).toEqual({ 'pull.rebase': 'true', 'alias.lg': 'log --graph' });
    expect(bp.claude).toEqual({ claudeMd: true, skills: ['handoff'], agents: true, settings: { model: 'opus', permissions: { deny: ['Bash(rm *)'] } } });
    expect(bp.shell).toEqual({ rc: 'export X=1' });
    expect(bp.files).toEqual([
      { from: '~/.vimrc', to: '.vimrc' },
      { from: '~/.config/nvim', to: '.config/nvim' },
    ]);
    expect(bp.aliases).toEqual({ t: 'npm test' });
    expect(bp.ignoredKeys).toEqual(['zeta']);
    expect(isEmptyPersonal(bp)).toBe(false);
    expect(isEmptyPersonal(parsePersonal('{}', 'p.json', 'global'))).toBe(true);
  });

  it('refuses git keys off the allowlist, with the reason', () => {
    const bad = (git: object, message: string) => expect(() => parsePersonal(JSON.stringify({ git }), 'p.json', 'global')).toThrow(message);
    bad({ 'credential.helper': 'osxkeychain' }, 'git."credential.helper" is not allowed in a container (it would shadow kunj\'s credential helper)');
    bad({ 'url.git@github.com:.insteadOf': 'https://github.com/' }, 'an insteadOf rewrite would break the token-based origin');
    bad({ 'core.hooksPath': '/Users/me/hooks' }, 'it is a host path');
    bad({ 'commit.gpgsign': 'true' }, 'the container has no signing key');
    bad({ 'core.editor': 'code --wait' }, 'the host\'s editor is not in the image');
    bad({ 'includeIf.gitdir:~/work/.path': 'x' }, 'it is a host path');
    bad({ 'something.odd': 'x' }, 'only a fixed set of per-user keys is copied');
    bad({ 'alias.sh': '!sh -c "echo"' }, 'git."alias.sh" runs a shell command, which is not allowed');
    bad({ 'alias.bad name': 'status' }, 'is not a valid alias name');
    bad({ 'pull.rebase': 'a\nb' }, 'git."pull.rebase" must be one line');
    bad({ 'pull.rebase': 'x'.repeat(1001) }, 'must be one line');
    bad({ 'pull.rebase': true }, 'must be one line');
  });

  it('refuses claude settings other than model and permissions.deny, and bad names', () => {
    const bad = (claude: object, message: string) => expect(() => parsePersonal(JSON.stringify({ claude }), 'p.json', 'global')).toThrow(message);
    bad({ settings: { hooks: {} } }, 'claude.settings.hooks is not copied into containers (only model and permissions.deny are)');
    bad({ settings: { permissions: { allow: [] } } }, 'claude.settings.permissions.allow is not copied into containers');
    bad({ settings: { apiKeyHelper: 'x' } }, 'claude.settings.apiKeyHelper is not copied');
    bad({ skills: ['../x'] }, 'claude.skills[0] "../x" is not a name');
    bad({ skills: ['a/b'] }, 'is not a name');
    bad({ skills: 'all' }, 'claude.skills must be true (every one) or an array of names');
    bad({ mcpServers: {} }, 'claude.mcpServers is not a known key');
    bad({ claudeMd: 'yes' }, 'claude.claudeMd must be true or false');
  });

  it('refuses shell with both or neither of rc and rcFile, and files outside the home', () => {
    const bad = (doc: object, message: string) => expect(() => parsePersonal(JSON.stringify(doc), 'p.json', 'global')).toThrow(message);
    bad({ shell: {} }, 'shell needs rc or rcFile, not both');
    bad({ shell: { rc: 'a', rcFile: 'b' } }, 'shell needs rc or rcFile, not both');
    bad({ shell: { rc: 'x'.repeat(65 * 1024) } }, 'shell.rc is over 64 KB');
    bad({ files: [{ from: '~/.vimrc', to: '/etc/x' }] }, 'files[0].to must be a path inside the container home');
    bad({ files: [{ from: '~/.vimrc', to: '../x' }] }, 'files[0].to must be a path inside the container home');
    bad({ files: [{ from: '~/.vimrc', to: '.kunj/rc' }] }, 'files[0].to must be a path inside the container home');
    bad({ files: [{ from: '~/.vimrc', to: '.claude/CLAUDE.md' }] }, 'files[0].to must be a path inside the container home');
    bad({ files: ['/etc/passwd'] }, 'files[0] "/etc/passwd" needs "to" unless it starts with ~/');
    bad({ files: [1] }, 'files[0] must be "~/path"');
    bad({ kunj: { config: true } }, '"kunj" is not supported yet');
  });

  it('refuses repository keys in the global file, and takes them in the host file', () => {
    expect(() => parsePersonal('{"tools": {"node": "22"}}', 'g.json', 'global')).toThrow('g.json: "tools" belongs in the repository\'s .kunj/blueprint.json');
    const host = parsePersonal('{"tools": {"node": "22"}, "git": {"pull.rebase": "true"}, "other": 1}', 'h.json', 'host');
    expect(host.git).toEqual({ 'pull.rebase': 'true' });
    expect(host.ignoredKeys).toEqual(['other']);
  });

  it('a committed blueprint refuses personal keys; the host copy leaves them to personal.ts', () => {
    expect(() => parseBlueprint('{"tools": {}, "git": {"pull.rebase": "true"}}', '.kunj/blueprint.json')).toThrow(
      '.kunj/blueprint.json: "git" is personal and belongs in ~/.kunj/blueprint.json'
    );
    const host = parseBlueprint('{"tools": {"node": "22"}, "claude": {"skills": true}, "x": 1}', 'h.json', { personal: 'ignore' });
    expect(host.tools).toEqual({ node: '22' });
    expect(host.ignoredKeys).toEqual(['x']);
  });
});

describe('mergePersonal and resolvePersonal', () => {
  it('the per-repo file wins per key: git and aliases by name, claude by sub-key, shell and files whole', () => {
    const base = parsePersonal(
      JSON.stringify({ git: { 'pull.rebase': 'true', 'alias.a': 'status' }, claude: { skills: true, agents: ['x'] }, shell: { rc: 'base' }, files: ['~/.vimrc'], aliases: { t: 'npm test', u: 'u' } }),
      'g.json',
      'global'
    );
    const over = parsePersonal(JSON.stringify({ git: { 'alias.a': 'log' }, claude: { agents: ['y'] }, files: [], aliases: { t: 'yarn test' } }), 'r.json', 'host');
    const merged = mergePersonal(base, over);
    expect(merged.git).toEqual({ 'pull.rebase': 'true', 'alias.a': 'log' });
    expect(merged.claude).toEqual({ skills: true, agents: ['y'] });
    expect(merged.shell).toEqual({ rc: 'base' });
    expect(merged.files).toEqual([]);
    expect(merged.aliases).toEqual({ t: 'yarn test', u: 'u' });
  });

  it('resolves the global file and the host copy, null when neither names anything personal', () => {
    const globalDir = tmp();
    const repoDir = tmp();
    expect(resolvePersonal({ globalKunjDir: globalDir, repoKunjDir: repoDir, home: globalDir })).toBeNull();
    write(path.join(repoDir, 'blueprint.json'), '{"tools": {"node": "22"}}');
    expect(resolvePersonal({ globalKunjDir: globalDir, repoKunjDir: repoDir, home: globalDir })).toBeNull();
    write(path.join(globalDir, 'blueprint.json'), '{"git": {"pull.rebase": "true"}}');
    write(path.join(repoDir, 'blueprint.json'), '{"tools": {"node": "22"}, "git": {"pull.rebase": "false"}}');
    const r = resolvePersonal({ globalKunjDir: globalDir, repoKunjDir: repoDir, home: globalDir, claudeDir: path.join(globalDir, 'c') });
    expect(r?.blueprint.git).toEqual({ 'pull.rebase': 'false' });
    expect(r?.sources.map(s => s.scope)).toEqual(['global', 'repo']);
    expect(r?.claudeDir).toBe(path.join(globalDir, 'c'));
    write(path.join(globalDir, 'blueprint.json'), '{"git": {"credential.helper": "x"}}');
    expect(() => resolvePersonal({ globalKunjDir: globalDir, repoKunjDir: repoDir, home: globalDir })).toThrow('blueprint.json: git."credential.helper" is not allowed');
  });
});

describe('planPersonal', () => {
  it('collects the named Claude entries, the rc, the files and the git keys, and nothing else', () => {
    const warnings: string[] = [];
    const plan = planPersonal(
      resolved({
        git: { 'pull.rebase': 'true', 'alias.lg': 'log --graph' },
        claude: { claudeMd: true, skills: ['handoff'], agents: true, commands: true, settings: { model: 'opus' } },
        shell: { rc: 'export X=1\n' },
        files: ['~/.vimrc', { from: '~/.config/nvim', to: '.config/nvim' }],
        aliases: { t: "echo 'hi'" },
      }),
      m => warnings.push(m)
    );
    const paths = plan.entries.map(e => e.path).sort();
    expect(paths).toEqual([
      '.claude/CLAUDE.md',
      '.claude/agents/planner.md',
      '.claude/commands/nested/deep.md',
      '.claude/commands/standup.md',
      '.claude/skills/handoff/SKILL.md',
      '.claude/skills/handoff/scripts/go.sh',
      '.config/nvim/init.lua',
      RC_PATH,
      '.vimrc',
    ]);
    expect(paths).not.toContain('.claude/settings.json');
    expect(paths.join()).not.toContain('credentials');
    expect(paths.join()).not.toContain('review');
    const by = Object.fromEntries(plan.entries.map(e => [e.path, e]));
    expect(by['.claude/skills/handoff/scripts/go.sh'].mode).toBe(0o755);
    expect(by['.vimrc'].mode).toBe(0o600);
    expect(by[RC_PATH].content.toString()).toBe("# aliases from the personal blueprint\nalias t='echo '\\''hi'\\'''\n# shell from the personal blueprint\nexport X=1\n");
    expect(plan.git).toEqual({ 'pull.rebase': 'true', 'alias.lg': 'log --graph' });
    expect(plan.settings).toEqual({ model: 'opus' });
    expect(plan.summary).toEqual({
      git: ['alias.lg', 'pull.rebase'],
      claude: { claudeMd: true, skills: ['handoff'], agents: ['planner'], commands: ['nested', 'standup'], settings: ['model'] },
      shell: true,
      files: ['.vimrc', '.config/nvim'],
      dropped: [],
    });
    expect(describePersonal(plan.summary)).toBe('git 2 keys · claude CLAUDE.md, 1 skill, 1 agent, 2 commands, settings · shell rc · 2 files');
    expect(warnings).toEqual([]);
  });

  it('drops a missing entry, a file outside the home, an oversized rc file, with a warning each', () => {
    const r = resolved({
      claude: { claudeMd: true, skills: ['nope', 'review'] },
      shell: { rcFile: '~/big' },
      files: ['~/missing', { from: '/etc/hostname', to: 'h' }, { from: '~/link', to: 'l' }],
    });
    fs.rmSync(path.join(r.claudeDir, 'CLAUDE.md'));
    write(path.join(r.home, 'big'), 'x'.repeat(65 * 1024));
    fs.symlinkSync('/etc', path.join(r.home, 'link'));
    const warnings: string[] = [];
    const plan = planPersonal(r, m => warnings.push(m));
    expect(plan.entries.map(e => e.path)).toEqual(['.claude/skills/review/SKILL.md']);
    expect(plan.summary.dropped).toEqual([
      { entry: 'claude.claudeMd', reason: 'no ~/.claude/CLAUDE.md' },
      { entry: 'claude.skills nope', reason: 'not in ~/.claude/skills' },
      { entry: 'shell.rcFile', reason: '~/big is over 64 KB' },
      { entry: 'files ~/missing', reason: 'not found' },
      { entry: 'files /etc/hostname', reason: 'it is outside your home directory' },
      { entry: 'files ~/link', reason: 'it is outside your home directory' },
    ]);
    expect(plan.summary.shell).toBe(false);
    expect(warnings).toHaveLength(6);
    expect(describePersonal(plan.summary)).toBe('claude 1 skill');
  });

  it('reads the rc from a file under the home and skips symlinks inside a directory', () => {
    const r = resolved({ shell: { rcFile: '~/.kunj/container/zshrc' }, files: [{ from: '~/.config/nvim', to: 'nv' }] });
    write(path.join(r.home, '.kunj', 'container', 'zshrc'), 'bindkey -v\n');
    fs.symlinkSync('/etc/passwd', path.join(r.home, '.config', 'nvim', 'pw'));
    const warnings: string[] = [];
    const plan = planPersonal(r, m => warnings.push(m));
    expect(plan.entries.map(e => e.path).sort()).toEqual([RC_PATH, 'nv/init.lua']);
    expect(plan.entries.find(e => e.path === RC_PATH)?.content.toString()).toBe('# shell from the personal blueprint\nbindkey -v\n');
    expect(warnings).toEqual(['personal blueprint: files ~/.config/nvim: symlink nv/pw skipped']);
  });

  it('the stamp follows the blueprint and the named files, and is empty without a blueprint', () => {
    const r = resolved({ claude: { skills: ['handoff'] }, git: { 'pull.rebase': 'true' } });
    const stamp = personalStamp(r);
    expect(stamp).toMatch(/^[0-9a-f]{12}$/);
    expect(personalStamp(r)).toBe(stamp);
    expect(personalStamp(null)).toBe('');
    write(path.join(r.claudeDir, 'skills', 'handoff', 'SKILL.md'), 'changed\n');
    const changed = personalStamp(r);
    expect(changed).not.toBe(stamp);
    // a file it does not name changes nothing
    write(path.join(r.claudeDir, 'skills', 'review', 'SKILL.md'), 'changed too\n');
    expect(personalStamp(r)).toBe(changed);
    const other = resolved({ claude: { skills: ['handoff'] }, git: { 'pull.rebase': 'false' } });
    expect(personalStamp(other)).not.toBe(stamp);
  });
});

describe('mergeSettings', () => {
  it('sets model and permissions.deny, keeps other keys, removes keys an earlier run set', () => {
    const r1 = mergeSettings('{"hooks": {"x": 1}}', { model: 'opus', deny: ['a'] }, []);
    expect(JSON.parse(r1!.text)).toEqual({ hooks: { x: 1 }, model: 'opus', permissions: { deny: ['a'] } });
    expect(r1!.keys).toEqual(['model', 'permissions.deny']);
    // unchanged: nothing to write
    expect(mergeSettings(r1!.text, { model: 'opus', deny: ['a'] }, r1!.keys)).toBeNull();
    // the blueprint dropped both: removed, the user's own keys kept
    const r2 = mergeSettings('{"hooks": {"x": 1}, "model": "opus", "permissions": {"deny": ["a"], "allow": ["b"]}}', undefined, ['model', 'permissions.deny']);
    expect(JSON.parse(r2!.text)).toEqual({ hooks: { x: 1 }, permissions: { allow: ['b'] } });
    expect(r2!.keys).toEqual([]);
    // a model the user set themselves (not recorded) is left alone
    expect(mergeSettings('{"model": "sonnet"}', undefined, [])).toBeNull();
    expect(mergeSettings(null, { model: 'opus' }, [])!.text).toBe('{\n  "model": "opus"\n}\n');
    expect(() => mergeSettings('nope', { model: 'x' }, [])).toThrow();
    expect(() => mergeSettings('[]', { model: 'x' }, [])).toThrow('not a JSON object');
  });

  it('deletablePath allows only what kunj writes, never the record or the stamp', () => {
    expect(deletablePath('.claude/skills/x/SKILL.md')).toBe(true);
    expect(deletablePath(RC_PATH)).toBe(true);
    expect(deletablePath('.vimrc')).toBe(true);
    expect(deletablePath('.config/nvim/init.lua')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', '.claude/../x', 'a//b', RECORD_PATH, STAMP_PATH, '.kunj/bin/git-credential-kunj', 'a\nb']) {
      expect(deletablePath(bad)).toBe(false);
    }
  });
});

describe('applyPersonal', () => {
  const HOME = '/home/dev';

  function reads(b: FakeBackend): string[][] {
    return b.callsOf('exec').map(a => a[1] as string[]);
  }

  it('writes the entries, the settings, the record and the stamp as the user, then the git keys', async () => {
    const b = testBackend();
    const plan = planPersonal(resolved({ git: { 'pull.rebase': 'true', 'alias.lg': 'log --graph' }, claude: { skills: ['handoff'], settings: { model: 'opus' } }, aliases: { t: 'npm test' } }));
    b.execHandler = (_id, cmd) => (cmd[2]?.includes('personal.json') && cmd[2].includes('cat') ? Promise.resolve({ exitCode: 0, stdout: '\n---kunj-personal---\n{"hooks": {"a": 1}}\n' }) : undefined);
    await applyPersonal(b, 'id-1', 'dev', HOME, plan);
    const cmds = reads(b);
    expect(cmds).toHaveLength(3);
    for (const a of b.callsOf('exec')) expect((a[2] as ExecIO).user).toBe('dev');
    // read: the home and the separator as arguments
    expect(cmds[0].slice(4)).toEqual([HOME, '---kunj-personal---']);
    // write: nothing to delete on a first run; the tar holds everything
    expect(cmds[1].slice(4)).toEqual([HOME]);
    const { files, modes } = await untar(b.stdinData.find(Boolean)!);
    expect(Object.keys(files).sort()).toEqual(['.claude/settings.json', '.claude/skills/handoff/SKILL.md', '.claude/skills/handoff/scripts/go.sh', RC_PATH, RECORD_PATH, STAMP_PATH].sort());
    expect(JSON.parse(files['.claude/settings.json'])).toEqual({ hooks: { a: 1 }, model: 'opus' });
    expect(files[STAMP_PATH]).toBe(plan.stamp + '\n');
    const record = JSON.parse(files[RECORD_PATH]);
    expect(record).toEqual({
      version: 1,
      stamp: plan.stamp,
      paths: ['.claude/skills/handoff/SKILL.md', '.claude/skills/handoff/scripts/go.sh', RC_PATH],
      gitKeys: ['alias.lg', 'pull.rebase'],
      settingsKeys: ['model'],
    });
    expect(modes['.claude/skills/handoff/scripts/go.sh']).toBe(0o755);
    // git: no keys to unset, then the pairs sorted by key, values as arguments
    expect(cmds[2].slice(4)).toEqual([HOME, '0', 'alias.lg', 'log --graph', 'pull.rebase', 'true']);
    expect(cmds[2][2]).toContain('git config --global -- "$1" "$2"');
  });

  it('a second run removes only what the record says it wrote and unsets dropped git keys', async () => {
    const b = testBackend();
    const previous = {
      version: 1,
      stamp: 'old',
      paths: ['.claude/skills/handoff/SKILL.md', '.claude/skills/old/SKILL.md', RC_PATH, '.vimrc', '/etc/evil', '../up', '.kunj/personal.json'],
      gitKeys: ['pull.rebase', 'alias.old'],
      settingsKeys: ['model', 'permissions.deny'],
    };
    b.execHandler = (_id, cmd) =>
      cmd[2]?.includes('personal.json') && cmd[2].includes('cat')
        ? Promise.resolve({ exitCode: 0, stdout: `${JSON.stringify(previous)}\n---kunj-personal---\n{"model": "opus", "permissions": {"deny": ["a"], "allow": ["b"]}, "hooks": 1}\n` })
        : undefined;
    const plan = planPersonal(resolved({ git: { 'pull.rebase': 'false' }, claude: { skills: ['handoff'] } }));
    await applyPersonal(b, 'id-1', 'dev', HOME, plan);
    const cmds = reads(b);
    // the rc and .vimrc are gone from the plan, the old skill too; the record, a path outside and .. never
    expect(cmds[1].slice(4)).toEqual([HOME, '.claude/skills/old/SKILL.md', RC_PATH, '.vimrc']);
    const { files } = await untar(b.stdinData.find(Boolean)!);
    // settings no longer named: both keys removed, the user's allow and hooks kept
    expect(JSON.parse(files['.claude/settings.json'])).toEqual({ permissions: { allow: ['b'] }, hooks: 1 });
    expect(JSON.parse(files[RECORD_PATH]).settingsKeys).toEqual([]);
    expect(cmds[2].slice(4)).toEqual([HOME, '1', 'alias.old', 'pull.rebase', 'false']);
  });

  it('a settings.json that is not JSON is left alone with a warning; the rest applies', async () => {
    const b = testBackend();
    b.execHandler = (_id, cmd) => (cmd[2]?.includes('personal.json') && cmd[2].includes('cat') ? Promise.resolve({ exitCode: 0, stdout: '\n---kunj-personal---\nnot json\n' }) : undefined);
    const warnings: string[] = [];
    const plan = planPersonal(resolved({ claude: { skills: ['handoff'], settings: { model: 'opus' } } }));
    await applyPersonal(b, 'id-1', 'dev', HOME, plan, m => warnings.push(m));
    const { files } = await untar(b.stdinData.find(Boolean)!);
    expect(files['.claude/settings.json']).toBeUndefined();
    expect(files['.claude/skills/handoff/SKILL.md']).toBe('handoff\n');
    expect(warnings).toEqual(['personal blueprint: .claude/settings.json in the container is not valid JSON, so model and permissions.deny were not written']);
    // no git keys: no git exec
    expect(reads(b)).toHaveLength(2);
  });

  it('a failed write is a ContainerError naming the step', async () => {
    const b = testBackend();
    b.execHandler = (_id, cmd, io) => (io.stdin ? Promise.resolve({ exitCode: 3, stdout: '' }) : undefined);
    const plan = planPersonal(resolved({ claude: { skills: ['handoff'] } }));
    await expect(applyPersonal(b, 'id-1', 'dev', HOME, plan)).rejects.toThrow('Writing the personal blueprint into the container failed (exit 3)');
  });
});
