// Jira settings - used by Jira integration

import { registerSettings } from '../lib/settings-registry';

export function registerJiraSettings(): void {
  registerSettings([
    {
      key: 'jira.enabled',
      description: 'Jira integration enabled',
      detailedDescription: 'Enable Jira Cloud integration for ticket management and automatic branch-ticket linking. When enabled, Kunj can list tickets, create issues, and automatically link branches to Jira tickets.',
      type: 'boolean',
      defaultValue: false,
      category: 'jira',
      relatedSettings: ['jira.baseUrl', 'jira.email', 'jira.apiToken']
    },
    {
      key: 'jira.baseUrl',
      description: 'Jira Cloud URL',
      detailedDescription: 'Your Jira Cloud instance URL (e.g., https://company.atlassian.net). This is required for API access.',
      type: 'string',
      defaultValue: '',
      category: 'jira',
      examples: [
        'https://company.atlassian.net',
        'https://myorg.atlassian.net'
      ],
      validate: (value: string) => {
        if (!value) return true; // Empty is ok (disabled)
        return value.startsWith('https://') && value.includes('.atlassian.net');
      }
    },
    {
      key: 'jira.email',
      description: 'Jira account email',
      detailedDescription: 'Email address associated with your Jira account. Used for authentication with API token.',
      type: 'string',
      defaultValue: '',
      category: 'jira',
      validate: (value: string) => {
        if (!value) return true; // Empty is ok (disabled)
        return value.includes('@');
      }
    },
    {
      key: 'jira.apiToken',
      description: 'Jira API token',
      detailedDescription: 'API token for authentication. Generate at https://id.atlassian.com/manage-profile/security/api-tokens',
      type: 'string',
      defaultValue: '',
      category: 'jira',
      sensitive: true
    },
    {
      key: 'jira.projectKey',
      description: 'Default project key',
      detailedDescription: 'Default Jira project key to use when creating tickets (e.g., PROJ, DEV). You can override this when creating tickets.',
      type: 'string',
      defaultValue: '',
      category: 'jira',
      examples: ['PROJ', 'DEV', 'TEAM'],
      validate: (value: string) => {
        if (!value) return true; // Empty is ok
        return /^[A-Z]+$/.test(value);
      }
    },
    {
      key: 'jira.defaultIssueType',
      description: 'Default issue type',
      detailedDescription: 'Default type when creating Jira tickets. Can be overridden with --type flag.',
      type: 'enum',
      defaultValue: 'Task',
      options: ['Story', 'Bug', 'Task', 'Epic'],
      category: 'jira'
    },
    {
      key: 'jira.boardId',
      description: 'Board ID for sprints',
      detailedDescription: 'Jira board ID for sprint operations (optional). Used by "kunj jira list --sprint" to show tickets in active sprint. Find this in your board URL.',
      type: 'string',
      defaultValue: '',
      category: 'jira',
      examples: [
        '123 - From URL https://company.atlassian.net/jira/software/projects/PROJ/boards/123'
      ]
    },
    {
      key: 'jira.aiGeneration',
      description: 'Use AI to generate tickets',
      detailedDescription: 'When enabled, AI will automatically analyze branch commits and generate ticket summaries and descriptions when creating Jira tickets. Requires AI to be enabled.',
      type: 'boolean',
      defaultValue: true,
      category: 'jira',
      relatedSettings: ['ai.enabled', 'ai.model']
    }
  ]);
}
