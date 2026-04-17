// Slack settings - used by Slack integration for team reports

import { registerSettings } from '../lib/settings-registry';

export function registerSlackSettings(): void {
  registerSettings([
    {
      key: 'slack.enabled',
      description: 'Slack integration enabled',
      detailedDescription: 'Enable Slack integration to pull channel activity into team reports. Requires a Slack app with channels:history, channels:read, groups:read, groups:history, and users:read scopes.',
      type: 'boolean',
      defaultValue: false,
      category: 'slack',
      relatedSettings: ['slack.token', 'slack.signingSecret', 'slack.appToken']
    },
    {
      key: 'slack.token',
      description: 'Slack Bot OAuth token',
      detailedDescription: 'Bot User OAuth Token (xoxb-...) from your Slack app. Found under OAuth & Permissions in your app settings. Requires scopes: channels:history, channels:read, groups:read, groups:history, users:read.',
      type: 'string',
      defaultValue: '',
      category: 'slack',
      sensitive: true,
      examples: ['xoxb-1234567890-1234567890123-abcdefghijklmnop'],
      validate: (value: string) => {
        if (!value) return true;
        return value.startsWith('xoxb-');
      }
    },
    {
      key: 'slack.signingSecret',
      description: 'Slack signing secret',
      detailedDescription: 'Signing Secret from your Slack app\'s Basic Information page. Used to verify requests originate from Slack.',
      type: 'string',
      defaultValue: '',
      category: 'slack',
      sensitive: true
    },
    {
      key: 'slack.appToken',
      description: 'Slack App-Level token',
      detailedDescription: 'App-Level Token (xapp-...) for Socket Mode. Generate under Basic Information → App-Level Tokens with connections:write scope. Optional — only needed for Socket Mode features.',
      type: 'string',
      defaultValue: '',
      category: 'slack',
      sensitive: true,
      examples: ['xapp-1-A1234567890-1234567890123-abcdefghijklmnop'],
      validate: (value: string) => {
        if (!value) return true;
        return value.startsWith('xapp-');
      }
    },
    {
      key: 'slack.channels',
      description: 'Channels to post reports to',
      detailedDescription: 'Slack channel IDs to post team reports to. Reports are automatically posted to all listed channels when running "kunj team". Configure via interactive editor for a channel selector.',
      type: 'array',
      defaultValue: [],
      category: 'slack',
      examples: ['C0123456789', 'C0987654321']
    }
  ]);
}
