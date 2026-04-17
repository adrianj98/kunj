// Slack integration for reading channel activity

import { WebClient } from '@slack/web-api';
import { loadConfig } from './config';

let cachedClient: WebClient | null = null;

export interface SlackChannel {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
}

export interface SlackMessage {
  channelId: string;
  channelName: string;
  user: string;
  text: string;
  timestamp: string;
  threadReplyCount?: number;
}

/**
 * Get or create cached Slack WebClient.
 * Pass an explicit token to bypass config lookup (useful during config editing).
 */
export function getSlackClient(explicitToken?: string): WebClient {
  if (explicitToken) {
    return new WebClient(explicitToken);
  }

  if (cachedClient) {
    return cachedClient;
  }

  const config = loadConfig();

  if (!config.slack?.enabled) {
    throw new Error('Slack integration is not enabled. Run "kunj config -i" to configure Slack.');
  }

  const token = config.slack.token || process.env.SLACK_BOT_TOKEN;

  if (!token) {
    throw new Error(
      'Slack bot token not configured. Run "kunj config -i" or set SLACK_BOT_TOKEN env var.\n' +
      'Create a Slack app at https://api.slack.com/apps and add scopes: channels:history, channels:read, groups:read, groups:history, users:read'
    );
  }

  cachedClient = new WebClient(token);
  return cachedClient;
}

/**
 * Check if Slack credentials are valid by testing auth.
 */
export async function checkSlackCredentials(token?: string): Promise<boolean> {
  try {
    const client = getSlackClient(token);
    const result = await client.auth.test();
    return !!result.ok;
  } catch {
    return false;
  }
}

/**
 * List channels the bot can see (public + joined private).
 */
export async function listSlackChannels(token?: string): Promise<SlackChannel[]> {
  const client = getSlackClient(token);
  const channels: SlackChannel[] = [];

  let cursor: string | undefined;
  do {
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    for (const ch of result.channels || []) {
      if (ch.id && ch.name) {
        channels.push({
          id: ch.id,
          name: ch.name,
          isMember: !!ch.is_member,
          isPrivate: !!ch.is_private,
        });
      }
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  channels.sort((a, b) => {
    if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return channels;
}

// Cache for user ID → display name lookups
const userNameCache = new Map<string, string>();

async function resolveUserName(client: WebClient, userId: string): Promise<string> {
  if (userNameCache.has(userId)) {
    return userNameCache.get(userId)!;
  }
  try {
    const result = await client.users.info({ user: userId });
    const name = result.user?.real_name || result.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    userNameCache.set(userId, userId);
    return userId;
  }
}

/**
 * Fetch recent messages from a channel (last 24h by default).
 * Requires channels:history / groups:history scopes.
 */
export async function fetchChannelHistory(
  channelId: string,
  sinceHoursAgo: number = 48,
  limit: number = 100,
  oldestOverride?: string
): Promise<SlackMessage[]> {
  const client = getSlackClient();

  const oldest = oldestOverride || String(Math.floor((Date.now() - sinceHoursAgo * 60 * 60 * 1000) / 1000));

  // Get channel name
  let channelName = channelId;
  try {
    const info = await client.conversations.info({ channel: channelId });
    channelName = (info.channel as any)?.name || channelId;
  } catch {
    // use ID as fallback
  }

  const messages: SlackMessage[] = [];

  try {
    const result = await client.conversations.history({
      channel: channelId,
      oldest,
      limit,
    });

    for (const msg of result.messages || []) {
      // Skip bot messages and join/leave events
      if (msg.subtype && msg.subtype !== 'thread_broadcast') continue;
      if (!msg.text) continue;

      const userName = msg.user ? await resolveUserName(client, msg.user) : 'unknown';

      messages.push({
        channelId,
        channelName,
        user: userName,
        text: msg.text,
        timestamp: msg.ts || '',
        threadReplyCount: msg.reply_count,
      });
    }
  } catch {
    // Channel may not be accessible
  }

  // Chronological order (oldest first)
  messages.reverse();

  return messages;
}

/**
 * Fetch messages from multiple channels.
 */
export async function fetchMultiChannelHistory(
  channelIds: string[],
  sinceHoursAgo: number = 48,
  limitPerChannel: number = 50,
  oldestOverride?: string
): Promise<SlackMessage[]> {
  const allMessages: SlackMessage[] = [];

  for (const channelId of channelIds) {
    const messages = await fetchChannelHistory(channelId, sinceHoursAgo, limitPerChannel, oldestOverride);
    allMessages.push(...messages);
  }

  // Sort all messages chronologically
  allMessages.sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));

  return allMessages;
}
