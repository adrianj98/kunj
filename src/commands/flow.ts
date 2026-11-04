// Git Flow workflow management command

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadConfig } from '../lib/config';
import { getCurrentBranch, getAllBranches, branchExists, wrapError } from '../lib/git';
import { UserError, formatError } from '../lib/errors';
import {
  initGitFlow,
  createFeatureBranch,
  finishFeatureBranch,
  createReleaseBranch,
  finishReleaseBranch,
  createHotfixBranch,
  finishHotfixBranch
} from '../lib/git-flow';

export class FlowCommand extends BaseCommand {
  constructor() {
    super({
      name: 'flow',
      description: 'Git Flow workflow management',
      options: []
    });
  }

  public register(program: Command): void {
    const flowCmd = program
      .command('flow')
      .description(this.config.description);

    // flow init - Initialize Git Flow
    flowCmd
      .command('init')
      .description('Initialize Git Flow in repository')
      .action(async () => {
        await run(() => this.initFlow());
      });

    // flow feature - Feature branch operations
    flowCmd
      .command('feature')
      .description('Feature branch operations')
      .argument('[action]', 'Action: start or finish')
      .argument('[name]', 'Feature name')
      .action(async (action, name) => {
        if (action === 'start') {
          await run(() => this.startFeature(name));
        } else if (action === 'finish') {
          await run(() => this.finishFeature(name));
        } else {
          console.log(chalk.yellow('Usage:'));
          console.log(chalk.gray('  kunj flow feature start <name>  ') + '- Start a new feature');
          console.log(chalk.gray('  kunj flow feature finish [name] ') + '- Finish a feature');
        }
      });

    // flow release - Release branch operations
    flowCmd
      .command('release')
      .description('Release branch operations')
      .argument('[action]', 'Action: start or finish')
      .argument('[version]', 'Release version')
      .action(async (action, version) => {
        if (action === 'start') {
          await run(() => this.startRelease(version));
        } else if (action === 'finish') {
          await run(() => this.finishRelease(version));
        } else {
          console.log(chalk.yellow('Usage:'));
          console.log(chalk.gray('  kunj flow release start <version>  ') + '- Start a new release');
          console.log(chalk.gray('  kunj flow release finish [version] ') + '- Finish a release');
        }
      });

    // flow hotfix - Hotfix branch operations
    flowCmd
      .command('hotfix')
      .description('Hotfix branch operations')
      .argument('[action]', 'Action: start or finish')
      .argument('[version]', 'Hotfix version')
      .action(async (action, version) => {
        if (action === 'start') {
          await run(() => this.startHotfix(version));
        } else if (action === 'finish') {
          await run(() => this.finishHotfix(version));
        } else {
          console.log(chalk.yellow('Usage:'));
          console.log(chalk.gray('  kunj flow hotfix start <version>  ') + '- Start a new hotfix');
          console.log(chalk.gray('  kunj flow hotfix finish [version] ') + '- Finish a hotfix');
        }
      });
  }

  private async initFlow(): Promise<void> {
    try {
      console.log(chalk.blue.bold('\nGit Flow Initialization\n'));

      // Check if already initialized
      const config = await loadConfig();
      if (config.flow?.enabled) {
        const answers = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'reinit',
            message: 'Git Flow is already initialized. Re-initialize?',
            default: false
          }
        ]);

