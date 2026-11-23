import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PLAN_FILE_MAX, trimPlanFile } from '../agent';

test('an oversized plan record keeps its last lines whole; a small one is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-trim-'));
  const file = path.join(dir, 'p.ndjson');
  const line = (i: number) => JSON.stringify({ kunj: { t: i }, hook: { pad: 'x'.repeat(200) } });
  const lines = Array.from({ length: Math.ceil(PLAN_FILE_MAX / 200) + 100 }, (_, i) => line(i));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  trimPlanFile(file);
  const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  expect(fs.statSync(file).size).toBeLessThanOrEqual(PLAN_FILE_MAX / 2);
  expect(kept.every(l => JSON.parse(l).kunj)).toBe(true);
  expect(kept[kept.length - 1]).toBe(lines[lines.length - 1]);
  fs.writeFileSync(file, 'small\n');
  trimPlanFile(file);
  expect(fs.readFileSync(file, 'utf8')).toBe('small\n');
  fs.rmSync(dir, { recursive: true });
});
