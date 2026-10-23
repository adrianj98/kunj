// Sidecar services (Postgres, Redis, ...) for a branch container: one container per service on the
// branch's own network, reachable from the branch container by the service's name. Declared in the
// blueprint, container.services or the devcontainer's compose file. A service image comes from the
// branch, so it gets nothing from the host: no env but its own, no mounts but its named volumes, no
// added capabilities, no published ports.
import { ContainerBackend, ContainerInfo, ContainerSpec, ExecTimeoutError, Labels, isImageRef } from './backend';
import { ContainerNames, LABEL, labelsFor, optionsLabel } from './names';

export interface ServiceSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  command?: string[];
  port?: number;
  healthcheck?: string;
  /** { volumeName: containerPath }; named volumes only, one per branch */
  volumes: Record<string, string>;
  dependsOn: string[];
}

export const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYS = new Set(['image', 'env', 'command', 'port', 'healthcheck', 'volumes', 'dependsOn']);

export const HEALTH_TIMEOUT_MS = 120_000;
export const HEALTH_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function validPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

/** `{ name: { image, env?, command?, port?, healthcheck?, volumes?, dependsOn? } }`; throws on anything else. */
export function parseServices(raw: unknown, source: string): ServiceSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) throw new Error(`${source}: services must be an object of name: { image, ... }`);
  const services: ServiceSpec[] = [];
  for (const [name, def] of Object.entries(raw)) {
    const where = `${source}: services.${name}`;
    if (!SERVICE_NAME.test(name)) throw new Error(`${where}: a service name may only use a-z, 0-9 and -`);
    if (!isRecord(def)) throw new Error(`${where} must be an object`);
    const unknown = Object.keys(def).filter(k => !KEYS.has(k));
    if (unknown.length) throw new Error(`${where}: unsupported keys ${unknown.sort().join(', ')}`);
    if (typeof def.image !== 'string' || !def.image.trim()) throw new Error(`${where}: image is required`);
    if (!isImageRef(def.image.trim())) throw new Error(`${where}: image "${def.image}" is not a valid image reference`);

    const env: Record<string, string> = {};
    if (def.env !== undefined) {
      if (!isRecord(def.env)) throw new Error(`${where}: env must be an object of NAME: value`);
      for (const [k, v] of Object.entries(def.env)) {
        if (!ENV_NAME.test(k)) throw new Error(`${where}: env.${k} is not a valid variable name`);
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error(`${where}: env.${k} must be a string`);
        env[k] = String(v);
      }
    }
    if (def.command !== undefined && (!isStringArray(def.command) || def.command.length === 0)) {
      throw new Error(`${where}: command must be a non-empty array of strings`);
    }
    if (def.port !== undefined && !validPort(def.port)) throw new Error(`${where}: port must be a number from 1 to 65535`);
    if (def.healthcheck !== undefined && (typeof def.healthcheck !== 'string' || !def.healthcheck.trim())) {
      throw new Error(`${where}: healthcheck must be a shell command string`);
    }

    const volumes: Record<string, string> = {};
    if (def.volumes !== undefined) {
      if (!isRecord(def.volumes)) throw new Error(`${where}: volumes must be an object of volumeName: containerPath`);
      for (const [vol, target] of Object.entries(def.volumes)) {
        // Nothing from the host: a path where the volume name goes would be a bind mount
        if (/^[/.~]/.test(vol) || vol.includes('/')) throw new Error(`${where}: volumes.${vol}: host paths are not allowed, only named volumes`);
        if (!VOLUME_NAME.test(vol)) throw new Error(`${where}: volumes.${vol} is not a valid volume name`);
        if (typeof target !== 'string' || !target.startsWith('/')) throw new Error(`${where}: volumes.${vol} must be an absolute path in the container`);
        volumes[vol] = target;
      }
    }
    if (def.dependsOn !== undefined && !isStringArray(def.dependsOn)) throw new Error(`${where}: dependsOn must be an array of service names`);

    services.push({
      name,
      image: def.image.trim(),
      env,
      ...(def.command ? { command: def.command as string[] } : {}),
      ...(def.port !== undefined ? { port: def.port as number } : {}),
      ...(def.healthcheck ? { healthcheck: def.healthcheck as string } : {}),
      volumes,
      dependsOn: (def.dependsOn as string[] | undefined) ?? [],
    });
  }
  return services;
}

// ---------------------------------------------------------------------------------------------
// Compose import

