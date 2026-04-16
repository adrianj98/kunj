// AI-powered commit message generation using AWS Bedrock Claude 3.5 Sonnet

const { ChatBedrockConverse } = require("@langchain/aws");
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { loadConfig as loadAwsConfig } from "@aws-sdk/node-config-provider";
import {
  NODE_REGION_CONFIG_OPTIONS,
  NODE_REGION_CONFIG_FILE_OPTIONS,
} from "@aws-sdk/config-resolver";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { exec } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { loadConfig } from "./config";
import { getCommitStylePrompt } from "./commit-styles";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

// Cache for region and credentials to avoid multiple async calls
let cachedRegion: string | null = null;
let regionProvider: (() => Promise<string>) | null = null;
let cachedClient: any | null = null;
let cachedProjectContext: string | null = null;
let projectContextChecked = false;

// Get project context from claude.md or similar files
function getProjectContext(): string | null {
  if (projectContextChecked) {
    return cachedProjectContext;
  }

  projectContextChecked = true;

  // Try multiple possible context file names
  const contextFiles = [
    'claude.md',
    '.claude.md',
    'CLAUDE.md',
    '.claude/context.md',
    'README.md',
  ];

  for (const fileName of contextFiles) {
    const filePath = path.join(process.cwd(), fileName);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Limit to first 1000 chars to avoid token overload
        cachedProjectContext = content.length > 1000
          ? content.substring(0, 1000) + '\n...(truncated)'
          : content;
        console.log(chalk.gray(`📋 Using project context from ${fileName}`));
        return cachedProjectContext;
      } catch (error) {
        // Ignore read errors
      }
    }
  }

  return null;
}

// Get the model ID from config or environment
export function getDefaultModelId(): string {
  const config = loadConfig();
  // Use config first, then environment variable, then default
  return (
    config.ai?.model ||
    process.env.BEDROCK_MODEL ||
    "anthropic.claude-3-5-sonnet-20240620-v1:0"
  );
}

// Check if an error is caused by missing inference profile (newer Claude models
// require cross-region inference profile IDs like us.anthropic.claude-... instead
// of bare anthropic.claude-... model IDs)
function isInferenceProfileError(err: any): boolean {
  return (
    err.message?.includes("on-demand throughput isn't supported") ||
    err.message?.includes("on-demand throughput is not supported") ||
    err.message?.includes("inference profile")
  );
}

function logInferenceProfileHelp(modelId: string): void {
  console.error(chalk.yellow(`\n⚠ Model '${modelId}' requires a cross-region inference profile.`));
  console.error(chalk.yellow("  Newer Claude models cannot be called with their bare model ID."));
  console.error(chalk.gray("  Fix: prefix the model ID with your region (e.g. 'us.', 'eu.', 'ap.'):"));
  console.error(chalk.cyan(`    kunj config set ai.model us.${modelId}`));
  console.error(chalk.gray("  Or set the BEDROCK_MODEL environment variable.\n"));
}

// Get the region provider
function getRegionProvider(): () => Promise<string> {
  if (!regionProvider) {
    // Use the SDK's built-in config loader which checks all standard sources
    const baseProvider = loadAwsConfig(
      NODE_REGION_CONFIG_OPTIONS,
      NODE_REGION_CONFIG_FILE_OPTIONS
    );

    // Wrap with fallback
    regionProvider = async () => {
      try {
        // First check our Kunj config
        const config = loadConfig();
        if (config.ai?.awsRegion) {
          return config.ai.awsRegion;
        }

        // Then fall back to SDK config
        const region = await baseProvider();
        return region || "us-east-1";
      } catch (error) {
        // Fallback if no region is configured anywhere
        return "us-east-1";
      }
    };
  }
  return regionProvider;
}

// Get AWS region using SDK's config resolver
export async function getAWSRegion(): Promise<string> {
  if (!cachedRegion) {
    try {
      const provider = getRegionProvider();
      cachedRegion = await provider();
    } catch (error) {
      // Fallback to default if region resolution fails
      cachedRegion = "us-east-1";
    }
  }
  return cachedRegion;
}

