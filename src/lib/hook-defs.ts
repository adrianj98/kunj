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
  | 'post-worktree-delete'
  | 'pre-branch-create'
  | 'post-branch-create'
  | 'pre-branch-switch'
  | 'post-branch-switch'
  | 'pre-branch-delete'
  | 'post-branch-delete'
  | 'pre-commit'
  | 'commit-msg'
  | 'post-commit'
  | 'pre-pr-create'
  | 'post-pr-create'
  | 'pre-stash'
  | 'post-stash';

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

// Every argument is also exported as KUNJ_<ARG> (worktree-path -> KUNJ_WORKTREE_PATH)
export function argEnvName(arg: string): string {
  return `KUNJ_${arg.toUpperCase().replace(/-/g, '_')}`;
}

// ...and, for configured commands, as the ${camelCase} variable (previous-branch -> ${previousBranch})
export function argVariableName(arg: string): string {
  return arg.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function define(
  name: HookName,
  args: string[],
  description: string,
  abortsOnFailure = name.startsWith('pre-') || name === 'commit-msg'
): HookDefinition {
  return { name, description, args, env: args.map(argEnvName), abortsOnFailure };
}

const WORKTREE_ARGS = ['worktree-path', 'branch'];
const WORKTREE_ENV = WORKTREE_ARGS.map(argEnvName);
const BRANCH_CHANGE_ARGS = ['branch', 'previous-branch'];
const PR_ARGS = ['branch', 'base-branch', 'title'];
const STASH_ARGS = ['branch', 'message'];

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
  define(
    'pre-branch-create',
    BRANCH_CHANGE_ARGS,
    'Runs before `kunj create` or `kunj switch -c` creates a branch. A non-zero exit aborts the creation.'
  ),
  define('post-branch-create', BRANCH_CHANGE_ARGS, 'Runs after `kunj create` or `kunj switch -c` has created and switched to a branch.'),
  define('pre-branch-switch', BRANCH_CHANGE_ARGS, 'Runs before `kunj switch` changes branch. A non-zero exit aborts the switch.'),
  define('post-branch-switch', BRANCH_CHANGE_ARGS, 'Runs after `kunj switch` has changed branch and restored its stash (e.g. to install dependencies).'),
  define('pre-branch-delete', ['branch'], 'Runs before `kunj delete` deletes a branch. A non-zero exit aborts the deletion.'),
  define('post-branch-delete', ['branch'], 'Runs after `kunj delete` has deleted a branch.'),
  define('pre-commit', ['branch'], 'Runs after `kunj commit` has staged the files, before the message is written. A non-zero exit aborts the commit.'),
  define(
    'commit-msg',
    ['message-file', 'branch'],
    'Runs with the (AI-generated or typed) message in a file before `kunj commit` commits; it may edit the file. A non-zero exit aborts the commit.'
  ),
  define('post-commit', ['branch'], 'Runs after `kunj commit` has created a commit, before pushing.'),
  define('pre-pr-create', PR_ARGS, 'Runs before `kunj pr` pushes the branch and opens a pull request. A non-zero exit aborts the pull request.'),
  define('post-pr-create', [...PR_ARGS, 'pr-url'], 'Runs after `kunj pr` has opened a pull request.'),
  define('pre-stash', STASH_ARGS, 'Runs before kunj stashes changes (`kunj stash` or the auto-stash on create/switch). A non-zero exit aborts the operation.'),
  define('post-stash', STASH_ARGS, 'Runs after kunj has stashed changes.'),
];

export const HOOK_NAMES: HookName[] = HOOKS.map(h => h.name);

export function getHookDefinition(name: string): HookDefinition | undefined {
  return HOOKS.find(h => h.name === name);
}

export function isHookName(name: string): name is HookName {
  return HOOK_NAMES.includes(name as HookName);
}