// Keys that would give a branch-controlled image host powers or host data, or that change how the
// service runs but are not supported; reported when dropped
const DROPPED_KEYS = [
  'build', 'privileged', 'cap_add', 'network_mode', 'devices', 'pid', 'ipc', 'security_opt',
  'volumes_from', 'userns_mode', 'cgroup_parent', 'env_file', 'extra_hosts', 'sysctls', 'runtime',
  'entrypoint', 'user', 'working_dir', 'tmpfs',
];

/** `${NAME:-default}` and `${NAME-default}` become the default; any other `${...}` is null (never read from the host). */
function substituteDefaults(value: string): string | null {
  let unresolved = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-([^}]*))?\}/g, (_m, _name, dflt, text) => {
    if (dflt === undefined) {
      unresolved = true;
      return '';
    }
    return text;
  });
  return unresolved || /\$\{/.test(out) ? null : out.replace(/\$\$/g, '$');
}

/** Shell-like split of a compose string command: whitespace separates, quotes group. */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || word) words.push(word);
      word = '';
      has = false;
    } else {
      word += c;
    }
  }
  if (has || word) words.push(word);
  return words;
}

function shellWord(s: string): string {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function composeHealthcheck(hc: unknown): string | undefined {
  if (!isRecord(hc) || hc.disable === true) return undefined;
  const test = hc.test;
  if (typeof test === 'string') return test.trim() || undefined;
  if (!isStringArray(test) || test.length === 0) return undefined;
  if (test[0] === 'NONE') return undefined;
  if (test[0] === 'CMD-SHELL') return test.slice(1).join(' ') || undefined;
  if (test[0] === 'CMD') return test.slice(1).map(shellWord).join(' ') || undefined;
  return test.map(shellWord).join(' ');
}

function firstPort(svc: Record<string, unknown>): number | undefined {
  for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
    const target = isRecord(p) ? Number(p.target) : parseInt(String(p).split(':').pop() ?? '', 10);
    if (validPort(target)) return target;
  }
  for (const e of Array.isArray(svc.expose) ? svc.expose : []) {
    const port = parseInt(String(e), 10);
    if (validPort(port)) return port;
  }
  return undefined;
}

/**
 * Services from `docker compose config --format json` output, without the devcontainer's own
 * service. `dropped` lists what was left out (`<service>.<key>`), for one warning.
 */
