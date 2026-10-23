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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const command_1 = require("./lib/command");
const fast_1 = require("./commands/fast");
const version_1 = require("./lib/version");
// Loaded lazily: pulling in every command costs close to a second of startup
async function getAllCommands() {
    return (await Promise.resolve().then(() => __importStar(require('./commands')))).getAllCommands();
}
// Main function to handle both completion and normal execution
async function main() {
    // --json output is read by the VS Code extension and the macOS app; never colour it,
    // even when FORCE_COLOR is inherited. Callers don't set NO_COLOR themselves because
    // the editor kunj opens would hand it on to every terminal in its window.
    if (process.argv.includes('--json')) {
        chalk_1.default.level = 0;
    }
    // Handle shell completion first
    const env = process.env;
    if (env.COMP_LINE || env.COMP_POINT) {
        // Tabtab completion request
        const tabtab = await Promise.resolve().then(() => __importStar(require('tabtab')));
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
        console.log((0, version_1.getVersion)());
        return;
    }
    // Create the main program
    const program = new commander_1.Command();
    // Configure the program
    program
        .name('kunj')
        .description('A CLI tool for working with git branches')
        .version((0, version_1.getVersion)());
    // Register commands. Lightweight commands that are invoked frequently by
    // editors and shell prompts skip loading the heavy AI/Jira/UI modules.
    const registry = new command_1.CommandRegistry();
    const fastCommand = await (0, fast_1.loadFastCommand)(process.argv[2]);
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
//# sourceMappingURL=index.js.map