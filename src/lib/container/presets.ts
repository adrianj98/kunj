// Presets: root-run tool installers named by a blueprint's `tools`. Each is a POSIX sh script that
// sources the built-in _lib.sh and ends with `kunj_done <version>`.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ContainerBackend, ExecIO } from './backend';
import { Blueprint, ToolValue } from './blueprint';
import { tarEntries } from './image';
import { shellQuote } from '../config-vars';

export interface Preset {
  name: string;
  path: string;
  source: 'repo' | 'host' | 'builtin';
  text: string;
  hash: string;
}

/** apt first, then runtimes, then the package managers and tools that need a runtime. */
export const PRESET_ORDER = ['apt', 'node', 'python', 'go', 'rust', 'java', 'yarn', 'pnpm', 'bun', 'playwright'];

/** Where scripts, _lib.sh, env files and results go inside the container while presets run. */
export const PRESET_DIR = '/tmp/kunj-presets';

const NAME = /^[a-z0-9-]+$/;

/** dist/container/presets from dist/lib/container, src/container/presets under ts-jest. */
export function builtinPresetsDir(): string {
  return path.join(__dirname, '..', '..', 'container', 'presets');
}

export function orderTools(tools: Blueprint['tools']): string[] {
  const names = Object.keys(tools);
  return [...PRESET_ORDER.filter(n => names.includes(n)), ...names.filter(n => !PRESET_ORDER.includes(n))];
}

export async function resolvePresets(
  names: string[],
  // repoRoot is the host checkout, not origin: a repo preset is whatever is on disk here, unlike the
  // blueprint's lockfiles, which are read at origin/<default>.
  opts: { repoRoot?: string; globalKunjDir: string; builtinDir?: string }
): Promise<Preset[]> {
  const dirs: Array<[Preset['source'], string]> = [];
  if (opts.repoRoot) dirs.push(['repo', path.join(opts.repoRoot, '.kunj', 'presets')]);
  dirs.push(['host', path.join(opts.globalKunjDir, 'presets')]);
  dirs.push(['builtin', opts.builtinDir ?? builtinPresetsDir()]);

  // Every preset sources _lib.sh, so a change to it changes every preset's hash
  const lib = await fs.promises.readFile(path.join(builtinPresetsDir(), '_lib.sh'), 'utf8');
  const presets: Preset[] = [];
  for (const name of names) {
    // Validate before any path join: the name comes from blueprint.json
    if (!NAME.test(name)) throw new Error(`"${name}" is not a valid preset name (use a-z, 0-9 and -)`);
    let found: Preset | undefined;
    for (const [source, dir] of dirs) {
      const file = path.join(dir, `${name}.sh`);
      let text: string;
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch {
        continue;
      }
      found = { name, path: file, source, text, hash: presetHash(lib, text) };
      break;
    }
    if (!found) throw new Error(`Unknown preset "${name}" (looked in ${dirs.map(d => d[1]).join(', ')})`);
    presets.push(found);
  }
  return presets;
}

/** 12 hex of sha1 over the built-in _lib.sh and the preset's own text. */
export function presetHash(lib: string, text: string): string {
  return createHash('sha1').update(lib).update('\0').update(text).digest('hex').slice(0, 12);
}

export function presetEnv(name: string, value: ToolValue, user: string): Record<string, string> {
  const version = value === true ? '' : Array.isArray(value) ? value.join(' ') : value;
  return { KUNJ_TOOL_NAME: name, KUNJ_TOOL_VERSION: version, KUNJ_TOOL_USER: user };
}

function envFile(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map(k => `${k}=${shellQuote(env[k])}\n`)
    .join('');
}

// The environment goes through a file rather than `exec -e`, which would show it in `ps`.
// $1 is the preset name; kunj_done writes $1.result, so a stale one is removed first.
const WRAPPER =
  `cd ${PRESET_DIR} && rm -f "$1.result" && set -a && . "./$1.env" && set +a && exec sh "${PRESET_DIR}/$1.sh"`;

/** Run each preset as root in order; returns what each reported through kunj_done. */
export async function runPresets(
  backend: ContainerBackend,
  id: string,
  presets: Preset[],
  tools: Blueprint['tools'],
  user: string,
  io: ExecIO,
  warn: (msg: string) => void = msg => process.stderr.write(`${msg}\n`)
): Promise<Array<{ name: string; version: string }>> {
  const lib = fs.readFileSync(path.join(builtinPresetsDir(), '_lib.sh'));
  const entries = [{ path: '_lib.sh', content: lib, mode: 0o644 }];
  for (const p of presets) {
    entries.push({ path: `${p.name}.sh`, content: Buffer.from(p.text), mode: 0o755 });
    entries.push({ path: `${p.name}.env`, content: Buffer.from(envFile(presetEnv(p.name, tools[p.name] ?? true, user))), mode: 0o600 });
  }

  const installed: Array<{ name: string; version: string }> = [];
  try {
    const x = await backend.exec(
      id,
      ['sh', '-c', 'rm -rf "$1" && mkdir -m 700 -p "$1" && tar -xf - -C "$1"', 'sh', PRESET_DIR],
      { user: 'root', stdin: tarEntries(entries) }
    );
    if (x.exitCode !== 0) throw new Error(`Copying presets into the container failed (exit ${x.exitCode})`);

    for (const p of presets) {
      const r = await backend.exec(id, ['sh', '-c', WRAPPER, 'sh', p.name], {
        user: 'root',
        stdin: 'ignore',
        stdout: io.stdout ?? 'inherit',
        stderr: io.stderr ?? 'inherit',
      });
      if (r.exitCode !== 0) throw new Error(`preset ${p.name} failed (exit ${r.exitCode})`);
      // Written by kunj_done as "<name> <version>". A preset that skipped kunj_done still installed
      // something, so it is a warning with an empty version rather than a failure.
      const result = await backend.exec(id, ['cat', `${PRESET_DIR}/${p.name}.result`], { user: 'root' });
      const m = /^(\S+) (.*)$/.exec(result.exitCode === 0 ? result.stdout.trim() : '');
      if (!m) warn(`preset ${p.name} did not report its version (it should end with kunj_done <version>)`);
      installed.push({ name: p.name, version: m ? m[2] : '' });
    }
  } finally {
    // Keep the scripts out of the snapshot that is committed next
    await backend.exec(id, ['rm', '-rf', PRESET_DIR], { user: 'root' }).catch(() => undefined);
  }
  return installed;
}
