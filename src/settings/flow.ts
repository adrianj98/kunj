// Flow settings - Git Flow workflow configuration

import { registerSettings } from '../lib/settings-registry';

export function registerFlowSettings(): void {
  registerSettings([
    {
      key: 'flow.enabled',
      description: 'Enable Git Flow',
      detailedDescription: 'Enable Git Flow branching model in this repository. When enabled, you can use the `kunj flow` command to manage feature, release, and hotfix branches following the Git Flow methodology.',
      type: 'boolean',
      defaultValue: false,
      category: 'flow',
      examples: [
        'true - Enable Git Flow commands',
        'false - Disable Git Flow (default)'
      ]
    },
    {
      key: 'flow.mainBranch',
      description: 'Main/production branch',
      detailedDescription: 'The main production branch where stable releases are maintained. This is typically "main" or "master". Release and hotfix branches will be merged into this branch.',
      type: 'string',
      defaultValue: 'main',
      category: 'flow',
      examples: [
        'main - Use main as production branch (default)',
        'master - Use master as production branch'
      ],
      relatedSettings: ['flow.developBranch']
    },
    {
      key: 'flow.developBranch',
      description: 'Development branch',
      detailedDescription: 'The integration branch for ongoing development. Feature branches are created from and merged back into this branch. This is typically "develop" or "dev".',
      type: 'string',
      defaultValue: 'develop',
      category: 'flow',
      examples: [
        'develop - Use develop as integration branch (default)',
        'dev - Use dev as integration branch',
        'development - Use development as integration branch'
      ],
      relatedSettings: ['flow.mainBranch']
    },
    {
      key: 'flow.featurePrefix',
      description: 'Feature branch prefix',
      detailedDescription: 'Prefix for feature branch names. Feature branches are created for new features and improvements. Use empty string for no prefix.',
      type: 'string',
      defaultValue: 'feature/',
      category: 'flow',
      examples: [
        'feature/ - Feature branches like feature/user-auth (default)',
        'feat/ - Feature branches like feat/user-auth',
        '(empty) - No prefix, just feature name'
      ],
      relatedSettings: ['flow.releasePrefix', 'flow.hotfixPrefix']
    },
    {
      key: 'flow.releasePrefix',
      description: 'Release branch prefix',
      detailedDescription: 'Prefix for release branch names. Release branches are created to prepare new production releases. Use empty string for no prefix.',
      type: 'string',
      defaultValue: 'release/',
      category: 'flow',
      examples: [
        'release/ - Release branches like release/1.2.0 (default)',
        'rel/ - Release branches like rel/1.2.0',
        '(empty) - No prefix, just version number'
      ],
      relatedSettings: ['flow.featurePrefix', 'flow.hotfixPrefix']
    },
    {
      key: 'flow.hotfixPrefix',
      description: 'Hotfix branch prefix',
      detailedDescription: 'Prefix for hotfix branch names. Hotfix branches are created from production to quickly patch critical bugs. Use empty string for no prefix.',
      type: 'string',
      defaultValue: 'hotfix/',
      category: 'flow',
      examples: [
        'hotfix/ - Hotfix branches like hotfix/1.2.1 (default)',
        'fix/ - Hotfix branches like fix/1.2.1',
        '(empty) - No prefix, just version number'
      ],
      relatedSettings: ['flow.featurePrefix', 'flow.releasePrefix']
    },
    {
      key: 'flow.autoDeleteOnFinish',
      description: 'Auto-delete branch after finish',
      detailedDescription: 'Automatically delete feature/release/hotfix branches after successfully finishing them. When disabled, you will be prompted to confirm deletion for each branch.',
      type: 'boolean',
      defaultValue: true,
      category: 'flow',
      examples: [
        'true - Automatically delete branches after merge (default)',
        'false - Always ask before deleting branches'
      ]
    }
  ]);
}
