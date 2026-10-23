import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachedContainerUri, imageConfigFileName, imageConfigPaths, writeImageConfig } from '../editor';

describe('attachedContainerUri', () => {
  it('hex-encodes the container name with a leading slash', () => {
    const uri = attachedContainerUri('kunj-app-feat-1a2b');
    const match = /^vscode-remote:\/\/attached-container\+([0-9a-f]+)\/workspace$/.exec(uri);
    expect(match).not.toBeNull();
    expect(JSON.parse(Buffer.from(match![1], 'hex').toString('utf8'))).toEqual({ containerName: '/kunj-app-feat-1a2b' });
  });

  it('takes another folder', () => {
    expect(attachedContainerUri('c', '/srv')).toMatch(/\/srv$/);
  });
});

describe('imageConfigFileName', () => {
  // The Dev Containers extension (0.470.0) escapes only ':', '/' and '%' as %<lowercase hex>
  it('escapes : / and % the way the Dev Containers extension does', () => {
    expect(imageConfigFileName('kunj-sandbox:1.2.3-abc')).toBe('kunj-sandbox%3a1.2.3-abc.json');
    expect(imageConfigFileName('ghcr.io/acme/img:1%')).toBe('ghcr.io%2facme%2fimg%3a1%25.json');
    expect(imageConfigFileName('kunj-blueprint-app:0123abcd')).toBe('kunj-blueprint-app%3a0123abcd.json');
  });
});

describe('imageConfigPaths', () => {
  const tail = path.posix.join('User', 'globalStorage', 'ms-vscode-remote.remote-containers', 'imageConfigs');

  it('lists the VS Code and Cursor dirs on macOS', () => {
    expect(imageConfigPaths('/Users/me', 'darwin')).toEqual([
      path.posix.join('/Users/me/Library/Application Support/Code', tail),
      path.posix.join('/Users/me/Library/Application Support/Cursor', tail),
    ]);
  });

  it('lists the VS Code and Cursor dirs on Linux', () => {
    expect(imageConfigPaths('/home/me', 'linux')).toEqual([path.posix.join('/home/me/.config/Code', tail), path.posix.join('/home/me/.config/Cursor', tail)]);
  });

  it('uses AppData/Roaming on Windows', () => {
    const dirs = imageConfigPaths('C:\\Users\\me', 'win32');
    expect(dirs[0]).toBe('C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\ms-vscode-remote.remote-containers\\imageConfigs');
    expect(dirs[1]).toContain('\\Cursor\\');
  });
});

describe('writeImageConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-editor-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the directory and writes the config under the escaped image name', () => {
    const target = path.join(dir, 'imageConfigs');
    const file = writeImageConfig(target, 'kunj-sandbox:1.2.3-abc', { remoteUser: 'dev', workspaceFolder: '/workspace' });
    expect(file).toBe(path.join(target, 'kunj-sandbox%3a1.2.3-abc.json'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ remoteUser: 'dev', workspaceFolder: '/workspace' });
  });

  it("keeps the user's other keys and omits an empty remoteUser", () => {
    const file = path.join(dir, 'img%3a1.json');
    fs.writeFileSync(file, JSON.stringify({ extensions: ['dbaeumer.vscode-eslint'], remoteUser: 'old' }));
    writeImageConfig(dir, 'img:1', { workspaceFolder: '/workspace' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ extensions: ['dbaeumer.vscode-eslint'], workspaceFolder: '/workspace' });
  });

  it('leaves a file it cannot parse (JSON with comments) untouched', () => {
    const file = path.join(dir, 'img%3a1.json');
    const text = '{\n  // mine\n  "remoteUser": "me"\n}\n';
    fs.writeFileSync(file, text);
    writeImageConfig(dir, 'img:1', { remoteUser: 'dev', workspaceFolder: '/workspace' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});
