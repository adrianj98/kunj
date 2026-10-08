#!/usr/bin/env node

// Modular CLI entry point using pluggable command architecture

import { Command } from 'commander';
import chalk from 'chalk';
import { CommandRegistry } from './lib/command';
import { loadFastCommand } from './commands/fast';

// Loaded lazily: pulling in every command costs close to a second of startup
async function getAllCommands() {
  return (await import('./commands')).getAllCommands();
}

// The release workflow rewrites package.json *after* the build, so the version
// has to be read at runtime -- anything inlined at compile time is stale.
function getVersion(): string {
  try {
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Main function to handle both completion and normal execution
async function main() {
  // --json output is read by the VS Code extension and the macOS app; never colour it,
  // even when FORCE_COLOR is inherited. Callers don't set NO_COLOR themselves because
  // the editor kunj opens would hand it on to every terminal in its window.
  if (process.argv.includes('--json')) {
    chalk.level = 0;
  }

  // Handle shell completion first
  const env = process.env;
  if (env.COMP_LINE || env.COMP_POINT) {
    // Tabtab completion request
    const tabtab = await import('tabtab');
    const { log } = tabtab;

    // Get all commands
    const commands = await getAllCommands();
    const completions = commands.map(cmd => {
      const config = cmd.getConfig();
      return {
        name: config.name,
        description: config.description || '',
      };
    });

    // Add completions
    log(completions);
    return;
  }

  // Printing the version needs nothing but package.json, so answer it before
  // the registry pulls in the AWS/LangChain/Jira modules (see commands/fast.ts)
  if (process.argv.length === 3 && (process.argv[2] === '-V' || process.argv[2] === '--version')) {
    console.log(getVersion());
    return;
  }

  // Create the main program
  const program = new Command();

  // Configure the program
  program
    .name('kunj')
    .description('A CLI tool for working with git branches')
    .version(getVersion());

  // Register commands. Lightweight commands that are invoked frequently by
  // editors and shell prompts skip loading the heavy AI/Jira/UI modules.
  const registry = new CommandRegistry();
  const fastCommand = await loadFastCommand(process.argv[2]);
  registry.registerAll(fastCommand ? [fastCommand] : await getAllCommands());
  registry.applyTo(program);

  // Parse command line arguments
  program.parse(process.argv);
}

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});