        if (!answers.reinit) {
          console.log(chalk.gray('Initialization cancelled'));
          return;
        }
      }

      // Get all branches to suggest defaults
      const branches = await getAllBranches();
      const branchNames = branches.map(b => b.name);

      // Find common main branches
      const mainCandidates = ['main', 'master'];
      const developCandidates = ['develop', 'dev', 'development'];

      const defaultMain = mainCandidates.find(b => branchNames.includes(b)) || 'main';
      const defaultDevelop = developCandidates.find(b => branchNames.includes(b)) || 'develop';

      // Prompt for branch names and workflow settings
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'mainBranch',
          message: 'Main/production branch name:',
          default: defaultMain,
          validate: (input: string) => {
            if (!input.trim()) return 'Branch name cannot be empty';
            return true;
          }
        },
        {
          type: 'input',
          name: 'developBranch',
          message: 'Development branch name:',
          default: defaultDevelop,
          validate: (input: string) => {
            if (!input.trim()) return 'Branch name cannot be empty';
            return true;
          }
        },
        {
          type: 'list',
          name: 'mode',
          message: 'Git Flow mode:',
          choices: [
            { name: 'Local merges (traditional Git Flow)', value: 'local' },
            { name: 'Pull Requests (GitHub/GitLab)', value: 'pr' }
          ],
          default: 'local'
        },
        {
          type: 'list',
          name: 'prProvider',
          message: 'PR provider:',
          choices: [
            { name: 'GitHub', value: 'github' },
            { name: 'GitLab', value: 'gitlab' }
          ],
          default: 'github',
          when: (answers: any) => answers.mode === 'pr'
        },
        {
          type: 'confirm',
          name: 'mergeBackToDevelop',
          message: 'Merge releases/hotfixes back to develop?',
          default: true
        }
      ]);

      // Initialize Git Flow
      const result = await initGitFlow(
        answers.mainBranch,
        answers.developBranch,
        answers.mode,
        answers.prProvider || 'github',
        answers.mergeBackToDevelop
      );

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nYou can now use:'));
        console.log(chalk.gray('  kunj flow feature start <name>  - Start a new feature'));
        console.log(chalk.gray('  kunj flow release start <version> - Start a new release'));
        console.log(chalk.gray('  kunj flow hotfix start <version>  - Start a new hotfix'));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  private async startFeature(name?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        throw notInitialized();
      }

      // Prompt for feature name if not provided
      let featureName = name;
      if (!featureName) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: 'Feature name:',
            validate: (input: string) => {
              if (!input.trim()) return 'Feature name cannot be empty';
              return true;
            }
          }
        ]);
        featureName = answers.name;
      }

      // Ensure feature name is provided
      if (!featureName || !featureName.trim()) {
        throw new UserError('A feature name is required.', 'Pass it, as in `kunj flow feature start <name>`.');
      }

      // Create feature branch
      const result = await createFeatureBranch(featureName);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nWhen ready to merge back:'));
        console.log(chalk.gray('  kunj flow feature finish'));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  private async finishFeature(name?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        throw notInitialized();
      }

      // Determine feature branch
      let featureBranch = name;
      if (!featureBranch) {
        const currentBranch = await getCurrentBranch();
        const prefix = config.flow.featurePrefix || '';

        // Check if current branch is a feature branch
        if (prefix && currentBranch.startsWith(prefix)) {
          featureBranch = currentBranch;
        } else if (!prefix) {
          // If no prefix, assume current branch is the feature
          featureBranch = currentBranch;
        } else {
          // Prompt to select a feature branch
          const branches = await getAllBranches();
          const featureBranches = branches
            .map(b => b.name)
            .filter(b => prefix ? b.startsWith(prefix) : true);

          if (featureBranches.length === 0) {
            console.log(chalk.yellow('\n⚠ No feature branches found.'));
            return;
          }

          const answers = await inquirer.prompt([
            {
              type: 'list',
              name: 'branch',
              message: 'Select feature branch to finish:',
              choices: featureBranches
            }
          ]);
          featureBranch = answers.branch;
        }
      } else {
        // Add prefix if not already present
        const prefix = config.flow.featurePrefix || '';
        if (prefix && !featureBranch.startsWith(prefix)) {
          featureBranch = prefix + featureBranch;
        }
      }

      // Ensure featureBranch is defined
      if (!featureBranch) {
        throw new UserError('Could not tell which feature branch to finish.', 'Name it, as in `kunj flow feature finish <name>`.');
      }

      // Check if branch exists before prompting
      const exists = await branchExists(featureBranch);
      if (!exists) {
        throw new UserError(`There is no local branch named ${featureBranch}.`, 'Run `kunj list` to see the branches.');
      }

      // Confirm before finishing
      const confirmation = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Finish feature '${featureBranch}'?\n  → Merge into: ${config.flow.developBranch}\n  → Delete branch: ${config.flow.autoDeleteOnFinish ? 'yes' : 'no'}\n  Continue?`,
          default: true
        }
      ]);

      if (!confirmation.confirmed) {
        console.log(chalk.gray('\nCancelled'));
        return;
      }

      // Finish feature branch
      const result = await finishFeatureBranch(featureBranch);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  private async startRelease(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        throw notInitialized();
      }

      // Prompt for version if not provided
      let releaseVersion = version;
      if (!releaseVersion) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'version',
            message: 'Release version (e.g., 1.2.0):',
            validate: (input: string) => {
              if (!input.trim()) return 'Version cannot be empty';
              return true;
            }
          }
        ]);
        releaseVersion = answers.version;
      }

      // Ensure version is provided
      if (!releaseVersion || !releaseVersion.trim()) {
        throw new UserError('A release version is required.', 'Pass it, as in `kunj flow release start <version>`.');
      }

      // Create release branch
      const result = await createReleaseBranch(releaseVersion);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nMake release preparation commits, then:'));
        console.log(chalk.gray('  kunj flow release finish'));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  private async finishRelease(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        throw notInitialized();
      }

      // Determine release branch
      let releaseBranch = version;
      let releaseVersion = version;

      if (!releaseBranch) {
        const currentBranch = await getCurrentBranch();
        const prefix = config.flow.releasePrefix || '';

        // Check if current branch is a release branch
        if (prefix && currentBranch.startsWith(prefix)) {
          releaseBranch = currentBranch;
          releaseVersion = currentBranch.substring(prefix.length);
        } else if (!prefix) {
          releaseBranch = currentBranch;
          releaseVersion = currentBranch;
        } else {
          // Prompt to select a release branch
          const branches = await getAllBranches();
          const releaseBranches = branches
            .map(b => b.name)
            .filter(b => prefix ? b.startsWith(prefix) : true);

          if (releaseBranches.length === 0) {
            console.log(chalk.yellow('\n⚠ No release branches found.'));
            return;
          }

          const answers = await inquirer.prompt([
            {
              type: 'list',
              name: 'branch',
              message: 'Select release branch to finish:',
              choices: releaseBranches
            }
          ]);
          releaseBranch = answers.branch;
          if (releaseBranch) {
            releaseVersion = prefix ? releaseBranch.substring(prefix.length) : releaseBranch;
          }
        }
      } else {
        // Add prefix if not already present
        const prefix = config.flow.releasePrefix || '';
        if (prefix && !releaseBranch.startsWith(prefix)) {
          releaseBranch = prefix + releaseBranch;
        }
      }

      // Ensure releaseBranch is defined
      if (!releaseBranch) {
        throw new UserError('Could not tell which release branch to finish.', 'Name it, as in `kunj flow release finish <version>`.');
      }

      // Check if branch exists before prompting
      const exists = await branchExists(releaseBranch);
      if (!exists) {
        throw new UserError(`There is no local branch named ${releaseBranch}.`, 'Run `kunj list` to see the branches.');
      }

      // Prompt whether to create a tag
      const createTagAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'createTag',
          message: 'Create a tag for this release?',
          default: true
        }
      ]);

      // Prompt for tag name if creating a tag
      let tagName: string | undefined;
      if (createTagAnswer.createTag) {
        const tagAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'tag',
            message: 'Tag name:',
            default: releaseVersion?.startsWith('v') ? releaseVersion : `v${releaseVersion}`,
            validate: (input: string) => {
              if (!input.trim()) return 'Tag name cannot be empty';
              return true;
            }
          }
        ]);
        tagName = tagAnswers.tag;
      }

      // Confirm before finishing
      const tagMsg = tagName ? `\n  → Tag: ${tagName}` : '';
      const confirmation = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Finish release '${releaseBranch}'?\n  → Merge into: ${config.flow.mainBranch}${tagMsg}\n  → Merge back into: ${config.flow.developBranch}\n  → Delete branch: ${config.flow.autoDeleteOnFinish ? 'yes' : 'no'}\n  Continue?`,
          default: true
        }
      ]);

      if (!confirmation.confirmed) {
        console.log(chalk.gray('\nCancelled'));
        return;
      }

      // Finish release branch
      const result = await finishReleaseBranch(releaseBranch, tagName);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  private async startHotfix(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        throw notInitialized();
      }

      // Prompt for version if not provided
      let hotfixVersion = version;
      if (!hotfixVersion) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'version',
            message: 'Hotfix version (e.g., 1.2.1):',
            validate: (input: string) => {
              if (!input.trim()) return 'Version cannot be empty';
              return true;
            }
          }
        ]);
        hotfixVersion = answers.version;
      }

      // Ensure version is provided
      if (!hotfixVersion || !hotfixVersion.trim()) {
        throw new UserError('A hotfix version is required.', 'Pass it, as in `kunj flow hotfix start <version>`.');
      }

      // Create hotfix branch
      const result = await createHotfixBranch(hotfixVersion);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nMake hotfix commits, then:'));
        console.log(chalk.gray('  kunj flow hotfix finish'));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  private async finishHotfix(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        throw notInitialized();
      }

      // Determine hotfix branch
      let hotfixBranch = version;
      let hotfixVersion = version;

      if (!hotfixBranch) {
        const currentBranch = await getCurrentBranch();
        const prefix = config.flow.hotfixPrefix || '';

        // Check if current branch is a hotfix branch
        if (prefix && currentBranch.startsWith(prefix)) {
          hotfixBranch = currentBranch;
          hotfixVersion = currentBranch.substring(prefix.length);
        } else if (!prefix) {
          hotfixBranch = currentBranch;
          hotfixVersion = currentBranch;
        } else {
          // Prompt to select a hotfix branch
          const branches = await getAllBranches();
          const hotfixBranches = branches
            .map(b => b.name)
            .filter(b => prefix ? b.startsWith(prefix) : true);

          if (hotfixBranches.length === 0) {
            console.log(chalk.yellow('\n⚠ No hotfix branches found.'));
            return;
          }

          const answers = await inquirer.prompt([
            {
              type: 'list',
              name: 'branch',
              message: 'Select hotfix branch to finish:',
              choices: hotfixBranches
            }
          ]);
          hotfixBranch = answers.branch;
          if (hotfixBranch) {
            hotfixVersion = prefix ? hotfixBranch.substring(prefix.length) : hotfixBranch;
          }
        }
      } else {
        // Add prefix if not already present
        const prefix = config.flow.hotfixPrefix || '';
        if (prefix && !hotfixBranch.startsWith(prefix)) {
          hotfixBranch = prefix + hotfixBranch;
        }
      }

      // Ensure hotfixBranch is defined
      if (!hotfixBranch) {
        throw new UserError('Could not tell which hotfix branch to finish.', 'Name it, as in `kunj flow hotfix finish <version>`.');
      }

      // Check if branch exists before prompting
      const exists = await branchExists(hotfixBranch);
      if (!exists) {
        throw new UserError(`There is no local branch named ${hotfixBranch}.`, 'Run `kunj list` to see the branches.');
      }

      // Prompt whether to create a tag
      const createTagAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'createTag',
          message: 'Create a tag for this hotfix?',
          default: true
        }
      ]);

      // Prompt for tag name if creating a tag
      let tagName: string | undefined;
      if (createTagAnswer.createTag) {
        const tagAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'tag',
            message: 'Tag name:',
            default: hotfixVersion?.startsWith('v') ? hotfixVersion : `v${hotfixVersion}`,
            validate: (input: string) => {
              if (!input.trim()) return 'Tag name cannot be empty';
              return true;
            }
          }
        ]);
        tagName = tagAnswers.tag;
      }

      // Confirm before finishing
      const tagMsg = tagName ? `\n  → Tag: ${tagName}` : '';
      const confirmation = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Finish hotfix '${hotfixBranch}'?\n  → Merge into: ${config.flow.mainBranch}${tagMsg}\n  → Merge back into: ${config.flow.developBranch}\n  → Delete branch: ${config.flow.autoDeleteOnFinish ? 'yes' : 'no'}\n  Continue?`,
          default: true
        }
      ]);

      if (!confirmation.confirmed) {
        console.log(chalk.gray('\nCancelled'));
        return;
      }

      // Finish hotfix branch
      const result = await finishHotfixBranch(hotfixBranch, tagName);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
      } else {
        throw new UserError(result.message);
      }
    } catch (error: any) {
      throw wrapError('Git Flow failed', error);
    }
  }

  public async execute(): Promise<void> {
    // Not used - subcommands handle execution
  }
}

function notInitialized(): UserError {
  return new UserError('Git Flow is not set up in this repository.', 'Run `kunj flow init` first.');
}

// The flow subcommands are registered by hand, so they print their own errors like BaseCommand does
async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}
