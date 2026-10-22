// Starting, stopping and removing a branch container. Programs against ContainerBackend only, so
// it is tested with a fake backend; host-side git (origin checks, devcontainer reads) runs here.
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { ContainerBackend, ContainerInfo, ContainerSpec, ExecIO, ExecTimeoutError } from './backend';
import { ContainerNames, LABEL, containerNames, labelsFor, labelsMatch } from './names';
import { ImageSource, credentialHelperSource, ensureImage, resolveHelperImage, resolveImage, tarDirectory, tarEntries } from './image';
import { DEVCONTAINER_PATHS, DevcontainerSpec, parseDevcontainer } from './devcontainer';
import { Blueprint, ResolvedBlueprint, SEED_DIR, blueprintHash, blueprintRef, lockfileIds, resolveBlueprint } from './blueprint';
import { Preset, orderTools, resolvePresets } from './presets';
import { FoundSnapshot, findSnapshot, maintain, provisionNew } from './provision';
import { SEED_MARKER, hostGitIdentity, inspectOrigin, originPort, pushBranch, refExistsOnOrigin, seedScript } from './seed';
import {
  CLAUDE_AUTH_KEYS,
  ContainerStatus,
  RemoveGuard,
  TOKEN_KEYS,
  describeGuard,
  emptyStatus,
  firewallEnv,
  firewallMode,
  forwardedEnv,
  parseGuard,
  parseStatus,
  truthy,
} from './env';
import { getKeepDir, listKeptFiles } from '../keep';
import { getGlobalKunjDir, getKunjDir } from '../config';
import { ConfigVariables, expandVariables } from '../config-vars';
import { KunjConfig } from '../../types';

export { forwardedEnv, firewallEnv } from './env';
export type { ContainerStatus, RemoveGuard } from './env';
export { findSnapshot } from './provision';

const execFileAsync = promisify(execFile);

const WORKSPACE = '/workspace';
const READY_FILE = '/tmp/kunj-ready';
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 300;
const POST_CREATE_MARKER = '.kunj-created';
const CREDENTIAL_HELPER = 'git-credential-kunj';
// Everything else is dropped: NET_RAW (an AF_PACKET socket skips the helper's OUTPUT rules) above
// all. These keep chown, file ownership fixes and sudo in devcontainer images working.
export const MAIN_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];

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
  | 'setup';

export class StartError extends Error {
  constructor(message: string, readonly code: StartErrorCode) {
    super(message);
    this.name = 'StartError';
  }
}

export interface StartOptions {
  branch: string;
  create: boolean;
  base?: string;
  imageOverride?: string;
  publish: number[];
  rebuild: boolean;
  config: KunjConfig;
  repo: { root: string; name: string; id: string; originUrl: string };
  kunjVersion: string;
  hostEnv: NodeJS.ProcessEnv;
  cwd: string;
  jsonMode: boolean;
  skipHooks: boolean;
  keepOnError: boolean;
  confirmPush: () => Promise<boolean>;
  warn: (msg: string) => void;
  /** The repository's default branch (without origin/), asked only before a devcontainer build */
  defaultBranch?: () => Promise<string | undefined>;
  /** Start from the base image even when the repository has a blueprint snapshot */
  noSnapshot?: boolean;
  /** The blueprint (null: none); resolved here, from origin/<default branch> then the host copy, when undefined */
  blueprint?: ResolvedBlueprint | null;
  /** Names and the kunj.branch label come from this instead of `branch` (the snapshot's `<branch>@snapshot`); the clone still checks out `branch` */
  namesFor?: string;
  /** The blueprint's presets, already resolved (tests, and the snapshot command); resolved here when undefined */
  presets?: Preset[];
  /** Publish no devcontainer forwardPorts (the snapshot's temporary container binds no host port) */
  ignoreForwardPorts?: boolean;
}

export interface StartResult {
  names: ContainerNames;
  containerId: string;
  image: string;
  /** Who commands run as; resolved with `id -un` when the image's own USER is used. */
  user: string;
  created: boolean;
  seeded: boolean;
  keptFiles: string[];
  copiedFiles: string[];
  publish: Array<{ container: number; host: number }>;
  firewall: 'default' | 'allowlist';
  /** Only when the repository has a blueprint */
  blueprint?: {
    hash: string;
    /** The snapshot image started from; null after a clone */
    snapshot: string | null;
    /** Only on a new start: whether the snapshot's hash differs from the blueprint's */
    stale?: boolean;
    toolsRun: string[];
    /** What each preset reported it installed; only on a new start without a snapshot */
    tools?: Array<{ name: string; version: string }>;
    setupRan: boolean;
    maintainRan: boolean;
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function step<T>(code: StartErrorCode, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StartError) throw err;
    throw new StartError(message(err), code);
  }
}

// ---------------------------------------------------------------------------------------------
// Host side: devcontainer at the branch tip on origin

