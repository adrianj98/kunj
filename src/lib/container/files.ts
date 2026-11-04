// Reading and writing files in a container's /workspace for `kunj ct file`.
import * as path from 'path';
import { ContainerBackend } from './backend';
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

export async function readWorkspaceFile(backend: ContainerBackend, id: string, relPath: string, user?: string): Promise<string> {
  const r = await backend.exec(id, ['sh', '-c', 'cat -- "$1"', 'sh', relPath], { user, workdir: WORKSPACE });
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
