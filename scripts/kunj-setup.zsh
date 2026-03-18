#!/usr/bin/env zsh

# Kunj Complete Setup for Zsh
# Add this line to your ~/.zshrc AFTER oh-my-zsh initialization:
#   source /path/to/kunj-setup.zsh

# ============================================
# PART 1: Autocomplete
# ============================================

# Completion function for kunj
_kunj_completion() {
  local -a commands
  commands=(
    'create:Create and switch to new branch'
    'switch:Switch branches (interactive)'
    'list:List branches with metadata'
    'commit:AI-powered commit messages'
    'pr:Create/view pull requests'
    'delete:Delete branch'
    'config:Manage settings'
    'setup:Interactive onboarding'
    'log:View/manage work logs'
    'graph:Show branch graph'
    'diff:Show branch diffs'
    'stash:Manage stashes'
    'flow:Git flow operations'
    'jira:Jira integration'
    'completion:Manage shell completion'
    'prompt-info:Get PR info for prompts'
  )

  if (( CURRENT == 2 )); then
    # First argument - show commands
    _describe 'kunj commands' commands
  elif (( CURRENT > 2 )); then
    # Additional arguments - show options based on command
    case "${words[2]}" in
      pr)
        local -a pr_opts
        pr_opts=(
          '-t:PR title'
          '--title:PR title'
          '-b:PR body'
          '--body:PR body'
          '--base:Base branch'
          '-d:Create as draft'
          '--draft:Create as draft'
          '-w:Open in browser'
          '--web:Open in browser'
          '-s:View PR status'
          '--status:View PR status'
          '-l:List all PRs'
          '--list:List all PRs'
        )
        _describe 'pr options' pr_opts
        ;;
      prompt-info)
        local -a prompt_opts
        prompt_opts=(
          '-f:Output format'
          '--format:Output format'
          '--show-branch:Include branch name'
          '--show-status:Include PR status'
        )
        _describe 'prompt-info options' prompt_opts
        ;;
      config)
        local -a config_opts
        config_opts=(
          '--set:Set config value'
          '--get:Get config value'
          '--list:List all settings'
          '--reset:Reset to defaults'
        )
        _describe 'config options' config_opts
        ;;
      list)
        local -a list_opts
        list_opts=(
          '--wip:Show only WIP branches'
          '--all:Show all branches'
          '--remote:Include remote branches'
        )
        _describe 'list options' list_opts
        ;;
    esac
  fi
}

# Register the completion function
compdef _kunj_completion kunj

# ============================================
# PART 2: PR# in Prompt
# ============================================

# Function to display PR info in prompt
kunj_prompt_pr() {
  # Only run if kunj is installed
  command -v kunj &> /dev/null || return

  # Get PR info (silently fails if not in repo or no PR)
  local pr_info=$(kunj prompt-info 2>/dev/null)

  # Display with color if we have a PR
  [[ -n "$pr_info" ]] && echo " %F{blue}$pr_info%f"
}

# Add to right prompt if not already there
if [[ ! "$RPROMPT" =~ "kunj_prompt_pr" ]]; then
  RPROMPT='$(kunj_prompt_pr)'${RPROMPT}
fi