export function servicesFromCompose(config: any, excludeService?: string): { services: ServiceSpec[]; dropped: string[] } {
  const services: ServiceSpec[] = [];
  const dropped: string[] = [];
  const all = isRecord(config) && isRecord(config.services) ? config.services : {};
  for (const [name, raw] of Object.entries(all)) {
    if (name === excludeService) continue;
    if (!isRecord(raw)) continue;
    if (!SERVICE_NAME.test(name)) {
      dropped.push(`${name} (invalid name)`);
      continue;
    }
    const image = typeof raw.image === 'string' ? substituteDefaults(raw.image) : null;
    if (!image) {
      dropped.push(`${name} (no image${raw.build !== undefined ? '; build is not supported' : ''})`);
      continue;
    }
    if (!isImageRef(image)) {
      dropped.push(`${name} (invalid image "${image}")`);
      continue;
    }
    for (const key of DROPPED_KEYS) if (raw[key] !== undefined) dropped.push(`${name}.${key}`);

    const env: Record<string, string> = {};
    const environment = isRecord(raw.environment) ? raw.environment : {};
    for (const [k, v] of Object.entries(environment)) {
      const value = v === null || v === undefined ? null : substituteDefaults(String(v));
      if (value === null || !ENV_NAME.test(k)) dropped.push(`${name}.environment.${k}`);
      else env[k] = value;
    }

    let command: string[] | undefined;
    if (isStringArray(raw.command) && raw.command.length) command = raw.command;
    else if (typeof raw.command === 'string' && raw.command.trim()) command = splitWords(raw.command);

    const volumes: Record<string, string> = {};
    for (const v of Array.isArray(raw.volumes) ? raw.volumes : []) {
      if (isRecord(v) && v.type === 'volume' && typeof v.source === 'string' && VOLUME_NAME.test(v.source) && typeof v.target === 'string' && v.target.startsWith('/')) {
        volumes[v.source] = v.target;
      } else {
        const target = isRecord(v) ? v.target : v;
        dropped.push(`${name}.volumes ${String(target)}${isRecord(v) && v.type === 'bind' ? ' (host bind mount)' : ''}`);
      }
    }
    if (Array.isArray(raw.ports) && raw.ports.some(p => !isRecord(p) || p.published !== undefined)) dropped.push(`${name}.ports (published)`);

    const deps = raw.depends_on;
    const dependsOn = (isRecord(deps) ? Object.keys(deps) : isStringArray(deps) ? deps : []).filter(d => d !== excludeService);
    const port = firstPort(raw);
    const healthcheck = composeHealthcheck(raw.healthcheck);
    services.push({
      name,
      image,
      env,
      ...(command ? { command } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(healthcheck ? { healthcheck } : {}),
      volumes,
      dependsOn,
    });
  }
  // A dependency on a service left out above would fail every start; it is left out too
  const kept = new Set(services.map(s => s.name));
  for (const svc of services) {
    const gone = svc.dependsOn.filter(d => !kept.has(d));
    for (const d of gone) dropped.push(`${svc.name}: depends_on ${d} (dropped)`);
    if (gone.length) svc.dependsOn = svc.dependsOn.filter(d => kept.has(d));
  }
  return { services, dropped };
}

/** One list by name; the first layer that names a service wins. */
export function mergeServices(...layers: ServiceSpec[][]): ServiceSpec[] {
  const byName = new Map<string, ServiceSpec>();
  for (const layer of layers) for (const svc of layer) if (!byName.has(svc.name)) byName.set(svc.name, svc);
  return [...byName.values()];
}

/** Dependencies first, otherwise in declaration order; an unknown dependency or a cycle throws. */
export function serviceOrder(services: ServiceSpec[]): ServiceSpec[] {
  const byName = new Map(services.map(s => [s.name, s]));
  for (const s of services) {
    for (const d of s.dependsOn) if (!byName.has(d)) throw new Error(`Service ${s.name} depends on unknown service ${d}`);
  }
  const ordered: ServiceSpec[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (s: ServiceSpec, path: string[]) => {
    const seen = state.get(s.name);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`Services have a dependency cycle: ${[...path.slice(path.indexOf(s.name)), s.name].join(' -> ')}`);
    state.set(s.name, 'visiting');
    for (const d of s.dependsOn) visit(byName.get(d)!, [...path, s.name]);
    state.set(s.name, 'done');
    ordered.push(s);
  };
  for (const s of services) visit(s, []);
  return ordered;
}

// ---------------------------------------------------------------------------------------------
// Names, run spec, state

export function serviceNames(names: ContainerNames, svc: string): { container: string; volume: (v: string) => string } {
  const container = `${names.container}-svc-${svc}`;
  return { container, volume: (v: string) => `${container}-${v}` };
}

/** What a service records about itself in its kunj.options label (no env: values may be secrets). */
interface ServiceRecord {
  port?: number;
  healthcheck?: string;
  volumes: string[];
  dependsOn?: string[];
}

function serviceRecord(info: ContainerInfo): ServiceRecord {
  const r = optionsLabel(info.labels);
  return {
    port: r.port,
    healthcheck: r.healthcheck,
    volumes: Array.isArray(r.volumes) ? r.volumes : [],
    dependsOn: isStringArray(r.dependsOn) ? r.dependsOn : [],
  };
}

/** The run spec of one service: nothing from the host, on the branch network under its own name. */
export function serviceRunSpec(names: ContainerNames, repoId: string, branch: string, svc: ServiceSpec, kunjVersion = ''): ContainerSpec {
  const sn = serviceNames(names, svc.name);
  const volumes = Object.entries(svc.volumes).map(([v, p]) => ({ name: sn.volume(v), path: p }));
  const record: ServiceRecord = {
    port: svc.port,
    healthcheck: svc.healthcheck,
    volumes: volumes.map(v => v.name),
    ...(svc.dependsOn.length ? { dependsOn: svc.dependsOn } : {}),
  };
  return {
    name: sn.container,
    image: svc.image,
    labels: labelsFor(repoId, branch, {
      [LABEL.role]: 'service',
      [LABEL.service]: svc.name,
      [LABEL.version]: kunjVersion,
      [LABEL.options]: JSON.stringify(record),
    }),
    env: { ...svc.env },
    network: names.network,
    aliases: [svc.name],
    workdir: '',
    volumes,
    publish: [],
    // The image's own entrypoint and init: database images expect to be PID 1
    init: false,
    command: svc.command ?? [],
  };
}

/** Whose services: the kunj.repo and kunj.branch labels of the branch container. */
export interface ServiceOwner {
  repoId: string;
  branch: string;
}

/**
 * The service containers of a branch container, among `all` (any listing that includes them). The
 * labels decide; the name prefix alone could match another branch whose name extends this one's.
 */
export function servicesOf(all: ContainerInfo[], containerName: string, owner?: ServiceOwner): ContainerInfo[] {
  const prefix = `${containerName}-svc-`;
  return all.filter(c =>
    c.labels[LABEL.role] === 'service' &&
    c.name.startsWith(prefix) &&
    (!owner || (c.labels[LABEL.repo] === owner.repoId && c.labels[LABEL.branch] === owner.branch)));
}

export async function findServices(backend: ContainerBackend, names: ContainerNames, owner: ServiceOwner): Promise<ContainerInfo[]> {
  return servicesOf(await backend.list(labelsFor(owner.repoId, owner.branch, { [LABEL.role]: 'service' })), names.container, owner);
}

export interface ServiceState {
  name: string;
  state: string;
  port: number | null;
}

export function describeServices(found: ContainerInfo[]): ServiceState[] {
  return found
    .map(c => ({ name: c.labels[LABEL.service] ?? c.name, state: c.state, port: serviceRecord(c).port ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function serviceStates(backend: ContainerBackend, names: ContainerNames, owner: ServiceOwner): Promise<ServiceState[]> {
  return describeServices(await findServices(backend, names, owner));
}

/** Containers and volumes to remove with the branch container. */
export function serviceRemoval(found: ContainerInfo[], keepVolumes: boolean): { containers: string[]; volumes: string[] } {
  return {
    containers: found.map(c => c.name),
    volumes: keepVolumes ? [] : found.flatMap(c => serviceRecord(c).volumes),
  };
}

// ---------------------------------------------------------------------------------------------
// Start

export interface ServiceStartOptions {
  warn: (msg: string) => void;
  timeoutMs?: number;
  intervalMs?: number;
  kunjVersion?: string;
  /** Remove and recreate existing service containers (volumes are kept) */
  recreate?: boolean;
  /** Filled as objects are created, so a caller can roll back after a failure part way */
  created?: { containers: string[]; volumes: string[] };
}

function svcStub(name: string): ServiceSpec {
  return { name, image: '', env: {}, volumes: {}, dependsOn: [] };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Polls the health check; a service that is still not healthy after the timeout is a warning, not a failure. */
export async function waitHealthy(
  backend: ContainerBackend,
  id: string,
  svc: { name: string; healthcheck?: string },
  opts: Pick<ServiceStartOptions, 'warn' | 'timeoutMs' | 'intervalMs'>
): Promise<boolean> {
  if (!svc.healthcheck) return true;
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HEALTH_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await backend.exec(id, ['sh', '-c', svc.healthcheck], { timeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(timeoutMs, 1)) });
      if (r.exitCode === 0) return true;
    } catch (err) {
      if (!(err instanceof ExecTimeoutError)) {
        opts.warn(`Service ${svc.name} is not running (${message(err)}); see kunj ct logs <branch> ${svc.name}`);
        return false;
      }
    }
    if (Date.now() >= deadline) {
      const secs = timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : timeoutMs / 1000;
      opts.warn(`Service ${svc.name} did not pass its health check within ${secs}s; continuing`);
      return false;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Creates (or starts) each service in dependency order and waits for its health check before the
 * next. Volumes that already exist and containers that already run are reused.
 */
export async function startServices(
  backend: ContainerBackend,
  names: ContainerNames,
  repoId: string,
  branch: string,
  services: ServiceSpec[],
  opts: ServiceStartOptions
): Promise<{ created: string[]; volumes: string[] }> {
  const created = { containers: [] as string[], volumes: [] as string[] };
  const track = (kind: 'containers' | 'volumes', name: string) => {
    created[kind].push(name);
    opts.created?.[kind].push(name);
  };
  const ordered = serviceOrder(services);
  if (services.length === 0 && !opts.recreate) return { created: [], volumes: [] };
  const existing = new Map((await findServices(backend, names, { repoId, branch })).map(c => [c.name, c]));
  if (opts.recreate) {
    // --rebuild: a service no longer declared goes; its volumes stay, as `remove --keep-volumes` keeps them
    const declared = new Set(ordered.map(svc => serviceNames(names, svc.name).container));
    const undeclared = [...existing.values()].filter(c => !declared.has(c.name));
    if (undeclared.length) {
      await backend.remove({ containers: undeclared.map(c => c.name) });
      for (const c of undeclared) {
        existing.delete(c.name);
        const volumes = serviceRecord(c).volumes;
        opts.warn(`Removed service ${c.labels[LABEL.service] ?? c.name}: it is no longer declared` +
          (volumes.length ? `; its volumes are kept (${volumes.join(', ')}; docker volume rm them when you no longer need the data)` : ''));
      }
    }
  }
  const volumeLabels: Labels = labelsFor(repoId, branch, { [LABEL.role]: 'service', ...(opts.kunjVersion ? { [LABEL.version]: opts.kunjVersion } : {}) });

  for (const svc of ordered) {
    const spec = serviceRunSpec(names, repoId, branch, svc, opts.kunjVersion);
    for (const v of spec.volumes) {
      if (await backend.volumeExists(v.name)) continue;
      await backend.createVolume(v.name, volumeLabels);
      track('volumes', v.name);
    }
    let id: string;
    const found = existing.get(spec.name);
    if (found && !opts.recreate) {
      if (found.state !== 'running') await backend.start(found.id);
      id = found.id;
    } else {
      if (found) await backend.remove({ containers: [found.name] });
      // Listed before run: a run that creates the container but fails to start it leaves it behind
      track('containers', spec.name);
      id = await backend.run(spec);
    }
    await waitHealthy(backend, id, svc, opts);
  }
  return { created: created.containers, volumes: created.volumes };
}

/** Starts the stopped services among `found` (resume), dependencies first (as recorded in their labels). */
export async function resumeServices(
  backend: ContainerBackend,
  found: ContainerInfo[],
  opts: Pick<ServiceStartOptions, 'warn' | 'timeoutMs' | 'intervalMs'>
): Promise<void> {
  const byName = new Map(found.map(c => [c.labels[LABEL.service] ?? c.name, c]));
  let ordered = found;
  try {
    const specs = [...byName].map(([name, c]) => ({
      ...svcStub(name),
      dependsOn: (serviceRecord(c).dependsOn ?? []).filter(d => byName.has(d)),
    }));
    ordered = serviceOrder(specs).map(s => byName.get(s.name)!);
  } catch {
    // A recorded cycle cannot happen (it was refused at start); keep the listing order if it does
  }
  for (const c of ordered) {
    if (c.state === 'running') continue;
    await backend.start(c.id);
    await waitHealthy(backend, c.id, { name: c.labels[LABEL.service] ?? c.name, healthcheck: serviceRecord(c).healthcheck }, opts);
  }
}

export async function stopServices(
  backend: ContainerBackend,
  names: ContainerNames,
  owner: ServiceOwner,
  warn: (m: string) => void = () => {}
): Promise<void> {
  for (const c of await findServices(backend, names, owner)) {
    if (c.state !== 'running') continue;
    try {
      await backend.stop(c.id);
    } catch (err) {
      warn(`Could not stop service ${c.labels[LABEL.service] ?? c.name}: ${message(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Resolution

export interface ComposeSource {
  path: string;
  text: string;
}

/**
 * Blueprint services, then container.services, then the devcontainer's compose services (without
 * its own `service`), merged by name. Throws on an invalid definition or dependency graph.
 */
/**
 * Why kunj will not import a compose file, or null. `include` and `extends.file` make docker compose
 * read other files from the host (even with an empty project directory), so another project's
 * compose env could end up in a service this branch controls. A check on the raw text: any
 * `include:` key, and any `extends:` in a file that also has a `file:` key.
 */
export function composeRefusal(text: string): string | null {
  // Unanchored, so flow style ({ extends: { file: ... } }) and JSON are caught as well as block style
  const key = (name: string) => new RegExp(`(^|[\\s{,\\-])["']?${name}["']?\\s*:`, 'm');
  if (key('include').test(text)) return 'include is not supported';
  // Conservative: any extends in a file that has a `file:` key anywhere (extends within the file is fine)
  if (key('extends').test(text) && key('file').test(text)) return 'extends with a file is not supported';
  return null;
}

export async function resolveServices(
  backend: ContainerBackend,
  input: {
    blueprint?: ServiceSpec[];
    config?: unknown;
    compose?: ComposeSource[];
    devcontainerService?: string;
    warn: (msg: string) => void;
  }
): Promise<ServiceSpec[]> {
  const fromConfig = parseServices(input.config, 'container.services');
  const fromCompose: ServiceSpec[] = [];
  for (const file of input.compose ?? []) {
    const refused = composeRefusal(file.text);
    if (refused) {
      input.warn(`${file.path}: ${refused} by kunj's compose import; its services are not started`);
      continue;
    }
    let json: unknown;
    try {
      json = await backend.composeConfig(file.text);
    } catch (err) {
      input.warn(`${file.path}: could not read the compose file, its services are not started (${message(err)})`);
      continue;
    }
    const { services, dropped } = servicesFromCompose(json, input.devcontainerService);
    if (dropped.length) input.warn(`${file.path}: ignoring ${dropped.join(', ')}`);
    // A later compose file overrides an earlier one, as with docker compose -f a -f b
    fromCompose.unshift(...services);
  }
  const merged = mergeServices(input.blueprint ?? [], fromConfig, mergeServices(fromCompose));
  serviceOrder(merged);
  return merged;
}
