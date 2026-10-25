// Secrets from the vault reaching a branch container, through the built CLI: `kunj secret set` with a
// container target, then `kunj ct start`. With KUNJ_FUNCTIONAL_REMOTE=1 the start goes through kunj serve,
// so the env file is written on the server's side. Opt-in: npm run test:functional.
import { describe, it, expect } from '@jest/globals';
import { describeFunctional, docker, useFixture } from './harness';

// A raw vault key, so no test reaches a real keychain (KUNJ_SECRETS_KEY opens keychain-kdf vaults)
const KEY = { KUNJ_SECRETS_KEY: 'cd'.repeat(32) };
const ENV_VALUE = 'env-secret-value-1234';
const FILE_VALUE = 'file-secret-value-5678';

describeFunctional('kunj ct (functional): secrets from the vault', () => {
  const ctx = useFixture('secrets');

  it('delivers a container env secret and a file secret, and neither reaches labels or docker argv', async () => {
    const { fx } = ctx;
    fx.writeConfig({ secrets: { keyProvider: 'keychain' } });
    const setEnv = await fx.kunj(['secret', 'set', 'FT_API_KEY', '--targets', 'container'], { input: ENV_VALUE + '\n', env: KEY });
    expect(setEnv.status).toBe(0);
    const setFile = await fx.kunj(['secret', 'set', 'FT_FILE_SECRET', '--targets', 'container', '--no-env', '--file', 'config/ft-secret.env'], {
      input: FILE_VALUE + '\n',
      env: KEY,
    });
    expect(setFile.status).toBe(0);

    // list shows names, never values
    const list = await fx.kunj(['secret', 'list'], { env: KEY });
    expect(list.stdout).toContain('FT_API_KEY');
    expect(list.stdout).not.toContain(ENV_VALUE);

    const branch = 'ft-secrets-a';
    const started = await fx.start(branch, [], { env: KEY });
    const container = started.names.container;

    const env = await fx.sh(branch, 'printf %s "$FT_API_KEY"', { env: KEY });
    expect(env.stdout).toBe(ENV_VALUE);
    const file = await fx.sh(branch, 'cat config/ft-secret.env; stat -c %a config/ft-secret.env', { env: KEY });
    expect(file.stdout).toContain(FILE_VALUE);
    expect(file.stdout.trim().split('\n').pop()).toBe('600');
    // Rendered files are kept out of git (anchored line in .git/info/exclude), so the agent cannot commit them
    expect((await fx.sh(branch, 'git check-ignore -q config/ft-secret.env', { env: KEY })).status).toBe(0);
    // A file-only secret is not in the environment
    expect((await fx.sh(branch, 'printf %s "${FT_FILE_SECRET:-unset}"', { env: KEY })).stdout).toBe('unset');

    // Never in a label, never on the command line docker recorded
    const labels = docker(['inspect', '--format', '{{json .Config.Labels}}', container]);
    expect(labels).not.toContain(ENV_VALUE);
    expect(labels).not.toContain(FILE_VALUE);
    const cmd = docker(['inspect', '--format', '{{json .Config.Cmd}} {{json .Config.Entrypoint}} {{json .Args}}', container]);
    expect(cmd).not.toContain(ENV_VALUE);

    // ct list reports the stamp: unchanged right after the start
    const listed = await fx.kunjJson<{ containers: Array<{ branch: string; secretsChanged?: boolean }> }>(['ct', 'list'], { env: KEY });
    expect(listed.containers.find(c => c.branch === branch)?.secretsChanged).toBe(false);
  });
});
