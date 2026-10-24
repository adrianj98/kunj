import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KunjConfig } from '../../../types';
import { GhRunner, TokenLookup, ghAuthToken, ghKnowsHost, githubTokenSource, withHostTokens } from '../tokens';

function lookup(token: string | null = 'gho_fromgh', known: string[] = []): TokenLookup & { gh: jest.Mock } {
  return {
    gh: jest.fn(async (_host: string) => token) as any,
    ghKnowsHost: (host: string) => known.includes(host),
  };
}

const cfg = (over: NonNullable<KunjConfig['container']> = {}): KunjConfig['container'] => over;

describe('withHostTokens (GitHub)', () => {
  it('uses gh auth token when no token is in the host env and origin is github.com', async () => {
    const l = lookup();
    const env: Record<string, string> = { ANTHROPIC_API_KEY: 'k' };
    const r = await withHostTokens(env, cfg(), 'github.com', l);
    expect(r.github).toBe('gh');
    expect(r.env.GH_TOKEN).toBe('gho_fromgh');
    expect(l.gh).toHaveBeenCalledWith('github.com');
    // The caller's env is not changed
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('a token from the host env wins: no gh call', async () => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN']) {
      const l = lookup();
      const r = await withHostTokens({ [key]: 'host' }, cfg(), 'github.com', l);
      expect(r.github).toBe('env');
      expect(r.env.GH_TOKEN).toBe(key === 'GH_TOKEN' ? 'host' : undefined);
      expect(l.gh).not.toHaveBeenCalled();
    }
  });

  it('container.useGhToken false: no gh call', async () => {
    const l = lookup();
    const r = await withHostTokens({}, cfg({ useGhToken: false }), 'github.com', l);
    expect(r.github).toBeNull();
    expect(r.env.GH_TOKEN).toBeUndefined();
    expect(l.gh).not.toHaveBeenCalled();
  });

  it('GH_TOKEN not in container.env: no gh call', async () => {
    const l = lookup();
    const r = await withHostTokens({}, cfg({ env: ['ANTHROPIC_API_KEY'] }), 'github.com', l);
    expect(r.github).toBeNull();
    expect(l.gh).not.toHaveBeenCalled();
    // A literal GH_TOKEN=... entry is in the list too
    const l2 = lookup();
    expect((await withHostTokens({}, cfg({ env: ['GH_TOKEN=${home}'] }), 'github.com', l2)).github).toBe('gh');
  });

  it('a host that is not GitHub: no gh call; a GitHub Enterprise host gh knows: asked for that host', async () => {
    const l = lookup('ghe_tok', ['ghe.acme.com']);
    expect((await withHostTokens({}, cfg(), 'gitlab.com', l)).github).toBeNull();
    expect(l.gh).not.toHaveBeenCalled();
    const r = await withHostTokens({}, cfg(), 'ghe.acme.com', l);
    expect(r.github).toBe('gh');
    expect(l.gh).toHaveBeenCalledWith('ghe.acme.com');
    expect(r.env.GH_TOKEN).toBe('ghe_tok');
  });

  it('gh without a token: nothing added', async () => {
    const r = await withHostTokens({}, cfg(), 'GitHub.com', lookup(null));
    expect(r.github).toBeNull();
    expect(r.env.GH_TOKEN).toBeUndefined();
  });

  it('githubTokenSource reports the same without returning the token', async () => {
    expect(await githubTokenSource({}, cfg(), 'github.com', lookup())).toEqual({ source: 'gh', enabled: true });
    expect(await githubTokenSource({ GH_TOKEN: 'x' }, cfg(), 'github.com', lookup())).toEqual({ source: 'env', enabled: true });
    expect(await githubTokenSource({}, cfg({ useGhToken: false }), 'github.com', lookup())).toEqual({ source: null, enabled: false });
  });
});

describe('ghAuthToken', () => {
  it('runs gh auth token --hostname <host> with a timeout and trims the output', async () => {
    const run = jest.fn(async () => ({ stdout: 'gho_abc\n' })) as unknown as GhRunner & jest.Mock;
    expect(await ghAuthToken('github.com', run)).toBe('gho_abc');
    expect(run).toHaveBeenCalledWith('gh', ['auth', 'token', '--hostname', 'github.com'], expect.objectContaining({ timeout: 10000 }));
  });

  it('gh missing, failing or printing nothing: null', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    expect(await ghAuthToken('github.com', (async () => { throw enoent; }) as GhRunner)).toBeNull();
    expect(await ghAuthToken('github.com', (async () => { throw new Error('exit 1'); }) as GhRunner)).toBeNull();
    expect(await ghAuthToken('github.com', (async () => ({ stdout: '  \n' })) as GhRunner)).toBeNull();
    expect(await ghAuthToken('github.com', (async () => ({ stdout: 'two\nlines' })) as GhRunner)).toBeNull();
  });
});

describe('ghKnowsHost', () => {
  it('reads the hosts gh is logged in to from hosts.yml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-gh-'));
    fs.writeFileSync(path.join(dir, 'hosts.yml'), 'github.com:\n    user: me\nghe.acme.com:\n    git_protocol: ssh\n');
    const env = { GH_CONFIG_DIR: dir };
    expect(ghKnowsHost('ghe.acme.com', env)).toBe(true);
    expect(ghKnowsHost('GHE.acme.com', env)).toBe(true);
    expect(ghKnowsHost('acme.com', env)).toBe(false);
    expect(ghKnowsHost('gitlab.com', env)).toBe(false);
    expect(ghKnowsHost('x', { GH_CONFIG_DIR: path.join(dir, 'missing') })).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
