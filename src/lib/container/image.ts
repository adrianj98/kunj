// Which image a branch container runs, and building it when it is missing. Resolution is pure (the
// caller reads the devcontainer and its Dockerfile from git) so the lifecycle can be tested with a
// fake backend. Build contexts are streamed as ustar archives written here, with no dependency.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { ContainerBackend } from './backend';
import { DevcontainerSpec } from './devcontainer';

export interface ImageSource {
  kind: 'setting' | 'devcontainer' | 'sandbox';
  tag: string;
  build?: { contextTar: () => NodeJS.ReadableStream; dockerfile: string; buildArgs: Record<string, string> };
  /** User to run as; '' means the image's own USER (no --user is passed). */
  user: string;
  spec?: DevcontainerSpec;
}

export interface ResolveImageInput {
  setting: string;
  devcontainer: {
    spec: DevcontainerSpec;
    treeId: string;
    archive: () => NodeJS.ReadableStream;
    /** Dockerfile contents at the same commit, read by the caller with `git show` */
    dockerfileText: string;
  } | null;
  repoName: string;
  kunjVersion: string;
}

export const SANDBOX_IMAGE = (version: string) => `kunj-sandbox:${version}`;
export const NETHELPER_IMAGE = (version: string) => `kunj-nethelper:${version}`;

/** dist/container from dist/lib/container, src/container under ts-jest. */
export function sandboxAssetsDir(): string {
  return path.join(__dirname, '..', '..', 'container');
}

/** The git credential helper script, streamed into every container that gets a token. */
export function credentialHelperSource(): string {
  return path.join(sandboxAssetsDir(), 'sandbox', 'git-credential-kunj');
}

export function imageHash(dockerfileText: string, treeId: string, buildArgs: Record<string, string>): string {
  const args = Object.keys(buildArgs).sort().map(k => [k, buildArgs[k]]);
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([dockerfileText, treeId, args]))
    .digest('hex')
    .slice(0, 12);
}

export function resolveImage(input: ResolveImageInput): ImageSource {
  if (input.setting) return { kind: 'setting', tag: input.setting, user: '' };

  const dc = input.devcontainer;
  if (dc) {
    const user = dc.spec.remoteUser ?? '';
    if (dc.spec.image) return { kind: 'devcontainer', tag: dc.spec.image, user, spec: dc.spec };
    if (dc.spec.build) {
      const { dockerfile, context, args } = dc.spec.build;
      const inContext = path.posix.relative(context, dockerfile);
      if (inContext.startsWith('../') || path.posix.isAbsolute(inContext)) {
        throw new Error(`devcontainer build.dockerfile must be inside build.context (${dockerfile} is not in ${context})`);
      }
      return {
        kind: 'devcontainer',
        tag: `kunj-${input.repoName}:${imageHash(dc.dockerfileText, dc.treeId, args)}`,
        build: { contextTar: dc.archive, dockerfile: inContext, buildArgs: args },
        user,
        spec: dc.spec,
      };
    }
  }

  return {
    kind: 'sandbox',
    tag: SANDBOX_IMAGE(input.kunjVersion),
    build: assetBuild('sandbox'),
    user: 'dev',
  };
}

export function resolveHelperImage(kunjVersion: string): ImageSource {
  return { kind: 'sandbox', tag: NETHELPER_IMAGE(kunjVersion), build: assetBuild('nethelper'), user: '' };
}

function assetBuild(name: string): NonNullable<ImageSource['build']> {
  return { contextTar: () => tarDirectory(path.join(sandboxAssetsDir(), name)), dockerfile: 'Dockerfile', buildArgs: {} };
}

