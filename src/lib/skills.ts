// The Claude Code skills kunj ships (skills/<name>/ in the package), installed by `kunj install skill`
// into ~/.claude/skills/<name>/. A `.kunj-version` file marks a copy kunj wrote, so an update replaces
// it and a skill of the same name the user wrote is never overwritten without --force.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserError } from './errors';

export const KUNJ_SKILLS = ['handoff'] as const;
const MARKER = '.kunj-version';

// skills/ next to dist/ (and src/) in the package
export function packagedSkillsDir(): string {
  return path.resolve(__dirname, '..', '..', 'skills');
}

export function userSkillsDir(home = os.homedir()): string {
  return path.join(home, '.claude', 'skills');
}

export interface SkillInstallResult {
  name: string;
  path: string;
  replaced: boolean;
}

export function installSkill(name: string, opts: { version: string; force?: boolean; from?: string; to?: string }): SkillInstallResult {
  const source = path.join(opts.from ?? packagedSkillsDir(), name);
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new UserError(`The ${name} skill is missing from this kunj install (${source}).`, 'Reinstall kunj: npm i -g kunj');
  }
  const target = path.join(opts.to ?? userSkillsDir(), name);
  const exists = fs.existsSync(target);
  if (exists && !fs.existsSync(path.join(target, MARKER)) && !opts.force) {
    throw new UserError(`${target} exists and was not installed by kunj.`, 'Move it away, or run `kunj install skill --force` to replace it.');
  }
  if (exists) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  fs.writeFileSync(path.join(target, MARKER), `${opts.version}\n`);
  return { name, path: target, replaced: exists };
}
