// Secret manager settings - used by src/lib/secrets/keyprovider.ts

import { registerSettings } from '../lib/settings-registry';

const KEY_PROVIDERS = ['auto', 'keychain', 'libsecret', 'passphrase'];

export function registerSecretsSettings(): void {
  registerSettings([
    {
      key: 'secrets.keyProvider',
      description: 'Where the secrets vault key comes from: auto (macOS Keychain, else libsecret, else a passphrase), keychain, libsecret or passphrase',
      type: 'string',
      defaultValue: 'auto',
      category: 'secrets',
      options: KEY_PROVIDERS,
      validate: (value: string) => KEY_PROVIDERS.includes(value),
      detailedDescription:
        'Picks the key provider for a new vault. An existing vault keeps its kdf: a passphrase vault always asks for its passphrase, and KUNJ_SECRETS_KEY (64 hex chars) overrides the keychain for keychain vaults.',
      examples: ['auto', 'passphrase'],
    },
  ]);
}
