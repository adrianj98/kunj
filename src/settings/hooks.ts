// Hook settings - commands run at well-defined points, alongside the hook
// scripts in ~/.kunj/hooks and ~/.kunj/{reponame}/hooks (see src/lib/hooks.ts)

import { registerSettings } from '../lib/settings-registry';
import { HOOKS } from '../lib/hook-defs';

export function registerHookSettings(): void {
  registerSettings(
    HOOKS.map(hook => ({
      key: `hooks.${hook.name}`,
      description: `Command run by the ${hook.name} hook`,
      type: 'string' as const,
      defaultValue: '',
      category: 'hooks',
      detailedDescription:
        `${hook.description} ` +
        'The command runs through the shell with ${repoRoot}, ${repoconfig}, ${repoName}, ${home}, ${branch} and ${worktree} expanded, ' +
        `and receives ${['KUNJ_HOOK', 'KUNJ_REPO_ROOT', ...hook.env].join(', ')} in its environment. ` +
        'Edit the config file by hand to list several commands as a JSON array. ' +
        `Executable scripts named ${hook.name} in ~/.kunj/hooks or ~/.kunj/<repo>/hooks run as well; see \`kunj hooks\`.`,
      examples:
        hook.name === 'post-worktree-create'
          ? ['npm install', 'direnv allow ${worktree}', '(empty) - No configured command (default)']
          : hook.name === 'pre-worktree-delete'
            ? ['docker compose down', 'test -z "$(git status --porcelain)"', '(empty) - No configured command (default)']
            : ['(empty) - No configured command (default)'],
      validate: (value: unknown) => typeof value === 'string' || Array.isArray(value),
      relatedSettings: HOOKS.filter(h => h.name !== hook.name).map(h => `hooks.${h.name}`),
    }))
  );
}
