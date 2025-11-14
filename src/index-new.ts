#!/usr/bin/env node

import { Command } from 'commander';
import { CommandRegistry } from './lib/command';
import { getAllCommands } from './commands';

// Create the main program
const program = new Command();

program
  .name('kunj')
  .description('A CLI tool for working with git branches')
  .version('1.0.0');

// Create command registry and register all commands
const registry = new CommandRegistry();
const commands = getAllCommands();
registry.registerAll(commands);

// Apply all commands to the program
registry.applyTo(program);

// Parse command line arguments
program.parse(process.argv);