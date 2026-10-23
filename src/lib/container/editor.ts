// Attaching VS Code-like editors to a branch container (`kunj ct open`).
//
// The Dev Containers extension opens `vscode-remote://attached-container+<hex>/<folder>` and reads
// the user and folder for the container from its per-image "attached container configuration"
// (globalStorage/ms-vscode-remote.remote-containers/imageConfigs/<image>.json), so kunj writes that
// file before launching the editor. Plain fs/path only: this module is on the fast path.

import * as fs from 'fs';
import * as path from 'path';

const EXTENSION_ID = 'ms-vscode-remote.remote-containers';
// Editors that run the Dev Containers extension, by their user-data directory name
const EDITOR_DIRS = ['Code', 'Cursor'];

// The Dev Containers extension (checked in 0.470.0) copies the host's ~/.gitconfig, installs a git
// credential helper that answers from the host's credentials, and forwards the host's SSH agent and
// gpg-agent while a window is attached. The first two have settings; SSH and GPG forwarding have
// none (they follow SSH_AUTH_SOCK and the host's gpg-agent). kunj cannot change that, so it says so.
export const EDITOR_CREDENTIALS_WARNING =
  "While the editor is attached, the Dev Containers extension may forward your host's git credentials, " +
  'SSH agent and GPG agent into the container, where the agent can use them. Turn off the git ones with ' +
  '"dev.containers.copyGitConfig": false and "dev.containers.gitCredentialHelperConfigLocation": "none"; ' +
  'SSH and GPG agent forwarding have no setting (start the editor without SSH_AUTH_SOCK and gpg-agent to avoid them)';

export interface ImageConfig {
  remoteUser?: string;
  workspaceFolder: string;
}

export function attachedContainerUri(containerName: string, folder = '/workspace'): string {
  const hex = Buffer.from(JSON.stringify({ containerName: '/' + containerName }), 'utf8').toString('hex');
  return `vscode-remote://attached-container+${hex}${folder}`;
}

// The extension (checked against 0.470.0) names the file by escaping only ':', '/' and '%' as
// %<lowercase hex>, and decodes with a lowercase-only pattern: this is not encodeURIComponent.
export function imageConfigFileName(image: string): string {
  return image.replace(/[:/%]/g, c => `%${c.charCodeAt(0).toString(16)}`) + '.json';
}

/** The imageConfigs directories of VS Code and Cursor for this platform. */
export function imageConfigPaths(home: string, platform: NodeJS.Platform): string[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const base =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? join(home, 'AppData', 'Roaming')
        : join(home, '.config');
  return EDITOR_DIRS.map(dir => join(base, dir, 'User', 'globalStorage', EXTENSION_ID, 'imageConfigs'));
}

/**
 * Writes (merges) the attached-container config for `image` into `dir` and returns the file. Keys the
 * user added are kept; a file that is not plain JSON (the extension allows comments) is left alone.
 */
export function writeImageConfig(dir: string, image: string, cfg: ImageConfig): string {
  const file = path.join(dir, imageConfigFileName(image));
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return file;
      existing = parsed;
    } catch {
      return file;
    }
  }
  const { remoteUser: _old, ...rest } = existing;
  const merged = { ...rest, ...(cfg.remoteUser ? { remoteUser: cfg.remoteUser } : {}), workspaceFolder: cfg.workspaceFolder };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return file;
}