// Initialize AWS Bedrock client using ChatBedrockConverse
export async function getBedrockClient(): Promise<any> {
  if (!cachedClient) {
    const region = await getAWSRegion();
    const modelId = getDefaultModelId();

    // The ChatBedrockConverse will automatically use the credential chain via defaultProvider:
    // 1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
    // 2. Shared credentials file (~/.aws/credentials)
    // 3. Shared config file (~/.aws/config with AWS_PROFILE)
    // 4. ECS container credentials
    // 5. EC2 instance metadata service (IMDS)
    // 6. SSO credentials
    // 7. Web identity token credentials
    // 8. Process credentials

    cachedClient = new ChatBedrockConverse({
      model: modelId,
      region,
      credentials: defaultProvider(),
      temperature: 0.7,
      maxTokens: 2000, // Enough for PR descriptions (title + summary + changes)
    });
  }
  return cachedClient;
}

// Get the diff for the files being committed
export async function getCommitDiff(files: string[]): Promise<string> {
  try {
    // Get the diff for staged files
    const { stdout } = await execAsync("git diff --cached");
    if (stdout) {
      return stdout;
    }

    // If no staged files, get diff for the specified files
    const escapedFiles = files.map((f) => `"${f}"`).join(" ");
    const { stdout: fileDiff } = await execAsync(
      `git diff HEAD -- ${escapedFiles}`
    );
    return fileDiff || "";
  } catch (error) {
    console.error(chalk.yellow("Warning: Could not get file diff"));
    return "";
  }
}

