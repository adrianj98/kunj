import { initializeSettings, settingsRegistry } from '../index';

describe('container settings', () => {
  it('registers the container settings with their defaults', () => {
    initializeSettings();
    const defaults = settingsRegistry.getDefaultConfig().container;
    expect(defaults).toEqual({
      image: '',
      agentCommand: 'claude --dangerously-skip-permissions',
      env: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'GH_TOKEN'],
      files: [],
      keepFiles: true,
      network: { allow: [], allowHost: false },
      dockerContext: '',
      cpus: '',
      memory: '',
      pidsLimit: 4096,
      publish: [],
      services: {},
      caches: [],
      useGhToken: true,
      forward: { auto: true, ignore: [] },
      pruneAfterDays: 0,
      snapshotPruneDays: 14,
      remote: '',
      dockerInDocker: 'off',
      allowPrivileged: false,
      mcp: {},
    });
    expect(settingsRegistry.get('container.dockerInDocker')?.validate?.('sysbox')).toBe(true);
    expect(settingsRegistry.get('container.dockerInDocker')?.validate?.('privileged')).toBe(true);
    expect(settingsRegistry.get('container.dockerInDocker')?.validate?.('yes')).toBe(false);
    expect(settingsRegistry.get('container.pruneAfterDays')?.validate?.(30)).toBe(true);
    expect(settingsRegistry.get('container.pruneAfterDays')?.validate?.(-1)).toBe(false);
    expect(settingsRegistry.get('container.snapshotPruneDays')?.validate?.(0)).toBe(true);
    expect(settingsRegistry.get('container.snapshotPruneDays')?.validate?.(1.5)).toBe(false);
    expect(settingsRegistry.get('container.pidsLimit')?.validate?.(0)).toBe(true);
    expect(settingsRegistry.get('container.pidsLimit')?.validate?.(-1)).toBe(false);
    expect(settingsRegistry.get('container.memory')?.validate?.('')).toBe(true);
    expect(settingsRegistry.get('container.memory')?.validate?.('4g')).toBe(true);
    expect(settingsRegistry.get('container.memory')?.validate?.('--privileged')).toBe(false);
    expect(settingsRegistry.get('container.services')?.validate?.({ pg: { image: 'p' } })).toBe(true);
    expect(settingsRegistry.get('container.mcp')?.validate?.({ chrome: {} })).toBe(true);
    expect(settingsRegistry.get('container.mcp')?.validate?.(['chrome'])).toBe(false);
    expect(settingsRegistry.get('container.services')?.validate?.('pg')).toBe(false);
    expect(settingsRegistry.get('hooks.pre-container-create')).toBeDefined();
  });
});
