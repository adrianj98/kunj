#!/usr/bin/env node
"use strict";
// Modular CLI entry point using pluggable command architecture
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const command_1 = require("./lib/command");
const commands_1 = require("./commands");
// Create the main program
const program = new commander_1.Command();
// Configure the program
program
    .name('kunj')
    .description('A CLI tool for working with git branches')
    .version('1.0.0');
// Register all commands
const registry = new command_1.CommandRegistry();
const commands = (0, commands_1.getAllCommands)();
registry.registerAll(commands);
registry.applyTo(program);
// Parse command line arguments
program.parse(process.argv);
//# sourceMappingURL=index.js.map