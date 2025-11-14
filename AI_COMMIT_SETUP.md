# AI-Powered Commit Messages with AWS Bedrock Claude 3.5 Sonnet

The Kunj CLI now supports AI-generated commit messages using AWS Bedrock with Claude 3.5 Sonnet - the latest and most capable model. When you select the "AI" option during commit, it analyzes your code changes and generates an appropriate conventional commit message.

## Features

- 🤖 **Intelligent Analysis**: Analyzes your code diff to understand the changes
- 📝 **Conventional Commits**: Automatically follows conventional commit standards
- 🎯 **Context-Aware**: Generates messages based on actual code changes, not just file names
- ✏️ **Editable**: Review and edit AI-generated messages before committing
- 🔄 **Fallback**: Manual entry available if AI generation fails

## Prerequisites

1. **AWS Account**: You need an AWS account with Bedrock access
2. **Bedrock Access**: Enable Claude models in AWS Bedrock
3. **AWS Credentials**: Configure AWS CLI or environment variables

## Setup

### Step 1: Enable AWS Bedrock

1. Go to AWS Console → Bedrock
2. Navigate to "Model access"
3. Request access to Claude models (especially Claude 3.5 Sonnet)
4. Wait for approval (usually instant)

### Step 2: Configure AWS Credentials

Choose one of these methods:

#### Option A: AWS CLI Configuration
```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter your default region (e.g., us-east-1)
```

#### Option B: Environment Variables
```bash
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="us-east-1"

# Optional: Specify the model
export BEDROCK_MODEL="anthropic.claude-3-5-sonnet-20241022-v2:0"
```

#### Option C: AWS Profile
```bash
export AWS_PROFILE="your-profile-name"
export AWS_REGION="us-east-1"
```

### Step 3: Available Models

You can set the `BEDROCK_MODEL` environment variable to use different Claude models:

- `anthropic.claude-3-5-sonnet-20241022-v2:0` - **Claude 3.5 Sonnet (default)** - Latest, most capable
- `anthropic.claude-3-5-sonnet-20240620-v1:0` - Claude 3.5 Sonnet (previous version)
- `anthropic.claude-3-opus-20240229-v1:0` - Claude 3 Opus - Very capable (higher cost)
- `anthropic.claude-3-sonnet-20240229-v1:0` - Claude 3 Sonnet - Balanced
- `anthropic.claude-3-haiku-20240307-v1:0` - Claude 3 Haiku - Fastest and cheapest

## Usage

### Interactive AI Commit

1. Make your code changes
2. Run the commit command:
   ```bash
   kunj commit
   ```

3. Select files to commit (or use `--all` flag)

4. Choose **"🤖 AI: Generate message with AI"** from the commit type menu

5. Wait for AI to analyze your changes

6. Review the generated message and either:
   - Accept it as-is
   - Edit it before committing
   - Reject and write manually

### Example Workflow

```bash
$ kunj commit

On branch: main

Select files to include in commit:
✓ src/lib/ai-commit.ts
✓ src/commands/commit.ts

Files to commit: 2 selected

Recent commit messages for reference:
  1. feat: Add interactive commit command
  2. refactor: Extract commands to modular structure

Select commit type:
❯ 🤖 AI: Generate message with AI
  ──────────────────────
  feat: A new feature
  fix: A bug fix
  ...

🤖 Analyzing changes with Claude 3.5 Sonnet...

🤖 AI-generated commit message:
feat: Add AI-powered commit message generation using AWS Bedrock

Integrates Claude 3.5 Sonnet via AWS Bedrock to automatically generate
conventional commit messages based on code diff analysis. Includes fallback
to manual entry if AI is unavailable.

Use this AI-generated message? (Y/n) Y
Edit the message (or press Enter to use as-is): [Enter]

Commit message preview:
feat: Add AI-powered commit message generation using AWS Bedrock

Integrates Claude 3.5 Sonnet via AWS Bedrock to automatically generate
conventional commit messages based on code diff analysis. Includes fallback
to manual entry if AI is unavailable.

Proceed with this commit? (Y/n) Y

Creating commit...
✓ Commit created successfully
  Branch: main
  Message: feat: Add AI-powered commit message generation using AWS Bedrock

Committed 2 files:
  - src/lib/ai-commit.ts
  - src/commands/commit.ts
```

## Configuration

### Environment Variables

- `AWS_REGION` or `AWS_DEFAULT_REGION`: AWS region (default: us-east-1)
- `BEDROCK_MODEL`: Claude model to use (default: anthropic.claude-3-5-sonnet-20241022-v2:0)
- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret key
- `AWS_PROFILE`: AWS profile name (alternative to keys)

### Cost Considerations

AWS Bedrock charges per token processed. Typical costs per commit message:
- Claude 3.5 Sonnet: ~$0.003-0.004
- Claude 3 Opus: ~$0.015
- Claude 3 Sonnet: ~$0.003
- Claude 3 Haiku: ~$0.001

The actual cost depends on the size of your code diff. Claude 3.5 Sonnet provides the best balance of capability and cost.

## Troubleshooting

### "AI: Not configured" Message

If you see this in the commit type menu:
```
🤖 AI: Not configured (set AWS credentials)
```

This means:
1. AWS credentials are not set, or
2. AWS Bedrock access is not enabled, or
3. The configured region doesn't have Bedrock access

**Fix**: Follow the setup steps above to configure AWS credentials and enable Bedrock.

### "AI generation failed" Error

If AI generation fails, the tool will:
1. Show an error message
2. Provide a basic fallback suggestion
3. Allow you to write the message manually

Common causes:
- Network issues
- AWS credential problems
- Bedrock quota exceeded
- Model not available in region

### Regional Availability

Not all AWS regions support Bedrock. Recommended regions:
- `us-east-1` (N. Virginia)
- `us-west-2` (Oregon)
- `eu-west-1` (Ireland)
- `ap-northeast-1` (Tokyo)

## Security Best Practices

1. **Never commit AWS credentials** to version control
2. **Use IAM roles** when running on EC2/Lambda
3. **Rotate access keys** regularly
4. **Use AWS profiles** for multiple accounts
5. **Limit IAM permissions** to only what's needed:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "bedrock:InvokeModel"
         ],
         "Resource": "arn:aws:bedrock:*:*:model/anthropic.claude-*"
       }
     ]
   }
   ```

## Benefits

- **Consistency**: All commits follow the same format
- **Context**: Messages reflect actual code changes
- **Speed**: Generate messages in seconds
- **Learning**: See examples of good commit messages
- **Productivity**: Focus on coding, not message writing

## Limitations

- Requires AWS account and Bedrock access
- Needs internet connection
- Limited by diff size (very large diffs are truncated)
- Costs per use (though minimal)

## Future Enhancements

Potential improvements planned:
- Support for other AI providers (OpenAI, local models)
- Customizable prompt templates
- Team-specific conventions
- Commit message history learning
- Integration with issue trackers