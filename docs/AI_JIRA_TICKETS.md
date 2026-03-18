# AI-Powered Jira Ticket Creation

## Overview

Kunj can automatically generate Jira ticket summaries and descriptions by analyzing your branch's commit history and code changes using AI (AWS Bedrock Claude).

## Features

- **Automatic Analysis**: Analyzes all commits and diffs in your current branch
- **Smart Summaries**: Generates concise, actionable ticket titles
- **Detailed Descriptions**: Creates comprehensive descriptions with:
  - Problem/feature overview
  - Key implementation details
  - Business context
  - Bullet points for readability
- **Editable Output**: Review and modify AI suggestions before creating the ticket
- **Branch Context**: Incorporates branch metadata (description, tags, notes)

## Usage

### Enable AI Ticket Generation

AI ticket generation is enabled by default when:
1. Jira integration is enabled
2. AI is enabled in config
3. AWS credentials are configured

### Create a Ticket with AI

```bash
# Create ticket with AI (default if enabled)
kunj jira create

# Explicitly enable AI
kunj jira create --ai

# Disable AI for manual input
kunj jira create --no-ai
```

### Configuration

```bash
# Enable/disable AI ticket generation globally
kunj config set jira.aiGeneration true

# Check current setting
kunj config get jira.aiGeneration
```

## How It Works

1. **Analyze Branch**: Gets all commits since the base branch (main/master)
2. **Get Changes**: Retrieves the complete diff of code changes
3. **Generate Content**: Sends commit history and diff to Claude AI with instructions to:
   - Write from a business/product perspective
   - Focus on WHAT and WHY, not just HOW
   - Create actionable, clear descriptions
4. **Present Suggestions**: Shows AI-generated summary and description
5. **Allow Editing**: Opens your editor to review/modify before creation
6. **Create Ticket**: Creates the Jira ticket with your final content

## Example Workflow

```bash
# 1. Make changes and commit
git checkout -b feature/user-authentication
# ... make changes ...
git commit -m "Add JWT authentication"
git commit -m "Add login endpoint"
git commit -m "Add user session management"

# 2. Create ticket with AI
kunj jira create

# AI Output:
# Summary: Implement JWT-based user authentication system
# Description:
# Add secure authentication to the application using JSON Web Tokens.
#
# Key Features:
# - JWT token generation and validation
# - Secure login endpoint with credential verification
# - Session management with token refresh
# - User authentication middleware
#
# Implementation Details:
# - Uses bcrypt for password hashing
# - Implements token expiration and refresh logic
# - Adds authentication middleware to protected routes

# 3. Review, edit if needed, and create
```

## Benefits

### For Developers
- **Save Time**: No need to manually write ticket descriptions
- **Better Documentation**: AI captures technical details you might forget
- **Consistency**: Tickets follow a standardized format

### For Teams
- **Better Context**: Team members understand the work without digging through commits
- **Improved Planning**: Clear descriptions help with estimation
- **Knowledge Sharing**: Technical implementation details are documented

### For Product/Managers
- **Business Focus**: AI translates technical changes to business value
- **Visibility**: Easy-to-understand summaries of development work
- **Tracking**: Better traceability between code and requirements

## Configuration Options

```json
{
  "ai": {
    "enabled": true,
    "provider": "bedrock",
    "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "awsRegion": "us-east-1"
  },
  "jira": {
    "enabled": true,
    "aiGeneration": true,
    "projectKey": "PROJ",
    "defaultIssueType": "Task"
  }
}
```

## Requirements

- Jira Cloud integration configured
- AI features enabled
- AWS Bedrock access with Claude models
- At least one commit in the current branch

## Troubleshooting

### "No commits found in current branch"
- Ensure you've made commits on your branch
- Check you're not on the main/master branch

### "AI features are disabled"
```bash
kunj config set ai.enabled true
```

### "AI ticket generation failed"
- Verify AWS credentials are configured
- Check network connectivity to AWS Bedrock
- Ensure you have permissions for the Claude model
- Falls back to manual input if AI fails

### AI Output Needs Improvement
- Add a branch description: `kunj branch desc "Your branch purpose"`
- Add custom AI instructions: `kunj config set ai.customInstructions "Your guidelines"`
- Make more descriptive commit messages

## Tips for Best Results

1. **Write Good Commits**: More detailed commits = better ticket descriptions
2. **Add Branch Context**: Use `kunj create -d "description"` when creating branches
3. **Use Tags**: Tag branches with `kunj branch tag feature priority-high`
4. **Link Early**: Link to existing Jira tickets if available
5. **Review AI Output**: Always review and edit AI suggestions before creating

## Advanced: Custom Instructions

Tailor AI output to your team's needs:

```bash
# Add team-specific guidelines
kunj config set ai.customInstructions "Always mention security implications. Use active voice. Keep descriptions under 200 words."
```

## Integration with Other Commands

```bash
# Create branch, make changes, create linked ticket
kunj create feature/new-feature
# ... make changes and commits ...
kunj jira create --ai
# AI generates ticket from your work
# Ticket is created and can be linked to branch
```

## See Also

- [Jira Integration](../JIRA_INTEGRATION.md)
- [AI Commit Messages](../README.md#ai-features)
- [AI PR Descriptions](../README.md#pull-requests)
