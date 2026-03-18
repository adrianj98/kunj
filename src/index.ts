#!/usr/bin/env node

// Modular CLI entry point using pluggable command architecture

import { Command } from 'commander';
import { CommandRegistry } from './lib/command';
import { getAllCommands } from './commands';

// Main function to handle both completion and normal execution
async function main() {
  // Handle shell completion first
  const env = process.env;
  if (env.COMP_LINE || env.COMP_POINT) {
    // Tabtab completion request
    const tabtab = await import('tabtab');
    const { log } = tabtab;

    // Get all commands
    const commands = getAllCommands();
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

  // Register all commands
  const registry = new CommandRegistry();
  const commands = getAllCommands();
  registry.registerAll(commands);
  registry.applyTo(program);

  // Parse command line arguments
  program.parse(process.argv);
}

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});