// Generate commit message using AI
export async function generateAICommitMessage(
  files: string[],
  branchCommits: string[],
  currentBranch: string,
  diff?: string
): Promise<{ type: string; message: string; fullMessage?: string; branchDescription?: string }> {
  try {
    const config = loadConfig();

    // Check if AI is enabled
    if (!config.ai?.enabled) {
      throw new Error("AI features are disabled in config");
    }

    // Get the diff if not provided
    const fileDiff = diff || (await getCommitDiff(files));

    // Prepare the context for AI
    const fileList = files.join(", ");
    const diffPreview =
      fileDiff.length > 3000
        ? fileDiff.substring(0, 3000) + "...[truncated]"
        : fileDiff;

    // Get AI configuration options
    const maxCommits = config.ai?.maxContextCommits || 10;
    const includeBranch = config.ai?.includeBranchContext !== false; // default true
    const commitStyle = config.ai?.commitStyle || 'conventional';
    const maxLength = config.ai?.subjectMaxLength || 50;
    const includeBody = config.ai?.includeBody !== false; // default true
    const customInstructions = config.ai?.customInstructions || '';

    const branchContext = includeBranch && branchCommits.length > 0
      ? `\nRecent commits on this branch (${currentBranch}):\n${branchCommits.slice(0, maxCommits).map(c => `- ${c}`).join('\n')}\n`
      : '';

    // Get project context if available
    const projectContext = getProjectContext();
    const projectContextSection = projectContext
      ? `\nProject Context:\n${projectContext}\n`
      : '';

    // Get the style-specific prompt guidelines
    const styleGuidelines = getCommitStylePrompt(commitStyle, maxLength, includeBody, customInstructions);

    // Create the prompt for Claude
    const prompt = `${styleGuidelines}
${projectContextSection}
Your task is to analyze the code changes and generate an appropriate commit message, and also provide a very short description of what this branch is doing overall.
${branchContext}
Analyze these code changes:

Files changed: ${fileList}

Diff:
\`\`\`diff
${diffPreview}
\`\`\`

Respond with:
TYPE: <commit type or category>
MESSAGE: <commit subject line>
${includeBody ? 'BODY: <optional detailed description>\n' : ''}BRANCH_DESC: <very short description of what this branch is doing, 5-10 words>`;

    // Get the Bedrock client
    const client = await getBedrockClient();

    const styleLabel = commitStyle === 'conventional' ? 'Conventional Commits' :
                       commitStyle === 'semantic' ? 'Semantic Commits' :
                       commitStyle === 'gitmoji' ? 'Gitmoji' :
                       commitStyle === 'simple' ? 'Simple' :
                       commitStyle === 'caveman' ? 'Caveman' :
                       'Custom Style';

    console.log(chalk.blue(`🤖 Analyzing changes with Claude (${styleLabel})...`));

    // Invoke the model using ChatBedrockConverse
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content from Claude's response
    const content = response.content?.toString() || "";

    // Parse the response
    const typeMatch = content.match(/TYPE:\s*(.+?)(?:\n|$)/i);
    const messageMatch = content.match(/MESSAGE:\s*(.+?)(?:\n|$)/i);
    const bodyMatch = includeBody ? content.match(/BODY:\s*([^\n]*(?:\n(?!BRANCH_DESC:).*)*)/i) : null;
    const branchDescMatch = content.match(/BRANCH_DESC:\s*(.+?)(?:\n|$)/i);

    if (!typeMatch || !messageMatch) {
      throw new Error("Could not parse AI response");
    }

    const type = typeMatch[1].trim();
    let commitMessage = messageMatch[1].trim();
    const body = bodyMatch ? bodyMatch[1].trim() : undefined;
    const branchDescription = branchDescMatch ? branchDescMatch[1].trim() : undefined;

    // Build the full message based on commit style
    let fullMessage: string;

    if (commitStyle === 'conventional' || commitStyle === 'caveman') {
      // Format: type: message (caveman uses same conventional format, just terser content)
      const typePrefix = type.toLowerCase();
      fullMessage = body
        ? `${typePrefix}: ${commitMessage}\n\n${body}`
        : `${typePrefix}: ${commitMessage}`;
    } else if (commitStyle === 'semantic') {
      // Format: [TYPE] message
      fullMessage = body
        ? `[${type.toUpperCase()}] ${commitMessage}\n\n${body}`
        : `[${type.toUpperCase()}] ${commitMessage}`;
    } else if (commitStyle === 'gitmoji') {
      // Format: emoji message (type contains the emoji)
      fullMessage = body
        ? `${type} ${commitMessage}\n\n${body}`
        : `${type} ${commitMessage}`;
    } else if (commitStyle === 'simple') {
      // Format: just message (no type prefix)
      fullMessage = body
        ? `${commitMessage}\n\n${body}`
        : commitMessage;
    } else {
      // Custom style - use as is
      fullMessage = body
        ? `${type ? type + ': ' : ''}${commitMessage}\n\n${body}`
        : `${type ? type + ': ' : ''}${commitMessage}`;
    }

    return {
      type: type.toLowerCase(),
      message: commitMessage,
      fullMessage,
      branchDescription,
    };
  } catch (error: any) {
    if (isInferenceProfileError(error)) {
      logInferenceProfileHelp(getDefaultModelId());
    }
    console.error(chalk.red("AI generation failed:"), error.message);

    // Provide a fallback suggestion based on file patterns
    const fallbackType = suggestCommitType(files);
    const fallbackMessage = `Update ${files.length} file${
      files.length > 1 ? "s" : ""
    }`;

    return {
      type: fallbackType,
      message: fallbackMessage,
      fullMessage: `${fallbackType}: ${fallbackMessage}`,
      branchDescription: undefined,
    };
  }
}

