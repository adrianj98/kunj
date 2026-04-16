// Base command class and registry for pluggable command system

import { Command as CommanderCommand } from "commander";

export interface UIWidgetConfig {
  category: "dashboard" | "data" | "action" | "hidden";
  widget: "table" | "stat-card" | "timeline" | "key-value" | "markdown" | "form-only";
  label?: string;
  icon?: string;
  refreshInterval?: number;
  defaultArgs?: string[];
  dataKey?: string;
  columns?: Array<{ key: string; label: string; format?: string }>;
  order?: number;
}

export interface CommandConfig {
  name: string;
  description: string;
  arguments?: string;
  options?: Array<{
    flags: string;
    description: string;
    defaultValue?: any;
  }>;
  ui?: UIWidgetConfig;
}

export abstract class BaseCommand {
  protected config: CommandConfig;
  protected jsonMode = false;

  constructor(config: CommandConfig) {
    this.config = config;
  }

  // Getter for config (used by completion)
  getConfig(): CommandConfig {
    return this.config;
  }

  // Register the command with Commander
  register(program: CommanderCommand): void {
    let cmd = program.command(this.config.name);

    if (this.config.arguments) {
      cmd = cmd.arguments(this.config.arguments);
    }

    cmd.description(this.config.description);

    // Add global --json option
    cmd.option("--json", "Output result as JSON");

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
        // Detect --json from args — Commander passes (options, Command) or (arg, options, Command)
        // Options object has .opts() method on Commander's Command, but plain options don't
        // The second-to-last arg is always the options object
        const opts = args.length >= 2 ? args[args.length - 2] : args[0];
        if (opts && typeof opts === "object" && opts.json === true) {
          this.jsonMode = true;
        }
        await this.execute(...args);
      } catch (error) {
        if (this.jsonMode) {
          process.stdout.write(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n"
          );
          process.exit(1);
        }
        console.error("Command failed:", error);
        process.exit(1);
      }
    });
  }

  // Log a message (suppressed in JSON mode)
  protected log(message: string): void {
    if (!this.jsonMode) {
      console.log(message);
    }
  }

  // Output JSON data and exit
  protected outputJSON(data: any): void {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
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
