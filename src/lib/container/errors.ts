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

export type ContainerErrorCode =
  | 'bad-path'
  | 'not-found'
  | 'write-failed'
  // remotes (docs/specs/remote-containers.md)
  | 'bad-remote'
  | 'remote-unknown'
  | 'remote-no-editor'
  | 'remote-no-tty';

// Expected outcomes (not running, nothing to remove, ...): printed without a stack trace.
// With a code, `--json` prints { error: { code, message } }; without, the plain message.
export class ContainerError extends Error {
  constructor(message: string, public code?: ContainerErrorCode) {
    super(message);
    this.name = 'ContainerError';
  }

  // Read by the --json error printers (opt-in); one source, so it cannot differ from `code`
  get jsonCode(): ContainerErrorCode | undefined {
    return this.code;
  }
}