// Generate a work log entry based on the commit
export async function generateWorkLogEntry(
  files: string[],
  commitMessage: string,
  branchName: string
): Promise<string | null> {
  try {
    // Check if AI is enabled
    const config = loadConfig();
    if (!config.ai?.enabled) {
      return null;
    }

    // Get the diff from the last commit (HEAD)
    // We're calling this after the commit is made, so we look at the commit we just made
    const { stdout: diff } = await execAsync(`git show HEAD`);

    if (!diff.trim()) {
      console.log(chalk.gray("No diff available for work log"));
      return null;
    }

    // Limit diff size for API
    const diffPreview = diff.length > 4000 ? diff.substring(0, 4000) + "\n... (truncated)" : diff;
    const fileList = files.join(", ");

    // Get project context if available
    const projectContext = getProjectContext();
    const projectContextSection = projectContext
      ? `\nProject Context:\n${projectContext}\n`
      : '';

    // Get commit style to determine verbosity
    const commitStyle = config.ai?.commitStyle || 'conventional';
    const isCaveman = commitStyle === 'caveman';

    // Create a prompt for generating a work log entry
    const prompt = isCaveman
      ? `Document dev work. Ultra-terse. Based on this commit, write compressed work log entry.
${projectContextSection}
Commit: ${commitMessage}
Branch: ${branchName}
Files: ${fileList}

Diff:
\`\`\`diff
${diffPreview}
\`\`\`

Format:
[TAG] WHAT changed (3-5 words)
- Change 1 (2-4 words)
- Change 2 (2-4 words)
Files: file1.ts, file2.ts

Tags: [feature] [bug] [refactor] [perf] [docs] [test] [chore]

Rules:
- Drop articles (a/an/the), filler, hedging
- Fragments OK. Short synonyms
- WHAT only. No WHY. Past tense
- 2-3 bullets max, 2-4 words each
- Max 3 files

Example:
"[feature] Added JWT auth
- Built token generation
- Created auth endpoints
Files: src/auth/jwt.ts"

Tagged entry only, no extra formatting.`
      : `You are documenting a developer's daily work. Based on this commit, write a CONCISE itemized work log entry.
${projectContextSection}
Commit message: ${commitMessage}
Branch: ${branchName}
Files changed: ${fileList}

Diff preview:
\`\`\`diff
${diffPreview}
\`\`\`

Write an ITEMIZED work log entry in this format:
[TAG] Brief description of WHAT was done
- Specific change 1
- Specific change 2
- Specific change 3 (if applicable)
Files: file1.ts, file2.ts

Tags to use:
- [feature] - New functionality added
- [bug] - Bug fix
- [refactor] - Code refactoring/cleanup
- [perf] - Performance improvement
- [docs] - Documentation update
- [test] - Test additions/updates
- [chore] - Maintenance tasks

CRITICAL Guidelines:
1. Start with [TAG] and brief summary of WHAT changed
2. Follow with 2-4 bullet points listing specific WHAT was added/changed/removed
3. Each bullet should be SHORT (3-6 words max)
4. End with "Files: " followed by comma-separated list of main files changed (max 3-4 files, use relative paths)
5. Focus ONLY on WHAT was done, NOT why it was needed
6. Use past tense
7. Be specific but concise
8. NEVER explain reasons, purposes, or goals - only state the changes

Good Examples (WHAT only):
"[feature] Added user authentication
- Built JWT token generation
- Created login/logout endpoints
- Added session middleware
Files: src/auth/jwt.ts, src/api/auth.ts"

"[bug] Fixed payment rounding
- Updated decimal calculation
- Added validation checks
- Corrected currency handling
Files: src/payments/processor.ts"

"[refactor] Restructured database layer
- Split queries into functions
- Removed duplicate code
- Updated connection pooling
Files: src/db/queries.ts, src/db/connection.ts"

Bad Examples (includes WHY - DO NOT do this):
"[feature] Added authentication to secure endpoints" ❌
"[bug] Fixed rounding to prevent errors" ❌
"[refactor] Split queries for better performance" ❌

Respond with just the tagged entry with bullets, no additional formatting.`;

    // Get the Bedrock client
    const client = await getBedrockClient();

    // Invoke the model
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content from Claude's response
    const workLogEntry = response.content?.toString().trim() || "";

    if (workLogEntry) {
      return workLogEntry;
    }

    console.log(chalk.gray("AI returned empty work log entry"));
    return null;
  } catch (error: any) {
    if (isInferenceProfileError(error)) {
      logInferenceProfileHelp(getDefaultModelId());
    }
    console.error(chalk.red("Work log generation error:"), error.message);
    throw error; // Re-throw to be caught by caller
  }
}

