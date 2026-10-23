import * as fs from 'fs';
import * as path from 'path';
import { Blueprint, KNOWN_LOCKFILES, TOOL_WORD } from './blueprint';

export interface Inferred {
  tools: Blueprint['tools'];
  setup: string[];
  maintain: string[];
  lockfiles: string[];
  reasons: string[];
}

function read(root: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join(root, name), 'utf8');
  } catch {
    return null;
  }
}

const has = (root: string, name: string): boolean => fs.existsSync(path.join(root, name));

/**
 * Lowest node major a range allows and whether `imageMajor` satisfies it. Major granularity only:
 * handles >=, >, <, <=, ^, ~, exact, x/*, space-joined comparators and ||.
 */
function nodeRange(range: string, imageMajor: number): { lowest?: number; satisfied: boolean } | null {
  let lowest: number | undefined;
  let satisfied = false;
  for (const alt of range.split('||')) {
    const parts = alt.trim().replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    let altLow: number | undefined;
    let ok = true;
    for (const part of parts) {
      const m = /^(>=|<=|>|<|\^|~|=)?v?(\d+|[xX*])?(?:\.[\dxX*]+)*(?:-.*)?$/.exec(part);
      if (!m) return null;
      const op = m[1] ?? '';
      if (m[2] === undefined || /[xX*]/.test(m[2])) continue;
      const n = Number(m[2]);
      if (op === '<') ok = ok && imageMajor < n;
      else if (op === '<=') ok = ok && imageMajor <= n;
      else if (op === '>') { ok = ok && imageMajor >= n; altLow = Math.max(altLow ?? 0, n); }
      else if (op === '>=') { ok = ok && imageMajor >= n; altLow = Math.max(altLow ?? 0, n); }
      else { ok = ok && imageMajor === n; altLow = Math.max(altLow ?? 0, n); }
    }
    satisfied = satisfied || ok;
    if (altLow !== undefined) lowest = lowest === undefined ? altLow : Math.min(lowest, altLow);
  }
  return { lowest, satisfied };
}

const ASDF_NAMES: Record<string, string> = {
  nodejs: 'node', node: 'node', golang: 'go', go: 'go', python: 'python', rust: 'rust',
  java: 'java', bun: 'bun', yarn: 'yarn', pnpm: 'pnpm',
};

