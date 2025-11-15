#!/usr/bin/env node

// Modular CLI entry point using pluggable command architecture

import { Command } from 'commander';
import { CommandRegistry } from './lib/command';
import { getAllCommands } from './commands';

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