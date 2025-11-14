# Interactive Commit Command

The new `kunj commit` command provides an interactive way to stage files and create commits with a structured workflow.

## Features

- 📝 **Interactive File Selection**: Choose which files to include in your commit using checkboxes
- 🏷️ **Commit Type Selection**: Choose from conventional commit types (feat, fix, docs, etc.)
- 📋 **Recent Commits Display**: Shows recent commit messages for reference
- 🎨 **Visual Status Indicators**: Clear icons showing file status (new, modified, deleted, etc.)
- ✍️ **Multi-line Commit Messages**: Support for detailed commit body text
- 🔍 **Smart Type Suggestions**: Automatically suggests commit type based on changed files

## Usage

### Basic Interactive Mode

```bash
kunj commit
```

This will:
1. Show all changed files with their status
2. Let you select which files to stage
3. Show recent commits for reference
4. Prompt for commit type (feat, fix, docs, etc.)
5. Ask for commit message
6. Optionally add detailed description
7. Preview and confirm before committing

### Quick Commit (All Files)

```bash
kunj commit --all
```

Automatically stages all changed files and prompts for commit message.

### Direct Commit Message

```bash
kunj commit -m "Your commit message"
```

Skip the interactive message prompt and use the provided message.

### Amend Last Commit

```bash
kunj commit --amend
```

Modify the most recent commit with new changes or message.

## File Status Indicators

- `+` Green: New file
- `M` Yellow: Modified file
- `D` Red: Deleted file
- `R` Blue: Renamed file
- `C` Cyan: Copied file
- `U` Magenta: Unmerged file

## Commit Types

The command supports conventional commit types:

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, etc.)
- **refactor**: Code refactoring
- **test**: Adding or updating tests
- **chore**: Maintenance tasks
- **build**: Build system changes
- **ci**: CI configuration changes
- **perf**: Performance improvements
- **revert**: Revert a previous commit

## Smart Features

### Automatic Type Detection

The command analyzes your changed files and suggests appropriate commit types:
- Files with "test" or "spec" → suggests `test`
- Markdown files → suggests `docs`
- package.json changes → suggests `build`
- CI/CD files → suggests `ci`

### Pre-selected Staged Files

If you've already staged files using `git add`, they'll be pre-selected in the interactive file chooser.

### Commit Message Validation

- Ensures message is not empty
- Warns if message exceeds 100 characters
- Supports multi-line descriptions

## Examples

### Example 1: Interactive Feature Commit

```bash
$ kunj commit

On branch: main

Select files to include in commit:
(Use arrow keys to move, space to select, enter to confirm)

Files to commit:
 ◯ + src/commands/commit.ts
 ◯ M src/lib/git.ts
 ◯ M src/commands/index.ts

Recent commit messages for reference:
  1. feat: Add interactive commit command
  2. refactor: Modularize codebase architecture
  3. fix: Resolve stash tracking issue

Select commit type:
❯ feat: A new feature
  fix: A bug fix
  docs: Documentation changes

Enter commit message: Add interactive commit feature

Additional commit details (optional):
Implements a new interactive commit command that allows users to:
- Select files to stage
- Choose conventional commit types
- Add detailed commit messages

Commit message preview:
feat: Add interactive commit feature

Implements a new interactive commit command that allows users to:
- Select files to stage
- Choose conventional commit types
- Add detailed commit messages

Proceed with this commit? Yes

✓ Commit created successfully
  Branch: main
  Message: feat: Add interactive commit feature

Committed 3 files:
  - src/commands/commit.ts
  - src/lib/git.ts
  - src/commands/index.ts
```

### Example 2: Quick Fix Commit

```bash
$ kunj commit --all -m "Fix typo in README"

On branch: main
Staging all 2 changed files...
Creating commit...
✓ Commit created successfully
  Branch: main
  Message: Fix typo in README

Committed 2 files:
  - README.md
  - docs/guide.md
```

## Integration with Kunj Workflow

The commit command integrates seamlessly with other Kunj commands:

1. Use `kunj switch` to change branches
2. Make your changes
3. Use `kunj commit` to commit interactively
4. Use `kunj list` to see branch status

## Benefits

- **Consistency**: Enforces conventional commit format
- **Efficiency**: Faster than typing git commands manually
- **Clarity**: Visual feedback on what's being committed
- **Safety**: Preview before committing
- **Learning**: Shows recent commits as examples

## Tips

- Use space bar to select/deselect files
- Press Enter to confirm selection
- Use Tab to navigate between form fields
- Press Ctrl+C to cancel at any time
- The editor for detailed description opens your default text editor