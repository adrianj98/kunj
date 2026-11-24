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
      key: 'container.useGhToken',
      description:
        "When container.env names GH_TOKEN and the host env has no GH_TOKEN, GITHUB_TOKEN or GITLAB_TOKEN, forward `gh auth token` for origin's GitHub host as GH_TOKEN. The agent in the container can use this token with everything your gh login can do; false turns it off",
      type: 'boolean',
      defaultValue: true,
      category: 'container',
    },
    {
      key: 'container.files',
      description: 'Host files and folders copied into containers on every start, as hostPath:containerPath',
      detailedDescription:
        'Copied when a container is created and again on every kunj ct start, so a change on this computer reaches a container that ' +
        'already exists. Files are added and replaced, so an edit made to the copy in the container is lost; a file deleted here stays ' +
        'there. A folder is copied whole. A containerPath starting with ~ or without a leading / is under the container user\'s home. For your Claude Code skills: ' +
        '"~/.claude/skills:~/.claude/skills".',
      type: 'array',
      defaultValue: [],
      category: 'container',
      examples: ['~/.gitconfig:/home/node/.gitconfig', '~/.claude/skills:~/.claude/skills'],
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
      key: 'container.remote',
      description: "Run this repository's containers on a remote kunj serve (a name from kunj remote add); empty: the laptop's Docker",
      type: 'string',
      defaultValue: '',
      category: 'container',
      examples: ['box'],
      relatedSettings: ['container.dockerContext'],
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
      detailedDescription:
        'Empty by default: no memory cap, because a cap too small for a build or a test run kills it. ' +
        'Set one (e.g. 8g) to keep a runaway agent or test from taking the whole Docker VM. Services take their own `memory` in their spec.',
      type: 'string',
      defaultValue: '',
      category: 'container',
      // A docker size (as services' memory): digits and a unit, never an option
      validate: (value: string) => value === '' || /^[0-9]+(\.[0-9]+)?[kmgtp]?i?b?$/i.test(value),
      examples: ['4g'],
    },
    {
      key: 'container.pidsLimit',
      description: 'Most processes a branch container or service may run (docker run --pids-limit; 0 = no limit)',
      detailedDescription:
        'Stops a fork bomb or a runaway test from exhausting the Docker host. Applies to the main container and every service; ' +
        'the network helper always has its own small limit. Takes effect when a container is created (kunj ct start --rebuild).',
      type: 'number',
      defaultValue: 4096,
      category: 'container',
      validate: (value: number) => Number.isInteger(value) && value >= 0,
      examples: ['8192', '0'],
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
      key: 'container.snapshotPruneDays',
      description: '`kunj container prune` also removes blueprint snapshots no container uses that were built more than this many days ago (0 = off)',
      detailedDescription:
        'A snapshot is several GB. One that no container (running or stopped) uses goes once it is this old, even for the current blueprint; ' +
        'the next start rebuilds it. Snapshots of an older blueprint go whatever their age.',
      type: 'number',
      defaultValue: 14,
      category: 'container',
      validate: (value: number) => Number.isInteger(value) && value >= 0,
      examples: ['30', '0'],
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
      type: 'object',
      defaultValue: {},
      category: 'container',
      detailedDescription:
        'An object of name: { image, env?, command?, port?, healthcheck?, volumes?, dependsOn?, memory? }; edit the config file by hand. ' +
        "Each service runs on the branch's own network and is reached by its name (postgres:5432). It gets only the env " +
        'declared here, only named volumes (created per branch), no added capabilities and no published ports. ' +
        "The blueprint's services win over these by name, and these over the devcontainer's compose services. " +
        'memory (e.g. "512m") is its docker run --memory (none by default); container.pidsLimit applies to every service.',
      examples: ['{"postgres": {"image": "postgres:16-alpine", "env": {"POSTGRES_PASSWORD": "dev"}, "healthcheck": "pg_isready -U postgres", "volumes": {"data": "/var/lib/postgresql/data"}}}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
    {
      key: 'container.caches',
      description: 'Cache volumes shared by every branch container of the repository',
      type: 'array',
      defaultValue: [],
      category: 'container',
      detailedDescription:
        'A list of { name, path }. Each is one Docker volume per repository and Docker host, mounted at path in every branch ' +
        'container (new containers only) and in the blueprint snapshot build, and kept by kunj ct remove and prune. The ' +
        "container gets KUNJ_CACHE_DIR (the first cache's path) and KUNJ_CACHE_<NAME>. kunj puts nothing there: the " +
        "repository's own scripts keep what is expensive to fetch again, such as a database dump. Every branch can write " +
        'to it, so do not trust its contents more than you trust the branches. On cloud machines each machine has its own ' +
        'copy, which starts as what the machine image held and is deleted with the machine.',
      examples: ['[{"name": "db", "path": "/cache/db"}]'],
      validate: (value: unknown) => Array.isArray(value),
    },
    {
      key: 'container.mcp',
      description: 'MCP servers on this machine bridged into the container for its Claude Code; only "chrome" (a browser) for now',
      type: 'object',
      defaultValue: {},
      category: 'container',
      detailedDescription:
        'An object of name: { command?, args?, env?, allowOrigins? }; edit the config file by hand (host config only, never the ' +
        'blueprint). Off while empty, because the agent then drives a browser on this machine and its network. {"chrome": {}} ' +
        'runs npx -y chrome-devtools-mcp@1.12.0 (performance, memory and file: navigation off) with an empty profile per ' +
        'session that refuses downloads, in a temp directory deleted afterwards, when `kunj ct agent` starts, and adds a ' +
        "matching entry to the container user's ~/.claude.json. The server gets only PATH, HOME and its env. Only a fixed " +
        'list of browser tools and arguments passes, so no file path from the agent reaches the server; with your own ' +
        'command or args there is no throwaway profile and downloads land where that browser puts them (normally ' +
        '~/Downloads). navigate_page and new_page may open only the host ' +
        'ports forwarded for the container, unless allowOrigins lists origins (with a port: that port; without: any port, ' +
        'which is broad). This limits explicit navigation only: a click or a script can still take the page elsewhere. ' +
        'One session at a time per server.',
      examples: ['{"chrome": {}}', '{"chrome": {"allowOrigins": ["http://localhost:3000", "https://staging.example.com"]}}'],
      validate: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    },
  ]);
}
