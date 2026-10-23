import { describe, it, expect, jest } from '@jest/globals';
import { FakeBackend } from './fake-backend';
import { ContainerInfo } from '../backend';
import { LABEL, containerNames, labelsFor } from '../names';
import { runArgs } from '../docker';
import {
  ServiceSpec,
  composeRefusal,
  describeServices,
  findServices,
  resumeServices,
  stopServices,
  mergeServices,
  parseServices,
  resolveServices,
  serviceNames,
  serviceOrder,
  serviceRemoval,
  serviceRunSpec,
  servicesFromCompose,
  splitWords,
  startServices,
  waitHealthy,
} from '../services';
import { parseBlueprint } from '../blueprint';

// Fixture repositories and subprocesses: slow when the machine is busy
jest.setTimeout(30000);

const REPO = 'github.com/acme/app';
const BRANCH = 'feature/x';
const names = containerNames('app', REPO, BRANCH);

function svc(name: string, over: Partial<ServiceSpec> = {}): ServiceSpec {
  return { name, image: `${name}:1`, env: {}, volumes: {}, dependsOn: [], ...over };
}

describe('parseServices', () => {
  it('parses every key', () => {
    expect(
      parseServices(
        {
          postgres: {
            image: 'postgres:16-alpine',
            env: { POSTGRES_PASSWORD: 'dev', PORT: 5432 },
            command: ['postgres', '-c', 'fsync=off'],
            port: 5432,
            healthcheck: 'pg_isready -U postgres',
            volumes: { data: '/var/lib/postgresql/data' },
          },
          app: { image: 'app:1', dependsOn: ['postgres'] },
        },
        'blueprint.json'
      )
    ).toEqual([
      {
        name: 'postgres',
        image: 'postgres:16-alpine',
        env: { POSTGRES_PASSWORD: 'dev', PORT: '5432' },
        command: ['postgres', '-c', 'fsync=off'],
        port: 5432,
        healthcheck: 'pg_isready -U postgres',
        volumes: { data: '/var/lib/postgresql/data' },
        dependsOn: [],
      },
      { name: 'app', image: 'app:1', env: {}, volumes: {}, dependsOn: ['postgres'] },
    ]);
    expect(parseServices(undefined, 'x')).toEqual([]);
  });

  it('rejects a bad name, a missing image, a host path volume and unsupported keys', () => {
    expect(() => parseServices({ Postgres: { image: 'p' } }, 'f')).toThrow('f: services.Postgres: a service name may only use a-z, 0-9 and -');
    expect(() => parseServices({ 'pg_1': { image: 'p' } }, 'f')).toThrow(/a service name/);
    expect(() => parseServices({ pg: {} }, 'f')).toThrow('f: services.pg: image is required');
    expect(() => parseServices({ pg: { image: '  ' } }, 'f')).toThrow(/image is required/);
    expect(() => parseServices({ pg: { image: 'p', volumes: { '/var/run/docker.sock': '/x' } } }, 'f')).toThrow(/host paths are not allowed/);
    expect(() => parseServices({ pg: { image: 'p', volumes: { './data': '/x' } } }, 'f')).toThrow(/host paths are not allowed/);
    expect(() => parseServices({ pg: { image: 'p', volumes: { '~': '/x' } } }, 'f')).toThrow(/host paths are not allowed/);
    expect(() => parseServices({ pg: { image: 'p', volumes: { data: 'relative' } } }, 'f')).toThrow(/absolute path/);
    expect(() => parseServices({ pg: { image: 'p', privileged: true } }, 'f')).toThrow('f: services.pg: unsupported keys privileged');
    expect(() => parseServices({ pg: { image: 'p', port: 70000 } }, 'f')).toThrow(/port/);
    expect(() => parseServices({ pg: { image: 'p', command: 'postgres' } }, 'f')).toThrow(/command/);
    expect(() => parseServices({ pg: { image: 'p', env: { 'A-B': 'x' } } }, 'f')).toThrow(/env.A-B/);
    expect(() => parseServices({ pg: { image: 'p', dependsOn: 'x' } }, 'f')).toThrow(/dependsOn/);
    expect(() => parseServices(['pg'], 'f')).toThrow(/services must be an object/);
  });

  it('is part of the blueprint', () => {
    const bp = parseBlueprint(JSON.stringify({ services: { redis: { image: 'redis:7' } } }), 'bp');
    expect(bp.services).toEqual([svc('redis', { image: 'redis:7' })]);
    expect(bp.ignoredKeys).toEqual([]);
    expect(parseBlueprint('{}', 'bp').services).toBeUndefined();
    expect(() => parseBlueprint(JSON.stringify({ services: { redis: {} } }), 'bp')).toThrow('bp: services.redis: image is required');
  });
});

