import { KunjConfig } from '../../../types';
import { LocalDockerBackend } from '../docker';
import { RemoteKunjBackend } from '../remote';
import { remoteNameOf, selectBackend } from '../select-backend';
import { Harness, startHarness, HARNESS_TOKEN } from './remote-harness';

const config = (container: Record<string, unknown> = {}): KunjConfig => ({ container } as unknown as KunjConfig);

describe('remoteNameOf', () => {
  it('prefers the option, then the setting; local and empty mean the laptop', () => {
    expect(remoteNameOf({}, config())).toBeUndefined();
    expect(remoteNameOf({}, config({ remote: 'box' }))).toBe('box');
    expect(remoteNameOf({ remote: 'other' }, config({ remote: 'box' }))).toBe('other');
    expect(remoteNameOf({ remote: 'local' }, config({ remote: 'box' }))).toBeUndefined();
    expect(remoteNameOf({}, config({ remote: '' }))).toBeUndefined();
  });
});

describe('selectBackend', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(() => h.close());

  it('is the laptop\'s Docker with its context by default', async () => {
    const s = await selectBackend({ config: config({ dockerContext: 'colima' }) });
    expect(s.kind).toBe('docker');
    expect(s.backend).toBeInstanceOf(LocalDockerBackend);
    expect(s.dockerContext).toBe('colima');
    const overridden = await selectBackend({ context: 'desktop', config: config({ dockerContext: 'colima' }) });
    expect(overridden.dockerContext).toBe('desktop');
    await s.close();
  });

  it('is the remote over its URL, ready, with the box\'s context', async () => {
    const s = await selectBackend({ config: config(), remote: 'box', remotes: () => ({ url: `http://127.0.0.1:${h.port}`, token: HARNESS_TOKEN, addedAt: '' }) });
    expect(s).toMatchObject({ kind: 'remote', remote: 'box', dockerContext: 'default' });
    expect(s.backend).toBeInstanceOf(RemoteKunjBackend);
    expect(s.backend.features.editorAttach).toBe(false);
  });

  it('opens the tunnel for an --ssh remote and closes it with the selection, also when ready() fails', async () => {
    let closed = 0;
    const tunnel = jest.fn(async () => ({ localPort: h.port, close: async () => void closed++ }));
    const s = await selectBackend({ config: config(), remote: 'box', remotes: () => ({ ssh: 'me@box', token: HARNESS_TOKEN, addedAt: '' }), tunnel });
    expect(tunnel).toHaveBeenCalledWith({ ssh: 'me@box', port: 7433 });
    expect(s.kind).toBe('remote');
    await s.close();
    await s.close();
    expect(closed).toBe(1);

    await expect(
      selectBackend({ config: config(), remote: 'box', remotes: () => ({ ssh: 'me@box', port: 9000, token: 'wrong', addedAt: '' }), tunnel }),
    ).rejects.toMatchObject({ code: 'remote-unauthorized' });
    expect(tunnel).toHaveBeenLastCalledWith({ ssh: 'me@box', port: 9000 });
    expect(closed).toBe(2);
  });

  it('refuses an unknown remote and an entry with neither url nor ssh', async () => {
    await expect(selectBackend({ config: config({ remote: 'nope' }) })).rejects.toMatchObject({ code: 'remote-unknown' });
    await expect(selectBackend({ config: config(), remote: 'odd', remotes: () => ({ token: 't', addedAt: '' }) })).rejects.toMatchObject({ code: 'bad-remote' });
  });
});