async function gitOut(args: string[], cwd: string): Promise<string> {
  return (await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** The commit-ish on the host that the container will clone. */
function hostRef(branch: string, create: boolean, base: string | undefined): string {
  if (!create) return `origin/${branch}`;
  const b = base ?? '';
  if (b.startsWith('refs/heads/')) return `origin/${b.slice('refs/heads/'.length)}`;
  if (b.startsWith('refs/')) return b;
  return `origin/${b}`;
}

async function readDevcontainer(ref: string, cwd: string): Promise<ResolveDevcontainer | null> {
  for (const p of DEVCONTAINER_PATHS) {
    let text: string;
    try {
      text = await gitOut(['show', `${ref}:${p}`], cwd);
    } catch {
      continue;
    }
    const spec = parseDevcontainer(text, p);
    if (!spec.build) return { spec, treeId: '', archive: emptyArchive, dockerfileText: '' };
    const context = spec.build.context === '.' ? '' : spec.build.context;
    const treeId = (await gitOut(['rev-parse', `${ref}:${context}`], cwd)).trim();
    const dockerfileText = await gitOut(['show', `${ref}:${spec.build.dockerfile}`], cwd);
    // The subtree itself, so archive paths are relative to the build context
    const archive = () => spawn('git', ['archive', '--format=tar', `${ref}:${context}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).stdout;
    return { spec, treeId, archive, dockerfileText };
  }
  return null;
}

type ResolveDevcontainer = { spec: DevcontainerSpec; treeId: string; archive: () => NodeJS.ReadableStream; dockerfileText: string };

const emptyArchive = () => tarEntries([]);

export const STALE_SNAPSHOT_HINT = 'Blueprint snapshot is stale (lockfiles or blueprint changed); run kunj ct blueprint snapshot';
export function noSnapshotHint(bp: Pick<Blueprint, 'tools' | 'setup'>): string {
  const steps = [Object.keys(bp.tools).length ? 'tools' : '', bp.setup.length ? 'setup' : ''].filter(Boolean).join(' and ');
  return steps
    ? `No blueprint snapshot yet; running ${steps} in the container (kunj ct blueprint snapshot makes this instant)`
    : 'No blueprint snapshot yet (kunj ct blueprint snapshot makes new containers start from it)';
}

async function loadBlueprint(options: StartOptions): Promise<ResolvedBlueprint | null> {
  if (options.blueprint !== undefined) return options.blueprint;
  const defaultBranch = (await options.defaultBranch?.())?.replace(/^origin\//, '');
  return resolveBlueprint({ cwd: options.cwd, repoKunjDir: getKunjDir(), defaultBranch });
}

interface BlueprintPlan {
  resolved: ResolvedBlueprint;
  presets: Preset[];
  hash: string;
  snapshot: FoundSnapshot | null;
}

async function baseSource(
  options: StartOptions,
  warn: (m: string) => void
): Promise<{ input: Parameters<typeof resolveImage>[0]; base: ImageSource }> {
  const setting = options.imageOverride || options.config.container?.image || '';
  let devcontainer: ResolveDevcontainer | null = null;
  if (!setting) {
    const ref = hostRef(options.branch, options.create, options.base);
    if (options.create && !ref.startsWith('refs/')) {
      // origin/<base> may never have been fetched; the container clones it fresh anyway
      await execFileAsync('git', ['fetch', 'origin', `+refs/heads/${ref.slice(7)}:refs/remotes/${ref}`], {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 30000,
      }).catch(() => undefined);
    }
    devcontainer = await readDevcontainer(ref, options.cwd);
    if (devcontainer?.spec.ignoredKeys.length) {
      warn(`devcontainer.json: ignoring unsupported keys: ${devcontainer.spec.ignoredKeys.join(', ')}`);
    }
    if (devcontainer?.spec.hasComposeFile) {
      warn('devcontainer.json: dockerComposeFile is not supported; services are not started');
    }
  }
  const input = { setting, devcontainer, repoName: options.repo.name, kunjVersion: options.kunjVersion };
  return { input, base: resolveImage(input) };
}

/** The image a start would use without a blueprint snapshot; the snapshot hashes the same tag. */
export async function baseImageTag(options: StartOptions, warn: (m: string) => void = () => {}): Promise<string> {
  return (await baseSource(options, warn)).base.tag;
}

async function resolveSource(
  backend: ContainerBackend,
  options: StartOptions,
  warn: (m: string) => void
): Promise<{ source: ImageSource; plan: BlueprintPlan | null }> {
  const { input, base } = await baseSource(options, warn);
  const resolved = await step('setup', () => loadBlueprint(options));
  if (!resolved) return { source: base, plan: null };
  const bp = resolved.blueprint;
  const presets = options.presets ?? (await step('setup', () =>
    resolvePresets(orderTools(bp.tools), { repoRoot: options.repo.root, globalKunjDir: getGlobalKunjDir() })));
  // The base image is part of the hash, so a snapshot is only exact for the image it was built on
  const hash = blueprintHash({
    text: resolved.text,
    lockfiles: await lockfileIds(bp.lockfiles, blueprintRef(resolved, await options.defaultBranch?.()), options.cwd),
    baseImage: base.tag,
    presetHashes: presets.map(p => p.hash),
  });
  // --image is a one-off choice of image, so it is never swapped for a snapshot
  const lookup = !options.noSnapshot && !options.imageOverride;
  const snapshot = lookup ? await findSnapshot(backend, options.repo.name, options.repo.id, hash) : null;
  if (snapshot?.stale) warn(STALE_SNAPSHOT_HINT);
  else if (lookup && !snapshot) warn(noSnapshotHint(bp));
  const source = snapshot ? resolveImage({ ...input, snapshot }) : base;
  return { source, plan: { resolved, presets, hash, snapshot } };
}

export const BUILD_NETWORK_WARNING = 'Building a Dockerfile changed on this branch; image builds run with full network access';

/** True when the devcontainer build context on the branch differs from the default branch's. */
async function buildContextChanged(options: StartOptions, context: string): Promise<boolean> {
  const defaultBranch = (await options.defaultBranch?.())?.replace(/^origin\//, '');
  if (!defaultBranch) return false;
  const ref = hostRef(options.branch, options.create, options.base);
  const base = `origin/${defaultBranch}`;
  if (ref === base) return false;
  try {
    await execFileAsync('git', ['diff', '--quiet', `${base}..${ref}`, '--', context], { cwd: options.cwd });
    return false;
  } catch (err) {
    // 1 means a difference; anything else (an unknown ref) skips the comparison
    return (err as { code?: unknown }).code === 1;
  }
}

/**
 * Image builds are not behind the firewall (they need the network for package installs), so a
 * branch that changed its Dockerfile gets a say before anything is built. A warning, not a prompt.
 */
async function warnOnChangedBuild(backend: ContainerBackend, options: StartOptions, source: ImageSource): Promise<void> {
  if (source.kind !== 'devcontainer' || !source.build || !source.spec?.build) return;
  if (!options.rebuild && (await backend.imageExists(source.tag))) return;
  if (await buildContextChanged(options, source.spec.build.context)) options.warn(BUILD_NETWORK_WARNING);
}

// ---------------------------------------------------------------------------------------------
// Ports

// Private on purpose: Task 9's port forwarding exports its own
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function findFreePort(preferred: number, taken: Set<number>): Promise<number> {
  for (let port = preferred; port < preferred + 100 && port <= 65535; port++) {
    if (!taken.has(port) && (await portFree(port))) return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function mapPorts(ports: number[]): Promise<Array<{ container: number; host: number }>> {
  const taken = new Set<number>();
  const out: Array<{ container: number; host: number }> = [];
  for (const port of [...new Set(ports)]) {
    const host = await findFreePort(port, taken);
    taken.add(host);
    out.push({ container: port, host });
  }
  return out;
}

function requestedPorts(options: StartOptions, spec: DevcontainerSpec | undefined): number[] {
  const all = [...options.publish, ...(options.config.container?.publish ?? []).map(p => parseInt(p, 10)), ...(options.ignoreForwardPorts ? [] : spec?.forwardPorts ?? [])];
  return all.filter(p => Number.isInteger(p) && p > 0 && p <= 65535);
}

// ---------------------------------------------------------------------------------------------
// Steps run inside the container

function outputIO(jsonMode: boolean): Pick<ExecIO, 'stdout' | 'stderr'> {
  // In --json mode stdout must stay clean for the JSON document
  return { stdout: jsonMode ? process.stderr : 'inherit', stderr: 'inherit' };
}

async function waitForHelper(backend: ContainerBackend, helperId: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const r = await backend.exec(helperId, ['test', '-f', READY_FILE], { timeoutMs: 1000 });
      if (r.exitCode === 0) return;
    } catch (err) {
      if (!(err instanceof ExecTimeoutError)) {
        throw new StartError(`Network helper failed before the firewall was ready: ${message(err)}`, 'firewall');
      }
    }
    if (Date.now() >= deadline) {
      throw new StartError(`Network helper did not report ready within ${READY_TIMEOUT_MS / 1000}s`, 'firewall');
    }
    await new Promise(r => setTimeout(r, READY_POLL_MS));
  }
}

function helperEnv(options: StartOptions, origin: { originUrl: string; originHost: string }, env: Record<string, string>): Record<string, string> {
  const bedrockRegion = truthy(env.CLAUDE_CODE_USE_BEDROCK) ? env.AWS_REGION || env.AWS_DEFAULT_REGION : undefined;
  // The port lets the allowlist check reach origin wherever it listens (git://, https on :8443, ssh on :2222)
  return firewallEnv(options.config.container, '', origin.originHost, bedrockRegion, originPort(origin.originUrl));
}

function helperSpec(
  names: ContainerNames,
  mainId: string,
  mainLabels: Record<string, string>,
  kunjVersion: string,
  env: Record<string, string>
): ContainerSpec {
  return {
    name: names.helper,
    image: NETHELPER_TAG(kunjVersion),
    labels: labelsFor(mainLabels[LABEL.repo], mainLabels[LABEL.branch], { [LABEL.version]: kunjVersion, [LABEL.role]: 'helper' }),
    env,
    network: names.network,
    workdir: '/',
    volumes: [],
    publish: [],
    capabilities: ['NET_ADMIN', 'NET_RAW'],
    networkOf: mainId,
    init: false,
    command: [],
  };
}

interface UpState { startedMain: boolean; helperCreated: boolean }

/**
 * Bring an existing main container up behind a fresh network helper. Nothing is exec'd in main
 * before the helper reports ready: the firewall accepts established connections, so anything
 * opened earlier would outlive the rules. `state` says what to undo when this throws.
 */
async function bringUp(
  backend: ContainerBackend,
  names: ContainerNames,
  main: ContainerInfo,
  fwEnv: Record<string, string>,
  kunjVersion: string,
  warn: (m: string) => void,
  state: UpState
): Promise<void> {
  await step('image', () => ensureImage(backend, resolveHelperImage(kunjVersion), warn));
  if (main.state !== 'running') {
    await step('docker', () => backend.start(main.id));
    state.startedMain = true;
  }
  // Always a fresh helper: a stale ready file survives a docker restart, the rules do not
  await step('docker', () => backend.remove({ containers: [names.helper] }));
  state.helperCreated = true;
  const helperId = await step('docker', () => backend.run(helperSpec(names, main.id, main.labels, kunjVersion, fwEnv)));
  await waitForHelper(backend, helperId);
}

/** Never leave a container this run started running without its firewall. */
async function undoUp(backend: ContainerBackend, names: ContainerNames, mainId: string, state: UpState, warn: (m: string) => void): Promise<void> {
  try {
    if (state.helperCreated) await backend.remove({ containers: [names.helper] });
    if (state.startedMain) await backend.stop(mainId);
  } catch (err) {
    warn(`Could not undo this start: ${message(err)}`);
  }
}

const NETHELPER_TAG = (version: string) => resolveHelperImage(version).tag;

/** Refuse root (the branch can edit devcontainer.json) and warn about missing tools. */
async function checkImage(backend: ContainerBackend, id: string, source: ImageSource, warn: (m: string) => void): Promise<void> {
  if (source.kind === 'sandbox') return;
  if (source.kind === 'devcontainer') {
    let uid: string;
    try {
      const r = await backend.exec(id, ['id', '-u'], { user: source.user || undefined });
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      uid = r.stdout.trim();
    } catch (err) {
      throw new StartError(`remoteUser "${source.user}" does not exist in the image (${message(err)})`, 'image');
    }
    if (uid === '0') {
      throw new StartError('The devcontainer image runs as root; set remoteUser to a non-root user', 'image');
    }
  }
  const r = await backend.exec(id, ['sh', '-c', 'for t in git tmux socat; do command -v $t >/dev/null 2>&1 || echo $t; done'], {
    user: source.user || undefined,
  });
  const missing = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (missing.length) warn(`The image lacks ${missing.join(', ')}; some kunj container features will not work`);
}

async function seedIfNeeded(
  backend: ContainerBackend,
  id: string,
  user: string,
  home: string | null,
  options: StartOptions,
  origin: { originUrl: string; originHost: string },
  hasToken: boolean,
  alreadySeeded: boolean,
  fromSnapshot: boolean
): Promise<boolean> {
  if (alreadySeeded) return false;
  if (user) {
    // A volume over a path the image lacks is root-owned; the clone runs as the user
    await backend.exec(id, ['chown', user, WORKSPACE, ...(home ? [home] : [])], { user: 'root' });
  }
  const credentialHelper = hasToken ? await installCredentialHelper(backend, id, user, home) : undefined;
  const identity = await hostGitIdentity(options.cwd);
  const script = seedScript({
    originUrl: origin.originUrl,
    originHost: origin.originHost,
    branch: options.branch,
    create: options.create,
    base: options.base,
    userName: identity.name,
    userEmail: identity.email,
    hasToken,
    credentialHelper,
    seedFrom: fromSnapshot ? SEED_DIR : undefined,
  });
  const r = await backend.exec(id, ['sh', '-c', script], { user: user || undefined, ...outputIO(options.jsonMode) });
  if (r.exitCode !== 0) {
    const what = fromSnapshot ? `Seeding the workspace from the snapshot (origin ${origin.originUrl})` : `Cloning ${origin.originUrl}`;
    throw new StartError(
      `${what} in the container failed (exit ${r.exitCode}).` +
        (hasToken ? '' : ' If origin needs authentication, forward a token with container.env (GH_TOKEN, GITHUB_TOKEN or GITLAB_TOKEN).'),
      'seed'
    );
  }
  return true;
}

async function extractInto(backend: ContainerBackend, id: string, user: string, dir: string, tar: NodeJS.ReadableStream): Promise<void> {
  // tar as the user so the files belong to them (docker cp would make them root's)
  const r = await backend.exec(id, ['sh', '-c', 'mkdir -p "$1" && tar -xf - -C "$1"', 'sh', dir], {
    user: user || undefined,
    stdin: tar,
  });
  if (r.exitCode !== 0) throw new Error(`Copying files into ${dir} failed (exit ${r.exitCode})`);
}

// Any image, not just kunj-sandbox, needs the helper the seed points credential.helper at. It goes
// in $HOME (the home volume when there is one), owned by the user.
async function installCredentialHelper(backend: ContainerBackend, id: string, user: string, home: string | null): Promise<string> {
  const dir = path.posix.join(await containerHome(backend, id, user, home), '.kunj', 'bin');
  const tar = tarEntries([{ path: CREDENTIAL_HELPER, content: fs.readFileSync(credentialHelperSource()), mode: 0o755 }]);
  await extractInto(backend, id, user, dir, tar);
  return path.posix.join(dir, CREDENTIAL_HELPER);
}

async function containerHome(backend: ContainerBackend, id: string, user: string, home: string | null): Promise<string> {
  if (home) return home;
  const r = await backend.exec(id, ['sh', '-c', 'printf %s "$HOME"'], { user: user || undefined });
  return r.stdout.trim() || '/root';
}

function splitFileEntry(entry: string): [string, string] | null {
  // Skip a Windows drive letter when looking for the separator
  const from = /^[A-Za-z]:[\\/]/.test(entry) ? 2 : 0;
  const i = entry.indexOf(':', from);
  return i > 0 ? [entry.slice(0, i), entry.slice(i + 1)] : null;
}

async function copyFiles(
  backend: ContainerBackend,
  id: string,
  user: string,
  home: string | null,
  options: StartOptions,
  vars: ConfigVariables
): Promise<{ keptFiles: string[]; copiedFiles: string[] }> {
  const keptFiles: string[] = [];
  if (options.config.container?.keepFiles !== false) {
    const keepDir = getKeepDir();
    const entries = listKeptFiles().map(rel => {
      const full = path.join(keepDir, ...rel.split('/'));
      return { path: rel, content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 };
    });
    if (entries.length) {
      await extractInto(backend, id, user, WORKSPACE, tarEntries(entries));
      keptFiles.push(...entries.map(e => e.path));
    }
  }

  const copiedFiles: string[] = [];
  let resolvedHome: string | undefined;
  for (const entry of options.config.container?.files ?? []) {
    const parts = splitFileEntry(entry);
    if (!parts) {
      options.warn(`container.files: "${entry}" is not hostPath:containerPath; skipped`);
      continue;
    }
    const hostPath = expandVariables(parts[0], vars).replace(/^~(?=$|\/)/, os.homedir());
    let target = expandVariables(parts[1], vars);
    if (!path.posix.isAbsolute(target)) {
      resolvedHome ??= await containerHome(backend, id, user, home);
      target = path.posix.join(resolvedHome, target.replace(/^~(\/|$)/, ''));
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(hostPath);
    } catch {
      options.warn(`container.files: ${hostPath} not found; skipped`);
      continue;
    }
    if (stat.isDirectory()) {
      await extractInto(backend, id, user, target, tarDirectory(hostPath));
    } else {
      const tar = tarEntries([{ path: path.posix.basename(target), content: fs.readFileSync(hostPath), mode: stat.mode & 0o777 }]);
      await extractInto(backend, id, user, path.posix.dirname(target), tar);
    }
    copiedFiles.push(target);
  }
  return { keptFiles, copiedFiles };
}

/** How setup, maintain and the devcontainer commands run: in the workspace, as the user. */
function commandIO(user: string, jsonMode: boolean): ExecIO {
  return { user: user || undefined, workdir: WORKSPACE, ...outputIO(jsonMode) };
}

async function postCommands(
  backend: ContainerBackend,
  id: string,
  user: string,
  spec: Pick<DevcontainerSpec, 'postCreateCommand' | 'postStartCommand'> | undefined,
  options: StartOptions
): Promise<void> {
  const io = commandIO(user, options.jsonMode);
  const marker = `"$HOME/${POST_CREATE_MARKER}"`;
  if (spec?.postCreateCommand) {
    const done = await backend.exec(id, ['sh', '-c', `test -f ${marker}`], { user: user || undefined });
    if (done.exitCode !== 0) {
      const r = await backend.exec(id, ['sh', '-lc', spec.postCreateCommand], io);
      if (r.exitCode === 0) await backend.exec(id, ['sh', '-c', `touch ${marker}`], { user: user || undefined });
      else options.warn(`postCreateCommand failed (exit ${r.exitCode}); it runs again on the next start`);
    }
  }
  if (spec?.postStartCommand) {
    const r = await backend.exec(id, ['sh', '-lc', spec.postStartCommand], io);
    if (r.exitCode !== 0) options.warn(`postStartCommand failed (exit ${r.exitCode})`);
  }
}

// Only called after READY. Labels cannot change after `docker run`, so this is reported, not
// recorded: later commands pass no -u for a recorded '', which docker resolves to the same user.
async function effectiveUser(backend: ContainerBackend, id: string, user: string): Promise<string> {
  if (user) return user;
  const r = await backend.exec(id, ['id', '-un']);
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

async function hasSeedMarker(backend: ContainerBackend, id: string): Promise<boolean> {
  return (await backend.exec(id, ['test', '-f', SEED_MARKER])).exitCode === 0;
}

function variables(options: StartOptions): ConfigVariables {
  return { repoRoot: options.repo.root, repoName: options.repo.name, home: os.homedir(), branch: options.branch };
}

function homeFor(source: ImageSource): string | null {
  return source.user ? `/home/${source.user}` : null;
}

// ---------------------------------------------------------------------------------------------
// start

function once<T>(fn: (() => Promise<T>) | undefined): (() => Promise<T>) | undefined {
  if (!fn) return undefined;
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

export async function startContainer(backend: ContainerBackend, startOptions: StartOptions): Promise<StartResult> {
  // Asked by the blueprint resolution and the build check: one git call is enough
  const options: StartOptions = { ...startOptions, defaultBranch: once(startOptions.defaultBranch) };
  const { branch, repo, warn } = options;
  const cfg = options.config.container;
  const labelBranch = options.namesFor ?? branch;
  const names = containerNames(repo.name, repo.id, labelBranch);
  const vars = variables(options);

  await step('docker', () => backend.info());

  // An existing container is resumed whatever origin now has: its clone is the source of truth
  const labels = await step('docker', () => backend.inspectLabels(names.container));
  if (labels && !labelsMatch(labels, repo.id, labelBranch)) {
    throw new StartError(`A container named ${names.container} exists but does not belong to ${repo.name} ${labelBranch}`, 'collision');
  }

  // Origin (only its host matters for an existing container; the fetch may fail)
  const origin = await step('origin', () => inspectOrigin(branch, options.cwd));
  if (!origin.originHost) {
    throw new StartError('Origin has no host; a container can only clone from a remote origin', 'origin');
  }
  const env = forwardedEnv(cfg, options.hostEnv, vars);
  const hasToken = TOKEN_KEYS.some(k => env[k]);

  if (labels && !options.rebuild) {
    return resume(backend, options, names, origin, env, hasToken);
  }

  if (!labels) {
    if (origin.isSsh && !hasToken) {
      throw new StartError(
        `Origin ${origin.originUrl} uses SSH, which the container cannot use without a token; forward GH_TOKEN, GITHUB_TOKEN or GITLAB_TOKEN with container.env`,
        'no-token'
      );
    }
    if (options.create) {
      if (!options.base) throw new StartError('No base branch to create the branch from', 'base-missing');
      const base = options.base;
      if (!(await step('origin', () => refExistsOnOrigin(base, options.cwd)))) {
        throw new StartError(`Base ${base} is not on origin`, 'base-missing');
      }
    }

    // Origin must have the work the new clone starts from
    if (!options.create && (origin.unpushed > 0 || !origin.branchOnOrigin)) {
      const what = origin.branchOnOrigin
        ? `${branch} has ${origin.unpushed} commit${origin.unpushed === 1 ? '' : 's'} origin does not have`
        : `${branch} is not on origin`;
      if (options.jsonMode || !(await options.confirmPush())) {
        throw new StartError(`${what}; push it first (the container clones from origin)`, 'unpushed');
      }
      await step('unpushed', () => pushBranch(branch, options.cwd));
    }
  }

  if (cfg?.agentCommand?.trim().startsWith('claude') !== false && !CLAUDE_AUTH_KEYS.some(k => env[k])) {
    warn('None of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CODE_USE_BEDROCK is forwarded; Claude Code will need a login inside the container');
  }

  // 4. Images
  const { source, plan } = await step('image', () => resolveSource(backend, options, warn));
  await step('image', () => warnOnChangedBuild(backend, options, source));
  const image = await step('image', async () => {
    if (options.rebuild && source.build) await backend.buildImage(source.tag, source.build.contextTar(), {
      dockerfile: source.build.dockerfile,
      buildArgs: source.build.buildArgs,
    });
    return ensureImage(backend, source, warn);
  });
  await step('image', () => ensureImage(backend, resolveHelperImage(options.kunjVersion), warn));
  if (labels) {
    // --rebuild: a new container on the same volumes, once the new image is there
    await step('docker', () => backend.remove({ containers: [names.helper, names.container] }));
  }

  const user = source.user;
  const home = homeFor(source);
  const publish = await mapPorts(requestedPorts(options, source.spec));
  const firewall = firewallMode(cfg);
  const fwEnv = helperEnv(options, origin, env);
  // What this run created, and so what a failure removes. Volumes kept by `remove --keep-volumes`
  // existed before and are never removed here.
  const created: { containers: string[]; volumes: string[]; networks: string[] } = { containers: [], volumes: [], networks: [] };
  // Set once the firewall is in place; a main container running before that is unfirewalled
  let mainRun = false;
  let ready = false;

  try {
    // 5. Network and volumes
    const objLabels = labelsFor(repo.id, labelBranch, { [LABEL.version]: options.kunjVersion });
    await step('docker', async () => {
      try {
        await backend.createNetwork(names.network, objLabels);
        created.networks.push(names.network);
      } catch (err) {
        if (!/already exists/i.test(message(err))) throw err;
      }
    });
    const volumes = [{ name: names.workspaceVolume, path: WORKSPACE }];
    if (home) volumes.push({ name: names.homeVolume, path: home });
    else warn('The image has no known user, so its home directory is not kept in a volume');
    for (const v of volumes) {
      if (await step('docker', () => backend.volumeExists(v.name))) continue;
      await step('docker', () => backend.createVolume(v.name, objLabels));
      created.volumes.push(v.name);
    }

    // 6. Main container: all capabilities dropped except MAIN_CAPABILITIES, and the image's ENTRYPOINT (branch-controlled for a
    // devcontainer) replaced by sleep, so nothing of the image's runs before the firewall is up
    const spec: ContainerSpec = {
      name: names.container,
      image,
      labels: labelsFor(repo.id, labelBranch, {
        [LABEL.base]: options.base ?? '',
        [LABEL.version]: options.kunjVersion,
        // helperEnv lets a stopped container be brought up behind its firewall again (remove guard);
        // user and the post commands are what resuming needs, even once the branch is gone from origin
        [LABEL.options]: JSON.stringify({
          firewall,
          allowHost: !!cfg?.network?.allowHost,
          publish,
          helperEnv: fwEnv,
          user,
          postCreateCommand: source.spec?.postCreateCommand,
          postStartCommand: source.spec?.postStartCommand,
          // For `list`, and the seed of a resumed container that never finished seeding
          imageKind: source.kind,
          blueprintHash: plan?.hash,
        }),
        [LABEL.role]: 'main',
      }),
      // The devcontainer comes from the branch: it must not override the credential host or secrets
      env: { ...(source.spec?.containerEnv ?? {}), ...env, KUNJ_CREDENTIAL_HOST: origin.credentialHost },
      network: names.network,
      user: user || undefined,
      workdir: WORKSPACE,
      volumes,
      publish,
      cpus: cfg?.cpus || undefined,
      memory: cfg?.memory || undefined,
      capDrop: ['ALL'],
      capabilities: MAIN_CAPABILITIES,
      // Docker Desktop resolves it anyway; Linux engines need the mapping (the firewall still
      // blocks it unless allowHost)
      extraHosts: ['host.docker.internal:host-gateway'],
      init: true,
      entrypoint: ['sleep'],
      command: ['infinity'],
    };
    // Listed before run: a run that creates the container but fails to start it leaves it behind
    // (the label check above ruled out a container of someone else's by this name)
    created.containers.unshift(names.container);
    const id = await step('docker', () => backend.run(spec));
    mainRun = true;

    // 7. Network helper
    created.containers.unshift(names.helper);
    const helperId = await step('docker', () => backend.run(helperSpec(names, id, spec.labels, options.kunjVersion, fwEnv)));
    await waitForHelper(backend, helperId);
    ready = true;

    // 8. Nothing runs in the container before this point. Seed, once the firewall is in place
    const seededBefore = await step('docker', () => hasSeedMarker(backend, id));
    await checkImage(backend, id, source, warn);
    const runAs = await step('docker', () => effectiveUser(backend, id, user));
    const fromSnapshot = source.kind === 'blueprint';
    const seeded = await step('seed', () => seedIfNeeded(backend, id, user, home, options, origin, hasToken, seededBefore, fromSnapshot));

    // 9. Files
    const files = await step('docker', () => copyFiles(backend, id, user, home, options, vars));

    // 10. Blueprint: presets and setup once (a snapshot already holds them), maintain every start
    let blueprint: StartResult['blueprint'];
    if (plan) {
      const io = commandIO(user, options.jsonMode);
      const bp = plan.resolved.blueprint;
      // Every new container without a snapshot, also on a kept workspace volume (--rebuild,
      // remove --keep-volumes): the image is new, so its tools are not there yet
      const provisioned = !plan.snapshot
        ? await step('setup', () => provisionNew(backend, id, bp, plan.presets, runAs, io, warn))
        : { toolsRun: [], setupRan: false };
      const maintainRan = await step('docker', () => maintain(backend, id, bp, io, warn));
      blueprint = {
        hash: plan.hash,
        snapshot: plan.snapshot?.tag ?? null,
        stale: plan.snapshot?.stale ?? false,
        ...provisioned,
        maintainRan,
      };
    }

    // 11. Devcontainer commands
    await step('docker', () => postCommands(backend, id, user, source.spec, options));

    return { names, containerId: id, image, user: runAs, created: true, seeded, ...files, publish, firewall, ...(blueprint ? { blueprint } : {}) };
  } catch (err) {
    if (options.keepOnError && mainRun && !ready) {
      // Kept for debugging, but never left running without its firewall
      try {
        await backend.stop(names.container);
      } catch (stopErr) {
        warn(`Could not stop ${names.container}: ${message(stopErr)}`);
      }
    }
    if (!options.keepOnError) {
      try {
        await backend.remove({
          containers: created.containers,
          volumes: created.volumes,
          networks: created.networks,
        });
      } catch (cleanup) {
        warn(`Could not remove what this start created: ${message(cleanup)}`);
      }
    }
    throw err;
  }
}

function parseOptionsLabel(labels: Record<string, string>): {
  publish?: Array<{ container: number; host: number }>;
  helperEnv?: Record<string, string>;
  user?: string;
  postCreateCommand?: string;
  postStartCommand?: string;
  imageKind?: ImageSource['kind'];
  blueprintHash?: string;
} {
  try {
    return JSON.parse(labels[LABEL.options] ?? '{}');
  } catch {
    return {};
  }
}

async function resume(
  backend: ContainerBackend,
  options: StartOptions,
  names: ContainerNames,
  origin: { originUrl: string; originHost: string },
  env: Record<string, string>,
  hasToken: boolean
): Promise<StartResult> {
  const { repo, warn } = options;
  const found = await step('docker', () => backend.list(labelsFor(repo.id, options.namesFor ?? options.branch)));
  const main = found.find(c => c.name === names.container);
  if (!main) throw new StartError(`Container ${names.container} disappeared while starting`, 'docker');
  const helper: ContainerInfo | undefined = found.find(c => c.name === names.helper);
  const firewall = firewallMode(options.config.container);
  const recorded = parseOptionsLabel(main.labels);
  const result: StartResult = {
    names,
    containerId: main.id,
    image: main.image,
    user: recorded.user ?? '',
    created: false,
    seeded: false,
    keptFiles: [],
    copiedFiles: [],
    publish: main.ports.length ? main.ports : recorded.publish ?? [],
    firewall,
  };
  if (main.state === 'running' && helper?.state === 'running') return result;

  const state: UpState = { startedMain: false, helperCreated: false };
  let ready = false;
  try {
    await bringUp(backend, names, main, helperEnv(options, origin, env), options.kunjVersion, warn, state);
    ready = true;

    const user = recorded.user ?? '';
    const home = user ? `/home/${user}` : null;
    result.user = await step('docker', () => effectiveUser(backend, main.id, user));
    const seededBefore = await step('docker', () => hasSeedMarker(backend, main.id));
    const fromSnapshot = recorded.imageKind === 'blueprint';
    result.seeded = await step('seed', () =>
      seedIfNeeded(backend, main.id, user, home, options, origin, hasToken, seededBefore, fromSnapshot));
    if (result.seeded) {
      Object.assign(result, await step('docker', () => copyFiles(backend, main.id, user, home, options, variables(options))));
    }
    // An existing container is never set up again, but maintain absorbs lockfile drift every start.
    // A broken blueprint must not keep the container from starting, so it is only a warning here.
    let resolved: ResolvedBlueprint | null = null;
    try {
      resolved = await loadBlueprint(options);
    } catch (err) {
      warn(`Blueprint not loaded, maintain skipped: ${message(err)}`);
    }
    if (resolved) {
      const bp = resolved.blueprint;
      const maintainRan = await step('docker', () => maintain(backend, main.id, bp, commandIO(user, options.jsonMode), warn));
      result.blueprint = {
        hash: recorded.blueprintHash ?? '',
        snapshot: fromSnapshot ? main.image : null,
        toolsRun: [],
        setupRan: false,
        maintainRan,
      };
    }
    await step('docker', () => postCommands(backend, main.id, user, recorded, options));
    return result;
  } catch (err) {
    if (!options.keepOnError) {
      await undoUp(backend, names, main.id, state, warn);
    } else if (!ready && state.startedMain) {
      // Keep the helper to debug, but stop the container this run started without a firewall
      await undoUp(backend, names, main.id, { startedMain: true, helperCreated: false }, warn);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// stop, remove, status

export async function stopContainer(backend: ContainerBackend, names: ContainerNames): Promise<void> {
  // The firewall rules live in the container's network namespace, so the helper can go first
  try {
    await backend.stop(names.helper);
  } catch {
    // no helper (or already stopped)
  }
  await backend.stop(names.container);
}

// The workspace's .git/config is the agent's: git must not run its fsmonitor or hooks for kunj
const SAFE_GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const G = SAFE_GIT.join(' ');

// Sections parsed by parseGuard; untracked files are not protected, as with `git worktree remove`.
// A detached HEAD counts as a ref; a ref whose rev-list fails prints no count and counts as unpushed.
// The stash and status sections end with their git exit code, so a failure is never read as clean.
const GUARD_SCRIPT = [
  `cd ${WORKSPACE} 2>/dev/null && [ -d .git ] || { echo @@none; exit 0; }`,
  'echo @@refs',
  `{ ${G} symbolic-ref -q HEAD >/dev/null || echo HEAD; ${G} for-each-ref --format='%(refname)' refs/heads; } | while read -r ref; do`,
  `  echo "$ref $(${G} rev-list --count "$ref" --not --remotes=origin -- 2>/dev/null)"`,
  'done',
  'echo @@stash',
  `out=$(${G} stash list); rc=$?; printf '%s\n' "$out" | grep -c .; echo "@@stash-exit $rc"`,
  'echo @@status',
  `out=$(${G} status --porcelain=v2 --branch --untracked-files=no); rc=$?; [ -z "$out" ] || printf '%s\n' "$out"; echo "@@status-exit $rc"`,
].join('\n');

const ORIGIN_TIMEOUT_MS = 15000;

async function mainInfo(backend: ContainerBackend, names: ContainerNames): Promise<ContainerInfo> {
  const labels = await backend.inspectLabels(names.container);
  if (!labels) throw new Error(`No container ${names.container}`);
  const found = await backend.list({ [LABEL.repo]: labels[LABEL.repo], [LABEL.branch]: labels[LABEL.branch] });
  const main = found.find(c => c.name === names.container);
  if (!main) throw new Error(`No container ${names.container}`);
  return main;
}

export interface RemoveContext {
  user: string;
  kunjVersion: string;
  warn?: (msg: string) => void;
}

/** Starts a stopped container (behind its firewall) to look inside, and stops it again. */
export async function inspectForRemove(backend: ContainerBackend, names: ContainerNames, ctx: RemoveContext): Promise<RemoveGuard> {
  const warn = ctx.warn ?? (() => {});
  const main = await mainInfo(backend, names);
  const state: UpState = { startedMain: false, helperCreated: false };
  if (main.state !== 'running') {
    const fwEnv = parseOptionsLabel(main.labels).helperEnv;
    if (!fwEnv) throw new Error(`${names.container} has no recorded firewall settings, so it cannot be checked safely; use --force`);
    try {
      await bringUp(backend, names, main, fwEnv, ctx.kunjVersion, warn, state);
    } catch (err) {
      await undoUp(backend, names, main.id, state, warn);
      throw err;
    }
  }
  try {
    const io: ExecIO = { user: ctx.user || undefined, workdir: WORKSPACE };
    const r = await backend.exec(main.id, ['sh', '-c', GUARD_SCRIPT], io);
    if (r.exitCode !== 0) throw new Error(`Could not inspect ${names.container} for unpushed work (exit ${r.exitCode}); use --force`);
    if (r.stdout.split('\n')[0].trim() === '@@none') {
      // Never cloned: nothing to lose
      return { unpushedRefs: [], stashes: 0, dirty: false, originReachable: true };
    }
    let originReachable = false;
    try {
      const ls = await backend.exec(main.id, [...SAFE_GIT, 'ls-remote', '--exit-code', 'origin', 'HEAD'], {
        ...io,
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: ORIGIN_TIMEOUT_MS,
      });
      originReachable = ls.exitCode === 0;
    } catch {
      originReachable = false;
    }
    return { ...parseGuard(r.stdout), originReachable };
  } finally {
    if (state.startedMain) await stopContainer(backend, names);
  }
}

/** Throws unless `force` when the container holds work origin does not have. */
export async function removeContainer(
  backend: ContainerBackend,
  names: ContainerNames,
  opts: RemoveContext & { force: boolean; keepVolumes: boolean }
): Promise<RemoveGuard> {
  let guard: RemoveGuard = { unpushedRefs: [], stashes: 0, dirty: false, originReachable: true };
  if (!opts.force) {
    guard = await inspectForRemove(backend, names, opts);
    const problems = describeGuard(guard);
    if (problems.length) throw new Error(`Container has unpushed work: ${problems.join('; ')}; use --force`);
  }
  await backend.remove({
    containers: [names.helper, names.container],
    volumes: opts.keepVolumes ? [] : [names.workspaceVolume, names.homeVolume],
    networks: [names.network],
  });
  return guard;
}

const STATUS_SCRIPT = `tmux has-session -t agent 2>/dev/null; echo "tmux=$?"; cd ${WORKSPACE} && ${G} status --porcelain=v2 --branch`;

/** One exec per container, bounded by timeoutMs, so a listing never hangs on one container. */
export async function containerStatus(backend: ContainerBackend, id: string, user: string, timeoutMs = 2000): Promise<ContainerStatus> {
  try {
    const r = await backend.exec(id, ['sh', '-c', STATUS_SCRIPT], { user: user || undefined, timeoutMs });
    return parseStatus(r.stdout);
  } catch (err) {
    if (err instanceof ExecTimeoutError) return emptyStatus('timeout');
    if (/is not running/i.test(message(err))) return emptyStatus('stopped');
    return emptyStatus('error');
  }
}
