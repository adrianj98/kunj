#!/usr/bin/env node

// Modular CLI entry point using pluggable command architecture

import { Command } from 'commander';
import { CommandRegistry } from './lib/command';
import { loadFastCommand } from './commands/fast';

// Loaded lazily: pulling in every command costs close to a second of startup
async function getAllCommands() {
  return (await import('./commands')).getAllCommands();
}

// Main function to handle both completion and normal execution
async function main() {
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

  // Create the main program
  const program = new Command();

  // Configure the program
  program
    .name('kunj')
    .description('A CLI tool for working with git branches')
    .version('1.0.0');

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