describe('servicesFromCompose', () => {
  // As `docker compose config --format json --no-interpolate` prints it
  const CONFIG = {
    name: 'kunj-import',
    services: {
      app: { build: { context: '/x' }, volumes: [{ type: 'bind', source: '/repo', target: '/workspace' }] },
      db: {
        cap_add: ['NET_ADMIN'],
        command: 'postgres -c "log_statement=all"',
        depends_on: { redis: { condition: 'service_started' }, app: { condition: 'service_started' } },
        env_file: [{ path: '/x/.env' }],
        environment: { HOSTVAR: null, POSTGRES_PASSWORD: '${PW:-dev}', SECRET: '${SECRET}', PLAIN: 'x' },
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres'] },
        image: 'postgres:16-alpine',
        ports: [{ mode: 'ingress', protocol: 'tcp', published: '5433', target: 5432 }],
        privileged: true,
        network_mode: 'host',
        volumes: [
          { source: 'pgdata', target: '/var/lib/postgresql/data', type: 'volume', volume: {} },
          { source: '/x/data', target: '/x', type: 'bind' },
        ],
      },
      redis: { command: ['redis-server'], expose: ['6379'], image: 'redis:7', healthcheck: { test: ['CMD', 'redis-cli', 'ping'] } },
      built: { build: { context: '/y' } },
    },
  };

  it('maps image, environment, command, healthcheck, depends_on, named volumes and the first port', () => {
    const { services, dropped } = servicesFromCompose(CONFIG, 'app');
    expect(services).toEqual([
      {
        name: 'db',
        image: 'postgres:16-alpine',
        env: { POSTGRES_PASSWORD: 'dev', PLAIN: 'x' },
        command: ['postgres', '-c', 'log_statement=all'],
        port: 5432,
        healthcheck: 'pg_isready -U postgres',
        volumes: { pgdata: '/var/lib/postgresql/data' },
        dependsOn: ['redis'],
      },
      { name: 'redis', image: 'redis:7', env: {}, command: ['redis-server'], port: 6379, healthcheck: 'redis-cli ping', volumes: {}, dependsOn: [] },
    ]);
    // One warning lists everything left out
    expect(dropped).toEqual([
      'db.privileged',
      'db.cap_add',
      'db.network_mode',
      'db.env_file',
      'db.environment.HOSTVAR',
      'db.environment.SECRET',
      'db.volumes /x (host bind mount)',
      'db.ports (published)',
      'built (no image; build is not supported)',
    ]);
  });

  it('keeps the devcontainer service when nothing excludes it, without its bind mount', () => {
    const { services, dropped } = servicesFromCompose({ services: { app: { image: 'node:22', volumes: [{ type: 'bind', source: '/r', target: '/w' }] } } });
    expect(services.map(s => s.name)).toEqual(['app']);
    expect(dropped).toEqual(['app.volumes /w (host bind mount)']);
    expect(servicesFromCompose(null)).toEqual({ services: [], dropped: [] });
  });

  it('drops a depends_on naming a service that was left out, with the dropped keys, so the start does not fail', () => {
    const { services, dropped } = servicesFromCompose({
      services: {
        web: { image: 'node:22', depends_on: { api: { condition: 'service_started' }, db: { condition: 'service_started' } } },
        api: { build: { context: '/api' } },
        db: { image: 'postgres:16' },
      },
    });
    expect(services.map(s => [s.name, s.dependsOn])).toEqual([['web', ['db']], ['db', []]]);
    expect(dropped).toEqual(['api (no image; build is not supported)', 'web: depends_on api (dropped)']);
    expect(() => serviceOrder(services)).not.toThrow();
  });

  it('splits a string command like a shell', () => {
    expect(splitWords(`sh -c 'echo "a b"' x\\ y ""`)).toEqual(['sh', '-c', 'echo "a b"', 'x y', '']);
  });
});

