#!/usr/bin/env zsh

# Kunj Shell Integration for Zsh
# Source this file in your ~/.zshrc:
# source /path/to/kunj-prompt.zsh

# Function to display PR info in prompt
kunj_prompt_pr() {
  # Only run if kunj is installed and we're in a git repo
  if ! command -v kunj &> /dev/null; then
    return
  fi

  # Get PR info (silently fails if not in repo or no PR)
  local pr_info=$(kunj prompt-info 2>/dev/null)

  # Display with color if we have a PR
  if [ -n "$pr_info" ]; then
    echo " %F{blue}$pr_info%f"
  fi
}

# Add to right prompt (modify as needed)
if [[ -z "$RPROMPT" ]]; then
  RPROMPT='$(kunj_prompt_pr)'
else
  # Append to existing RPROMPT
  RPROMPT='$(kunj_prompt_pr)'$RPROMPT
fi

# Optional: More detailed version (includes branch and status)
kunj_prompt_detailed() {
  if ! command -v kunj &> /dev/null; then
    return
  fi

  local pr_info=$(kunj prompt-info --format detailed --show-branch 2>/dev/null)

  if [ -n "$pr_info" ]; then
    echo " %F{cyan}[$pr_info]%f"
  fi
}

# Uncomment to use detailed version instead:
# RPROMPT='$(kunj_prompt_detailed)'
