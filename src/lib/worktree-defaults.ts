// Kept in its own module so the settings registry can reference the default
// without importing the worktree library (and its git helpers) at startup.

// Worktrees live beside the repository's own git data, which keeps them out of
// the working tree for a normal repo and inside the repo dir for a bare one.
export const DEFAULT_WORKTREE_BASE_DIR = '${repoconfig}/kunj/worktrees';
