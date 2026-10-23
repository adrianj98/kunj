import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repoIdentity, readOriginUrl } from '../repo-identity';
import { repoIdFromUrl } from '../container/names';
import { agentSessionName } from '../agent-session';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-ident-'));

test('reads origin from the config file without git', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'config'),
    '[core]\n\turl = nope\n[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = https://user:pw@github.com/acme/app.git\n[branch "main"]\n\turl = nope\n',
  );
  expect(readOriginUrl(dir)).toBe('https://user:pw@github.com/acme/app.git');
  const id = repoIdentity({ commonDir: dir, repoRoot: '/src/app-checkout' });
  expect(id).toMatchObject({ name: 'app', id: repoIdFromUrl('https://github.com/acme/app.git'), originUrl: 'https://github.com/acme/app.git' });
  expect(agentSessionName(id.name, id.id, 'feature-a')).toMatch(/^kunj-app-feature-a-/);
});

test('without an origin the name and id come from the repository root', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config'), '[core]\n\tbare = false\n');
  expect(repoIdentity({ commonDir: dir, repoRoot: '/src/shop.git' })).toMatchObject({ name: 'shop', id: repoIdFromUrl('/src/shop.git'), originUrl: '' });
  expect(repoIdentity({ commonDir: path.join(dir, 'missing'), repoRoot: '/src/shop' }).name).toBe('shop');
});
