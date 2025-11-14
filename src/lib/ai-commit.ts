// AI-powered commit message generation using AWS Bedrock Claude 3.5 Sonnet

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { exec } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

// Get AWS region from config files or environment
function getAWSRegion(): string {
  // First check environment variables
  if (process.env.AWS_REGION) return process.env.AWS_REGION;
  if (process.env.AWS_DEFAULT_REGION) return process.env.AWS_DEFAULT_REGION;
  if (process.env.AMAZON_REGION) return process.env.AMAZON_REGION;

  // Try to read from AWS config file
  try {
    const configPath = path.join(os.homedir(), '.aws', 'config');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf8');
      const profileName = process.env.AWS_PROFILE || 'default';

      // Look for the region in the specified profile
      const profileRegex = new RegExp(`\\[(?:profile )?${profileName}\\][^\\[]*region\\s*=\\s*([^\\s]+)`, 'im');
      const match = config.match(profileRegex);
      if (match && match[1]) {
        return match[1];
      }

      // Fallback to default profile if not found
      if (profileName !== 'default') {
        const defaultMatch = config.match(/\[(?:profile )?default\][^\[]*region\s*=\s*([^\s]+)/im);
        if (defaultMatch && defaultMatch[1]) {
          return defaultMatch[1];
        }
      }
    }
  } catch (error) {
    // Ignore errors reading config file
  }

  // Default fallback
  return 'us-east-1';
}

// Initialize AWS Bedrock client
function getBedrockClient(): BedrockRuntimeClient {
  // The SDK will automatically use the credential chain:
  // 1. Environment variables (AWS_ACCESS_KEY_ID, etc.)
  // 2. Shared credentials file (~/.aws/credentials)
  // 3. Shared config file (~/.aws/config with AWS_PROFILE)
  // 4. EC2/ECS task roles
  // 5. EC2 instance metadata service
  // 6. SSO credentials
  // 7. And more...

  const region = getAWSRegion();

  return new BedrockRuntimeClient({
    region,
    // The SDK handles credentials automatically via the credential chain
  });
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
  diff?: string
): Promise<{ type: string; message: string; fullMessage?: string }> {
  try {
    // Get the diff if not provided
    const fileDiff = diff || (await getCommitDiff(files));

    // Prepare the context for AI
    const fileList = files.join(", ");
    const diffPreview =
      fileDiff.length > 3000
        ? fileDiff.substring(0, 3000) + "...[truncated]"
        : fileDiff;

    // Create the prompt for Claude
    const prompt = `You are an expert at writing clear, concise git commit messages following conventional commit standards.
Your task is to analyze the code changes and generate an appropriate commit message.

Conventional commit types:
- feat: A new feature
- fix: A bug fix
- docs: Documentation changes
- style: Code style changes (formatting, etc)
- refactor: Code refactoring
- test: Adding or updating tests
- chore: Maintenance tasks
- build: Build system changes
- ci: CI configuration changes
- perf: Performance improvements

Guidelines:
1. Choose the most appropriate commit type based on the changes
2. Write a clear, concise commit message (max 50 characters for the subject)
3. Focus on WHY the change was made, not just what changed
4. Use present tense ("add" not "added")
5. Don't end with a period

Analyze these code changes:

Files changed: ${fileList}

Diff:
\`\`\`diff
${diffPreview}
\`\`\`

Respond with:
TYPE: <commit type>
MESSAGE: <commit subject>
BODY: <optional detailed description>`;

    // Get the Bedrock client
    const client = getBedrockClient();

    // Using Claude 3.5 Sonnet
    const modelId =
      process.env.BEDROCK_MODEL || "anthropic.claude-3-5-sonnet-20241022-v2:0";

    console.log(chalk.blue("🤖 Analyzing changes with Claude 3.5 Sonnet..."));

    // Invoke the model
    const command = new InvokeModelCommand({
      modelId,
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 500,
        temperature: 0.7,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      contentType: "application/json",
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    // Extract the content from Claude's response
    const content = responseBody.content?.[0]?.text || "";

    // Parse the response
    const typeMatch = content.match(/TYPE:\s*(\w+)/i);
    const messageMatch = content.match(/MESSAGE:\s*(.+)/i);
    const bodyMatch = content.match(/BODY:\s*([\s\S]+)/i);

    if (!typeMatch || !messageMatch) {
      throw new Error("Could not parse AI response");
    }

    const type = typeMatch[1].toLowerCase();
    const message = messageMatch[1].trim();
    const body = bodyMatch ? bodyMatch[1].trim() : undefined;

    // Build the full message
    const fullMessage = body
      ? `${type}: ${message}\n\n${body}`
      : `${type}: ${message}`;

    return {
      type,
      message,
      fullMessage,
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
    };
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

// Check if AWS credentials are configured
export async function checkAWSCredentials(): Promise<boolean> {
  try {
    const client = getBedrockClient();

    // Try a minimal invoke to check if we have valid credentials and access
    // We use a very small request to minimize cost
    const command = new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL || "anthropic.claude-3-5-sonnet-20241022-v2:0",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      }),
      contentType: "application/json",
    });

    // Try to send the command
    try {
      await client.send(command);
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
      if (err.message?.includes("Could not load credentials") ||
          err.message?.includes("Missing credentials") ||
          err.message?.includes("No credentials")) {
        return false;
      }

      // Other errors (like ResourceNotFoundException for the model,
      // or throttling) mean credentials are OK but there might be
      // other issues - we consider credentials valid in these cases
      return true;
    }
  } catch (error: any) {
    // If we can't even create the client, credentials are not configured
    console.error(chalk.yellow("Warning: Could not check AWS credentials:", error.message));
    return false;
  }
}

// Get information about the current AWS configuration
export function getAWSConfigInfo(): { region: string; model: string } {
  return {
    region: getAWSRegion(),
    model: process.env.BEDROCK_MODEL || 'anthropic.claude-3-5-sonnet-20241022-v2:0'
  };
}
