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

    console.log(chalk.blue('\n🎉 Setup complete! Happy coding with kunj!'));
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