export function inferBlueprint(repoRoot: string, imageNodeMajor = 22): Inferred {
  const tools: Blueprint['tools'] = {};
  const installs: string[] = [];
  const builds: string[] = [];
  const reasons: string[] = [];

  const lockfiles = KNOWN_LOCKFILES.filter(f => has(repoRoot, f));

  // JavaScript
  const nvm = has(repoRoot, '.nvmrc') ? '.nvmrc' : has(repoRoot, '.node-version') ? '.node-version' : null;
  const pkgText = read(repoRoot, 'package.json');
  let pkg: Record<string, any> | null = null;
  if (pkgText !== null) {
    try {
      const parsed = JSON.parse(pkgText);
      if (parsed && typeof parsed === 'object') pkg = parsed;
    } catch {
      reasons.push('package.json is not valid JSON; skipped');
    }
  }
  if (pkg) {
    let pm: string | undefined;
    let pmVersion = '';
    const field = typeof pkg.packageManager === 'string' ? /^(yarn|pnpm|bun|npm)@(.*)$/.exec(pkg.packageManager) : null;
    if (field) {
      pm = field[1];
      pmVersion = field[2];
      reasons.push(`packageManager ${pkg.packageManager} → ${pm}`);
    } else if (has(repoRoot, 'yarn.lock')) pm = 'yarn';
    else if (has(repoRoot, 'pnpm-lock.yaml')) pm = 'pnpm';
    else if (has(repoRoot, 'bun.lock') || has(repoRoot, 'bun.lockb')) pm = 'bun';
    else if (has(repoRoot, 'package-lock.json')) pm = 'npm';
    if (pm && !field) reasons.push(`lockfile found → ${pm}`);

    if (pm) {
      let install: string;
      if (pm === 'yarn') {
        const classic = field ? pmVersion.startsWith('1') : !(read(repoRoot, 'yarn.lock') ?? '').includes('__metadata');
        install = classic ? 'yarn install --frozen-lockfile' : 'yarn install --immutable';
      } else if (pm === 'pnpm') install = 'pnpm install --frozen-lockfile';
      else if (pm === 'bun') install = 'bun install --frozen-lockfile';
      else install = 'npm ci';
      installs.push(install);
      reasons.push(`${pm}: install with \`${install}\``);
      if (pm === 'yarn' || pm === 'pnpm') {
        tools[pm] = 'corepack';
        reasons.push(`${pm}: provided by corepack`);
      } else if (pm === 'bun') {
        tools.bun = true;
        reasons.push('bun: installed by the bun preset');
      }
      if (pkg.scripts && typeof pkg.scripts === 'object' && typeof pkg.scripts.build === 'string') {
        const build = pm === 'yarn' || pm === 'pnpm' ? `${pm} build` : `${pm} run build`;
        builds.push(build);
        reasons.push(`package.json has a build script → \`${build}\` in setup`);
      }
    }

    // Node version
    const engines = pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node : null;
    if (!nvm && engines) {
      const r = nodeRange(engines, imageNodeMajor);
      if (!r) reasons.push(`engines.node "${engines}" not understood; node left to the image`);
      else if (r.satisfied) reasons.push(`engines.node "${engines}" is satisfied by the image's node ${imageNodeMajor}; node omitted`);
      else if (r.lowest !== undefined) {
        tools.node = String(r.lowest);
        reasons.push(`engines.node "${engines}" → node: ${r.lowest}`);
      }
    }

    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('@playwright/test' in deps || 'playwright' in deps) {
      tools.playwright = true;
      reasons.push('playwright in package.json → playwright: true');
    }
    // A supabase/ directory means the project uses the Supabase CLI (migrations, gen types)
    if (fs.existsSync(path.join(repoRoot, 'supabase', 'config.toml'))) {
      tools.supabase = 'latest';
      reasons.push('supabase/config.toml → supabase: latest');
    }
  }
  if (nvm) {
    tools.node = 'nvmrc';
    reasons.push(`${nvm} → node: nvmrc`);
  }

  // Python
  const pyproject = read(repoRoot, 'pyproject.toml');
  if (pyproject !== null && /^\s*\[tool\.poetry[\].]/m.test(pyproject)) {
    installs.push('poetry install');
    reasons.push('pyproject.toml has [tool.poetry] → `poetry install`');
  } else if (pyproject !== null && has(repoRoot, 'uv.lock')) {
    installs.push('uv sync');
    reasons.push('pyproject.toml with uv.lock → `uv sync`');
  } else if (has(repoRoot, 'requirements.txt')) {
    installs.push('pip install -r requirements.txt');
    reasons.push('requirements.txt → `pip install -r requirements.txt`');
  }
  const pyVersion = (read(repoRoot, '.python-version') ?? '').trim().match(/^(\d+\.\d+)/);
  const requires = pyproject !== null ? /requires-python\s*=\s*["']\s*>=\s*(\d+\.\d+)/.exec(pyproject) : null;
  if (pyVersion) {
    tools.python = pyVersion[1];
    reasons.push(`.python-version → python: ${pyVersion[1]}`);
  } else if (requires) {
    tools.python = requires[1];
    reasons.push(`requires-python >=${requires[1]} → python: ${requires[1]}`);
  }

  // Go
  const gomod = read(repoRoot, 'go.mod');
  if (gomod !== null) {
    installs.push('go mod download');
    reasons.push('go.mod → `go mod download`');
    const g = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(gomod);
    if (g) {
      tools.go = g[1];
      reasons.push(`go.mod go ${g[1]} → go: ${g[1]}`);
    }
  }

  // Rust
  if (has(repoRoot, 'Cargo.toml')) {
    installs.push('cargo fetch');
    reasons.push('Cargo.toml → `cargo fetch`');
  }
  const toolchainFile = has(repoRoot, 'rust-toolchain.toml') ? 'rust-toolchain.toml' : has(repoRoot, 'rust-toolchain') ? 'rust-toolchain' : null;
  if (toolchainFile) {
    const text = read(repoRoot, toolchainFile) ?? '';
    const channel = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? (/^\s*([A-Za-z0-9._-]+)\s*$/.exec(text)?.[1]);
    if (channel && TOOL_WORD.test(channel)) {
      tools.rust = channel;
      reasons.push(`${toolchainFile} → rust: ${channel}`);
    }
  }

  // Ruby
  if (has(repoRoot, 'Gemfile')) {
    installs.push('bundle install');
    reasons.push('Gemfile → `bundle install`');
  }

  // asdf
  const asdf = read(repoRoot, '.tool-versions');
  if (asdf !== null) {
    for (const raw of asdf.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const [name, version] = line.split(/\s+/);
      const preset = Object.hasOwn(ASDF_NAMES, name) ? ASDF_NAMES[name] : undefined;
      if (!preset || !version || !TOOL_WORD.test(version)) {
        reasons.push(`.tool-versions: ${name} is not supported; install it by hand`);
      } else if (tools[preset] !== undefined) {
        reasons.push(`.tool-versions: ${name} ${version} ignored; ${preset} already set`);
      } else {
        tools[preset] = version;
        reasons.push(`.tool-versions ${name} ${version} → ${preset}: ${version}`);
      }
    }
  }

  // Makefile
  const make = read(repoRoot, 'Makefile');
  if (make !== null) {
    const target = /^(setup|install)\s*:/m.exec(make)?.[1];
    if (target) reasons.push(`Makefile has a \`${target}\` target; use \`make ${target}\` instead if you prefer`);
  }

  if (installs.length === 0 && builds.length === 0 && Object.keys(tools).length === 0) {
    return { tools, setup: [], maintain: [], lockfiles, reasons: ['nothing recognised; fill in setup by hand', ...reasons] };
  }
  return { tools, setup: [...installs, ...builds], maintain: installs, lockfiles, reasons };
}
