// Hook definitions: names, arguments and behaviour of every kunj hook.
//
// Kept free of imports so the settings registry and the type definitions can
// use it without pulling in the runner (src/lib/hooks.ts) or creating an
// import cycle through config.ts.

export const HOOKS_DIR = 'hooks';

export type HookName =
  | 'pre-worktree-create'
  | 'post-worktree-create'
  | 'pre-worktree-delete'
  | 'post-worktree-delete';

export interface HookDefinition {
  name: HookName;
  description: string;
  // Positional arguments the hook receives, in order (documented in the template)
  args: string[];
  // Environment variables set for the hook, beyond the KUNJ_REPO_* ones
  env: string[];
  // A failing pre-* hook aborts the operation
  abortsOnFailure: boolean;
}

const WORKTREE_ARGS = ['worktree-path', 'branch'];
const WORKTREE_ENV = ['KUNJ_WORKTREE_PATH', 'KUNJ_BRANCH'];

export const HOOKS: HookDefinition[] = [
  {
    name: 'pre-worktree-create',
    description: 'Runs before `kunj worktree add` creates a worktree. A non-zero exit aborts the creation.',
    args: WORKTREE_ARGS,
    env: WORKTREE_ENV,
    abortsOnFailure: true,
  },
  {
    name: 'post-worktree-create',
    description: 'Runs inside a freshly created worktree, after keep files have been copied in (e.g. to install dependencies).',
    args: WORKTREE_ARGS,
    env: WORKTREE_ENV,
    abortsOnFailure: false,
  },
  {
    name: 'pre-worktree-delete',
    description: 'Runs inside a worktree before `kunj worktree remove` deletes it. A non-zero exit aborts the removal.',
    args: WORKTREE_ARGS,
    env: WORKTREE_ENV,
    abortsOnFailure: true,
  },
  {
    name: 'post-worktree-delete',
    description: 'Runs from the main worktree after a worktree has been removed (e.g. to clean up containers or databases).',
    args: WORKTREE_ARGS,
    env: WORKTREE_ENV,
    abortsOnFailure: false,
  },
];

export const HOOK_NAMES: HookName[] = HOOKS.map(h => h.name);

export function getHookDefinition(name: string): HookDefinition | undefined {
  return HOOKS.find(h => h.name === name);
}

export function isHookName(name: string): name is HookName {
  return HOOK_NAMES.includes(name as HookName);
}
