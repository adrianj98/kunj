export type ContainerErrorCode = 'bad-path' | 'not-found' | 'write-failed';

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
