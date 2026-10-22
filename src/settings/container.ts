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
  ]);
}
