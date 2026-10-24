import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkRemoteName, checkRemoteUrl, checkSshDestination, checkToken, describeRemote, readRemotes, requireRemote, writeRemotes } from '../remotes';

describe('remotes.json', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-remotes-'));
    file = path.join(dir, '.kunj', 'remotes.json');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is empty when missing, round-trips, and is written 0600 with no temp file left', () => {
    expect(readRemotes(file)).toEqual({});
    const remotes = { box: { ssh: 'me@box', port: 7433, token: 't', addedAt: '2026-10-24T00:00:00Z' } };
    writeRemotes(remotes, file);
    expect(readRemotes(file)).toEqual(remotes);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['remotes.json']);
  });

  it('refuses a file that is not an object of remotes', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]');
    expect(() => readRemotes(file)).toThrow(/object of remotes/);
    fs.writeFileSync(file, '{');
    expect(() => readRemotes(file)).toThrow(/not valid JSON/);
  });

  it('requireRemote names the file for an unknown name', () => {
    expect(() => requireRemote('nope', file)).toThrow(expect.objectContaining({ code: 'remote-unknown', message: expect.stringContaining(file) }));
  });
});

describe('remote validation', () => {
  it('names', () => {
    for (const ok of ['box', 'ci-1', 'a.b_c', 'X'.repeat(32)]) expect(() => checkRemoteName(ok)).not.toThrow();
    for (const bad of ['', '-x', 'a b', 'X'.repeat(33), 'local', 'é']) expect(() => checkRemoteName(bad)).toThrow(expect.objectContaining({ code: 'bad-remote' }));
  });

  it('urls: https anywhere, http only to loopback', () => {
    expect(checkRemoteUrl('https://box.example/kunj').protocol).toBe('https:');
    expect(checkRemoteUrl('http://127.0.0.1:7433').hostname).toBe('127.0.0.1');
    expect(checkRemoteUrl('http://localhost:7433').hostname).toBe('localhost');
    expect(checkRemoteUrl('http://[::1]:7433').hostname).toBe('[::1]');
    expect(() => checkRemoteUrl('http://10.0.0.5:7433')).toThrow(/only accepted to a loopback address/);
    expect(() => checkRemoteUrl('http://box.local:7433')).toThrow(/--ssh/);
    expect(() => checkRemoteUrl('ftp://box')).toThrow(/http/);
    expect(() => checkRemoteUrl('box:7433')).toThrow(expect.objectContaining({ code: 'bad-remote' }));
  });

  it('ssh destinations and tokens', () => {
    expect(() => checkSshDestination('me@box')).not.toThrow();
    expect(() => checkSshDestination('box')).not.toThrow();
    expect(() => checkSshDestination('-oProxyCommand=x')).toThrow(/SSH destination/);
    expect(() => checkSshDestination('me@box extra')).toThrow(/SSH destination/);
    expect(() => checkToken('abc')).not.toThrow();
    expect(() => checkToken('')).toThrow(/one word/);
    expect(() => checkToken('a b')).toThrow(/one word/);
  });

  it('describes a remote without its token', () => {
    expect(describeRemote({ ssh: 'me@box', token: 'secret', addedAt: '' })).toBe('ssh me@box (port 7433)');
    expect(describeRemote({ ssh: 'me@box', port: 9000, token: 'secret', addedAt: '' })).toBe('ssh me@box (port 9000)');
    expect(describeRemote({ url: 'https://box.example', token: 'secret', addedAt: '' })).toBe('https://box.example');
  });
});
