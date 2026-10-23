// Container settings - used by the `kunj container` command

import { registerSettings } from '../lib/settings-registry';
import { CONTAINER_AGENT_COMMAND_DEFAULT, CONTAINER_ENV_DEFAULT } from '../lib/container/defaults';

export function registerContainerSettings(): void {
  registerSettings([
    {
      key: 'container.image',
      description: "Container image override (default: the repo's devcontainer, else kunj-sandbox)",
      type: 'string',
      defaultValue: '',
      category: 'container',
      examples: ['node:22', 'my-registry/dev-image:latest'],
    },
    {
      key: 'container.agentCommand',
      description: 'Command `kunj container agent` runs inside the container (in tmux)',
      type: 'string',
      defaultValue: CONTAINER_AGENT_COMMAND_DEFAULT,
      category: 'container',
      examples: [CONTAINER_AGENT_COMMAND_DEFAULT],
    },
    {
      key: 'container.env',
      description: 'Host environment variable names forwarded into containers when set; NAME=value entries are passed literally',
      type: 'array',
      defaultValue: CONTAINER_ENV_DEFAULT,
      category: 'container',
      examples: ['ANTHROPIC_API_KEY', 'NODE_ENV=development'],
    },
    {
      key: 'container.files',
      description: 'Host files copied into new containers, as hostPath:containerPath',
      type: 'array',
      defaultValue: [],
      category: 'container',
      examples: ['~/.gitconfig:/home/node/.gitconfig'],
    },
    {
      key: 'container.keepFiles',
      description: "Copy the repository's keep files into new containers",
      type: 'boolean',
      defaultValue: true,
      category: 'container',
    },
    {
      key: 'container.network.allow',
      description: 'Egress allowlist of domains; empty means open internet (the host and LAN are always blocked)',
      type: 'array',
      defaultValue: [],
      category: 'container',
      examples: ['github.com', 'registry.npmjs.org'],
    },
    {
      key: 'container.network.allowHost',
      description: 'Allow containers to reach the Docker host (host.docker.internal)',
      type: 'boolean',
      defaultValue: false,
      category: 'container',
    },
    {
      key: 'container.dockerContext',
      description: 'Docker context used for every docker call',
      type: 'string',
      defaultValue: '',
      category: 'container',
      examples: ['colima', 'desktop-linux'],
    },
    {
      key: 'container.cpus',
      description: 'CPU limit passed to docker run (e.g. 2)',
      type: 'string',
      defaultValue: '',
      category: 'container',
      examples: ['2'],
    },
    {
      key: 'container.memory',
      description: 'Memory limit passed to docker run (e.g. 4g)',
      type: 'string',
      defaultValue: '',
      category: 'container',
      examples: ['4g'],
    },
    {
      key: 'container.publish',
      description: 'Ports always published at container start',
      type: 'array',
      defaultValue: [],
      category: 'container',
      examples: ['3000:3000'],
    },
    {
      key: 'container.forward.auto',
      description: '`kunj container agent` starts a background `forward --auto` that forwards every new port the container listens on to 127.0.0.1',
      type: 'boolean',
      defaultValue: true,
      category: 'container',
    },
    {
      key: 'container.forward.ignore',
      description: 'Container ports `forward --auto` never forwards (ports below 1024 are never forwarded)',
      type: 'array',
      defaultValue: [],
      category: 'container',
      examples: ['9229'],
    },
    {
      key: 'container.pruneAfterDays',
      description: '`kunj container prune` also removes stopped containers created more than this many days ago (0 = off)',
      detailedDescription: 'Off by default. A container removed this way still has to pass the remove guard (no unpushed commits, stashes or uncommitted changes) unless prune is run with --force.',
      type: 'number',
      defaultValue: 0,
      category: 'container',
      validate: (value: number) => Number.isInteger(value) && value >= 0,
      examples: ['30'],
    },
    {
      key: 'container.dockerInDocker',
      description: 'Docker inside branch containers: off, sysbox (needs the sysbox-runc runtime on the Docker host) or privileged (needs container.allowPrivileged; refused on Docker Desktop)',
      detailedDescription:
        'Each container then runs its own dockerd, its /var/lib/docker on a per-branch volume, so docker compose up works inside. ' +
        'The container keeps its capabilities. sysbox keeps inner containers inside the sandbox\'s user namespace; privileged ' +
        'gives the container root on the Docker host (on a Mac, its VM), so use it only on a dedicated Docker context. ' +
        'Needs the kunj sandbox image (no devcontainer or container.image).',
      type: 'enum',
      options: ['off', 'sysbox', 'privileged'],
      defaultValue: 'off',
      category: 'container',
      relatedSettings: ['container.allowPrivileged', 'container.dockerContext'],
      validate: (value: unknown) => value === 'off' || value === 'sysbox' || value === 'privileged',
      examples: ['sysbox', 'privileged'],
    },
    {
      key: 'container.allowPrivileged',
      description: 'Allow container.dockerInDocker "privileged" (root on the Docker host or its VM); it is still refused on Docker Desktop',
      type: 'boolean',
      relatedSettings: ['container.dockerInDocker'],
      defaultValue: false,
      category: 'container',
    },
    {
      key: 'container.services',
      description: 'Sidecar services (Postgres, Redis, ...) started next to each branch container, by name',
      type: 'string',
      defaultValue: {},
      category: 'container',
      detailedDescription:
        'An object of name: { image, env?, command?, port?, healthcheck?, volumes?, dependsOn? }; edit the config file by hand. ' +
        "Each service runs on the branch's own network and is reached by its name (postgres:5432). It gets only the env " +
        'declared here, only named volumes (created per branch), no added capabilities and no published ports. ' +
        "The blueprint's services win over these by name, and these over the devcontainer's compose services.",
      examples: ['{"postgres": {"image": "postgres:16-alpine", "env": {"POSTGRES_PASSWORD": "dev"}, "healthcheck": "pg_isready -U postgres", "volumes": {"data": "/var/lib/postgresql/data"}}}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
    {
      key: 'container.mcp',
      description: 'MCP servers on this machine bridged into the container for its Claude Code; only "chrome" (a browser) for now',
      type: 'string',
      defaultValue: {},
      category: 'container',
      detailedDescription:
        'An object of name: { command?, args?, env?, allowOrigins? }; edit the config file by hand (host config only, never the ' +
        'blueprint). Off while empty. {"chrome": {}} runs npx -y chrome-devtools-mcp@latest --isolated (an empty, isolated ' +
        "browser profile) on this machine when `kunj ct agent` starts, and adds a matching entry to the container user's " +
        '~/.claude.json. The server gets only PATH, HOME and its env. allowOrigins (default http://localhost and ' +
        'http://127.0.0.1, any port) limits the URLs navigate_page and new_page may open. One session at a time per server.',
      examples: ['{"chrome": {}}', '{"chrome": {"allowOrigins": ["http://localhost", "https://staging.example.com"]}}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
  ]);
}
