// Installing the companion apps - the VS Code extension and the macOS menu
// bar app - from the GitHub release assets the release workflow attaches
// (kunj-worktrees-<version>.vsix and Kunj-macos-<version>.zip).

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const RELEASES_REPO = 'adrianj98/kunj';
export const VSCODE_EXTENSION_ID = 'kunj.kunj-worktrees';
export const MAC_APP_NAME = 'Kunj.app';

export type CompanionApp = 'vscode' | 'macos';

export const COMPANION_APPS: Record<CompanionApp, { label: string; asset: RegExp }> = {
  vscode: { label: 'VS Code extension (Kunj Worktrees)', asset: /^kunj-worktrees-.*\.vsix$/ },
  macos: { label: 'macOS menu bar app (Kunj.app)', asset: /^Kunj-macos-.*\.zip$/ },
};

export interface ReleaseAsset {
  tag: string;
  name: string;
  url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kunj-cli' },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

// Pick the asset for an app from a list of releases: the release for
// `version` when it has one, otherwise the newest release that does.
// Exposed for testing.
export function pickAsset(releases: GitHubRelease[], app: CompanionApp, version?: string): ReleaseAsset | null {
  const pattern = COMPANION_APPS[app].asset;
  const withAsset = releases
    .filter(r => !r.draft)
    .map(r => ({ release: r, asset: r.assets.find(a => pattern.test(a.name)) }))
    .filter(r => r.asset);
  const wanted = version ? withAsset.find(r => r.release.tag_name.replace(/^v/, '') === version.replace(/^v/, '')) : undefined;
  const chosen = wanted || withAsset[0];
  if (!chosen || !chosen.asset) return null;
  return { tag: chosen.release.tag_name, name: chosen.asset.name, url: chosen.asset.browser_download_url };
}

export async function findReleaseAsset(app: CompanionApp, version?: string): Promise<ReleaseAsset | null> {
  // Releases come newest first
  const releases = await githubJson<GitHubRelease[]>(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`);
  return pickAsset(releases, app, version);
}

export async function downloadAsset(asset: ReleaseAsset): Promise<string> {
  const response = await fetch(asset.url, { headers: { 'User-Agent': 'kunj-cli' } });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${asset.url}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-install-'));
  const file = path.join(dir, asset.name);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

// ---------------------------------------------------------------------------
// VS Code
// ---------------------------------------------------------------------------

// The editor CLI to install into: an explicit one, else `code`
export function editorCli(editor?: string): string {
  return (editor || 'code').trim().split(/\s+/)[0];
}

export async function isVscodeExtensionInstalled(editor?: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(editorCli(editor), ['--list-extensions'], { timeout: 20000 });
    return stdout.split('\n').some(line => line.trim().toLowerCase() === VSCODE_EXTENSION_ID);
  } catch {
    return null; // editor CLI not available
  }
}

export async function installVscodeExtension(vsixPath: string, editor?: string): Promise<void> {
  const cli = editorCli(editor);
  try {
    await execFileAsync(cli, ['--install-extension', vsixPath, '--force'], { timeout: 120000 });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `'${cli}' was not found. In VS Code run "Shell Command: Install 'code' command in PATH", or pass --editor <cli>`
      );
    }
    throw new Error((error?.stderr || error?.message || String(error)).trim());
  }
}

// ---------------------------------------------------------------------------
// macOS app
// ---------------------------------------------------------------------------

// /Applications when it is writable, otherwise ~/Applications
export function macAppDestination(): string {
  try {
    fs.accessSync('/Applications', fs.constants.W_OK);
    return '/Applications';
  } catch {
    return path.join(os.homedir(), 'Applications');
  }
}

export function installedMacApp(): string | null {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const candidate = path.join(dir, MAC_APP_NAME);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Unzip the app into place, replacing (and quitting) any existing copy,
// clear the download quarantine (the app is not notarized) and launch it.
export async function installMacApp(zipPath: string, options: { launch?: boolean } = {}): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('The menu bar app is only available on macOS');
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-app-'));
  await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, staging]);
  const built = path.join(staging, MAC_APP_NAME);
  if (!fs.existsSync(built)) {
    throw new Error(`${MAC_APP_NAME} not found in ${path.basename(zipPath)}`);
  }

  const destDir = installedMacApp() ? path.dirname(installedMacApp() as string) : macAppDestination();
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, MAC_APP_NAME);

  await execFileAsync('/usr/bin/pkill', ['-x', 'KunjBar']).catch(() => undefined);
  fs.rmSync(dest, { recursive: true, force: true });
  await execFileAsync('/usr/bin/ditto', [built, dest]);
  await execFileAsync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dest]).catch(() => undefined);
  fs.rmSync(staging, { recursive: true, force: true });

  if (options.launch !== false) {
    await execFileAsync('/usr/bin/open', [dest]).catch(() => undefined);
  }
  return dest;
}