export async function ensureImage(backend: ContainerBackend, source: ImageSource, warn: (msg: string) => void): Promise<string> {
  if (await backend.imageExists(source.tag)) return source.tag;
  if (!source.build) throw new Error(`Image not found: ${source.tag} (pull it or set container.image)`);
  warn(`Building image ${source.tag} (first use; this can take a few minutes)…`);
  await backend.buildImage(source.tag, source.build.contextTar(), {
    dockerfile: source.build.dockerfile,
    buildArgs: source.build.buildArgs,
  });
  return source.tag;
}

// ---------------------------------------------------------------------------------------------
// ustar writer. Owner 0:0 and mtime 0 so the same input always gives the same bytes.

const BLOCK = 512;

type TarEntry =
  | { type: 'file'; path: string; mode: number; content: () => Buffer }
  | { type: 'dir'; path: string; mode: number }
  | { type: 'symlink'; path: string; mode: number; target: string };

function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  if (Buffer.byteLength(name) <= 256) {
    // Split at a slash so the prefix fits 155 bytes and the rest 100
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
      const prefix = name.slice(0, i);
      const rest = name.slice(i + 1);
      if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length > 0) return { name: rest, prefix };
    }
  }
  throw new Error(`Path too long for a tar archive: ${name}`);
}

function octal(buf: Buffer, offset: number, length: number, value: number): void {
  buf.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function header(entry: TarEntry, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(entry.type === 'dir' ? `${entry.path}/` : entry.path);
  buf.write(name, 0, 100, 'utf8');
  octal(buf, 100, 8, entry.mode & 0o7777);
  octal(buf, 108, 8, 0);
  octal(buf, 116, 8, 0);
  octal(buf, 124, 12, size);
  octal(buf, 136, 12, 0);
  buf.write('        ', 148, 8, 'ascii');
  buf.write(entry.type === 'file' ? '0' : entry.type === 'dir' ? '5' : '2', 156, 1, 'ascii');
  if (entry.type === 'symlink') {
    if (Buffer.byteLength(entry.target) > 100) throw new Error(`Symlink target too long for a tar archive: ${entry.path}`);
    buf.write(entry.target, 157, 100, 'utf8');
  }
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function* tarBlocks(entries: TarEntry[]): Generator<Buffer> {
  for (const entry of entries) {
    if (entry.type !== 'file') {
      yield header(entry, 0);
      continue;
    }
    const content = entry.content();
    yield header(entry, content.length);
    yield content;
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Archive the contents of `dir` (paths relative to it), in sorted order. */
export function tarDirectory(dir: string): NodeJS.ReadableStream {
  const entries: TarEntry[] = [];
  const walk = (rel: string) => {
    const names = fs.readdirSync(path.join(dir, rel)).sort();
    for (const name of names) {
      const relPath = rel ? path.join(rel, name) : name;
      const full = path.join(dir, relPath);
      const stat = fs.lstatSync(full);
      const entryPath = toPosix(relPath);
      if (stat.isDirectory()) {
        entries.push({ type: 'dir', path: entryPath, mode: stat.mode });
        walk(relPath);
      } else if (stat.isSymbolicLink()) {
        entries.push({ type: 'symlink', path: entryPath, mode: 0o777, target: fs.readlinkSync(full) });
      } else if (stat.isFile()) {
        entries.push({ type: 'file', path: entryPath, mode: stat.mode, content: () => fs.readFileSync(full) });
      }
    }
  };
  walk('');
  // Validate every name before the stream starts, so errors throw here rather than mid-stream
  for (const e of entries) header(e, 0);
  return Readable.from(tarBlocks(entries));
}

/** Archive in-memory files; parent directories are implied, as tar extraction creates them. */
export function tarEntries(entries: Array<{ path: string; content: Buffer | string; mode?: number }>): NodeJS.ReadableStream {
  const list: TarEntry[] = entries.map(e => ({
    type: 'file',
    path: e.path,
    mode: e.mode ?? 0o644,
    content: () => (typeof e.content === 'string' ? Buffer.from(e.content) : e.content),
  }));
  for (const e of list) header(e, 0);
  return Readable.from(tarBlocks(list));
}
