// Git Flow workflow management command

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { BaseCommand } from '../lib/command';
import { loadConfig } from '../lib/config';
import { getCurrentBranch, getAllBranches, branchExists } from '../lib/git';
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
        await this.initFlow();
      });

    // flow feature - Feature branch operations
    flowCmd
      .command('feature')
      .description('Feature branch operations')
      .argument('[action]', 'Action: start or finish')
      .argument('[name]', 'Feature name')
      .action(async (action, name) => {
        if (action === 'start') {
          await this.startFeature(name);
        } else if (action === 'finish') {
          await this.finishFeature(name);
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
          await this.startRelease(version);
        } else if (action === 'finish') {
          await this.finishRelease(version);
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
          await this.startHotfix(version);
        } else if (action === 'finish') {
          await this.finishHotfix(version);
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

      // Prompt for branch names
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
        }
      ]);

      // Initialize Git Flow
      const result = await initGitFlow(answers.mainBranch, answers.developBranch);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nYou can now use:'));
        console.log(chalk.gray('  kunj flow feature start <name>  - Start a new feature'));
        console.log(chalk.gray('  kunj flow release start <version> - Start a new release'));
        console.log(chalk.gray('  kunj flow hotfix start <version>  - Start a new hotfix'));
      } else {
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  private async startFeature(name?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        console.log(chalk.yellow('\n⚠ Git Flow not initialized. Run "kunj flow init" first.'));
        return;
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
        console.log(chalk.red('\n✗ Feature name is required'));
        return;
      }

      // Create feature branch
      const result = await createFeatureBranch(featureName);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nWhen ready to merge back:'));
        console.log(chalk.gray('  kunj flow feature finish'));
      } else {
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  private async finishFeature(name?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        console.log(chalk.yellow('\n⚠ Git Flow not initialized. Run "kunj flow init" first.'));
        return;
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
        console.log(chalk.red('\n✗ Could not determine feature branch'));
        return;
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
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  private async startRelease(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        console.log(chalk.yellow('\n⚠ Git Flow not initialized. Run "kunj flow init" first.'));
        return;
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
        console.log(chalk.red('\n✗ Release version is required'));
        return;
      }

      // Create release branch
      const result = await createReleaseBranch(releaseVersion);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nMake release preparation commits, then:'));
        console.log(chalk.gray('  kunj flow release finish'));
      } else {
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  private async finishRelease(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        console.log(chalk.yellow('\n⚠ Git Flow not initialized. Run "kunj flow init" first.'));
        return;
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
        console.log(chalk.red('\n✗ Could not determine release branch'));
        return;
      }

      // Prompt for tag name
      const tagAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'tag',
          message: 'Tag name for this release:',
          default: releaseVersion?.startsWith('v') ? releaseVersion : `v${releaseVersion}`,
          validate: (input: string) => {
            if (!input.trim()) return 'Tag name cannot be empty';
            return true;
          }
        }
      ]);

      // Confirm before finishing
      const confirmation = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Finish release '${releaseBranch}'?\n  → Merge into: ${config.flow.mainBranch}\n  → Tag: ${tagAnswers.tag}\n  → Merge back into: ${config.flow.developBranch}\n  → Delete branch: ${config.flow.autoDeleteOnFinish ? 'yes' : 'no'}\n  Continue?`,
          default: true
        }
      ]);

      if (!confirmation.confirmed) {
        console.log(chalk.gray('\nCancelled'));
        return;
      }

      // Finish release branch
      const result = await finishReleaseBranch(releaseBranch, tagAnswers.tag);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
      } else {
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  private async startHotfix(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        console.log(chalk.yellow('\n⚠ Git Flow not initialized. Run "kunj flow init" first.'));
        return;
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
        console.log(chalk.red('\n✗ Hotfix version is required'));
        return;
      }

      // Create hotfix branch
      const result = await createHotfixBranch(hotfixVersion);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
        console.log(chalk.gray('\nMake hotfix commits, then:'));
        console.log(chalk.gray('  kunj flow hotfix finish'));
      } else {
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  private async finishHotfix(version?: string): Promise<void> {
    try {
      const config = await loadConfig();
      if (!config.flow?.enabled) {
        console.log(chalk.yellow('\n⚠ Git Flow not initialized. Run "kunj flow init" first.'));
        return;
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
        console.log(chalk.red('\n✗ Could not determine hotfix branch'));
        return;
      }

      // Prompt for tag name
      const tagAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'tag',
          message: 'Tag name for this hotfix:',
          default: hotfixVersion?.startsWith('v') ? hotfixVersion : `v${hotfixVersion}`,
          validate: (input: string) => {
            if (!input.trim()) return 'Tag name cannot be empty';
            return true;
          }
        }
      ]);

      // Confirm before finishing
      const confirmation = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Finish hotfix '${hotfixBranch}'?\n  → Merge into: ${config.flow.mainBranch}\n  → Tag: ${tagAnswers.tag}\n  → Merge back into: ${config.flow.developBranch}\n  → Delete branch: ${config.flow.autoDeleteOnFinish ? 'yes' : 'no'}\n  Continue?`,
          default: true
        }
      ]);

      if (!confirmation.confirmed) {
        console.log(chalk.gray('\nCancelled'));
        return;
      }

      // Finish hotfix branch
      const result = await finishHotfixBranch(hotfixBranch, tagAnswers.tag);

      if (result.success) {
        console.log(chalk.green('\n✓ ' + result.message));
      } else {
        console.log(chalk.red('\n✗ ' + result.message));
      }
    } catch (error: any) {
      console.log(chalk.red(`\n✗ Error: ${error.message}`));
    }
  }

  public async execute(): Promise<void> {
    // Not used - subcommands handle execution
  }
}
