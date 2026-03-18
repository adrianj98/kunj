# Kunj Documentation

## Quick Links

- [Shell Integration Guide](./SHELL_INTEGRATION.md) - Autocomplete & PR# in prompt

## Features

### Shell Autocomplete

Tab completion for all kunj commands:

```bash
kunj <TAB>        # Shows all commands
kunj pr <TAB>     # Shows PR command options
```

**Setup:** `kunj completion --install`

### PR# in Shell Prompt

Show the current PR number in your shell prompt:

```
~/projects/myapp (feature-branch) #123 $
                                  ^^^^
                                  PR number
```

**Quick Setup (zsh):**

```zsh
# Add to ~/.zshrc
kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " %F{blue}$pr%f"
}
RPROMPT='$(kunj_prompt_pr)'
```

See [Shell Integration Guide](./SHELL_INTEGRATION.md) for detailed instructions.

## Command Reference

| Command | Description |
|---------|-------------|
| `kunj create <branch>` | Create and switch to new branch |
| `kunj switch [branch]` | Switch branches (interactive) |
| `kunj list` | List branches with metadata |
| `kunj commit` | AI-powered commit messages |
| `kunj pr` | Create/view pull requests |
| `kunj pr --status` | View PR status with checks |
| `kunj log` | View/manage work logs |
| `kunj config` | Manage settings |
| `kunj completion` | Manage shell completion |
| `kunj prompt-info` | Get PR info for prompts |

## Configuration

### Global Config
`~/.kunj/config.json` - User-wide settings

### Local Config
`.kunj/config.json` - Repository-specific settings

### Branch Metadata
`.kunj/branches.json` - Per-branch metadata including PR URLs

## AI Features

Kunj uses AWS Bedrock Claude 3.5 Sonnet for:
- Commit message generation
- PR description generation
- Work log summaries

Configure AWS credentials via standard AWS SDK methods.

## Contributing

See the main README for contribution guidelines.
