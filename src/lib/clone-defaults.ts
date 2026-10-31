// Default for repos.cloneDir, in its own module (like worktree-defaults.ts) so the settings
// registry can use it without importing github-repos.ts and, through it, config.ts
export const DEFAULT_CLONE_DIR = '~/projects';
