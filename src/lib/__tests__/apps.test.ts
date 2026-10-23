import { describe, it, expect, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installMacApp, installedMacApp, pickAsset } from '../apps';

const release = (tag: string, names: string[], draft = false) => ({
  tag_name: tag,
  draft,
  assets: names.map(name => ({ name, browser_download_url: `https://example.test/${tag}/${name}` })),
});

describe('pickAsset', () => {
  const releases = [
    release('v1.3.0', ['kunj-worktrees-1.3.0.vsix'], true),
    release('v1.2.0', ['kunj-worktrees-1.2.0.vsix', 'Kunj-macos-1.2.0.zip', 'Kunj-workspace-1.2.0.zip']),
    release('v1.1.0', ['kunj-worktrees-1.1.0.vsix', 'Kunj-macos-1.1.0.zip', 'Kunj-workspace-1.1.0.zip']),
  ];

  it('prefers the release matching the CLI version', () => {
    expect(pickAsset(releases, 'vscode', '1.1.0')?.name).toBe('kunj-worktrees-1.1.0.vsix');
  });

  it('falls back to the newest published release with the asset', () => {
    expect(pickAsset(releases.slice(0, 2), 'macos', '1.1.0')).toMatchObject({ tag: 'v1.2.0', name: 'Kunj-macos-1.2.0.zip' });
    expect(pickAsset(releases, 'vscode')?.tag).toBe('v1.2.0'); // skips the draft
  });

  it('returns null when no release has the asset', () => {
    expect(pickAsset([release('v1.0.0', ['other.tgz'])], 'macos')).toBeNull();
    expect(pickAsset([release('v1.0.0', ['Kunj-macos-1.0.0.zip'])], 'workspace')).toBeNull();
  });

  it('finds the workspace zip of the matching release', () => {
    expect(pickAsset(releases, 'workspace', '1.1.0')).toMatchObject({ tag: 'v1.1.0', name: 'Kunj-workspace-1.1.0.zip' });
    expect(pickAsset(releases, 'macos', '1.1.0')?.name).toBe('Kunj-macos-1.1.0.zip');
  });
});

const onMac = process.platform === 'darwin' ? describe : describe.skip;

onMac('installMacApp', () => {
  const temps: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-apps-test-'));
    temps.push(dir);
    return dir;
  };
  afterEach(() => temps.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

  // A zip holding "<app>/Contents/Info.plist", as ditto -c -k --keepParent makes it
  const zipOf = (app: string): string => {
    const stage = tempDir();
    fs.mkdirSync(path.join(stage, app, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(stage, app, 'Contents', 'Info.plist'), '<plist/>');
    const zip = path.join(tempDir(), 'app.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(stage, app), zip]);
    return zip;
  };

  it('installs to the app name given', async () => {
    const apps = tempDir();
    const dest = await installMacApp(zipOf('Kunj Workspace.app'), {
      app: 'Kunj Workspace.app', launch: false, quit: false, dirs: [apps],
    });
    expect(dest).toBe(path.join(apps, 'Kunj Workspace.app'));
    expect(fs.existsSync(path.join(dest, 'Contents', 'Info.plist'))).toBe(true);
    expect(fs.existsSync(path.join(apps, 'Kunj.app'))).toBe(false);
    expect(installedMacApp('Kunj Workspace.app', [apps])).toBe(dest);
    expect(installedMacApp('Kunj.app', [apps])).toBeNull();
  });

  it('refuses a zip without the app named', async () => {
    await expect(
      installMacApp(zipOf('Kunj.app'), { app: 'Kunj Workspace.app', launch: false, quit: false, dirs: [tempDir()] })
    ).rejects.toThrow('Kunj Workspace.app not found');
  });
});
