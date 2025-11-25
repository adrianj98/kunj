// AI-powered PR description generation using existing AI infrastructure

import chalk from "chalk";
import { loadConfig } from "./config";
import { getCommitStylePrompt } from "./commit-styles";
import { getBedrockClient } from "./ai-commit";
import { BranchMetadata } from "../types";

// Get the diff between branches for PR context
export async function getPRDiff(baseBranch: string): Promise<string> {
  try {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);

    // Get the diff from base branch to current HEAD
    const { stdout } = await execAsync(`git diff ${baseBranch}...HEAD`);
    return stdout || "";
  } catch (error) {
    console.error(chalk.yellow("Warning: Could not get PR diff"));
    return "";
  }
}

// Generate PR title and description using AI
export async function generateAIPRDescription(
  currentBranch: string,
  baseBranch: string,
  branchMetadata: BranchMetadata | undefined,
  commits: string[],
  diff?: string
): Promise<{ title: string; body: string }> {
  try {
    const config = loadConfig();

    // Check if AI is enabled
    if (!config.ai?.enabled) {
      throw new Error("AI features are disabled in config");
    }

    // Get the diff if not provided and includeDiffInPR is enabled
    const shouldIncludeDiff = config.ai?.includeDiffInPR !== false; // default true
    const prDiff = shouldIncludeDiff ? (diff || (await getPRDiff(baseBranch))) : "";

    // Get AI configuration
    const commitStyle = config.ai?.commitStyle || 'conventional';
    const maxLength = config.ai?.subjectMaxLength || 72; // PRs can be longer
    const includeBody = config.ai?.includeBody !== false;
    const customInstructions = config.ai?.customInstructions || '';
    const includeBranchContext = config.ai?.includeBranchContext !== false;
    const maxContextCommits = config.ai?.maxContextCommits || 10;

    // Prepare branch context
    const branchDescription = branchMetadata?.description || '';
    const branchTags = branchMetadata?.tags?.join(', ') || '';
    const branchNotes = branchMetadata?.notes || '';

    // Truncate diff if too long
    const diffPreview = prDiff.length > 5000
      ? prDiff.substring(0, 5000) + "...[truncated]"
      : prDiff;

    // Format commits for context
    const commitsContext = includeBranchContext && commits.length > 0
      ? `\nCommits in this PR:\n${commits.slice(0, maxContextCommits).map(c => `- ${c}`).join('\n')}\n`
      : '';

    // Get style-specific guidelines (reuse commit style prompts)
    const styleGuidelines = getCommitStylePrompt(commitStyle, maxLength, includeBody, customInstructions);

    // Create the PR-specific prompt
    const prompt = `You are an expert at writing clear, informative GitHub pull request descriptions.

${styleGuidelines}

Your task is to analyze the code changes and generate a pull request title and description.

Branch Information:
- Current branch: ${currentBranch}
- Base branch: ${baseBranch}
${branchDescription ? `- Branch purpose: ${branchDescription}` : ''}
${branchTags ? `- Tags: ${branchTags}` : ''}
${branchNotes ? `- Notes: ${branchNotes}` : ''}
${commitsContext}
Code Changes:
\`\`\`diff
${diffPreview}
\`\`\`

Generate a pull request with:
1. A concise, descriptive title (max ${maxLength} characters)
2. A summary section explaining what this PR accomplishes
3. A changes section detailing the key modifications

Respond with:
TITLE: <pr title>
SUMMARY: <high-level overview of what this PR does and why>
CHANGES: <detailed breakdown of key changes, one per line, use bullet points>`;

    // Get the Bedrock client (reuses cached client from ai-commit)
    const client = await getBedrockClient();

    const styleLabel = commitStyle === 'conventional' ? 'Conventional Style' :
                       commitStyle === 'semantic' ? 'Semantic Style' :
                       commitStyle === 'gitmoji' ? 'Gitmoji Style' :
                       commitStyle === 'simple' ? 'Simple Style' :
                       'Custom Style';

    console.log(chalk.blue(`🤖 Generating PR description with Claude (${styleLabel})...`));

    // Invoke the model
    const response = await client.invoke([{ role: "user", content: prompt }]);

    // Extract the content
    const content = response.content?.toString() || "";

    // Parse the response
    const titleMatch = content.match(/TITLE:\s*(.+?)(?:\n|$)/i);
    const summaryMatch = content.match(/SUMMARY:\s*([^\n]*(?:\n(?!CHANGES:).*)*)/i);
    const changesMatch = content.match(/CHANGES:\s*([^\n]*(?:\n(?!$).*)*)$/is);

    if (!titleMatch) {
      throw new Error("Could not parse AI response - no title found");
    }

    const title = titleMatch[1].trim();
    const summary = summaryMatch ? summaryMatch[1].trim() : '';
    const changes = changesMatch ? changesMatch[1].trim() : '';

    // Build the PR body
    let body = '';

    if (summary) {
      body += `## Summary\n\n${summary}\n\n`;
    }

    if (changes) {
      body += `## Changes\n\n${changes}\n`;
    }

    return {
      title,
      body: body.trim() || summary || 'PR description generated by AI',
    };
  } catch (error: any) {
    console.error(chalk.red("AI PR generation failed:"), error.message);

    // Return empty to trigger fallback to heuristic method
    throw error;
  }
}
