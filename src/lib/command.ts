// Base command class and registry for pluggable command system

import { Command as CommanderCommand } from 'commander';

export interface CommandConfig {
  name: string;
  description: string;
  arguments?: string;
  options?: Array<{
    flags: string;
    description: string;
    defaultValue?: any;
  }>;
}

export abstract class BaseCommand {
  protected config: CommandConfig;

  constructor(config: CommandConfig) {
    this.config = config;
  }

  // Register the command with Commander
  register(program: CommanderCommand): void {
    let cmd = program.command(this.config.name);

    if (this.config.arguments) {
      cmd = cmd.arguments(this.config.arguments);
    }

    cmd.description(this.config.description);

    // Add options if defined
    if (this.config.options) {
      for (const option of this.config.options) {
        if (option.defaultValue !== undefined) {
          cmd.option(option.flags, option.description, option.defaultValue);
        } else {
          cmd.option(option.flags, option.description);
        }
      }
    }

    // Set the action handler
    cmd.action(async (...args) => {
      try {
        await this.execute(...args);
      } catch (error) {
        console.error('Command failed:', error);
        process.exit(1);
      }
    });
  }

  // Abstract method that each command must implement
  abstract execute(...args: any[]): Promise<void>;
}

// Command registry to manage all commands
export class CommandRegistry {
  private commands: BaseCommand[] = [];

  // Register a command
  register(command: BaseCommand): void {
    this.commands.push(command);
  }

  // Register multiple commands
  registerAll(commands: BaseCommand[]): void {
    this.commands.push(...commands);
  }

  // Apply all registered commands to the Commander program
  applyTo(program: CommanderCommand): void {
    for (const command of this.commands) {
      command.register(program);
    }
  }

  // Get all registered commands (for testing/debugging)
  getCommands(): BaseCommand[] {
    return this.commands;
  }
}