// Reading and writing files in a container's /workspace for `kunj ct file`.
import * as path from 'path';
import { ContainerBackend, ExecOutputLimitError } from './backend';
import { ContainerError } from './errors';

const WORKSPACE = '/workspace';

/** The POSIX-normalised relative path; refuses empty, absolute, escaping and NUL-containing paths. */
export function validateWorkspacePath(p: string): string {
  if (!p || p.includes('\0')) throw new ContainerError(`Invalid path ${JSON.stringify(p)}: give a path relative to /workspace, e.g. src/index.ts.`, 'bad-path');
  if (p.startsWith('/')) throw new ContainerError(`Path must be relative to /workspace (e.g. src/index.ts), not ${p}.`, 'bad-path');
  const normalised = path.posix.normalize(p);
  if (normalised === '.' || normalised === '..' || normalised.startsWith('../')) {
    throw new ContainerError(`Path must stay inside /workspace: ${p}.`, 'bad-path');
  }
  return normalised.replace(/\/$/, '');
}

/** The largest file `kunj ct file read` returns: it is held in memory whole, on the box and here. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

// A regular, readable file (symlinks followed) whose size, from stat (wc -c without it), is at
// most $2 bytes is printed; a larger one exits 3 with its size on stdout, anything else exits 1.
export const READ_SCRIPT =
  '[ -f "$1" ] && [ -r "$1" ] || exit 1; ' +
  's=$(stat -L -c %s -- "$1" 2>/dev/null || wc -c < "$1") || exit 1; ' +
  'if [ "$s" -gt "$2" ]; then printf %s "$s"; exit 3; fi; ' +
  'exec cat -- "$1"';

function tooLarge(relPath: string, size?: number): ContainerError {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const what = size === undefined ? 'more than' : `${mb(size)}, over`;
  return new ContainerError(`/workspace/${relPath} is too large to read (${what} the ${mb(MAX_READ_BYTES)} limit).`, 'too-large');
}

export async function readWorkspaceFile(
  backend: ContainerBackend,
  id: string,
  relPath: string,
  user?: string,
  maxBytes = MAX_READ_BYTES,
): Promise<string> {
  let r: { exitCode: number; stdout: string };
  try {
    // maxStdout is the second guard: a file that grows between stat and cat
    r = await backend.exec(id, ['sh', '-c', READ_SCRIPT, 'sh', relPath, String(maxBytes)], { user, workdir: WORKSPACE, maxStdout: maxBytes });
  } catch (err) {
    if (err instanceof ExecOutputLimitError) throw tooLarge(relPath);
    throw err;
  }
  if (r.exitCode === 3) {
    const size = Number(r.stdout.trim());
    throw tooLarge(relPath, Number.isFinite(size) && size > 0 ? size : undefined);
  }
  if (r.exitCode !== 0) throw new ContainerError(`Cannot read /workspace/${relPath} in the container: it is missing, a directory or not readable.`, 'not-found');
  return r.stdout;
}

export async function writeWorkspaceFile(
  backend: ContainerBackend,
  id: string,
  relPath: string,
  stdin: NodeJS.ReadableStream,
  user?: string,
): Promise<void> {
  const r = await backend.exec(id, ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', relPath], {
    stdin,
    user,
    workdir: WORKSPACE,
  });
  if (r.exitCode !== 0) throw new ContainerError(`Cannot write /workspace/${relPath} in the container: a directory is in the way or it is not writable.`, 'write-failed');
}
