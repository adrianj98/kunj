import { describe, it, expect, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { PassThrough } from 'stream';
import { FakeBackend } from './fake-backend';
import { builtinPresetsDir, orderTools, presetEnv, resolvePresets, runPresets, Preset, PRESET_DIR } from '../presets';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-presets-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** List the names in a tar stream, with their contents, via the system tar. */
async function untar(data: string): Promise<Record<string, string>> {
  const out = tmp();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-x', '-C', out]);
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
    child.stdin.end(Buffer.from(data, 'latin1'));
  });
  const files: Record<string, string> = {};
  for (const name of fs.readdirSync(out)) files[name] = fs.readFileSync(path.join(out, name), 'utf8');
  return files;
}

describe('presets', () => {
  it('orderTools puts apt first, runtimes, then package managers, then unknown in given order', () => {
    expect(orderTools({ zeta: true, pnpm: '9', mytool: '1', node: '22', apt: ['jq'], python: '3.12' })).toEqual([
      'apt', 'node', 'python', 'pnpm', 'zeta', 'mytool',
    ]);
    expect(orderTools({})).toEqual([]);
  });

  it('resolvePresets prefers repo over host over builtin and hashes content', async () => {
    const repoRoot = tmp();
    const globalKunjDir = tmp();
    const builtinDir = tmp();
    write(path.join(repoRoot, '.kunj', 'presets', 'node.sh'), 'echo repo-node\n');
    write(path.join(globalKunjDir, 'presets', 'node.sh'), 'echo host-node\n');
    write(path.join(globalKunjDir, 'presets', 'go.sh'), 'echo host-go\n');
    write(path.join(builtinDir, 'node.sh'), 'echo builtin-node\n');
    write(path.join(builtinDir, 'go.sh'), 'echo builtin-go\n');
    write(path.join(builtinDir, 'apt.sh'), 'echo builtin-apt\n');

    const presets = await resolvePresets(['node', 'go', 'apt'], { repoRoot, globalKunjDir, builtinDir });
    expect(presets.map(p => [p.name, p.source, p.text])).toEqual([
      ['node', 'repo', 'echo repo-node\n'],
      ['go', 'host', 'echo host-go\n'],
      ['apt', 'builtin', 'echo builtin-apt\n'],
    ]);
    expect(presets[0].path).toBe(path.join(repoRoot, '.kunj', 'presets', 'node.sh'));
    expect(presets[0].hash).toBe(crypto.createHash('sha1').update('echo repo-node\n').digest('hex').slice(0, 12));

    // Without a repo checkout the host copy wins
    const noRepo = await resolvePresets(['node'], { globalKunjDir, builtinDir });
    expect(noRepo[0].source).toBe('host');

    await expect(resolvePresets(['nope'], { repoRoot, globalKunjDir, builtinDir })).rejects.toThrow(
      `Unknown preset "nope" (looked in ${path.join(repoRoot, '.kunj', 'presets')}, ${path.join(globalKunjDir, 'presets')}, ${builtinDir})`
    );
  });

  it('resolvePresets finds the shipped presets by default', async () => {
    const presets = await resolvePresets(['apt', 'node'], { globalKunjDir: tmp() });
    expect(presets.map(p => p.source)).toEqual(['builtin', 'builtin']);
    expect(presets[0].path).toBe(path.join(builtinPresetsDir(), 'apt.sh'));
  });

  it('rejects names with / or ..', async () => {
    const opts = { globalKunjDir: tmp(), builtinDir: tmp() };
    for (const name of ['../etc/passwd', 'a/b', '..', '_lib', 'Node', '']) {
      await expect(resolvePresets([name], opts)).rejects.toThrow(/not a valid preset name/);
    }
  });

  it('presetEnv joins arrays and maps true to empty', () => {
    expect(presetEnv('apt', ['jq', 'git'], 'dev')).toEqual({ KUNJ_TOOL_NAME: 'apt', KUNJ_TOOL_VERSION: 'jq git', KUNJ_TOOL_USER: 'dev' });
    expect(presetEnv('bun', true, 'dev').KUNJ_TOOL_VERSION).toBe('');
    expect(presetEnv('node', '22', 'node').KUNJ_TOOL_VERSION).toBe('22');
  });

  posixOnly('runPresets streams script and env, runs as root, parses installed line, throws on failure', async () => {
    const preset = (name: string, text: string): Preset => ({ name, path: `/x/${name}.sh`, source: 'builtin', text, hash: 'h' });
    const presets = [preset('apt', 'echo apt\n'), preset('node', 'echo node\n')];
    const tools = { node: '22', apt: ['jq', "it's"] };
    const backend = new FakeBackend();
    backend.execResults.set(`cat ${PRESET_DIR}/apt.result`, { exitCode: 0, stdout: "apt jq it's\n" });
    backend.execResults.set(`cat ${PRESET_DIR}/node.result`, { exitCode: 0, stdout: 'node 22.12.0\n' });
    const out = new PassThrough();

    const installed = await runPresets(backend, 'c1', presets, tools, 'dev', { stdout: out, stderr: out });
    expect(installed).toEqual([{ name: 'apt', version: "jq it's" }, { name: 'node', version: '22.12.0' }]);

    const execs = backend.callsOf('exec') as Array<[string, string[], { user?: string; stdout?: unknown; env?: unknown }]>;
    // Everything runs as root, and nothing passes the environment on the command line
    expect(execs.every(([, , io]) => io.user === 'root' && io.env === undefined)).toBe(true);
    expect(execs.some(([, cmd]) => cmd.some(a => a.includes('KUNJ_TOOL_VERSION=')))).toBe(false);

    // The first exec extracts the scripts, _lib.sh and the env files into the preset dir
    expect(execs[0][1]).toEqual(['sh', '-c', expect.stringContaining('tar -xf -'), 'sh', PRESET_DIR]);
    const files = await untar(backend.stdinData[0]!);
    expect(Object.keys(files).sort()).toEqual(['_lib.sh', 'apt.env', 'apt.sh', 'node.env', 'node.sh']);
    expect(files['apt.sh']).toBe('echo apt\n');
    expect(files['_lib.sh']).toBe(fs.readFileSync(path.join(builtinPresetsDir(), '_lib.sh'), 'utf8'));
    expect(files['apt.env']).toBe("KUNJ_TOOL_NAME='apt'\nKUNJ_TOOL_USER='dev'\nKUNJ_TOOL_VERSION='jq it'\\''s'\n");

    // Each preset runs through the wrapper with the caller's output streams, then its result is read
    const runs = execs.filter(([, cmd]) => cmd[0] === 'sh' && cmd[2] && cmd[2].includes('exec sh'));
    expect(runs.map(([, cmd]) => cmd.slice(3))).toEqual([['sh', 'apt'], ['sh', 'node']]);
    expect(runs[0][2].stdout).toBe(out);
    expect(execs[execs.length - 1][1]).toEqual(['rm', '-rf', PRESET_DIR]);

    // The wrapper sources the env file exported, and runs the script with sh
    const wrapper = runs[0][1][2];
    const dir = tmp();
    write(path.join(dir, 'apt.env'), "KUNJ_TOOL_NAME='apt'\nKUNJ_TOOL_VERSION='jq it'\\''s'\nKUNJ_TOOL_USER='dev'\n");
    write(path.join(dir, 'apt.sh'), 'echo "$KUNJ_TOOL_NAME|$KUNJ_TOOL_VERSION|$KUNJ_TOOL_USER"\n');
    const r = spawnSync('sh', ['-c', wrapper.split(PRESET_DIR).join(dir), 'sh', 'apt'], { encoding: 'utf8' });
    expect(r.stdout).toBe("apt|jq it's|dev\n");

    // A failing preset stops the run with its exit code
    const failing = new FakeBackend();
    failing.execResults.set(runs[1][1].join(' '), { exitCode: 3, stdout: '' });
    await expect(runPresets(failing, 'c1', presets, tools, 'dev', {})).rejects.toThrow('preset node failed (exit 3)');
    expect(failing.callsOf('exec').pop()).toEqual(['c1', ['rm', '-rf', PRESET_DIR], { user: 'root' }]);
  });

  posixOnly('sh -n passes for every builtin script', () => {
    const scripts = fs.readdirSync(builtinPresetsDir()).filter(f => f.endsWith('.sh'));
    expect(scripts.sort()).toEqual(
      ['_lib.sh', 'apt.sh', 'bun.sh', 'go.sh', 'java.sh', 'node.sh', 'playwright.sh', 'pnpm.sh', 'python.sh', 'rust.sh', 'yarn.sh']
    );
    for (const f of scripts) {
      const r = spawnSync('sh', ['-n', path.join(builtinPresetsDir(), f)], { encoding: 'utf8' });
      expect({ f, status: r.status, stderr: r.stderr }).toEqual({ f, status: 0, stderr: '' });
    }
  });

  posixOnly('kunj_done records the result next to the script', () => {
    const dir = tmp();
    const r = spawnSync('sh', ['-c', `. ${path.join(builtinPresetsDir(), '_lib.sh')}; KUNJ_RESULT_DIR=${dir} kunj_done 1.2.3`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', KUNJ_TOOL_NAME: 'demo' },
    });
    expect(r.stdout).toBe('installed demo 1.2.3\n');
    expect(fs.readFileSync(path.join(dir, 'demo.result'), 'utf8')).toBe('demo 1.2.3\n');
  });
});
