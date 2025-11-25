// AI-powered commit message generation using AWS Bedrock Claude 3.5 Sonnet

const { ChatBedrockConverse } = require("@langchain/aws");
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { loadConfig as loadAwsConfig } from "@aws-sdk/node-config-provider";
import {
  NODE_REGION_CONFIG_OPTIONS,
  NODE_REGION_CONFIG_FILE_OPTIONS,
} from "@aws-sdk/config-resolver";
import { exec } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { loadConfig } from "./config";
import { getCommitStylePrompt } from "./commit-styles";

const execAsync = promisify(exec);

// Cache for region and credentials to avoid multiple async calls
let cachedRegion: string | null = null;
let regionProvider: (() => Promise<string>) | null = null;
let cachedClient: any | null = null;

// Get the model ID from config or environment
function getDefaultModelId(): string {
  const config = loadConfig();
  // Use config first, then environment variable, then default
  return (
    config.ai?.model ||
    process.env.BEDROCK_MODEL ||
    "anthropic.claude-3-5-sonnet-20240620-v1:0"
  );
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
async function getAWSRegion(): Promise<string> {
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
      maxTokens: 1000, // Increased to handle both commits and PR descriptions
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

    // Get the style-specific prompt guidelines
    const styleGuidelines = getCommitStylePrompt(commitStyle, maxLength, includeBody, customInstructions);

    // Create the prompt for Claude
    const prompt = `${styleGuidelines}

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

    if (commitStyle === 'conventional') {
      // Format: type: message
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

    // Get the diff
    const { stdout: diff } = await execAsync(
      `git diff --cached -- ${files.map((f) => `"${f}"`).join(" ")}`
    );

    if (!diff.trim()) {
      return null;
    }

    // Limit diff size for API
    const diffPreview = diff.length > 4000 ? diff.substring(0, 4000) + "\n... (truncated)" : diff;
    const fileList = files.join(", ");

    // Create a prompt for generating a work log entry
    const prompt = `You are documenting a developer's daily work. Based on this commit, write a brief, professional work log entry.

Commit message: ${commitMessage}
Branch: ${branchName}
Files changed: ${fileList}

Diff preview:
\`\`\`diff
${diffPreview}
\`\`\`

Write a concise work log entry (2-3 sentences) that:
1. Describes WHAT was done (the feature/fix/change)
2. Explains WHY it was needed (the purpose/goal)
3. Uses past tense and professional language
4. Is suitable for reviewing your work later

Do NOT include the commit message directly. Write it as a natural diary entry describing your work.
Example: "Implemented user authentication flow with JWT tokens to secure API endpoints. Added middleware for token validation and refresh logic to maintain user sessions."

Respond with just the work log entry text, no additional formatting or labels.`;

    // Get the Bedrock client
    const client = await getBedrockClient();

    console.log(chalk.gray("📝 Generating work log entry..."));

    // Invoke the model
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content from Claude's response
    const workLogEntry = response.content?.toString().trim() || "";

    if (workLogEntry) {
      return workLogEntry;
    }

    return null;
  } catch (error: any) {
    console.error(chalk.gray("Work log generation failed:"), error.message);
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
