// The error a container start fails with. Its own module so dind.ts can throw it without an import
// cycle through lifecycle.ts, which re-exports it.

export type StartErrorCode =
  | 'unpushed'
  | 'base-missing'
  | 'origin'
  | 'no-token'
  | 'docker'
  | 'image'
  | 'seed'
  | 'firewall'
  | 'collision'
  | 'setup'
  | 'dind';

export class StartError extends Error {
  constructor(message: string, readonly code: StartErrorCode) {
    super(message);
    this.name = 'StartError';
  }
}
