// AI settings - used by AI commit message generation

import { registerSettings } from '../lib/settings-registry';

export function registerAISettings(): void {
  registerSettings([
    {
      key: 'ai.enabled',
      description: 'AI features enabled',
      type: 'boolean',
      defaultValue: true,
      category: 'ai'
    },
    {
      key: 'ai.provider',
      description: 'AI provider',
      type: 'enum',
      defaultValue: 'bedrock',
      options: ['bedrock', 'openai', 'anthropic'],
      category: 'ai'
    },
    {
      key: 'ai.model',
      description: 'Model name',
      type: 'string',
      defaultValue: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      category: 'ai'
    },
    {
      key: 'ai.awsRegion',
      description: 'AWS region',
      type: 'string',
      defaultValue: 'us-east-1',
      category: 'ai'
    },
    {
      key: 'ai.autoGenerateCommitMessage',
      description: 'Auto-generate commits',
      type: 'boolean',
      defaultValue: true,
      category: 'ai'
    },
    {
      key: 'ai.includeBranchContext',
      description: 'Include branch context',
      type: 'boolean',
      defaultValue: true,
      category: 'ai'
    },
    {
      key: 'ai.maxContextCommits',
      description: 'Max context commits',
      type: 'number',
      defaultValue: 10,
      category: 'ai',
      validate: (value: number) => value > 0 && value <= 100
    }
  ]);
}
