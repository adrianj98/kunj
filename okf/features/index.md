# Features

User-facing capabilities of the kunj CLI outside branch containers and secrets.

# Branches

* [Branch Commands](/features/branch-commands.md) - The everyday branch commands - create, switch, delete, list, stash, diff and graph - and the auto-stash that carries uncommitted work between branches.
* [Base Branch Resolution](/features/base-branch.md) - How kunj picks the start point for a new branch - --base, preferences.defaultBaseBranch or the repo default, fetched from origin unless turned off, never tracked.
* [Branch Metadata](/features/branch-metadata.md) - Per-branch descriptions, tags, notes, stash records, PR URL, Jira link and Git Flow state kept in ~/.kunj/{reponame}/branches.json.

# AI and Integrations

* [AI Commit Messages](/features/ai-commit.md) - kunj commit stages files interactively and writes the message with Claude on AWS Bedrock (via LangChain ChatBedrockConverse) in one of six commit styles.
* [AI Pull Requests](/features/ai-pr.md) - kunj pr creates, lists and shows GitHub pull requests through gh, with the title and body drafted by Claude on Bedrock from the branch diff, commits and metadata.
* [Work Log](/features/work-log.md) - Daily Markdown work logs in ~/.kunj/{reponame}/work-logs/, appended by AI after commits and PRs and read back by kunj log, including standup summaries.
* [Integrations](/features/integrations.md) - Jira Cloud, GitHub issues, Slack, the kunj team activity report and Git Flow - the optional integrations around branches and pull requests.

# Worktrees

* [Worktrees](/features/worktrees.md) - The kunj worktree command, which wraps git worktree to list, create, remove, prune and open worktrees with status, pull requests, editor sessions and agents in one listing.
* [Editor Sessions](/features/editor-sessions.md) - A global registry of which editor windows have which worktree open, kept in ~/.kunj/worktree-sessions.json and pruned by PID liveness.
* [Keep Files](/features/keep-files.md) - Files deliberately left out of git (such as .env) stored per repository under ~/.kunj/<repo>/keep/ and copied into every new worktree.
* [PR Lookup Cache](/features/pr-lookup-cache.md) - How the worktree listing finds each branch's pull request with one gh or glab call per repository, cached for 60 seconds in ~/.kunj/pr-cache.json.
* [tmux sessions](/features/tmux-sessions.md) - kunj sessions lists kunj's tmux sessions (host and container) with owner, attached terminals, CPU, memory and orphans, and ends them; the workspace app's Sessions window.
* [Search](/features/search.md) - kunj search greps every worktree (uncommitted work included) and, on request, branches without a worktree, running branch containers, commit messages and work logs; SearchJson for the apps.

# Agents and Shells

* [Worktree Agents](/features/worktree-agents.md) - kunj agent runs an agent command (default claude) in a host tmux session per worktree, with optional extra sessions, waiting-for-input state via Claude Code hooks, and status in the worktree listing.
* [Persistent Shells](/features/persistent-shells.md) - kunj worktree shell and kunj ct shell with --session keep a login shell in a tmux session so a terminal tab survives the app that opened it.

# Extensibility and Plumbing

* [Hooks](/features/hooks.md) - Git-style user hooks that run before and after kunj actions, from global and per-repo script directories and hooks.* config commands, plus the kunj hooks command to list, scaffold and test them.
* [Events Stream](/features/events-stream.md) - kunj events, a long-lived NDJSON stream telling the workspace app which repository, container or agent to refresh, built from file watches, tmux and status polls and Docker events.
* [Shell Integration](/features/shell-integration.md) - Tab completion (kunj completion and the zsh scripts) and the PR number in the shell prompt (kunj prompt-info and the prompt scripts).
* [Setup and Install](/features/setup-and-install.md) - kunj setup, the interactive onboarding (shell aliases, Jira, secret import, companion apps), and kunj install, which downloads the VS Code extension and macOS apps from GitHub releases.
