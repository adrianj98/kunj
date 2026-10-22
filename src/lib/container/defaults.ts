// Kept import-free so the settings registry can reference the defaults
// without loading the container library (and its docker helpers) at startup.

// Host environment variables forwarded into containers when they are set
export const CONTAINER_ENV_DEFAULT = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'GH_TOKEN',
];

// Command `kunj container agent` runs inside the container
export const CONTAINER_AGENT_COMMAND_DEFAULT = 'claude --dangerously-skip-permissions';