describe('mergeServices / serviceOrder', () => {
  it('the first layer wins by name', () => {
    const merged = mergeServices([svc('pg', { image: 'blueprint' })], [svc('pg', { image: 'config' }), svc('redis')], [svc('redis', { image: 'compose' }), svc('mq')]);
    expect(merged.map(s => `${s.name}=${s.image}`)).toEqual(['pg=blueprint', 'redis=redis:1', 'mq=mq:1']);
  });

  it('orders dependencies first and rejects cycles and unknown names', () => {
    const order = serviceOrder([svc('app', { dependsOn: ['db', 'cache'] }), svc('cache'), svc('db', { dependsOn: ['cache'] })]);
    expect(order.map(s => s.name)).toEqual(['cache', 'db', 'app']);
    expect(() => serviceOrder([svc('a', { dependsOn: ['b'] }), svc('b', { dependsOn: ['a'] })])).toThrow('Services have a dependency cycle: a -> b -> a');
    expect(() => serviceOrder([svc('a', { dependsOn: ['nope'] })])).toThrow('Service a depends on unknown service nope');
  });

  it('resolveServices: blueprint, then container.services, then compose', async () => {
    const b = new FakeBackend();
    b.composeConfigs.set('compose-text', { services: { dev: { image: 'dev' }, pg: { image: 'compose-pg' }, mq: { image: 'rabbitmq', privileged: true } } });
    const warnings: string[] = [];
    const services = await resolveServices(b, {
      blueprint: [svc('pg', { image: 'bp-pg' })],
      config: { pg: { image: 'config-pg' }, redis: { image: 'config-redis' } },
      compose: [{ path: '.devcontainer/compose.yml', text: 'compose-text' }],
      devcontainerService: 'dev',
      warn: m => warnings.push(m),
    });
    expect(services.map(s => `${s.name}=${s.image}`)).toEqual(['pg=bp-pg', 'redis=config-redis', 'mq=rabbitmq']);
    expect(warnings).toEqual(['.devcontainer/compose.yml: ignoring mq.privileged']);

    // An unreadable compose file is a warning; an invalid config entry is an error
    b.composeConfigs.set('bad', new Error('docker compose failed: yaml: line 1'));
    const w2: string[] = [];
    expect(await resolveServices(b, { compose: [{ path: 'c.yml', text: 'bad' }], warn: m => w2.push(m) })).toEqual([]);
    expect(w2[0]).toMatch(/^c\.yml: could not read the compose file/);
    await expect(resolveServices(b, { config: { pg: {} }, warn: () => {} })).rejects.toThrow('container.services: services.pg: image is required');
  });
});

describe('service run spec', () => {
  // Review focus 1: a branch-named image gets nothing from the host
  it('has no env but its own, only named volumes, no capabilities, no published ports, and its name as alias', () => {
    const spec = serviceRunSpec(names, REPO, BRANCH, svc('postgres', {
      image: 'postgres:16-alpine',
      env: { POSTGRES_PASSWORD: 'dev' },
      port: 5432,
      healthcheck: 'pg_isready',
      volumes: { data: '/var/lib/postgresql/data' },
    }), '9.9.9');
    expect(spec).toEqual({
      name: `${names.container}-svc-postgres`,
      image: 'postgres:16-alpine',
      labels: {
        [LABEL.repo]: REPO,
        [LABEL.branch]: BRANCH,
        [LABEL.role]: 'service',
        [LABEL.service]: 'postgres',
        [LABEL.version]: '9.9.9',
        [LABEL.options]: JSON.stringify({ port: 5432, healthcheck: 'pg_isready', volumes: [`${names.container}-svc-postgres-data`] }),
      },
      env: { POSTGRES_PASSWORD: 'dev' },
      network: names.network,
      aliases: ['postgres'],
      workdir: '',
      volumes: [{ name: `${names.container}-svc-postgres-data`, path: '/var/lib/postgresql/data' }],
      publish: [],
      init: false,
      command: [],
    });
    const args = runArgs(spec, '/tmp/env');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--workdir');
    expect(args.join(' ')).toContain(`--network ${names.network} --network-alias postgres`);
    expect(args.filter(a => a === '-v')).toHaveLength(1);
    expect(serviceNames(names, 'redis').volume('d')).toBe(`${names.container}-svc-redis-d`);
  });
});