// Generate a stash message using AI
export async function generateStashMessage(
  files: string[]
): Promise<string | null> {
  try {
    // Check if AI is enabled
    const config = loadConfig();
    if (!config.ai?.enabled) {
      return null;
    }

    // Get the diff for unstaged/staged changes
    const { stdout: diff } = await execAsync("git diff HEAD");

    if (!diff.trim()) {
      console.log(chalk.gray("No changes to stash"));
      return null;
    }

    // Limit diff size for API
    const diffPreview = diff.length > 3000 ? diff.substring(0, 3000) + "\n... (truncated)" : diff;
    const fileList = files.join(", ");

    // Get project context if available
    const projectContext = getProjectContext();
    const projectContextSection = projectContext
      ? `\nProject Context:\n${projectContext}\n`
      : '';

    // Create a prompt for generating a stash message
    const prompt = `You are helping a developer create a descriptive stash message for their work-in-progress changes.
${projectContextSection}
Files changed: ${fileList}

Diff preview:
\`\`\`diff
${diffPreview}
\`\`\`

Generate a CONCISE stash message (one line, 50 characters max) that describes WHAT changes are being stashed.

Guidelines:
- One line only, no line breaks
- 50 characters max
- Use present tense (e.g., "WIP: Add user auth", "Half-done checkout flow")
- Start with "WIP: " if work is incomplete
- Be specific but brief
- Focus on WHAT, not WHY

Examples:
"WIP: Add JWT authentication"
"WIP: Refactor payment processor"
"Half-done user profile page"
"Incomplete API rate limiting"
"WIP: Fix checkout bug"

Respond with ONLY the stash message, nothing else.`;

    // Get the Bedrock client
    const client = await getBedrockClient();

    // Invoke the model
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content from Claude's response
    const stashMessage = response.content?.toString().trim() || "";

    if (stashMessage) {
      // Remove any quotes that might be added
      return stashMessage.replace(/^["']|["']$/g, '');
    }

    console.log(chalk.gray("AI returned empty stash message"));
    return null;
  } catch (error: any) {
    console.error(chalk.red("Stash message generation error:"), error.message);
    return null;
  }
}

// Generate a work log entry for a PR
export async function generatePRLogEntry(
  prTitle: string,
  prBody: string,
  commits: string[],
  branchName: string,
  baseBranch: string
): Promise<string | null> {
  try {
    // Check if AI is enabled
    const config = loadConfig();
    if (!config.ai?.enabled) {
      return null;
    }

    // Get the diff between base branch and current branch
    const { stdout: diff } = await execAsync(`git diff ${baseBranch}...HEAD`);

    if (!diff.trim()) {
      console.log(chalk.gray("No diff available for PR log"));
      return null;
    }

    // Limit diff size for API
    const diffPreview = diff.length > 4000 ? diff.substring(0, 4000) + "\n... (truncated)" : diff;
    const commitList = commits.slice(0, 10).join("\n");

    // Get project context if available
    const projectContext = getProjectContext();
    const projectContextSection = projectContext
      ? `\nProject Context:\n${projectContext}\n`
      : '';

    // Get commit style to determine verbosity
    const commitStyle = config.ai?.commitStyle || 'conventional';
    const isCaveman = commitStyle === 'caveman';

    // Create a prompt for generating a PR work log entry
    const prompt = isCaveman
      ? `Document PR work. Ultra-terse.
${projectContextSection}
PR: ${prTitle}
Branch: ${branchName} → ${baseBranch}
Commits:
${commitList}

Diff:
\`\`\`diff
${diffPreview}
\`\`\`

Format:
[TAG] WHAT done (3-5 words)
- Change 1 (2-4 words)
- Change 2 (2-4 words)
PR: #

Tags: [feature] [bug] [refactor] [perf] [docs] [test] [chore]

Rules: Drop articles/filler. Fragments OK. WHAT only. Past tense. 2-3 bullets max.

Tagged entry only.`
      : `You are documenting a developer's daily work. Based on this pull request, write a CONCISE itemized work log entry.
${projectContextSection}
PR Title: ${prTitle}
PR Description: ${prBody}
Branch: ${branchName} → ${baseBranch}
Commits:
${commitList}

Diff preview:
\`\`\`diff
${diffPreview}
\`\`\`

Write an ITEMIZED work log entry in this format:
[TAG] Brief description of WHAT was done (PR-level summary)
- Specific change 1
- Specific change 2
- Specific change 3 (if applicable)
PR: #<will be added later>

Tags to use:
- [feature] - New functionality added
- [bug] - Bug fix
- [refactor] - Code refactoring/cleanup
- [perf] - Performance improvement
- [docs] - Documentation update
- [test] - Test additions/updates
- [chore] - Maintenance tasks

CRITICAL Guidelines:
1. Start with [TAG] and brief summary of WHAT the PR accomplishes overall
2. Follow with 2-4 bullet points listing the main WHAT was added/changed/removed across all commits
3. Each bullet should be SHORT (3-6 words max)
4. End with "PR: #" (the PR number will be added by the system)
5. Focus ONLY on WHAT was done, NOT why it was needed
6. Use past tense
7. Be specific but concise
8. Think at the PR level - summarize the overall changes, not individual commits
9. NEVER explain reasons, purposes, or goals - only state the changes

Good Examples (WHAT only, PR-level):
"[feature] Implemented user authentication system
- Added JWT token generation
- Created auth endpoints
- Built session management
- Added auth middleware
PR: #"

"[bug] Fixed payment processing issues
- Corrected decimal rounding
- Updated transaction validation
- Fixed currency conversion
PR: #"

"[refactor] Restructured API layer
- Split routes into modules
- Cleaned up error handling
- Updated middleware chain
PR: #"

Respond with just the tagged entry with bullets, no additional formatting.`;

    // Get the Bedrock client
    const client = await getBedrockClient();

    // Invoke the model
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content from Claude's response
    const prLogEntry = response.content?.toString().trim() || "";

    if (prLogEntry) {
      return prLogEntry;
    }

    console.log(chalk.gray("AI returned empty PR log entry"));
    return null;
  } catch (error: any) {
    if (isInferenceProfileError(error)) {
      logInferenceProfileHelp(getDefaultModelId());
    }
    console.error(chalk.red("PR log generation error:"), error.message);
    throw error; // Re-throw to be caught by caller
  }
}

// Generate abbreviated standup bullets from work log entries
export async function generateStandupBullets(
  workLogContent: string,
  dateLabel: string
): Promise<string[] | null> {
  try {
    // Check if AI is enabled
    const config = loadConfig();
    if (!config.ai?.enabled) {
      return null;
    }

    if (!workLogContent || !workLogContent.trim()) {
      return null;
    }

    // Get project context if available
    const projectContext = getProjectContext();
    const projectContextSection = projectContext
      ? `\nProject Context:\n${projectContext}\n`
      : '';

    // Get commit style to determine verbosity
    const commitStyle = config.ai?.commitStyle || 'conventional';
    const isCaveman = commitStyle === 'caveman';

    // Create a prompt for generating abbreviated bullets
    const prompt = isCaveman
      ? `Standup bullets for ${dateLabel}. Ultra-terse.
${projectContextSection}
Work Log:
${workLogContent}

Format: "- Area: action" (3-6 words total)
[bug] → "Fixed..." | [feature] → "Added/Built..." | [refactor] → "Cleaned up..."
Combine related. 2-4 bullets max. No filler. Dashes only.`
      : `You are helping prepare for a daily standup meeting. Below is a work log for ${dateLabel}.
${projectContextSection}
Your task: Create 3-5 EXTREMELY concise bullet points using the format: <feature>: <action>

Guidelines:
- Format: "<feature area>: <action description>" (5-10 words total)
- Feature area should be 1-2 words (e.g., Auth, API, UI, Database, etc.)
- If the work log entry has [bug] or [fix] tag, START the action with "Fixed"
- If [feature] tag, use casual verbs like "Added/Built/Worked on/Set up"
- If [refactor] tag, use "Cleaned up/Improved/Reworked"
- Use CASUAL, NATURAL language - sound like a developer talking to their team, NOT like formal documentation
- Avoid corporate jargon or overly polished language
- Use simple, direct words that you'd actually say out loud
- Combine related tasks into single bullets
- Remove redundancy and technical details
- Use past tense

Work Log:
${workLogContent}

Respond with ONLY the bullet points, one per line, starting with a dash (-). No additional text, explanations, or formatting.

Example format (CASUAL tone):
- Auth: Built JWT auth
- Payment: Fixed that checkout bug
- API: Added rate limiting
- Database: Cleaned up queries
- UI: Added dark mode`;

    // Get the Bedrock client
    const client = await getBedrockClient();

    // Invoke the model
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content from Claude's response
    const responseText = response.content?.toString().trim() || "";

    if (!responseText) {
      return null;
    }

    // Parse bullet points from response
    const bullets = responseText
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.startsWith('-'))
      .map((line: string) => line.substring(1).trim())
      .filter((line: string) => line.length > 0);

    if (bullets.length === 0) {
      return null;
    }

    return bullets;
  } catch (error: any) {
    console.error(chalk.gray("Standup bullet generation failed:"), error.message);
    return null;
  }
}

// Fallback function to suggest commit type based on files
function suggestCommitType(files: string[]): string {
  if (files.some((f) => f.includes("test") || f.includes("spec"))) {
    return "test";
  }
  if (files.some((f) => f.includes(".md") || f.includes("README"))) {
    return "docs";
  }
  if (files.some((f) => f.includes("package.json") || f.includes("tsconfig"))) {
    return "build";
  }
  if (
    files.some(
      (f) => f.includes(".yml") || f.includes(".yaml") || f.includes(".github")
    )
  ) {
    return "ci";
  }
  if (files.some((f) => f.includes("fix") || f.includes("bug"))) {
    return "fix";
  }

  return "feat";
}

// Validate that a specific model ID works by sending a minimal request.
// Returns { ok: true } on success or { ok: false, message, inferenceProfileNeeded } on failure.
export async function validateBedrockModel(modelId: string): Promise<{ ok: boolean; message?: string; inferenceProfileNeeded?: boolean }> {
  try {
    const region = await getAWSRegion();
    const testClient = new ChatBedrockConverse({
      model: modelId,
      region,
      credentials: defaultProvider(),
      maxTokens: 1,
    });

    await testClient.invoke([{ role: "user", content: "hi" }]);
    return { ok: true };
  } catch (err: any) {
    if (isInferenceProfileError(err)) {
      return { ok: false, inferenceProfileNeeded: true, message: `Model requires a cross-region inference profile prefix (e.g. us.${modelId})` };
    }
    if (err.message?.includes("model identifier is invalid") || err.message?.includes("ValidationException")) {
      return { ok: false, message: `Model '${modelId}' is not available in this region` };
    }
    if (
      err.name === "CredentialsProviderError" ||
      err.message?.includes("Could not load credentials") ||
      err.message?.includes("Missing credentials") ||
      err.$metadata?.httpStatusCode === 403 ||
      err.$metadata?.httpStatusCode === 401
    ) {
      return { ok: false, message: "AWS credentials are missing or invalid" };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

// Check if AI is enabled and AWS credentials are configured
export async function checkAWSCredentials(): Promise<boolean> {
  try {
    const config = loadConfig();

    // First check if AI is enabled in config
    if (!config.ai?.enabled) {
      return false;
    }

    // Try a minimal invoke to check if we have valid credentials and access
    // We use a very small request to minimize cost
    try {
      // Set a very low max tokens to minimize cost
      const testClient = new ChatBedrockConverse({
        model: getDefaultModelId(),
        region: await getAWSRegion(),
        credentials: defaultProvider(),
        maxTokens: 1,
      });

      await testClient.invoke([{ role: "user", content: "test" }]);
      return true; // If successful, credentials are valid
    } catch (err: any) {
      // Check specific error types
      if (
        err.name === "CredentialsProviderError" ||
        err.name === "InvalidSignatureException" ||
        err.name === "UnrecognizedClientException" ||
        err.name === "InvalidUserException" ||
        err.name === "TokenRefreshRequired" ||
        err.$metadata?.httpStatusCode === 403 ||
        err.$metadata?.httpStatusCode === 401
      ) {
        // These errors indicate credential problems
        return false;
      }

      // Check for missing credentials
      if (
        err.message?.includes("Could not load credentials") ||
        err.message?.includes("Missing credentials") ||
        err.message?.includes("No credentials") ||
        err.message?.includes("Could not resolve credentials")
      ) {
        return false;
      }

      // Check for inference profile requirement (newer Claude models)
      if (isInferenceProfileError(err)) {
        logInferenceProfileHelp(getDefaultModelId());
        return false;
      }

      // Check for invalid model identifier
      if (
        err.message?.includes("model identifier is invalid") ||
        err.message?.includes("ValidationException")
      ) {
        // Model doesn't exist but credentials are OK
        console.error(
          chalk.yellow("Warning: Model not available:", getDefaultModelId())
        );
        console.error(
          chalk.yellow(
            "Try setting BEDROCK_MODEL environment variable to a valid model ID"
          )
        );
        return true;
      }

      // Other errors (like ResourceNotFoundException for the model,
      // or throttling) mean credentials are OK but there might be
      // other issues - we consider credentials valid in these cases
      return true;
    }
  } catch (error: any) {
    // If we can't even create the client, credentials are not configured
    console.error(
      chalk.yellow("Warning: Could not check AWS credentials:", error.message)
    );
    return false;
  }
}

export interface BedrockModelOption {
  id: string;
  name: string;
  provider: string;
  /** true = requires cross-region inference profile prefix (us./eu./ap.) */
  requiresInferenceProfile: boolean;
}

// List available Bedrock models (foundation models + inference profiles),
// filtered to Anthropic/Claude models only.
export async function listBedrockModels(): Promise<BedrockModelOption[]> {
  const region = await getAWSRegion();
  const client = new BedrockClient({
    region,
    credentials: defaultProvider(),
  });

  const models: BedrockModelOption[] = [];

  // 1. Foundation models (all providers that support text generation)
  try {
    const { modelSummaries = [] } = await client.send(
      new ListFoundationModelsCommand({})
    );
    for (const m of modelSummaries) {
      if (!m.modelId) continue;
      // Only include models that support text generation
      const outputModalities = m.outputModalities || [];
      if (!outputModalities.includes("TEXT" as any)) continue;
      const onDemandOk = m.inferenceTypesSupported?.includes("ON_DEMAND" as any);
      models.push({
        id: m.modelId,
        name: m.modelName || m.modelId,
        provider: m.providerName || "Unknown",
        requiresInferenceProfile: !onDemandOk,
      });
    }
  } catch {
    // credentials or network issue — let caller handle
  }

  // 2. Cross-region inference profiles
  try {
    const { inferenceProfileSummaries = [] } = await client.send(
      new ListInferenceProfilesCommand({})
    );
    for (const p of inferenceProfileSummaries) {
      if (!p.inferenceProfileId) continue;
      models.push({
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
        provider: "Inference Profile",
        requiresInferenceProfile: false, // it IS the profile
      });
    }
  } catch {
    // Not all regions/accounts have inference profiles configured
  }

  return models;
}

// Get information about the current AWS configuration
export async function getAWSConfigInfo(): Promise<{
  enabled: boolean;
  region: string;
  model: string;
  provider?: string;
}> {
  const config = loadConfig();
  return {
    enabled: config.ai?.enabled || false,
    region: await getAWSRegion(),
    model: getDefaultModelId(),
    provider: config.ai?.provider,
  };
}
