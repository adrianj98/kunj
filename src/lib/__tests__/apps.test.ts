import { describe, it, expect } from '@jest/globals';
import { pickAsset } from '../apps';

const release = (tag: string, names: string[], draft = false) => ({
  tag_name: tag,
  draft,
  assets: names.map(name => ({ name, browser_download_url: `https://example.test/${tag}/${name}` })),
});

describe('pickAsset', () => {
  const releases = [
    release('v1.3.0', ['kunj-worktrees-1.3.0.vsix'], true),
    release('v1.2.0', ['kunj-worktrees-1.2.0.vsix', 'Kunj-macos-1.2.0.zip']),
    release('v1.1.0', ['kunj-worktrees-1.1.0.vsix']),
  ];

  it('prefers the release matching the CLI version', () => {
    expect(pickAsset(releases, 'vscode', '1.1.0')?.name).toBe('kunj-worktrees-1.1.0.vsix');
  });

  it('falls back to the newest published release with the asset', () => {
    expect(pickAsset(releases, 'macos', '1.1.0')).toMatchObject({ tag: 'v1.2.0', name: 'Kunj-macos-1.2.0.zip' });
    expect(pickAsset(releases, 'vscode')?.tag).toBe('v1.2.0'); // skips the draft
  });

  it('returns null when no release has the asset', () => {
    expect(pickAsset([release('v1.0.0', ['other.tgz'])], 'macos')).toBeNull();
  });
});
