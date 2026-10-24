// Expected secret-manager outcomes. BaseCommand prints them without a stack trace, and in --json mode
// as { error: { code, message } }. A message never contains a secret value.

export type SecretErrorCode =
  | 'secrets-locked'
  | 'secrets-corrupt'
  | 'secret-not-found'
  | 'bad-name'
  | 'not-ignored'
  | 'bad-dotenv';

export class SecretError extends Error {
  constructor(message: string, readonly jsonCode: SecretErrorCode) {
    super(message);
    this.name = 'SecretError';
  }
}
