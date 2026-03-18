# Kunj Shell Integration

This guide covers setting up autocomplete and showing PR# in your shell prompt.

## Table of Contents

- [Shell Autocomplete](#shell-autocomplete)
- [PR# in Shell Prompt](#pr-in-shell-prompt)

---

## Shell Autocomplete

Enable tab completion for `kunj` commands and options.

### Quick Setup

```bash
# Install completion
kunj completion --install

# Reload your shell
source ~/.zshrc  # for zsh
source ~/.bashrc # for bash
```

### Manual Setup (if automatic install fails)

#### For Zsh

Add to your `~/.zshrc`:

```bash
# Kunj autocomplete
if command -v kunj &> /dev/null; then
  source <(kunj completion 2>/dev/null || true)
fi
```

#### For Bash

Add to your `~/.bashrc`:

```bash
# Kunj autocomplete
if command -v kunj &> /dev/null; then
  source <(kunj completion 2>/dev/null || true)
fi
```

### Uninstall

```bash
kunj completion --uninstall
```

---

## PR# in Shell Prompt

Display the current PR number in your shell prompt for the active branch.

### What It Does

- Shows PR# when your current branch has an associated pull request
- Lightweight and fast (uses cached metadata)
- Only queries GitHub API when metadata is unavailable
- Silently fails if not in a git repo or no PR exists

### Zsh Setup

#### Basic Setup (PR# only)

Add to your `~/.zshrc`:

```zsh
# Function to get PR info
function kunj_prompt_pr() {
  if command -v kunj &> /dev/null; then
    local pr_info=$(kunj prompt-info 2>/dev/null)
    if [ -n "$pr_info" ]; then
      echo " $pr_info"
    fi
  fi
}

# Add to your prompt (example with oh-my-zsh)
RPROMPT='$(kunj_prompt_pr)'
```

#### Advanced Setup (with branch name and status)

```zsh
# Function to get detailed PR info
function kunj_prompt_pr() {
  if command -v kunj &> /dev/null; then
    local pr_info=$(kunj prompt-info --format detailed --show-branch --show-status 2>/dev/null)
    if [ -n "$pr_info" ]; then
      echo "%F{cyan}[$pr_info]%f"
    fi
  fi
}

# Add to your prompt
RPROMPT='$(kunj_prompt_pr)'
```

#### With Powerlevel10k

If you're using Powerlevel10k, add a custom segment:

```zsh
# Add to ~/.p10k.zsh in the POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS array
typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(
  # ... other elements ...
  kunj_pr              # Add this
  # ... other elements ...
)

# Define the custom segment
function prompt_kunj_pr() {
  if command -v kunj &> /dev/null; then
    local pr_info=$(kunj prompt-info 2>/dev/null)
    if [ -n "$pr_info" ]; then
      p10k segment -f 208 -i '🔀' -t "$pr_info"
    fi
  fi
}
```

#### With Starship

If you're using Starship, add to `~/.config/starship.toml`:

```toml
[custom.kunj_pr]
command = "kunj prompt-info"
when = "git rev-parse --git-dir 2> /dev/null"
format = "[$output]($style) "
style = "bold cyan"
```

### Bash Setup

Add to your `~/.bashrc`:

```bash
# Function to get PR info
kunj_prompt_pr() {
  if command -v kunj &> /dev/null; then
    local pr_info=$(kunj prompt-info 2>/dev/null)
    if [ -n "$pr_info" ]; then
      echo " $pr_info"
    fi
  fi
}

# Add to your PS1 prompt
PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w$(kunj_prompt_pr)\$ '
```

### Output Format Options

The `kunj prompt-info` command supports different output formats:

```bash
# Simple (default) - just PR number
kunj prompt-info
# Output: #123

# Detailed - with branch name and status
kunj prompt-info --format detailed --show-branch --show-status
# Output: feature/my-branch PR#123 [OPEN]

# JSON - for custom parsing
kunj prompt-info --format json
# Output: {"branch":"feature/my-branch","prNumber":"123","prStatus":"OPEN"}
```

### Performance Tips

1. **Cache Results**: The command is already optimized to use cached metadata first
2. **Async Loading**: For zsh, you can load PR info asynchronously:

```zsh
# Async PR info (requires zsh-async or similar)
async_kunj_pr() {
  # This runs in background
  kunj prompt-info 2>/dev/null
}

# Use in prompt with async framework
```

3. **Disable Status Checks**: If you don't need PR status (OPEN/MERGED), omit `--show-status` flag for faster execution

### Troubleshooting

#### PR# not showing up

1. Make sure you've created a PR for your branch:
   ```bash
   kunj pr
   ```

2. Check if PR URL is stored in metadata:
   ```bash
   cat .kunj/branches.json
   ```

3. Manually query PR info:
   ```bash
   kunj prompt-info --format json
   ```

#### Slow prompt

- Remove `--show-status` flag (avoids gh CLI API calls)
- Ensure GitHub CLI (`gh`) is properly authenticated
- Check network connectivity

#### Not working after installation

- Reload your shell: `source ~/.zshrc` or `source ~/.bashrc`
- Verify kunj is in PATH: `which kunj`
- Test command manually: `kunj prompt-info`

---

## Example Prompt Configurations

### Minimalist Zsh

```zsh
# ~/.zshrc
autoload -U colors && colors

kunj_prompt_pr() {
  local pr=$(kunj prompt-info 2>/dev/null)
  [ -n "$pr" ] && echo " %F{blue}$pr%f"
}

PROMPT='%F{green}%~%f$(kunj_prompt_pr) %# '
```

### Full-featured Zsh

```zsh
# ~/.zshrc
autoload -U colors && colors

kunj_prompt_info() {
  if ! command -v kunj &> /dev/null; then
    return
  fi

  local pr_info=$(kunj prompt-info --format detailed --show-branch 2>/dev/null)
  if [ -n "$pr_info" ]; then
    echo " %F{cyan}[$pr_info]%f"
  fi
}

git_branch() {
  git branch 2>/dev/null | grep '^*' | colrm 1 2
}

PROMPT='%F{green}%n@%m%f:%F{blue}%~%f$(kunj_prompt_info)
%F{yellow}$(git_branch)%f %# '
```

---

## Related Commands

- `kunj pr` - Create or view pull requests
- `kunj pr --status` - View PR status with checks
- `kunj list` - List branches with metadata
- `kunj config` - Configure kunj settings

---

## Support

For issues or feature requests, please visit:
- GitHub: https://github.com/your-repo/kunj
- Documentation: https://github.com/your-repo/kunj/docs
