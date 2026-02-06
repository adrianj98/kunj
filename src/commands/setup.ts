import { BaseCommand } from '../lib/command';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';

export class SetupCommand extends BaseCommand {
  constructor() {
    super({
      name: 'setup',
      description: 'Set up kunj aliases and shell configuration',
      options: [
        { flags: '-s, --shell <shell>', description: 'Shell type (bash, zsh, fish)' },
        { flags: '-f, --force', description: 'Force overwrite existing aliases' }
      ]
    });
  }

  async execute(options: any = {}): Promise<void> {
    console.log(chalk.blue('🚀 Kunj Setup Wizard'));
    console.log(chalk.gray('Setting up convenient aliases for kunj commands\n'));

    // Detect shell
    const shell = await this.detectShell(options.shell);
    console.log(chalk.green(`✓ Detected shell: ${shell}`));

    // Get config file path
    const configFile = this.getConfigFile(shell);
    console.log(chalk.gray(`  Config file: ${configFile}\n`));

    // Define aliases
    const aliases = [
      { alias: 'kj', command: 'kunj', description: 'Main kunj command' },
      { alias: 'ksw', command: 'kunj switch', description: 'Switch branches' },
      { alias: 'kcom', command: 'kunj commit', description: 'Interactive commit' },
      { alias: 'kpr', command: 'kunj pr', description: 'Create/view pull requests' },
      { alias: 'klist', command: 'kunj list', description: 'List branches' },
      { alias: 'kclean', command: 'kunj clean', description: 'Clean old branches' },
    ];

    // Show what will be installed
    console.log(chalk.cyan('The following aliases will be created:'));
    aliases.forEach(({ alias, command, description }) => {
      console.log(`  ${chalk.yellow(alias.padEnd(8))} → ${command.padEnd(20)} ${chalk.gray(description)}`);
    });
    console.log();

    // Ask for confirmation
    if (!options.force) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Continue with installation?',
        default: true
      }]);

      if (!confirm) {
        console.log(chalk.yellow('Setup cancelled'));
        return;
      }
    }

    // Check if config file exists
    if (!fs.existsSync(configFile)) {
      console.log(chalk.yellow(`Creating ${configFile}...`));
      fs.writeFileSync(configFile, '');
    }

    // Read existing config
    let config = fs.readFileSync(configFile, 'utf-8');

    // Check for existing kunj aliases
    const hasKunjSection = config.includes('# Kunj CLI Aliases');

    if (hasKunjSection && !options.force) {
      const { overwrite } = await inquirer.prompt([{
        type: 'confirm',
        name: 'overwrite',
        message: 'Kunj aliases already exist. Overwrite them?',
        default: false
      }]);

      if (!overwrite) {
        console.log(chalk.yellow('Setup cancelled'));
        return;
      }

      // Remove existing kunj section
      config = this.removeKunjSection(config);
    }

    // Generate alias commands based on shell
    const aliasCommands = this.generateAliases(shell, aliases);

    // Add aliases to config
    config += '\n' + aliasCommands;
    fs.writeFileSync(configFile, config);

    console.log(chalk.green('\n✅ Aliases installed successfully!\n'));

    // Show instructions
    this.showPostInstallInstructions(shell, configFile, aliases);

    // Ask if user wants to source the file now
    const { sourceNow } = await inquirer.prompt([{
      type: 'confirm',
      name: 'sourceNow',
      message: 'Apply changes to current session?',
      default: true
    }]);

    if (sourceNow) {
      try {
        // Source the config file
        const sourceCommand = shell === 'fish' ? 'source' : '.';
        execSync(`${sourceCommand} ${configFile}`, {
          shell: this.getShellPath(shell),
          stdio: 'inherit'
        });
        console.log(chalk.green('\n✓ Changes applied to current session'));
      } catch (error) {
        console.log(chalk.yellow('\n⚠ Could not apply to current session'));
        console.log(chalk.gray(`  Run manually: source ${configFile}`));
      }
    }

    // Ask about Jira integration
    await this.setupJiraIntegration();

    console.log(chalk.blue('\n🎉 Setup complete! Happy coding with kunj!'));
  }

  private async setupJiraIntegration(): Promise<void> {
    console.log(chalk.blue('\n\n🔗 Jira Integration Setup (Optional)'));
    console.log(chalk.gray('Connect kunj to your Jira Cloud instance for ticket management\n'));

    const { enableJira } = await inquirer.prompt([{
      type: 'confirm',
      name: 'enableJira',
      message: 'Enable Jira integration?',
      default: false
    }]);

    if (!enableJira) {
      console.log(chalk.gray('Skipping Jira setup\n'));
      return;
    }

    // Get config module dynamically to avoid circular dependency
    const { loadConfig, saveConfig } = await import('../lib/config');
    const { checkJiraCredentials } = await import('../lib/jira');

    // Prompt for Jira credentials
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Jira Cloud URL (e.g., https://company.atlassian.net):',
        validate: (input: string) => {
          if (!input.trim()) return 'Base URL is required';
          if (!input.startsWith('https://')) return 'URL must start with https://';
          if (!input.includes('.atlassian.net')) return 'Must be a valid Atlassian URL';
          return true;
        }
      },
      {
        type: 'input',
        name: 'email',
        message: 'Jira account email:',
        validate: (input: string) => {
          if (!input.trim()) return 'Email is required';
          if (!input.includes('@')) return 'Please enter a valid email';
          return true;
        }
      },
      {
        type: 'password',
        name: 'apiToken',
        message: 'API Token (generate at https://id.atlassian.com/manage-profile/security/api-tokens):',
        mask: '*',
        validate: (input: string) => {
          if (!input.trim()) return 'API token is required';
          return true;
        }
      },
      {
        type: 'input',
        name: 'projectKey',
        message: 'Default project key (e.g., PROJ, DEV):',
        validate: (input: string) => {
          if (!input.trim()) return true; // Optional
          if (!/^[A-Z]+$/.test(input)) return 'Project key must be uppercase letters only';
          return true;
        }
      }
    ]);

    // Test credentials
    console.log(chalk.gray('\nTesting Jira credentials...'));

    // Temporarily save config for testing
    const config = await loadConfig();
    config.jira = {
      enabled: true,
      baseUrl: answers.baseUrl,
      email: answers.email,
      apiToken: answers.apiToken,
      projectKey: answers.projectKey || '',
      defaultIssueType: 'Task' as 'Story' | 'Bug' | 'Task' | 'Epic',
      boardId: ''
    };

    await saveConfig(config);

    // Test connection
    const isValid = await checkJiraCredentials();

    if (isValid) {
      console.log(chalk.green('✓ Jira credentials validated successfully!\n'));

      // Ask about board ID for sprint features
      const { configureSprints } = await inquirer.prompt([{
        type: 'confirm',
        name: 'configureSprints',
        message: 'Configure board ID for sprint features?',
        default: false
      }]);

      if (configureSprints) {
        const { boardId } = await inquirer.prompt([{
          type: 'input',
          name: 'boardId',
          message: 'Board ID (find in your board URL):',
          validate: (input: string) => {
            if (!input.trim()) return true; // Optional
            if (!/^\d+$/.test(input)) return 'Board ID must be a number';
            return true;
          }
        }]);

        if (boardId) {
          config.jira!.boardId = boardId;
          await saveConfig(config);
          console.log(chalk.green('✓ Board ID configured\n'));
        }
      }

      console.log(chalk.cyan('🎯 Jira integration enabled!'));
      console.log(chalk.gray('  Try: kunj jira list'));
      console.log(chalk.gray('  Try: kunj jira create'));
    } else {
      console.log(chalk.red('✗ Jira credentials validation failed\n'));
      console.log(chalk.yellow('Jira integration has been disabled.'));
      console.log(chalk.gray('You can reconfigure later with: kunj config set jira.enabled true\n'));

      // Disable Jira
      config.jira!.enabled = false;
      await saveConfig(config);
    }
  }

  private async detectShell(providedShell?: string): Promise<string> {
    if (providedShell) {
      return providedShell;
    }

    // Try to detect from environment
    const shellEnv = process.env.SHELL || '';

    if (shellEnv.includes('zsh')) return 'zsh';
    if (shellEnv.includes('bash')) return 'bash';
    if (shellEnv.includes('fish')) return 'fish';

    // Ask user
    const { shell } = await inquirer.prompt([{
      type: 'list',
      name: 'shell',
      message: 'Select your shell:',
      choices: [
        { name: 'Zsh (default on macOS)', value: 'zsh' },
        { name: 'Bash', value: 'bash' },
        { name: 'Fish', value: 'fish' }
      ],
      default: 'zsh'
    }]);

    return shell;
  }

  private getConfigFile(shell: string): string {
    const home = os.homedir();

    switch (shell) {
      case 'zsh':
        return path.join(home, '.zshrc');
      case 'bash':
        // Check for .bashrc first, then .bash_profile
        const bashrc = path.join(home, '.bashrc');
        const bashProfile = path.join(home, '.bash_profile');
        return fs.existsSync(bashrc) ? bashrc : bashProfile;
      case 'fish':
        const fishConfig = path.join(home, '.config', 'fish', 'config.fish');
        // Ensure fish config directory exists
        const fishDir = path.dirname(fishConfig);
        if (!fs.existsSync(fishDir)) {
          fs.mkdirSync(fishDir, { recursive: true });
        }
        return fishConfig;
      default:
        return path.join(home, '.bashrc');
    }
  }

  private generateAliases(shell: string, aliases: Array<{alias: string, command: string, description: string}>): string {
    const lines: string[] = [];

    lines.push('# Kunj CLI Aliases');
    lines.push('# Generated by kunj setup');
    lines.push('# https://github.com/adrianj98/kunj');
    lines.push('');

    if (shell === 'fish') {
      // Fish shell syntax
      aliases.forEach(({ alias, command }) => {
        lines.push(`alias ${alias}="${command}"`);
      });
    } else {
      // Bash/Zsh syntax
      aliases.forEach(({ alias, command }) => {
        lines.push(`alias ${alias}="${command}"`);
      });
    }

    lines.push('# End Kunj CLI Aliases');

    return lines.join('\n');
  }

  private removeKunjSection(config: string): string {
    const startMarker = '# Kunj CLI Aliases';
    const endMarker = '# End Kunj CLI Aliases';

    const startIndex = config.indexOf(startMarker);
    const endIndex = config.indexOf(endMarker);

    if (startIndex !== -1 && endIndex !== -1) {
      // Remove the section including the end marker and any trailing newline
      const beforeSection = config.substring(0, startIndex);
      const afterSection = config.substring(endIndex + endMarker.length);
      return beforeSection.trimEnd() + afterSection;
    }

    return config;
  }

  private showPostInstallInstructions(shell: string, configFile: string, aliases: any[]): void {
    console.log(chalk.cyan('📝 Next steps:'));
    console.log();

    if (shell === 'fish') {
      console.log('  Restart your terminal or run:');
      console.log(chalk.gray(`  source ${configFile}`));
    } else {
      console.log('  Restart your terminal or run:');
      console.log(chalk.gray(`  source ${configFile}`));
    }

    console.log();
    console.log(chalk.cyan('🎯 Quick start:'));
    console.log();
    console.log('  Try these commands:');
    console.log(chalk.gray('  kj          # Show help'));
    console.log(chalk.gray('  ksw         # Switch branches'));
    console.log(chalk.gray('  kcom        # Interactive commit'));
    console.log(chalk.gray('  klist       # List all branches'));
    console.log();

    console.log(chalk.cyan('💡 Tips:'));
    console.log('  • Use tab completion with aliases');
    console.log('  • Run "kunj setup" again to update aliases');
    console.log('  • Edit ' + chalk.yellow(configFile) + ' to customize');
  }

  private getShellPath(shell: string): string {
    switch (shell) {
      case 'zsh':
        return '/bin/zsh';
      case 'bash':
        return '/bin/bash';
      case 'fish':
        return '/usr/bin/fish';
      default:
        return '/bin/bash';
    }
  }
}