function svcInfo(name: string, over: Partial<ContainerInfo> = {}, record: object = {}): ContainerInfo {
  return {
    id: `${name}-id`,
    name: `${names.container}-svc-${name}`,
    state: 'running',
    image: `${name}:1`,
    createdAt: '',
    labels: labelsFor(REPO, BRANCH, { [LABEL.role]: 'service', [LABEL.service]: name, [LABEL.options]: JSON.stringify(record) }),
    ports: [],
    ...over,
  };
}

describe('startServices', () => {
  it('creates volumes and containers in dependency order and waits for each health check', async () => {
    const b = new FakeBackend();
    const created = { containers: [] as string[], volumes: [] as string[] };
    const result = await startServices(b, names, REPO, BRANCH, [
      svc('app', { dependsOn: ['db'] }),
      svc('db', { healthcheck: 'pg_isready', volumes: { data: '/d' } }),
    ], { warn: () => {}, created });
    expect(b.callsOf('run').map(a => (a[0] as { name: string }).name)).toEqual([`${names.container}-svc-db`, `${names.container}-svc-app`]);
    expect(b.methods()).toEqual(['list', 'volumeExists', 'createVolume', 'run', 'exec', 'run']);
    expect(b.callsOf('exec')[0].slice(0, 2)).toEqual(['id-1', ['sh', '-c', 'pg_isready']]);
    expect(result).toEqual({ created: [`${names.container}-svc-db`, `${names.container}-svc-app`], volumes: [`${names.container}-svc-db-data`] });
    expect(created).toEqual({ containers: result.created, volumes: result.volumes });
    // Volumes are labelled for the branch so cleanup finds them
    expect(b.callsOf('createVolume')[0][1]).toMatchObject({ [LABEL.repo]: REPO, [LABEL.branch]: BRANCH, [LABEL.role]: 'service' });
  });

  it('does nothing without services', async () => {
    const b = new FakeBackend();
    expect(await startServices(b, names, REPO, BRANCH, [], { warn: () => {} })).toEqual({ created: [], volumes: [] });
    expect(b.calls).toEqual([]);
  });

  it('starts a stopped existing service and reuses a running one; recreate replaces them', async () => {
    const b = new FakeBackend();
    b.existing = [svcInfo('db', { state: 'exited' }), svcInfo('cache')];
    await startServices(b, names, REPO, BRANCH, [svc('db'), svc('cache')], { warn: () => {} });
    expect(b.callsOf('start')).toEqual([['db-id']]);
    expect(b.methods()).not.toContain('run');

    const r = new FakeBackend();
    r.existing = [svcInfo('db')];
    await startServices(r, names, REPO, BRANCH, [svc('db')], { warn: () => {}, recreate: true });
    expect(r.callsOf('remove')).toEqual([[{ containers: [`${names.container}-svc-db`] }]]);
    expect(r.callsOf('run')).toHaveLength(1);
  });

  it('recreate (--rebuild) removes a service no longer declared with its volumes, or keeps them with keepVolumes', async () => {
    const OLD_DATA = `${names.container}-svc-old-data`;
    const b = new FakeBackend();
    b.existing = [svcInfo('db'), svcInfo('old', {}, { volumes: [OLD_DATA] })];
    const warnings: string[] = [];
    await startServices(b, names, REPO, BRANCH, [svc('db')], { warn: m => warnings.push(m), recreate: true });
    expect(b.callsOf('remove')[0]).toEqual([{ containers: [`${names.container}-svc-old`], volumes: [OLD_DATA] }]);
    expect(warnings).toEqual([`Removed service old: it is no longer declared; its volumes were removed too (${OLD_DATA})`]);

    const kept = new FakeBackend();
    kept.existing = [svcInfo('db'), svcInfo('old', {}, { volumes: [OLD_DATA] })];
    const keptWarnings: string[] = [];
    await startServices(kept, names, REPO, BRANCH, [svc('db')], { warn: m => keptWarnings.push(m), recreate: true, keepVolumes: true });
    expect(kept.callsOf('remove')[0]).toEqual([{ containers: [`${names.container}-svc-old`] }]);
    expect(JSON.stringify(kept.callsOf('remove'))).not.toContain('svc-old-data');
    expect(keptWarnings).toEqual([expect.stringMatching(/Removed service old: it is no longer declared; its volumes are kept \(.*svc-old-data/)]);

    // Also when no service is declared any more
    const none = new FakeBackend();
    none.existing = [svcInfo('old')];
    await startServices(none, names, REPO, BRANCH, [], { warn: () => {}, recreate: true });
    expect(none.callsOf('remove')).toEqual([[{ containers: [`${names.container}-svc-old`] }]]);
  });

  it('warns and continues when a health check never passes', async () => {
    const b = new FakeBackend();
    b.execResults.set('sh -c pg_isready', { exitCode: 1, stdout: '' });
    const warnings: string[] = [];
    const started = Date.now();
    await startServices(b, names, REPO, BRANCH, [svc('db', { healthcheck: 'pg_isready' }), svc('app', { dependsOn: ['db'] })], {
      warn: m => warnings.push(m),
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(b.callsOf('exec').length).toBeGreaterThan(1);
    expect(warnings).toEqual(['Service db did not pass its health check within 0.06s; continuing']);
    // The start goes on
    expect(b.callsOf('run')).toHaveLength(2);
  });

  it('a service that is not running is a warning, not a wait', async () => {
    const b = new FakeBackend();
    b.execErrors.set('sh -c pg_isready', new Error('docker exec failed: container is not running'));
    const warnings: string[] = [];
    expect(await waitHealthy(b, 'x', { name: 'db', healthcheck: 'pg_isready' }, { warn: m => warnings.push(m), timeoutMs: 10_000 })).toBe(false);
    expect(b.callsOf('exec')).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Service db is not running/);
  });
});

describe('describeServices / serviceRemoval', () => {
  it('reports name, state and port, and removes containers with their recorded volumes', () => {
    const found = [svcInfo('redis', { state: 'exited' }), svcInfo('db', {}, { port: 5432, volumes: ['v1', 'v2'] })];
    expect(describeServices(found)).toEqual([
      { name: 'db', state: 'running', port: 5432 },
      { name: 'redis', state: 'exited', port: null },
    ]);
    expect(serviceRemoval(found, false)).toEqual({ containers: [found[0].name, found[1].name], volumes: ['v1', 'v2'] });
    expect(serviceRemoval(found, true).volumes).toEqual([]);
  });
});

describe('fix round 1', () => {
  it('an image that would be read as a docker run flag is refused, in a blueprint and in compose', () => {
    expect(() => parseBlueprint(JSON.stringify({ services: { evil: { image: '--privileged', command: ['alpine', 'sh'] } } }), 'bp'))
      .toThrow('bp: services.evil: image "--privileged" is not a valid image reference');
    expect(() => parseServices({ evil: { image: '-v=/:/host' } }, 'f')).toThrow(/services\.evil: image "-v=\/:\/host" is not a valid image reference/);
    expect(() => parseServices({ evil: { image: 'alpine --privileged' } }, 'f')).toThrow(/not a valid image reference/);
    const { services, dropped } = servicesFromCompose({ services: { evil: { image: '--privileged', command: ['alpine'] }, ok: { image: 'ghcr.io/a/b:1@sha256:abc' } } });
    expect(services.map(x => x.name)).toEqual(['ok']);
    expect(dropped).toEqual(['evil (invalid image "--privileged")']);
    // The last line of defence: runArgs never puts a flag where the image goes
    expect(() => runArgs(serviceRunSpec(names, REPO, BRANCH, svc('x', { image: '--cap-add=SYS_ADMIN' })), '/tmp/env')).toThrow(/not a valid image reference/);
  });

  it('refuses compose files with include or an extends that names a file', async () => {
    expect(composeRefusal('include:\n  - /etc/other/compose.yml\nservices: {}\n')).toBe('include is not supported');
    expect(composeRefusal('services:\n  db:\n    extends:\n      file: /home/me/other/compose.yml\n      service: db\n')).toBe('extends with a file is not supported');
    expect(composeRefusal('services:\n  db:\n    extends: { file: /x.yml, service: db }\n')).toBe('extends with a file is not supported');
    expect(composeRefusal('{"services": {"db": {"extends": {\n  "file": "/x.yml", "service": "db"}}}}')).toBe('extends with a file is not supported');
    // extends within the same file reads nothing from the host
    expect(composeRefusal('services:\n  base:\n    image: redis\n  db:\n    extends:\n      service: base\n    image: redis:7\n')).toBeNull();

    // YAML escapes compose decodes but the text check cannot read
    const escaped = 'a double-quoted key with a backslash escape is not supported';
    expect(composeRefusal('"\\x69nclude":\n  - /etc/other/compose.yml\nservices: {}\n')).toBe(escaped);
    expect(composeRefusal('services:\n  db:\n    extends:\n      "fi\\x6ce": /x.yml\n      service: db\n')).toBe(escaped);
    expect(composeRefusal('services:\n  db:\n    extends: { "fi\\u006ce" : /x.yml, service: db }\n')).toBe(escaped);
    expect(composeRefusal('? "\\x69nclude"  # explicit key\n: [/x.yml]\n')).toBe(escaped);
    // A stray quote earlier on cannot shift the pairing
    expect(composeRefusal('x: |\n  echo "\n"\\x69nclude": [/x.yml]\n')).toBe(escaped);
    // An alias as a key is whatever its anchor says
    expect(composeRefusal('x: &k include\n*k : [/x.yml]\n')).toBe('an alias as a key is not supported');
    // Explicit and alias keys (they parse in js-yaml and yaml.v3)
    expect(composeRefusal('? include # c\n: [ /etc/other.yml ]\n')).not.toBeNull();
    expect(composeRefusal('x-a: &a include\n? *a\n: [ /etc/other.yml ]\n')).not.toBeNull();
    expect(composeRefusal('? |-\n  include\n# c\n: [ /etc/other.yml ]\n')).not.toBeNull();
    expect(composeRefusal('services:\n  db:\n    extends:\n      ? file # c\n      : /etc/x.yml\n')).not.toBeNull();
    expect(composeRefusal('- ? a\n  : b\n')).toBe('an explicit key (?) is not supported');
    expect(composeRefusal('{ ? a : b }\n')).toBe('an explicit key (?) is not supported');
    // Escapes in values, and merge keys, are fine
    expect(composeRefusal('services:\n  db:\n    image: redis\n    command: "sh -c \\"echo a: b\\""\n    "environment": { "A": "x\\ty" }\n')).toBeNull();
    expect(composeRefusal('x: &d { image: redis }\nservices:\n  db:\n    <<: *d\n')).toBeNull();
    expect(composeRefusal('{"services": {"db": {"image": "redis", "command": ["sh", "-c", "echo \\"a\\": 1"]}}}')).toBeNull();

    const b = new FakeBackend();
    const warnings: string[] = [];
    expect(await resolveServices(b, { compose: [{ path: 'c.yml', text: 'include:\n  - /x.yml\n' }], warn: m => warnings.push(m) })).toEqual([]);
    expect(warnings).toEqual(["c.yml: include is not supported by kunj's compose import; its services are not started"]);
    expect(b.methods()).not.toContain('composeConfig');
  });

  it('decides on the parsed document: include, extends with a file, tags, more documents; fails closed', () => {
    // Refused by the parse (some also by the text backstop)
    expect(composeRefusal('<<: { "inc\\u006cude": [x] }\n')).not.toBeNull();
    expect(composeRefusal('base: &b { file: /x.yml, service: db }\nservices:\n  db:\n    extends: *b\n')).toBe('extends with a file is not supported');
    expect(composeRefusal('services:\n  db:\n    extends: { service: db, other: 1 }\n')).toBe('extends with a file is not supported');
    expect(composeRefusal('services:\n  db:\n    extends: [db]\n')).toBe('extends with a file is not supported');
    expect(composeRefusal('x-k: !!binary aW5jbHVkZQ==\n')).toBe('the YAML tag !!binary is not supported');
    expect(composeRefusal('x-k: !custom v\n')).toBe('the YAML tag !custom is not supported');
    expect(composeRefusal('services: {}\n---\nservices: {}\n')).toBe('more than one YAML document is not supported');
    expect(composeRefusal('services:\n  db: [unclosed\n')).toMatch(/^it could not be parsed/);
    expect(composeRefusal('services:\n  db:\n    image: a\n    image: b\n')).toMatch(/^it could not be parsed/);

    // yaml.v3 ends comments and block scalars at NEL/LS/PS; here they are refused outright
    const breaks = 'control characters and Unicode line breaks are not supported';
    expect(composeRefusal('services:\n  a:\n    image: x\nname: p #c\u0085include: [/etc/x.yml]\n')).toBe(breaks);
    expect(composeRefusal('name: p\nservices: {a: {image: x}} # c\u0085include: [../other/compose.yml]\n')).toBe(breaks);
    expect(composeRefusal('note: |\n        hi\u0085include:\n        - /etc/other/compose.yml\n')).toBe(breaks);
    for (const c of ['\u2028', '\u2029', '\u0000', '\u001b', '\u007f', '\u009f', '\u000b', '\u000c']) {
      expect(composeRefusal(`services: {}\nx: a${c}b\n`)).toBe(breaks);
    }
    expect(composeRefusal('services: {}\n\ufeffx: 1\n')).toBe(breaks);
    // A BOM at the start, tabs and CRLF are fine
    expect(composeRefusal('\ufeffservices:\r\n  db:\r\n    image: redis\r\n    command: ["a",\t"b"]\r\n')).toBeNull();

    // Files compose would read from the host
    expect(composeRefusal('services:\n  db:\n    image: redis\n    env_file: /home/me/.env\n')).toBe('env_file is not supported');
    expect(composeRefusal('services:\n  db:\n    image: redis\n    env_file: [{ path: .env, required: false }]\n')).toBe('env_file is not supported');
    expect(composeRefusal('services:\n  db:\n    image: redis\n    label_file: ./labels\n')).toBe('label_file is not supported');

    // Ordinary compose files still pass
    const ordinary = [
      'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: dev\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 5s\n    volumes:\n      - data:/var/lib/postgresql/data\n  app:\n    build: .\n    depends_on:\n      db:\n        condition: service_healthy\nvolumes:\n  data: {}\n',
      'x-env: &env\n  TZ: UTC\nservices:\n  base:\n    image: redis\n  cache:\n    extends: base\n    environment:\n      <<: *env\n  other:\n    extends: { service: base }\n    command: ["redis-server", "--save", ""]\n',
      'services:\n  db:\n    image: redis\n    ports: !override\n      - "6379"\n    labels: !reset {}\n',
      '{"services": {"db": {"image": "redis", "command": "echo \\"why? because\\""}}}',
      '',
    ];
    for (const text of ordinary) expect(composeRefusal(text)).toBeNull();
  });

  it('finds services by their labels, not a name prefix another branch can extend', async () => {
    // Branch "x" and a branch named so its container name starts with x's: "<x container>-svc-..."
    const other = { ...svcInfo('db'), id: 'other-id', labels: labelsFor(REPO, 'evil', { [LABEL.role]: 'service', [LABEL.service]: 'db' }) };
    const mine = svcInfo('cache');
    const b = new FakeBackend();
    b.existing = [other, mine];
    expect((await findServices(b, names, { repoId: REPO, branch: BRANCH })).map(c => c.id)).toEqual(['cache-id']);
    await stopServices(b, names, { repoId: REPO, branch: BRANCH });
    expect(b.callsOf('stop')).toEqual([['cache-id']]);
  });

  it('resume starts services dependencies first, as recorded in their labels', async () => {
    const b = new FakeBackend();
    const app = svcInfo('app', { state: 'exited' }, { dependsOn: ['db'] });
    const db = svcInfo('db', { state: 'exited' }, {});
    await resumeServices(b, [app, db], { warn: () => {} });
    expect(b.callsOf('start')).toEqual([['db-id'], ['app-id']]);
    expect(JSON.parse(serviceRunSpec(names, REPO, BRANCH, svc('app', { dependsOn: ['db'] })).labels[LABEL.options]).dependsOn).toEqual(['db']);
  });

  it('drops entrypoint, user, working_dir, tmpfs and relative volume targets with the warning', () => {
    const { services, dropped } = servicesFromCompose({ services: { db: {
      image: 'postgres', entrypoint: ['x'], user: 'root', working_dir: '/w', tmpfs: ['/t'],
      volumes: [{ type: 'volume', source: 'data', target: 'relative' }],
    } } });
    expect(services[0].volumes).toEqual({});
    expect(dropped).toEqual(['db.entrypoint', 'db.user', 'db.working_dir', 'db.tmpfs', 'db.volumes relative']);
  });
});
