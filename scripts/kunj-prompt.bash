#!/usr/bin/env bash

# Kunj Shell Integration for Bash
# Source this file in your ~/.bashrc:
# source /path/to/kunj-prompt.bash

# Function to display PR info in prompt
kunj_prompt_pr() {
  # Only run if kunj is installed and we're in a git repo
  if ! command -v kunj &> /dev/null; then
    return
  fi

  # Get PR info (silently fails if not in repo or no PR)
  local pr_info=$(kunj prompt-info 2>/dev/null)

  # Display if we have a PR
  if [ -n "$pr_info" ]; then
    echo " $pr_info"
  fi
}

# Add to PS1 prompt
# Example: user@host:~/path #123 $
if [[ "$PS1" != *'$(kunj_prompt_pr)'* ]]; then
  # Append before the final prompt character
  PS1="${PS1%\\$ }\$(kunj_prompt_pr)\\$ "
fi

# Optional: More detailed version (includes branch and status)
kunj_prompt_detailed() {
  if ! command -v kunj &> /dev/null; then
    return
  fi

  local pr_info=$(kunj prompt-info --format detailed --show-branch 2>/dev/null)

  if [ -n "$pr_info" ]; then
    echo " [$pr_info]"
  fi
}

# Uncomment to use detailed version instead:
# PS1="${PS1%\\$ }\$(kunj_prompt_detailed)\\$ "
