// Hook settings - commands run at well-defined points, alongside the hook
// scripts in ~/.kunj/hooks and ~/.kunj/{reponame}/hooks (see src/lib/hooks.ts)

import { registerSettings } from '../lib/settings-registry';
import { HOOKS, HookName, argVariableName } from '../lib/hook-defs';

const EXAMPLES: Partial<Record<HookName, string[]>> = {
  'post-worktree-create': ['npm install', 'direnv allow ${worktree}'],
  'pre-worktree-delete': ['docker compose down', 'test -z "$(git status --porcelain)"'],
  'post-branch-switch': ['npm install'],
  'pre-commit': ['npm test'],
  'commit-msg': ['grep -qE "[A-Z]+-[0-9]+" "$KUNJ_MESSAGE_FILE"'],
  'pre-pr-create': ['npm run lint && npm test'],
};

// The object a hook is about: pre-branch-switch -> branch-switch, commit-msg -> commit
function subject(name: string): string {
  return name.replace(/^(pre|post)-/, '').replace(/-msg$/, '');
}

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
        'The command runs through the shell with ' +
        ['repoRoot', 'repoconfig', 'repoName', 'home', ...(hook.name.includes('-worktree-') ? ['worktree'] : []), ...hook.args.map(argVariableName)]
          .filter((v, i, all) => all.indexOf(v) === i)
          .map(v => '${' + v + '}')
          .join(', ') +
        ' expanded, ' +
        `and receives ${['KUNJ_HOOK', 'KUNJ_REPO_ROOT', ...hook.env].join(', ')} in its environment. ` +
        'Edit the config file by hand to list several commands as a JSON array. ' +
        `Executable scripts named ${hook.name} in ~/.kunj/hooks or ~/.kunj/<repo>/hooks run as well; see \`kunj hooks\`.`,
      examples: [...(EXAMPLES[hook.name] || []), '(empty) - No configured command (default)'],
      validate: (value: unknown) => typeof value === 'string' || Array.isArray(value),
      relatedSettings: HOOKS.filter(h => h.name !== hook.name && subject(h.name).split('-')[0] === subject(hook.name).split('-')[0]).map(h => `hooks.${h.name}`),
    }))
  );
}
