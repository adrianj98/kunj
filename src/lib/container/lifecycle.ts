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
import { ImageSource, ensureImage, resolveHelperImage, resolveImage, tarDirectory, tarEntries } from './image';
import { DEVCONTAINER_PATHS, DevcontainerSpec, parseDevcontainer } from './devcontainer';
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
import { ConfigVariables, expandVariables } from '../config-vars';
import { KunjConfig } from '../../types';

export { forwardedEnv, firewallEnv } from './env';
export type { ContainerStatus, RemoveGuard } from './env';

const execFileAsync = promisify(execFile);

const WORKSPACE = '/workspace';
const READY_FILE = '/tmp/kunj-ready';
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 300;
const POST_CREATE_MARKER = '.kunj-created';
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
  | 'collision';

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
}

export interface StartResult {
  names: ContainerNames;
  containerId: string;
  image: string;
  created: boolean;
  seeded: boolean;
  keptFiles: string[];
  copiedFiles: string[];
  publish: Array<{ container: number; host: number }>;
  firewall: 'default' | 'allowlist';
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

async function resolveSource(options: StartOptions, warn: (m: string) => void): Promise<ImageSource> {
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
  return resolveImage({ setting, devcontainer, repoName: options.repo.name, kunjVersion: options.kunjVersion });
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
  const all = [...options.publish, ...(options.config.container?.publish ?? []).map(p => parseInt(p, 10)), ...(spec?.forwardPorts ?? [])];
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
  alreadySeeded: boolean
): Promise<boolean> {
  if (alreadySeeded) return false;
  if (user) {
    // A volume over a path the image lacks is root-owned; the clone runs as the user
    await backend.exec(id, ['chown', user, WORKSPACE, ...(home ? [home] : [])], { user: 'root' });
  }
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
  });
  const r = await backend.exec(id, ['sh', '-c', script], { user: user || undefined, ...outputIO(options.jsonMode) });
  if (r.exitCode !== 0) {
    throw new StartError(
      `Cloning ${origin.originUrl} in the container failed (exit ${r.exitCode}).` +
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

async function postCommands(
  backend: ContainerBackend,
  id: string,
  user: string,
  spec: Pick<DevcontainerSpec, 'postCreateCommand' | 'postStartCommand'> | undefined,
  options: StartOptions
): Promise<void> {
  const io: ExecIO = { user: user || undefined, workdir: WORKSPACE, ...outputIO(options.jsonMode) };
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

export async function startContainer(backend: ContainerBackend, options: StartOptions): Promise<StartResult> {
  const { branch, repo, warn } = options;
  const cfg = options.config.container;
  const names = containerNames(repo.name, repo.id, branch);
  const vars = variables(options);

  await step('docker', () => backend.info());

  // An existing container is resumed whatever origin now has: its clone is the source of truth
  const labels = await step('docker', () => backend.inspectLabels(names.container));
  if (labels && !labelsMatch(labels, repo.id, branch)) {
    throw new StartError(`A container named ${names.container} exists but does not belong to ${repo.name} ${branch}`, 'collision');
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
  const source = await step('image', () => resolveSource(options, warn));
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
  const created: { containers: string[]; networks: string[] } = { containers: [], networks: [] };
  // Volumes may survive from `remove --keep-volumes`; they are only rolled back once known to hold no clone
  let volumesFresh = false;

  try {
    // 5. Network and volumes
    const objLabels = labelsFor(repo.id, branch, { [LABEL.version]: options.kunjVersion });
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
    for (const v of volumes) await step('docker', () => backend.createVolume(v.name, objLabels));

    // 6. Main container: all capabilities dropped except MAIN_CAPABILITIES, and the image's ENTRYPOINT (branch-controlled for a
    // devcontainer) replaced by sleep, so nothing of the image's runs before the firewall is up
    const spec: ContainerSpec = {
      name: names.container,
      image,
      labels: labelsFor(repo.id, branch, {
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
        }),
        [LABEL.role]: 'main',
      }),
      // The devcontainer comes from the branch: it must not override the credential host or secrets
      env: { ...(source.spec?.containerEnv ?? {}), ...env, KUNJ_CREDENTIAL_HOST: origin.originHost },
      network: names.network,
      user: user || undefined,
      workdir: WORKSPACE,
      volumes,
      publish,
      cpus: cfg?.cpus || undefined,
      memory: cfg?.memory || undefined,
      capDrop: ['ALL'],
      capabilities: MAIN_CAPABILITIES,
      init: true,
      entrypoint: ['sleep'],
      command: ['infinity'],
    };
    const id = await step('docker', () => backend.run(spec));
    created.containers.unshift(names.container);

    // 7. Network helper
    created.containers.unshift(names.helper);
    const helperId = await step('docker', () => backend.run(helperSpec(names, id, spec.labels, options.kunjVersion, fwEnv)));
    await waitForHelper(backend, helperId);

    // 8. Nothing runs in the container before this point. Seed, once the firewall is in place
    const seededBefore = await step('docker', () => hasSeedMarker(backend, id));
    volumesFresh = !seededBefore;
    await checkImage(backend, id, source, warn);
    const seeded = await step('seed', () => seedIfNeeded(backend, id, user, home, options, origin, hasToken, seededBefore));

    // 9. Files
    const files = await step('docker', () => copyFiles(backend, id, user, home, options, vars));

    // 10. Devcontainer commands
    await step('docker', () => postCommands(backend, id, user, source.spec, options));

    return { names, containerId: id, image, created: true, seeded, ...files, publish, firewall };
  } catch (err) {
    if (!options.keepOnError) {
      try {
        await backend.remove({
          containers: created.containers,
          volumes: volumesFresh ? volumeNames(names, home) : [],
          networks: created.networks,
        });
      } catch (cleanup) {
        warn(`Could not remove what this start created: ${message(cleanup)}`);
      }
    }
    throw err;
  }
}

function volumeNames(names: ContainerNames, home: string | null): string[] {
  return home ? [names.workspaceVolume, names.homeVolume] : [names.workspaceVolume];
}

function parseOptionsLabel(labels: Record<string, string>): {
  publish?: Array<{ container: number; host: number }>;
  helperEnv?: Record<string, string>;
  user?: string;
  postCreateCommand?: string;
  postStartCommand?: string;
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
  const { repo, branch, warn } = options;
  const found = await step('docker', () => backend.list(labelsFor(repo.id, branch)));
  const main = found.find(c => c.name === names.container);
  if (!main) throw new StartError(`Container ${names.container} disappeared while starting`, 'docker');
  const helper: ContainerInfo | undefined = found.find(c => c.name === names.helper);
  const firewall = firewallMode(options.config.container);
  const recorded = parseOptionsLabel(main.labels);
  const result: StartResult = {
    names,
    containerId: main.id,
    image: main.image,
    created: false,
    seeded: false,
    keptFiles: [],
    copiedFiles: [],
    publish: main.ports.length ? main.ports : recorded.publish ?? [],
    firewall,
  };
  if (main.state === 'running' && helper?.state === 'running') return result;

  const state: UpState = { startedMain: false, helperCreated: false };
  try {
    await bringUp(backend, names, main, helperEnv(options, origin, env), options.kunjVersion, warn, state);

    const user = recorded.user ?? '';
    const home = user ? `/home/${user}` : null;
    const seededBefore = await step('docker', () => hasSeedMarker(backend, main.id));
    result.seeded = await step('seed', () => seedIfNeeded(backend, main.id, user, home, options, origin, hasToken, seededBefore));
    if (result.seeded) {
      Object.assign(result, await step('docker', () => copyFiles(backend, main.id, user, home, options, variables(options))));
    }
    await step('docker', () => postCommands(backend, main.id, user, recorded, options));
    return result;
  } catch (err) {
    if (!options.keepOnError) await undoUp(backend, names, main.id, state, warn);
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
const GUARD_SCRIPT = [
  `cd ${WORKSPACE} 2>/dev/null && [ -d .git ] || { echo @@none; exit 0; }`,
  'echo @@refs',
  `{ ${G} symbolic-ref -q HEAD >/dev/null || echo HEAD; ${G} for-each-ref --format='%(refname)' refs/heads; } | while read -r ref; do`,
  `  echo "$ref $(${G} rev-list --count "$ref" --not --remotes=origin -- 2>/dev/null)"`,
  'done',
  'echo @@stash',
  `${G} stash list | wc -l`,
  'echo @@status',
  `${G} status --porcelain=v2 --branch --untracked-files=no`,
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
