#!/usr/bin/env zsh

# Kunj completion script for zsh
# Add to ~/.zshrc: source /path/to/kunj-completion.zsh

_kunj() {
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

  local -a pr_options
  pr_options=(
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

  local -a prompt_info_options
  prompt_info_options=(
    '-f:Output format'
    '--format:Output format (simple|detailed|json)'
    '--show-branch:Include branch name'
    '--show-status:Include PR status'
  )

  _arguments -C \
    '1: :->cmds' \
    '*:: :->args' && return 0

  case $state in
    cmds)
      _describe 'kunj commands' commands
      ;;
    args)
      case $words[1] in
        pr)
          _arguments $pr_options
          ;;
        prompt-info)
          _arguments $prompt_info_options
          ;;
        config)
          _arguments \
            '--set:Set config value' \
            '--get:Get config value' \
            '--list:List all settings' \
            '--reset:Reset to defaults'
          ;;
        list)
          _arguments \
            '--wip:Show only WIP branches' \
            '--all:Show all branches' \
            '--remote:Include remote branches'
          ;;
      esac
      ;;
  esac
}

compdef _kunj kunj
