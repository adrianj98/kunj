#!/usr/bin/env node
"use strict";
// Modular CLI entry point using pluggable command architecture
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const command_1 = require("./lib/command");
const commands_1 = require("./commands");
// Main function to handle both completion and normal execution
async function main() {
    // Handle shell completion first
    const env = process.env;
    if (env.COMP_LINE || env.COMP_POINT) {
        // Tabtab completion request
        const tabtab = await Promise.resolve().then(() => __importStar(require('tabtab')));
        const { log } = tabtab;
        // Get all commands
        const commands = (0, commands_1.getAllCommands)();
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
}
// Run the main function
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map