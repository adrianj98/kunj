// Commit message style templates for AI generation

export interface CommitStyleTemplate {
  name: string;
  description: string;
  getPrompt: (params: {
    maxLength: number;
    includeBody: boolean;
    customInstructions?: string;
  }) => string;
}

export const commitStyles: Record<string, CommitStyleTemplate> = {
  conventional: {
    name: 'Conventional Commits',
    description: 'Standard conventional commit format with type prefix',
    getPrompt: ({ maxLength, includeBody, customInstructions }) => `You are an expert at writing clear, concise git commit messages following conventional commit standards.

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
2. Write a clear, concise commit message (max ${maxLength} characters for the subject)
3. Focus on WHY the change was made, not just what changed
4. Use present tense ("add" not "added")
5. Don't end with a period
6. Format: type: subject${includeBody ? '\n7. Optionally include a detailed body paragraph explaining the changes' : ''}
${customInstructions ? `\nAdditional instructions:\n${customInstructions}\n` : ''}`
  },

  semantic: {
    name: 'Semantic Commit Messages',
    description: 'Semantic versioning-aligned commit messages',
    getPrompt: ({ maxLength, includeBody, customInstructions }) => `You are an expert at writing semantic commit messages that align with semantic versioning.

Semantic commit types:
- MAJOR: Breaking changes (incompatible API changes)
- MINOR: New features (backward-compatible functionality)
- PATCH: Bug fixes (backward-compatible fixes)
- DOCS: Documentation only changes
- STYLE: Code style/formatting changes
- REFACTOR: Code changes that neither fix bugs nor add features
- TEST: Test-related changes
- CHORE: Maintenance and tooling changes

Guidelines:
1. Choose the semantic type that best represents the impact
2. Write a clear subject line (max ${maxLength} characters)
3. Use imperative mood ("Add feature" not "Added feature")
4. Be specific about what changed and why
5. Format: [TYPE] Subject${includeBody ? '\n6. Include detailed explanation in the body if needed' : ''}
${customInstructions ? `\nAdditional instructions:\n${customInstructions}\n` : ''}`
  },

  simple: {
    name: 'Simple Descriptive',
    description: 'Simple, clear descriptions without prefixes',
    getPrompt: ({ maxLength, includeBody, customInstructions }) => `You are an expert at writing simple, clear git commit messages without type prefixes.

Guidelines:
1. Write a clear, descriptive subject line (max ${maxLength} characters)
2. Start with a verb in present tense ("Add", "Fix", "Update", "Remove", etc.)
3. Be specific but concise
4. Focus on what changed and why
5. No type prefixes - just clear natural language
${includeBody ? '6. Include a detailed explanation in the body if the change is complex' : ''}
${customInstructions ? `\nAdditional instructions:\n${customInstructions}\n` : ''}`
  },

  gitmoji: {
    name: 'Gitmoji',
    description: 'Commits with emoji prefixes for visual categorization',
    getPrompt: ({ maxLength, includeBody, customInstructions }) => `You are an expert at writing git commit messages using gitmoji - emoji-based commit categorization.

Common gitmojis and their meanings:
- ✨ :sparkles: Introduce new features
- 🐛 :bug: Fix a bug
- 📝 :memo: Add or update documentation
- 🎨 :art: Improve structure/format of code
- ⚡️ :zap: Improve performance
- 🔥 :fire: Remove code or files
- ♻️ :recycle: Refactor code
- ✅ :white_check_mark: Add or update tests
- 🔧 :wrench: Add or update configuration files
- 🚀 :rocket: Deploy stuff
- 💄 :lipstick: Add or update UI/style files
- 🔒️ :lock: Fix security issues
- ⬆️ :arrow_up: Upgrade dependencies
- ⬇️ :arrow_down: Downgrade dependencies
- 🔖 :bookmark: Release/version tags

Guidelines:
1. Choose the most appropriate gitmoji for the change
2. Write a clear subject line after the emoji (max ${maxLength} characters total)
3. Use present tense verbs
4. Format: emoji Subject${includeBody ? '\n5. Include detailed explanation in the body if needed' : ''}
${customInstructions ? `\nAdditional instructions:\n${customInstructions}\n` : ''}`
  },

  custom: {
    name: 'Custom Style',
    description: 'Custom commit message style based on user instructions',
    getPrompt: ({ maxLength, includeBody, customInstructions }) => `You are an expert at writing git commit messages following the user's custom guidelines.

Basic requirements:
1. Keep the subject line under ${maxLength} characters
2. Be clear and concise
3. Focus on what changed and why
${includeBody ? '4. Include a detailed body if the change is complex' : ''}

${customInstructions ? `User's custom instructions:\n${customInstructions}` : 'Please write a clear, descriptive commit message.'}`
  }
};

export function getCommitStylePrompt(
  style: string,
  maxLength: number,
  includeBody: boolean,
  customInstructions?: string
): string {
  const template = commitStyles[style] || commitStyles.conventional;
  return template.getPrompt({ maxLength, includeBody, customInstructions });
}
