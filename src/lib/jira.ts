// Jira Cloud integration using jira.js

import { Version3Client } from 'jira.js';
import chalk from 'chalk';
import { loadConfig } from './config';

// Cache for Jira client to avoid repeated authentication
let cachedClient: Version3Client | null = null;
let cachedBoardId: string | null = null;

/**
 * Get or create cached Jira client
 */
export function getJiraClient(): Version3Client {
  if (cachedClient) {
    return cachedClient;
  }

  const config = loadConfig();

  // Check if Jira is enabled
  if (!config.jira?.enabled) {
    throw new Error('Jira integration is not enabled. Run "kunj setup" to configure Jira.');
  }

  // Get credentials from config or environment variables
  const baseUrl = config.jira.baseUrl || process.env.JIRA_BASE_URL;
  const email = config.jira.email || process.env.JIRA_EMAIL;
  const apiToken = config.jira.apiToken || process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) {
    throw new Error(
      'Jira credentials not configured. Run "kunj setup" or set environment variables:\n' +
      '  JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN\n' +
      'API token can be generated at: https://id.atlassian.com/manage-profile/security/api-tokens'
    );
  }

  try {
    // Remove trailing slash from baseUrl if present
    const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

    cachedClient = new Version3Client({
      host: cleanBaseUrl,
      authentication: {
        basic: {
          email,
          apiToken,
        },
      },
    });

    return cachedClient;
  } catch (error) {
    clearClientCache();
    throw new Error(`Failed to initialize Jira client: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Clear cached client (useful for handling auth errors)
 */
export function clearClientCache(): void {
  cachedClient = null;
  cachedBoardId = null;
}

/**
 * Validate Jira credentials with a test API call
 */
export async function checkJiraCredentials(): Promise<boolean> {
  try {
    const client = getJiraClient();
    // Test with a simple API call - get current user
    await client.myself.getCurrentUser();
    return true;
  } catch (error) {
    clearClientCache();
    console.error(chalk.red('\nFailed to authenticate with Jira:'));
    console.error(chalk.gray(error instanceof Error ? error.message : String(error)));

    if (error instanceof Error && error.message.includes('410')) {
      console.log(chalk.yellow('\nThe API endpoint returned 410 (Gone). This may indicate:'));
      console.log(chalk.gray('- The API endpoint has been deprecated'));
      console.log(chalk.gray('- There may be an issue with the jira.js library version'));
      console.log(chalk.gray('- Try updating your Jira configuration'));
    }

    console.log(chalk.yellow('\nPlease check your credentials and try again.'));
    console.log(chalk.gray('Generate API token at: https://id.atlassian.com/manage-profile/security/api-tokens\n'));
    return false;
  }
}

/**
 * List issues assigned to current user
 */
export async function listMyIssues(options?: {
  jql?: string;
  maxResults?: number;
  fields?: string[];
}): Promise<any[]> {
  const client = getJiraClient();

  const defaultFields = [
    'summary',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'updated'
  ];

  try {
    // Use the new /rest/api/3/search/jql endpoint directly
    // The jira.js library doesn't support this new endpoint yet
    const result = await (client as any).sendRequest({
      url: '/rest/api/3/search/jql',
      method: 'POST',
      data: {
        jql: options?.jql || 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
        maxResults: options?.maxResults || 50,
        fields: options?.fields || defaultFields,
      },
    });

    return result.issues || [];
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('401')) {
      clearClientCache();
      throw new Error('Authentication failed. Please check your Jira credentials.');
    }

    // Extract detailed error messages from Jira response
    if (error.response && error.response.data && error.response.data.errorMessages) {
      const jiraErrors = error.response.data.errorMessages;
      console.error(chalk.red('\nJira API Error:'));
      jiraErrors.forEach((msg: string) => console.error(chalk.gray(`  - ${msg}`)));
      throw new Error(`Jira API Error: ${jiraErrors.join(', ')}`);
    }

    console.error(chalk.red('Issue search error:'), error.message);
    throw error;
  }
}

/**
 * Get a single issue by key
 */
export async function getIssue(issueKey: string): Promise<any> {
  const client = getJiraClient();

  try {
    const issue = await client.issues.getIssue({
      issueIdOrKey: issueKey,
      fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'description'],
    });

    return issue;
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      throw new Error(`Issue ${issueKey} not found`);
    }
    if (error instanceof Error && error.message.includes('401')) {
      clearClientCache();
      throw new Error('Authentication failed. Please check your Jira credentials.');
    }
    throw error;
  }
}

/**
 * Create a new Jira issue
 */
export async function createIssue(params: {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  assignToMe?: boolean;
}): Promise<any> {
  const client = getJiraClient();

  try {
    // Get current user for assignment
    let assignee = undefined;
    if (params.assignToMe) {
      const currentUser = await client.myself.getCurrentUser();
      assignee = { accountId: currentUser.accountId };
    }

    const issue = await client.issues.createIssue({
      fields: {
        project: {
          key: params.projectKey,
        },
        summary: params.summary,
        issuetype: {
          name: params.issueType,
        },
        description: params.description ? {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: params.description,
                },
              ],
            },
          ],
        } : undefined,
        assignee,
      },
    });

    return issue;
  } catch (error) {
    if (error instanceof Error && error.message.includes('401')) {
      clearClientCache();
      throw new Error('Authentication failed. Please check your Jira credentials.');
    }
    throw error;
  }
}

/**
 * Get current active sprint for a board
 */
export async function getCurrentSprint(boardId: string): Promise<any | null> {
  const client = getJiraClient();

  try {
    // Use the Agile API directly to get active sprints
    // This uses the /rest/agile/1.0 API which is separate from the main REST API
    const response: any = await (client as any).sendRequest({
      url: `/rest/agile/1.0/board/${boardId}/sprint`,
      method: 'GET',
      params: {
        state: 'active',
      },
    });

    if (response.values && response.values.length > 0) {
      return response.values[0];
    }

    return null;
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('401')) {
      clearClientCache();
      throw new Error('Authentication failed. Please check your Jira credentials.');
    }

    // Extract error details if available
    if (error.response?.data?.errorMessages) {
      const errorMsg = error.response.data.errorMessages.join(', ');
      console.warn(chalk.yellow(`Could not fetch sprint: ${errorMsg}`));
      return null;
    }

    console.warn(chalk.yellow(`Could not fetch sprint for board ${boardId}: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
}

/**
 * Add issue to sprint
 */
export async function addIssueToSprint(issueKey: string, sprintId: number): Promise<void> {
  const client = getJiraClient();

  try {
    // Use the Agile API directly to move issues to sprint
    await (client as any).sendRequest({
      url: `/rest/agile/1.0/sprint/${sprintId}/issue`,
      method: 'POST',
      data: {
        issues: [issueKey],
      },
    });
  } catch (error: any) {
    if (error instanceof Error && error.message.includes('401')) {
      clearClientCache();
      throw new Error('Authentication failed. Please check your Jira credentials.');
    }

    // Extract error details if available
    if (error.response?.data?.errorMessages) {
      const errorMsg = error.response.data.errorMessages.join(', ');
      throw new Error(`Failed to add issue to sprint: ${errorMsg}`);
    }

    throw error;
  }
}

/**
 * Search issues with custom JQL
 */
export async function searchIssues(jql: string, maxResults = 50): Promise<any[]> {
  return listMyIssues({ jql, maxResults });
}

/**
 * Generate branch name from Jira issue
 * Example: "feature/PROJ-123-add-user-authentication"
 */
export function generateBranchName(issue: any, prefix = 'feature'): string {
  const key = issue.key;
  const summary = issue.fields.summary;

  // Sanitize summary for branch name
  const sanitized = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .substring(0, 50) // Limit length
    .replace(/-$/, ''); // Remove trailing hyphen

  return `${prefix}/${key}-${sanitized}`;
}

/**
 * Extract Jira issue key from branch name
 * Matches patterns like PROJ-123, DEV-456, etc.
 */
export function extractJiraKey(branchName: string): string | null {
  const match = branchName.match(/[A-Z]+-\d+/);
  return match ? match[0] : null;
}

/**
 * Get cached board ID or fetch from config
 */
export function getBoardId(): string | null {
  if (cachedBoardId) {
    return cachedBoardId;
  }

  const config = loadConfig();
  cachedBoardId = config.jira?.boardId || null;
  return cachedBoardId;
}
