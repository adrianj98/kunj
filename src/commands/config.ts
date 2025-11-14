// Config command - view and edit configuration

import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../lib/command';
import { loadConfig, saveConfig, getConfigPath } from '../lib/config';
import { defaultConfig } from '../constants';
import { formatConfigValue, formatBoolValue, parseKeyValue } from '../lib/utils';

interface ConfigOptions {
  set?: string;
  get?: string;
  list?: boolean;
  interactive?: boolean;
  reset?: boolean;
}

export class ConfigCommand extends BaseCommand {
  constructor() {
    super({
      name: 'config',
      description: 'View or edit configuration',
      options: [
        { flags: '-s, --set <key=value>', description: 'Set a configuration value' },
        { flags: '-g, --get <key>', description: 'Get a configuration value' },
        { flags: '-l, --list', description: 'List all configuration' },
        { flags: '-i, --interactive', description: 'Interactive configuration editor' },
        { flags: '-r, --reset', description: 'Reset to default configuration' }
      ]
    });
  }

  async execute(options: ConfigOptions = {}): Promise<void> {
    const config = loadConfig();

    if (options.reset) {
      saveConfig(defaultConfig);
      console.log(chalk.green("✓ Configuration reset to defaults"));
      return;
    }

    if (options.interactive) {
      await this.interactiveConfig(config);
      return;
    }

    if (options.list || (!options.set && !options.get)) {
      this.listConfig(config);
      return;
    }

    if (options.get) {
      this.getConfigValue(config, options.get);
      return;
    }

    if (options.set) {
      this.setConfigValue(config, options.set);
      return;
    }
  }

  private listConfig(config: any): void {
    console.log(chalk.blue("Configuration Settings:"));
    console.log(chalk.gray("─".repeat(50)));

    const settings = [
      { key: "autoStash", desc: "Auto-stash on switch" },
      { key: "branchSort", desc: "Branch sorting" },
      { key: "showStashDetails", desc: "Show stash details" },
      { key: "pageSize", desc: "Page size" },
      { key: "showOnlyWIP", desc: "Show only WIP" },
      { key: "showOnlyConfigured", desc: "Show only configured" },
      { key: "personalWIPMode", desc: "Personal WIP mode" },
      { key: "recentDays", desc: "Recent days" },
      { key: "stashAgeDays", desc: "Stash age days" },
      { key: "wipTags", desc: "WIP tags" },
      { key: "doneTags", desc: "Done tags" }
    ];

    const maxKeyLength = Math.max(...settings.map(s => s.key.length));

    settings.forEach(({ key, desc }) => {
      const value = (config.preferences as any)[key];
      const formattedValue = formatConfigValue(value ?? false);
      const paddedKey = key.padEnd(maxKeyLength);
      console.log(`  ${formattedValue} ${paddedKey}  ${chalk.gray(desc)}`);
    });

    // Display aliases if any
    if (Object.keys(config.aliases).length > 0) {
      console.log("");
      console.log(chalk.gray("─".repeat(50)));
      console.log(chalk.cyan("Aliases:"));
      Object.entries(config.aliases).forEach(([branch, alias]) => {
        console.log(`  ${branch.padEnd(15)} → ${chalk.magenta(alias)}`);
      });
    }

    console.log("");
    console.log(chalk.gray("─".repeat(50)));
    console.log(chalk.gray("Tip: Use 'kunj config -i' for interactive editor"));
    console.log(chalk.gray("     Use 'kunj config --set key=value' to set"));
  }

  private getConfigValue(config: any, keyPath: string): void {
    const keys = keyPath.split(".");
    let value: any = config;

    for (const key of keys) {
      value = value[key];
      if (value === undefined) {
        console.error(chalk.red(`✗ Configuration key '${keyPath}' not found`));
        process.exit(1);
      }
    }

    console.log(value);
  }

  private setConfigValue(config: any, input: string): void {
    const parsed = parseKeyValue(input);
    if (!parsed) {
      console.error(chalk.red("✗ Invalid format. Use: --set key=value"));
      process.exit(1);
    }

    const { keys, value } = parsed;

    // Navigate to the correct nested property and set the value
    let current: any = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }

    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;

