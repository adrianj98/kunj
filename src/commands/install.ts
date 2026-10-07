// Install command - the VS Code extension and the macOS menu bar app,
// downloaded from the GitHub release (src/lib/apps.ts).
//
//   kunj install                 ask which apps to install
//   kunj install vscode|macos    install one
//   kunj install all             install everything available on this OS

import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../lib/command';
import {
  COMPANION_APPS,
  CompanionApp,
  RELEASES_REPO,
  downloadAsset,
  findReleaseAsset,
  installMacApp,
  installVscodeExtension,
  installedMacApp,
  isVscodeExtensionInstalled,
} from '../lib/apps';

interface InstallOptions {
  release?: string;
  editor?: string;
  yes?: boolean;
}

// The release to install from matches the CLI version when it has the asset
function cliVersion(): string | undefined {
  try {
    return require('../../package.json').version;
  } catch {
    return undefined;
  }
}

function availableApps(): CompanionApp[] {
  return process.platform === 'darwin' ? ['vscode', 'macos'] : ['vscode'];
}

export class InstallCommand extends BaseCommand {
  constructor() {
    super({
      name: 'install',
      description: 'Install the VS Code extension and the macOS menu bar app',
      arguments: '[app]',
      options: [
        { flags: '--release <version>', description: 'Install from this release (default: the CLI version, else the newest)' },
        { flags: '--editor <cli>', description: 'Editor CLI for the extension, e.g. cursor (default: code)' },
        { flags: '-y, --yes', description: 'Install everything available without asking' },
      ],
      helpText: () =>
        [
          'Apps:',
          '  vscode   Kunj Worktrees extension for VS Code (and VS Code-like editors via --editor)',
          '  macos    Kunj menu bar app, installed to /Applications (or ~/Applications)',
          '  all      Both, where available',
          '',
          `Both are downloaded from https://github.com/${RELEASES_REPO}/releases. The macOS app is not`,
          'notarized; the download quarantine is cleared so it opens without a warning.',
        ].join('\n'),
    });
  }

  async execute(app?: string | InstallOptions, options: InstallOptions = {}): Promise<void> {
    // Commander passes (options, command) when the app argument is omitted
    if (app && typeof app === 'object') {
      options = app;
      app = undefined;
    }

    let apps: CompanionApp[];
    if (!app) {
      apps = options.yes ? availableApps() : await this.ask(options);
    } else if (app === 'all') {
      apps = availableApps();
    } else if (app === 'vscode' || app === 'macos') {
      apps = [app];
    } else {
      throw new Error(`Unknown app '${app}'. Expected vscode, macos or all`);
    }

    if (apps.length === 0) {
      this.log(chalk.gray('Nothing to install.'));
      return;
    }

    const results: Array<{ app: CompanionApp; success: boolean; release?: string; path?: string; error?: string }> = [];
    for (const name of apps) {
      try {
        const { release, path } = await this.installOne(name, options);
        results.push({ app: name, success: true, release, path });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ app: name, success: false, error: message });
        this.log(chalk.red(`✗ ${COMPANION_APPS[name].label}: ${message}`));
      }
    }

    if (this.jsonMode) {
      this.outputJSON({ success: results.every(r => r.success), results });
    }
    if (results.some(r => !r.success)) {
      process.exitCode = 1;
    }
  }

  // Interactive choice, showing what is already installed
  async ask(options: InstallOptions = {}): Promise<CompanionApp[]> {
    const choices = [];
    for (const name of availableApps()) {
      let note = '';
      if (name === 'vscode') {
        const installed = await isVscodeExtensionInstalled(options.editor);
        note = installed === null ? chalk.gray(' (editor CLI not found)') : installed ? chalk.gray(' (installed - update)') : '';
      } else {
        const installed = installedMacApp();
        note = installed ? chalk.gray(` (installed in ${installed} - update)`) : '';
      }
      choices.push({ name: COMPANION_APPS[name].label + note, value: name, checked: !note.includes('installed') });
    }
    const { apps } = await inquirer.prompt([
      { type: 'checkbox', name: 'apps', message: 'Which apps would you like to install?', choices },
    ]);
    return apps as CompanionApp[];
  }

  async installOne(app: CompanionApp, options: InstallOptions = {}): Promise<{ release: string; path?: string }> {
    const label = COMPANION_APPS[app].label;
    const version = options.release || cliVersion();
    this.log(chalk.blue(`Looking for the ${label} in the GitHub releases...`));
    const asset = await findReleaseAsset(app, version);
    if (!asset) {
      throw new Error(
        app === 'macos'
          ? 'no release has the macOS app yet. Build it from source: cd macos-app && scripts/bundle.sh --install'
          : 'no release has the VS Code extension. Build it from source: cd vscode-extension && npm run install-local'
      );
    }
    if (version && asset.tag.replace(/^v/, '') !== version.replace(/^v/, '')) {
      this.log(chalk.gray(`  ${version} has no ${asset.name.split('-')[0]} download; using ${asset.tag}`));
    }

    this.log(chalk.gray(`  Downloading ${asset.name} (${asset.tag})...`));
    const file = await downloadAsset(asset);

    if (app === 'vscode') {
      await installVscodeExtension(file, options.editor);
      this.log(chalk.green(`✓ Installed the ${label} ${asset.tag}. Reload VS Code windows to use it.`));
      return { release: asset.tag };
    }

    const dest = await installMacApp(file);
    this.log(chalk.green(`✓ Installed ${dest} ${asset.tag} and launched it. Look for the branch icon in the menu bar.`));
    return { release: asset.tag, path: dest };
  }
}
