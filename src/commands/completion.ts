import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { BaseCommand } from '../lib/command';

interface CompletionOptions {
  install?: boolean;
  uninstall?: boolean;
}

const COMPLETION_MARKER = '# Kunj completion';
const COMPLETION_END_MARKER = '# End Kunj completion';

function getShellRcFile(): string {
  const shell = process.env.SHELL || '';
  const home = os.homedir();

  if (shell.includes('zsh')) return path.join(home, '.zshrc');
  if (shell.includes('fish')) return path.join(home, '.config', 'fish', 'config.fish');
  return path.join(home, '.bashrc');
}

function getCompletionSnippet(shell: string): string {
  const lines = [
    COMPLETION_MARKER,
    'if command -v kunj &> /dev/null; then',
    '  source <(kunj completion 2>/dev/null || true)',
    'fi',
    COMPLETION_END_MARKER,
  ];
  return lines.join('\n');
}

function removeCompletionSection(content: string): string {
  const start = content.indexOf(COMPLETION_MARKER);
  const end = content.indexOf(COMPLETION_END_MARKER);
  if (start === -1 || end === -1) return content;

  const before = content.substring(0, start);
  const after = content.substring(end + COMPLETION_END_MARKER.length);
  return before.trimEnd() + after;
}

export class CompletionCommand extends BaseCommand {
  constructor() {
    super({
      name: 'completion',
      description: 'Manage shell tab completion',
      options: [
        { flags: '--install', description: 'Install shell completion' },
        { flags: '--uninstall', description: 'Uninstall shell completion' },
      ],
    });
  }

  async execute(options: CompletionOptions = {}): Promise<void> {
    if (options.install) {
      await this.install();
      return;
    }

    if (options.uninstall) {
      await this.uninstall();
      return;
    }

    // Output completion script for sourcing: source <(kunj completion)
    this.outputCompletionScript();
  }

  private outputCompletionScript(): void {
    // Output a basic bash/zsh completion script
    const script = `
_kunj_completion() {
  local commands="create switch list commit pr delete config setup log graph diff stash flow jira completion prompt-info"
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=($(compgen -W "$commands" -- "$cur"))
}
complete -F _kunj_completion kunj
`;
    process.stdout.write(script);
  }

  private async install(): Promise<void> {
    const rcFile = getShellRcFile();
    const shell = process.env.SHELL || 'bash';

    if (!fs.existsSync(rcFile)) {
      fs.writeFileSync(rcFile, '');
    }

    let content = fs.readFileSync(rcFile, 'utf-8');

    if (content.includes(COMPLETION_MARKER)) {
      console.log(chalk.yellow(`Completion already installed in ${rcFile}`));
      return;
    }

    const snippet = getCompletionSnippet(shell);
    content = content.trimEnd() + '\n\n' + snippet + '\n';
    fs.writeFileSync(rcFile, content);

    console.log(chalk.green(`✅ Completion installed in ${rcFile}`));
    console.log(chalk.gray(`   Reload your shell: source ${rcFile}`));
  }

  private async uninstall(): Promise<void> {
    const rcFile = getShellRcFile();

    if (!fs.existsSync(rcFile)) {
      console.log(chalk.yellow('No shell config file found'));
      return;
    }

    let content = fs.readFileSync(rcFile, 'utf-8');

    if (!content.includes(COMPLETION_MARKER)) {
      console.log(chalk.yellow('Completion is not installed'));
      return;
    }

    content = removeCompletionSection(content);
    fs.writeFileSync(rcFile, content.trimEnd() + '\n');

    console.log(chalk.green(`✅ Completion removed from ${rcFile}`));
    console.log(chalk.gray(`   Reload your shell: source ${rcFile}`));
  }
}
