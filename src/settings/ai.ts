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
    },
    {
      key: 'ai.commitStyle',
      description: 'Commit message style',
      detailedDescription: 'Choose the format for AI-generated commit messages and PR descriptions. Each style follows different conventions for organizing and presenting changes. This applies to both commit messages and pull request descriptions.',
      type: 'enum',
      defaultValue: 'conventional',
      options: ['conventional', 'semantic', 'simple', 'gitmoji', 'custom'],
      category: 'ai',
      examples: [
        'conventional - "feat: Add user authentication" (standard)',
        'semantic - "[MINOR] Add user authentication"',
        'simple - "Add user authentication" (no prefix)',
        'gitmoji - "✨ Add user authentication" (with emoji)',
        'custom - Use customInstructions for your own format'
      ],
      relatedSettings: ['ai.customInstructions', 'ai.includeBody']
    },
    {
      key: 'ai.subjectMaxLength',
      description: 'Max subject line length',
      type: 'number',
      defaultValue: 50,
      category: 'ai',
      validate: (value: number) => value > 0 && value <= 100
    },
    {
      key: 'ai.includeBody',
      description: 'Include detailed body',
      type: 'boolean',
      defaultValue: true,
      category: 'ai'
    },
    {
      key: 'ai.customInstructions',
      description: 'Custom AI instructions',
      detailedDescription: 'Additional instructions for the AI to follow when generating commit messages and PR descriptions. Use this to enforce team conventions, add specific requirements, or customize the output format. These instructions are added to all AI prompts.',
      type: 'string',
      defaultValue: '',
      category: 'ai',
      examples: [
        '"Always include the JIRA ticket ID"',
        '"Focus on business value over technical details"',
        '"Mention breaking changes prominently"',
        '"Use present tense and active voice"',
        '"Keep descriptions under 3 sentences"'
      ],
      relatedSettings: ['ai.commitStyle', 'ai.includeBody']
    },
    {
      key: 'ai.autoGeneratePRDescription',
      description: 'Auto-generate PR descriptions',
      detailedDescription: 'When enabled, AI automatically generates pull request titles and descriptions when you run "kunj pr". The AI analyzes code changes, commit history, and branch metadata to create comprehensive PR descriptions. Falls back to heuristic generation if AI fails.',
      type: 'boolean',
      defaultValue: true,
      category: 'ai',
      examples: [
        'true - Use AI for PR descriptions (recommended)',
        'false - Use simple heuristic generation'
      ],
      relatedSettings: ['ai.enabled', 'ai.includeDiffInPR', 'ai.commitStyle']
    },
    {
      key: 'ai.includeDiffInPR',
      description: 'Include full diff for PR context',
      detailedDescription: 'When generating PR descriptions, include the full code diff for AI analysis. This provides better context and more accurate descriptions, but may be slower for large changes. If disabled, the AI only uses commit messages and branch metadata.',
      type: 'boolean',
      defaultValue: true,
      category: 'ai',
      examples: [
        'true - Analyze full code changes (better quality)',
        'false - Only use commit messages (faster)'
      ],
      relatedSettings: ['ai.autoGeneratePRDescription']
    }
  ]);
}
