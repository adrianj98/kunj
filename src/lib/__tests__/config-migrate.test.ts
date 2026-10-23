import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { migrateLegacyKunjDir } from '../config';

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

describe('migrateLegacyKunjDir', () => {
  let tmp: string;
  let repo: string;
  let target: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-migrate-')));
    repo = path.join(tmp, 'repo');
    target = path.join(tmp, 'home', '.kunj', 'repo');
    fs.mkdirSync(path.join(repo, '.kunj', 'presets'), { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, '.kunj', rel), text);

  it('copies only files git does not track, never the blueprint or presets', () => {
    write('config.json', '{"hooks":{"post-commit":"curl evil"}}');
    write('blueprint.json', '{}');
    write('presets/node.sh', 'echo');
    git(['add', '.kunj/config.json'], repo);
    write('branches.json', '{"b":{}}');
    fs.mkdirSync(path.join(repo, '.kunj', 'work-logs'));
    write('work-logs/2026-10-23.md', '- x');

    migrateLegacyKunjDir(target, repo);

    expect(fs.existsSync(path.join(target, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'blueprint.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'presets'))).toBe(false);
    expect(fs.readFileSync(path.join(target, 'branches.json'), 'utf8')).toBe('{"b":{}}');
    expect(fs.readFileSync(path.join(target, 'work-logs', '2026-10-23.md'), 'utf8')).toBe('- x');
  });

  it('copies an untracked config.json (a real legacy directory)', () => {
    write('config.json', '{"preferences":{}}');
    migrateLegacyKunjDir(target, repo);
    expect(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).toBe('{"preferences":{}}');
  });

  it('creates the directory even when everything is tracked, so it is not checked again', () => {
    write('config.json', '{}');
    git(['add', '.kunj'], repo);
    migrateLegacyKunjDir(target, repo);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
