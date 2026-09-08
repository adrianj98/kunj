# Changelog

## 0.1.0

- Initial release: Worktrees view backed by `kunj worktree --json`.
- Shows which worktrees are open in other VS Code windows via `kunj worktree session`.
- Open (new/current window), add, remove, prune, terminal, reveal, copy path, add to workspace.
- Status bar item with quick pick.
- Related pull request per worktree (state, checks) with open, copy URL and create actions.
- Fast refresh: one CLI call per repository, cached PR lookup, no self-triggered refreshes.
