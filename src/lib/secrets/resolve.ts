// Which secrets apply to a branch and a target: global, then repo, then branch (the most specific wins
// by name), then only those whose targets include the target. loadSecrets is the glue that finds the
// vault files, unlocks them (only when one exists) and resolves them.

import { getGlobalKunjDir, getKunjDir, loadResolvedConfig } from '../config';
import { getUnlock, KeyProviderMode, Runner } from './keyprovider';
import { Kdf, readVault, SecretEntry, Unlock, vaultFiles, vaultKdf } from './vault';

export type SecretTarget = 'host' | 'container';

const MODES: KeyProviderMode[] = ['auto', 'keychain', 'libsecret', 'passphrase'];

export function resolveSecrets(global: SecretEntry[], repo: SecretEntry[], branch: string | undefined, target: SecretTarget): SecretEntry[] {
  const byName = new Map<string, SecretEntry>();
  // Globals are environment variables only, and have no branch scope.
  for (const e of global) byName.set(e.name, { ...e, delivery: { env: e.delivery.env } });
  for (const e of repo) if (!e.scope?.branch) byName.set(e.name, e);
  if (branch !== undefined) for (const e of repo) if (e.scope?.branch === branch) byName.set(e.name, e);
  return [...byName.values()].filter((e) => e.targets.includes(target)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function envOf(entries: SecretEntry[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const e of entries) if (e.delivery.env) env[e.name] = e.value;
  return env;
}

export interface LoadSecretsOptions {
  branch?: string;
  target: SecretTarget;
  create?: false;
  // Seams for tests and callers that already know them; default to the current repo, the
  // secrets.keyProvider setting and the process's env and platform.
  kunjDir?: string;
  globalDir?: string;
  mode?: KeyProviderMode;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: Runner;
  prompt?: (msg: string) => Promise<string>;
  tty?: boolean;
}

export async function loadSecrets(opts: LoadSecretsOptions): Promise<SecretEntry[]> {
  const files = vaultFiles(opts.kunjDir ?? getKunjDir(), opts.globalDir ?? getGlobalKunjDir());
  // Read both kinds first, so a corrupt file is reported before anything is unlocked.
  const globalKdf = vaultKdf(files.global);
  const repoKdf = vaultKdf(files.repo);
  if (!globalKdf && !repoKdf) return [];

  const mode = opts.mode ?? (await configuredMode());
  // One Unlock per kdf, shared by both files, so a passphrase or the keychain is asked once.
  const unlocks = new Map<Kdf, Promise<Unlock>>();
  const unlockFor = (kdf: Kdf): Promise<Unlock> => {
    let u = unlocks.get(kdf);
    if (!u) {
      u = getUnlock({
        mode,
        env: opts.env ?? process.env,
        platform: opts.platform ?? process.platform,
        run: opts.run,
        prompt: opts.prompt,
        tty: opts.tty,
        existingKdf: kdf,
        create: false,
      });
      unlocks.set(kdf, u);
    }
    return u;
  };

  const global = globalKdf ? await readVault(files.global, await unlockFor(globalKdf)) : [];
  const repo = repoKdf ? await readVault(files.repo, await unlockFor(repoKdf)) : [];
  return resolveSecrets(global, repo, opts.branch, opts.target);
}

async function configuredMode(): Promise<KeyProviderMode> {
  const config = (await loadResolvedConfig()) as { secrets?: { keyProvider?: string } };
  const mode = config.secrets?.keyProvider;
  return MODES.includes(mode as KeyProviderMode) ? (mode as KeyProviderMode) : 'auto';
}
