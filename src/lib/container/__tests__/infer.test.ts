import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inferBlueprint } from '../infer';

const dirs: string[] = [];
function repo(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-infer-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

function core(i: ReturnType<typeof inferBlueprint>) {
  const { reasons: _r, ...rest } = i;
  return rest;
}
const hasReason = (i: ReturnType<typeof inferBlueprint>, text: string) =>
  expect(i.reasons.some(r => r.includes(text))).toBe(true);

describe('inferBlueprint', () => {
  it('npm with a build script', () => {
    const i = inferBlueprint(repo({ 'package.json': { scripts: { build: 'tsc' } }, 'package-lock.json': '{}' }));
    expect(core(i)).toEqual({ tools: {}, setup: ['npm ci', 'npm run build'], maintain: ['npm ci'], lockfiles: ['package-lock.json'] });
    hasReason(i, 'npm ci');
  });

  it('yarn berry via corepack with engines >=24.2', () => {
    const i = inferBlueprint(repo({
      'package.json': { packageManager: 'yarn@4.6.0+sha512.abc', engines: { node: '>=24.2' }, scripts: { build: 'x' } },
      'yarn.lock': '__metadata:\n',
    }));
    expect(core(i)).toEqual({
      tools: { yarn: 'corepack', node: '24' },
      setup: ['yarn install --immutable', 'yarn build'],
      maintain: ['yarn install --immutable'],
      lockfiles: ['yarn.lock'],
    });
    hasReason(i, 'packageManager yarn@4.6.0');
  });

  it('yarn 1 uses frozen-lockfile', () => {
    const i = inferBlueprint(repo({ 'package.json': { packageManager: 'yarn@1.22.19' }, 'yarn.lock': '' }));
    expect(core(i)).toEqual({
      tools: { yarn: 'corepack' },
      setup: ['yarn install --frozen-lockfile'],
      maintain: ['yarn install --frozen-lockfile'],
      lockfiles: ['yarn.lock'],
    });
  });

  it('yarn.lock without packageManager: berry by __metadata, else classic', () => {
    const berry = inferBlueprint(repo({ 'package.json': {}, 'yarn.lock': '__metadata:\n  version: 8\n' }));
    expect(core(berry)).toEqual({
      tools: { yarn: 'corepack' }, setup: ['yarn install --immutable'], maintain: ['yarn install --immutable'], lockfiles: ['yarn.lock'],
    });
    const classic = inferBlueprint(repo({ 'package.json': {}, 'yarn.lock': '# yarn lockfile v1\n' }));
    expect(core(classic)).toEqual({
      tools: { yarn: 'corepack' },
      setup: ['yarn install --frozen-lockfile'],
      maintain: ['yarn install --frozen-lockfile'],
      lockfiles: ['yarn.lock'],
    });
  });

  it('bun.lockb', () => {
    const i = inferBlueprint(repo({ 'package.json': {}, 'bun.lockb': '' }));
    expect(core(i)).toEqual({
      tools: { bun: true }, setup: ['bun install --frozen-lockfile'], maintain: ['bun install --frozen-lockfile'], lockfiles: ['bun.lockb'],
    });
  });

  it('malformed package.json does not throw', () => {
    const i = inferBlueprint(repo({ 'package.json': '{ nope' }));
    expect(core(i)).toEqual({ tools: {}, setup: [], maintain: [], lockfiles: [] });
    hasReason(i, 'package.json is not valid JSON; skipped');
  });

  it('.nvmrc is honoured with a malformed package.json', () => {
    const i = inferBlueprint(repo({ 'package.json': '{ nope', '.nvmrc': '20\n' }));
    expect(core(i)).toEqual({ tools: { node: 'nvmrc' }, setup: [], maintain: [], lockfiles: [] });
    hasReason(i, 'package.json is not valid JSON; skipped');
  });

  it('.node-version', () => {
    const i = inferBlueprint(repo({ 'package.json': {}, 'package-lock.json': '', '.node-version': '20.1.0\n' }));
    expect(core(i)).toEqual({ tools: { node: 'nvmrc' }, setup: ['npm ci'], maintain: ['npm ci'], lockfiles: ['package-lock.json'] });
    hasReason(i, '.node-version → node: nvmrc');
  });

  it('engines ranges: ">=18 <21" and "18.x" give 18', () => {
    expect(inferBlueprint(repo({ 'package.json': { engines: { node: '>=18 <21' } } })).tools).toEqual({ node: '18' });
    expect(inferBlueprint(repo({ 'package.json': { engines: { node: '18.x' } } })).tools).toEqual({ node: '18' });
  });

  it('.tool-versions ignores prototype names', () => {
    const i = inferBlueprint(repo({ '.tool-versions': 'constructor 1.0\ntoString 2.0\n' }));
    expect(core(i)).toEqual({ tools: {}, setup: [], maintain: [], lockfiles: [] });
    hasReason(i, 'constructor is not supported');
  });

  it('pnpm from the lockfile', () => {
    const i = inferBlueprint(repo({ 'package.json': { scripts: { build: 'x' } }, 'pnpm-lock.yaml': '' }));
    expect(core(i)).toEqual({
      tools: { pnpm: 'corepack' },
      setup: ['pnpm install --frozen-lockfile', 'pnpm build'],
      maintain: ['pnpm install --frozen-lockfile'],
      lockfiles: ['pnpm-lock.yaml'],
    });
    hasReason(i, 'lockfile');
  });

  it('bun', () => {
    const i = inferBlueprint(repo({ 'package.json': { scripts: { build: 'x' } }, 'bun.lock': '' }));
    expect(core(i)).toEqual({
      tools: { bun: true },
      setup: ['bun install --frozen-lockfile', 'bun run build'],
      maintain: ['bun install --frozen-lockfile'],
      lockfiles: ['bun.lock'],
    });
  });

  it('.nvmrc wins over engines', () => {
    const i = inferBlueprint(repo({ 'package.json': { engines: { node: '^20' } }, 'package-lock.json': '', '.nvmrc': '20\n' }));
    expect(core(i)).toEqual({ tools: { node: 'nvmrc' }, setup: ['npm ci'], maintain: ['npm ci'], lockfiles: ['package-lock.json'] });
    hasReason(i, '.nvmrc → node: nvmrc');
  });

  it('kunj-like: engines >=18 is satisfied by the image so node is omitted', () => {
    const i = inferBlueprint(repo({ 'package.json': { engines: { node: '>=18' }, scripts: { build: 'tsc' } }, 'package-lock.json': '' }));
    expect(i.tools).toEqual({});
    hasReason(i, 'omitted');
  });

  it('engines ^20 with image 22 pins node 20; "20 || 22" is satisfied so node is omitted', () => {
    expect(inferBlueprint(repo({ 'package.json': { engines: { node: '^20' } } })).tools).toEqual({ node: '20' });
    expect(inferBlueprint(repo({ 'package.json': { engines: { node: '20 || 22' } } })).tools).toEqual({});
    expect(inferBlueprint(repo({ 'package.json': { engines: { node: '20 || 24' } } }), 23).tools).toEqual({ node: '20' });
    expect(inferBlueprint(repo({ 'package.json': { engines: { node: '*' } } })).tools).toEqual({});
  });

  it('poetry', () => {
    const i = inferBlueprint(repo({ 'pyproject.toml': '[tool.poetry]\nname="x"\n', 'poetry.lock': '' }));
    expect(core(i)).toEqual({ tools: {}, setup: ['poetry install'], maintain: ['poetry install'], lockfiles: ['poetry.lock'] });
  });

  it('uv with requires-python', () => {
    const i = inferBlueprint(repo({ 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n', 'uv.lock': '' }));
    expect(core(i)).toEqual({ tools: { python: '3.11' }, setup: ['uv sync'], maintain: ['uv sync'], lockfiles: ['uv.lock'] });
  });

  it('pip with .python-version', () => {
    const i = inferBlueprint(repo({ 'requirements.txt': 'x\n', '.python-version': '3.12.4\n' }));
    expect(core(i)).toEqual({
      tools: { python: '3.12' },
      setup: ['pip install -r requirements.txt'],
      maintain: ['pip install -r requirements.txt'],
      lockfiles: [],
    });
  });

  it('go', () => {
    const i = inferBlueprint(repo({ 'go.mod': 'module x\n\ngo 1.22\n', 'go.sum': '' }));
    expect(core(i)).toEqual({ tools: { go: '1.22' }, setup: ['go mod download'], maintain: ['go mod download'], lockfiles: ['go.sum'] });
  });

  it('cargo with a toolchain channel', () => {
    const i = inferBlueprint(repo({ 'Cargo.toml': '', 'Cargo.lock': '', 'rust-toolchain.toml': '[toolchain]\nchannel = "1.80"\n' }));
    expect(core(i)).toEqual({ tools: { rust: '1.80' }, setup: ['cargo fetch'], maintain: ['cargo fetch'], lockfiles: ['Cargo.lock'] });
  });

  it('bundler', () => {
    const i = inferBlueprint(repo({ Gemfile: '', 'Gemfile.lock': '' }));
    expect(core(i)).toEqual({ tools: {}, setup: ['bundle install'], maintain: ['bundle install'], lockfiles: ['Gemfile.lock'] });
  });

  it('.tool-versions maps known names and reports the rest', () => {
    const i = inferBlueprint(repo({ '.tool-versions': 'nodejs 20.11.0\ngolang 1.22.1 # comment\nterraform 1.7.0\n' }));
    expect(core(i)).toEqual({ tools: { node: '20.11.0', go: '1.22.1' }, setup: [], maintain: [], lockfiles: [] });
    hasReason(i, 'terraform is not supported');
  });

  it('playwright', () => {
    const i = inferBlueprint(repo({
      'package.json': { packageManager: 'pnpm@9.1.0', devDependencies: { '@playwright/test': '^1' } },
      'pnpm-lock.yaml': '',
    }));
    expect(i.tools).toEqual({ pnpm: 'corepack', playwright: true });
    hasReason(i, 'playwright');
  });

  it('suggests a Makefile setup target without choosing it', () => {
    const i = inferBlueprint(repo({ Makefile: 'setup:\n\techo hi\n' }));
    expect(i.setup).toEqual([]);
    hasReason(i, 'Makefile has a `setup` target; use `make setup` instead if you prefer');
  });

  it('empty repo', () => {
    expect(inferBlueprint(repo({}))).toEqual({
      tools: {}, setup: [], maintain: [], lockfiles: [], reasons: ['nothing recognised; fill in setup by hand'],
    });
  });
});
