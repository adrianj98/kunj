// The blueprint's part of a container start: finding its snapshot, and running presets, `setup`
// and `maintain` in a container. Kept out of lifecycle.ts, which calls these in its start order.
import { ContainerBackend, ExecIO } from './backend';
import { Blueprint, SNAPSHOT_REPO } from './blueprint';
import { LABEL } from './names';
import { Preset, runPresets } from './presets';

export interface FoundSnapshot {
  tag: string;
  user: string;
  stale: boolean;
}

/**
 * The repository's snapshot for `hash`, else its newest snapshot marked stale (still faster than
 * a fresh clone and setup), else null.
 */
export async function findSnapshot(
  backend: ContainerBackend,
  repoName: string,
  repoId: string,
  hash: string
): Promise<FoundSnapshot | null> {
  const prefix = `${SNAPSHOT_REPO(repoName)}:`;
  const images = (await backend.listImages({ [LABEL.repo]: repoId })).filter(i => i.tag.startsWith(prefix));
  if (!images.length) return null;
  const exact = images.find(i => i.labels[LABEL.blueprintHash] === hash);
  const pick = exact ?? [...images].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0];
  return { tag: pick.tag, user: pick.labels[LABEL.blueprintUser] ?? '', stale: !exact };
}

/** Each command with `sh -lc`, in order; the first failure stops and is returned. */
export async function runCommands(
  backend: ContainerBackend,
  id: string,
  commands: string[],
  io: ExecIO
): Promise<{ command: string; exitCode: number } | null> {
  for (const command of commands) {
    const r = await backend.exec(id, ['sh', '-lc', command], io);
    if (r.exitCode !== 0) return { command, exitCode: r.exitCode };
  }
  return null;
}

/**
 * A new container without a snapshot: the presets as root, then `setup` in the workspace as the
 * user (`io.user`). Throws on the first failure, which the caller turns into a failed start.
 */
export async function provisionNew(
  backend: ContainerBackend,
  id: string,
  blueprint: Blueprint,
  presets: Preset[],
  toolUser: string,
  io: ExecIO,
  warn: (msg: string) => void
): Promise<{ toolsRun: string[]; tools: Array<{ name: string; version: string }>; setupRan: boolean }> {
  const output = { stdout: io.stdout, stderr: io.stderr };
  const installed = presets.length ? await runPresets(backend, id, presets, blueprint.tools, toolUser, output, warn) : [];
  const failed = await runCommands(backend, id, blueprint.setup, io);
  if (failed) throw new Error(`setup command failed (exit ${failed.exitCode}): ${failed.command}`);
  return { toolsRun: installed.map(t => t.name), tools: installed, setupRan: blueprint.setup.length > 0 };
}

/** `maintain` on every start; a failure is a warning (dependencies may be partly updated). */
export async function maintain(
  backend: ContainerBackend,
  id: string,
  blueprint: Blueprint,
  io: ExecIO,
  warn: (msg: string) => void
): Promise<boolean> {
  if (!blueprint.maintain.length) return false;
  const failed = await runCommands(backend, id, blueprint.maintain, io);
  if (failed) warn(`maintain command failed (exit ${failed.exitCode}): ${failed.command}`);
  return true;
}