    saveConfig(config);
    console.log(chalk.green(`✓ Set ${input.split("=")[0]} to ${value}`));
  }

  private async interactiveConfig(config: any): Promise<void> {
    const formatValue = (val: any) => {
      if (typeof val === "boolean") return formatBoolValue(val);
      if (typeof val === "string") return chalk.cyan(val);
      return chalk.yellow(val);
    };

    const configItems = [
      {
        name: `${formatBoolValue(config.preferences.autoStash)} autoStash ${chalk.gray("- Auto-stash changes when switching")}`,
        value: "preferences.autoStash",
        type: "boolean",
        current: config.preferences.autoStash
      },
      {
        name: `${formatValue(config.preferences.branchSort)} branchSort ${chalk.gray("- Sort: recent/alphabetical")}`,
        value: "preferences.branchSort",
        type: "enum",
        options: ["recent", "alphabetical"],
        current: config.preferences.branchSort
      },
      {
        name: `${formatBoolValue(config.preferences.showStashDetails)} showStashDetails ${chalk.gray("- Show stash file/line counts")}`,
        value: "preferences.showStashDetails",
        type: "boolean",
        current: config.preferences.showStashDetails
      },
      {
        name: `${formatValue(config.preferences.pageSize)} pageSize ${chalk.gray("- Items per page")}`,
        value: "preferences.pageSize",
        type: "number",
        current: config.preferences.pageSize
      },
      {
        name: `${formatBoolValue(config.preferences.showOnlyWIP)} showOnlyWIP ${chalk.gray("- Filter to WIP branches")}`,
        value: "preferences.showOnlyWIP",
        type: "boolean",
        current: config.preferences.showOnlyWIP
      },
      {
        name: `${formatBoolValue(config.preferences.showOnlyConfigured || false)} showOnlyConfigured ${chalk.gray("- Filter to configured branches")}`,
        value: "preferences.showOnlyConfigured",
        type: "boolean",
        current: config.preferences.showOnlyConfigured || false
      },
      {
        name: `${formatBoolValue(config.preferences.personalWIPMode)} personalWIPMode ${chalk.gray("- Personal WIP detection")}`,
        value: "preferences.personalWIPMode",
        type: "boolean",
        current: config.preferences.personalWIPMode
      },
      {
        name: `${formatValue(config.preferences.recentDays)} recentDays ${chalk.gray("- Days for recent branches")}`,
        value: "preferences.recentDays",
        type: "number",
        current: config.preferences.recentDays
      },
      {
        name: `${formatValue(config.preferences.stashAgeDays)} stashAgeDays ${chalk.gray("- Days for recent stashes")}`,
        value: "preferences.stashAgeDays",
        type: "number",
        current: config.preferences.stashAgeDays
      },
      {
        name: chalk.cyan("Save and Exit"),
        value: "save",
        type: "action"
      },
      {
        name: chalk.yellow("Exit without saving"),
        value: "exit",
        type: "action"
      }
    ];

    let editing = true;
    while (editing) {
      // Update display names with current values
      configItems.forEach(item => {
        if (item.type === "separator" || item.type === "action") {
          return;
        }

        const keys = item.value.split(".");
        let value = config as any;
        for (const key of keys) {
          value = value[key];
        }

        const settingName = item.value.split(".")[1];
        const desc = item.name.split("- ")[1] || "";

        if (item.type === "boolean") {
          const status = formatBoolValue(value);
          item.name = `${status} ${settingName} ${chalk.gray("- " + desc)}`;
        } else if (item.type === "number") {
          item.name = `${formatValue(value)} ${settingName} ${chalk.gray("- " + desc)}`;
        } else if (item.type === "enum") {
          item.name = `${formatValue(value)} ${settingName} ${chalk.gray("- " + desc)}`;
        }
      });

      const { selectedItem } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedItem",
          message: "Select a setting to toggle/edit (↑↓ to navigate, Enter to select):",
          choices: configItems.filter(item => item.type !== "separator").map(item => ({
            name: item.name,
            value: item.value
          })),
          pageSize: 15
        }
      ]);

      const item = configItems.find(i => i.value === selectedItem);
      if (!item) continue;

      if (item.type === "action") {
        if (selectedItem === "save") {
          saveConfig(config);
          console.log(chalk.green("✓ Configuration saved"));
          editing = false;
        } else if (selectedItem === "exit") {
          console.log(chalk.yellow("Configuration not saved"));
          editing = false;
        }
      } else if (item.type === "boolean") {
        // Toggle boolean value
        const keys = item.value.split(".");
        let current: any = config;
        for (let i = 0; i < keys.length - 1; i++) {
          current = current[keys[i]];
        }
        const lastKey = keys[keys.length - 1];
        current[lastKey] = !current[lastKey];
        console.log(chalk.green(`✓ Toggled ${item.value} to ${current[lastKey]}`));
      } else if (item.type === "number") {
        // Edit number value
        const { newValue } = await inquirer.prompt([
          {
            type: "number",
            name: "newValue",
            message: `Enter new value for ${item.value}:`,
            default: item.current
          }
        ]);
        if (newValue !== undefined && !isNaN(newValue)) {
          const keys = item.value.split(".");
          let current: any = config;
          for (let i = 0; i < keys.length - 1; i++) {
            current = current[keys[i]];
          }
          const lastKey = keys[keys.length - 1];
          current[lastKey] = newValue;
          console.log(chalk.green(`✓ Set ${item.value} to ${newValue}`));
        }
      } else if (item.type === "enum") {
        // Select from enum options
        const { newValue } = await inquirer.prompt([
          {
            type: "list",
            name: "newValue",
            message: `Select value for ${item.value}:`,
            choices: item.options,
            default: item.current
          }
        ]);
        const keys = item.value.split(".");
        let current: any = config;
        for (let i = 0; i < keys.length - 1; i++) {
          current = current[keys[i]];
        }
        const lastKey = keys[keys.length - 1];
        current[lastKey] = newValue;
        console.log(chalk.green(`✓ Set ${item.value} to ${newValue}`));
      }
    }
  }
}