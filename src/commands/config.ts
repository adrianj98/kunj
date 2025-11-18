// Config command - view and edit configuration

import chalk from 'chalk';
import inquirer from 'inquirer';
import { BaseCommand } from '../lib/command';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  loadGlobalConfig,
  loadLocalConfig,
  saveGlobalConfig,
  saveLocalConfig,
  getGlobalConfigPath
} from '../lib/config';
import { defaultConfig } from '../constants';
import { formatConfigValue, formatBoolValue, parseKeyValue } from '../lib/utils';
import { settingsRegistry, SettingDefinition } from '../settings';

interface ConfigOptions {
  set?: string;
  get?: string;
  list?: boolean;
  interactive?: boolean;
  reset?: boolean;
  global?: boolean;
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
        { flags: '-r, --reset', description: 'Reset to default configuration' },
        { flags: '--global', description: 'Use global configuration instead of local' }
      ]
    });
  }

  async execute(options: ConfigOptions = {}): Promise<void> {
    // Load appropriate config based on --global flag
    const isGlobal = options.global || false;
    const config = isGlobal ? loadGlobalConfig() : loadLocalConfig();
    const mergedConfig = loadConfig(); // For viewing merged results

    if (options.reset) {
      if (isGlobal) {
        saveGlobalConfig({});
        console.log(chalk.green("✓ Global configuration reset to defaults"));
      } else {
        saveLocalConfig({});
        console.log(chalk.green("✓ Local configuration reset to defaults"));
      }
      return;
    }

    if (options.interactive) {
      await this.interactiveConfig(config, isGlobal);
      return;
    }

    if (options.list || (!options.set && !options.get)) {
      this.listConfig(config, mergedConfig, isGlobal);
      return;
    }

    if (options.get) {
      this.getConfigValue(mergedConfig, options.get);
      return;
    }

    if (options.set) {
      this.setConfigValue(config, options.set, isGlobal);
      return;
    }
  }

  private listConfig(config: any, mergedConfig: any, isGlobal: boolean): void {
    const scope = isGlobal ? "Global" : "Local";
    const localConfig = isGlobal ? {} : loadLocalConfig();
    const globalConfig = loadGlobalConfig();

    console.log(chalk.blue.bold(`\n${scope} Configuration Settings`));
    console.log(chalk.gray("═".repeat(100)));

    // Helper to get value from specific config
    const getValueFromConfig = (configObj: any, keyPath: string): any => {
      const keys = keyPath.split('.');
      let value: any = configObj;
      for (const key of keys) {
        if (value === undefined || value === null) return undefined;
        value = value[key];
      }
      return value;
    };

    // Determine the source of a setting value
    const getSettingSource = (keyPath: string): { source: string; color: any } => {
      const localValue = getValueFromConfig(localConfig, keyPath);
      const globalValue = getValueFromConfig(globalConfig, keyPath);

      if (localValue !== undefined) {
        return { source: '[local]', color: chalk.blue };
      } else if (globalValue !== undefined) {
        return { source: '[global]', color: chalk.magenta };
      } else {
        return { source: '[default]', color: chalk.dim };
      }
    };

    // Get all registered settings
    const allSettings = settingsRegistry.getAll();

    // Group settings by category
    const categories = new Map<string, SettingDefinition[]>();
    allSettings.forEach(setting => {
      const category = setting.category || 'general';
      if (!categories.has(category)) {
        categories.set(category, []);
      }
      categories.get(category)!.push(setting);
    });

    // Sort categories
    const sortedCategories = Array.from(categories.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    // Display settings by category
    sortedCategories.forEach(([categoryName, settings], categoryIndex) => {
      if (categoryIndex > 0) {
        console.log("");
      }

      const categoryTitle = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);
      console.log(chalk.cyan.bold(`\n  ${categoryTitle} Settings`));
      console.log(chalk.gray("  " + "─".repeat(96)));

      // Calculate max lengths for alignment
      const maxKeyLength = Math.max(24, ...settings.map(s => {
        const parts = s.key.split('.');
        return parts[parts.length - 1].length;
      }));

      settings.forEach((setting) => {
        const keys = setting.key.split('.');
        let value: any = config;
        let effectiveValue: any = mergedConfig;

        // Navigate to the value
        for (const k of keys) {
          value = value?.[k];
          effectiveValue = effectiveValue?.[k];
        }

        const { source, color } = getSettingSource(setting.key);
        const formattedValue = effectiveValue !== undefined
          ? formatConfigValue(effectiveValue)
          : chalk.gray("(none)");
        const shortKey = keys[keys.length - 1];
        const paddedKey = chalk.bold(shortKey.padEnd(maxKeyLength));
        const paddedSource = color(source.padEnd(10));

        console.log(`    ${formattedValue.padEnd(20)} ${paddedKey} ${paddedSource} ${chalk.dim(setting.description)}`);
      });
    });

    // Display aliases if any
    if (config.aliases && Object.keys(config.aliases).length > 0) {
      console.log("");
      console.log(chalk.cyan.bold("\n  Aliases"));
      console.log(chalk.gray("  " + "─".repeat(96)));
      Object.entries(config.aliases).forEach(([branch, alias]) => {
        console.log(`    ${branch.padEnd(30)} → ${chalk.magenta(alias)}`);
      });
    }

    // Display legend and footer
    console.log("");
    console.log(chalk.gray("═".repeat(100)));
    console.log(chalk.bold("\n  Legend:"));
    console.log(`    ${chalk.blue('[local]')}   - Value set in local config (overrides global and default)`);
    console.log(`    ${chalk.magenta('[global]')}  - Value set in global config (overrides default)`);
    console.log(`    ${chalk.dim('[default]')} - Using default value (not configured)`);
    console.log("");
    console.log(chalk.dim(`  Config file: ${isGlobal ? getGlobalConfigPath() : getConfigPath()}`));
    console.log(chalk.dim(`  Use 'kunj config -i' for interactive editor`));
    console.log(chalk.dim(`  Use 'kunj config --global' to manage global settings`));
    console.log("");
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

  private setConfigValue(config: any, input: string, isGlobal: boolean): void {
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

    if (isGlobal) {
      saveGlobalConfig(config);
      console.log(chalk.green(`✓ Set global ${input.split("=")[0]} to ${value}`));
    } else {
      saveLocalConfig(config);
      console.log(chalk.green(`✓ Set local ${input.split("=")[0]} to ${value}`));
    }
  }

  private async interactiveConfig(config: any, isGlobal: boolean): Promise<void> {
    // Load separate configs to track sources
    let localConfig = isGlobal ? {} : loadLocalConfig();
    let globalConfig = loadGlobalConfig();

    // The config we're actively editing (either local or global)
    const editingConfig = isGlobal ? globalConfig : localConfig;

    // Merge with defaults to ensure all properties exist
    const mergedConfig = {
      ...defaultConfig,
      ...config,
      preferences: {
        ...defaultConfig.preferences,
        ...(config.preferences || {})
      },
      ai: {
        ...defaultConfig.ai,
        ...(config.ai || {})
      }
    };

    const formatValue = (val: any) => {
      if (typeof val === "boolean") return formatBoolValue(val);
      if (typeof val === "string") return chalk.cyan(val);
      if (Array.isArray(val)) return chalk.cyan(val.join(', '));
      return chalk.yellow(val);
    };

    // Get value from a specific config object
    const getValueFromConfig = (configObj: any, keyPath: string): any => {
      const keys = keyPath.split('.');
      let value: any = configObj;
      for (const key of keys) {
        if (value === undefined || value === null) return undefined;
        value = value[key];
      }
      return value;
    };

    // Set value in a config object
    const setValueInConfig = (configObj: any, keyPath: string, newValue: any): void => {
      const keys = keyPath.split('.');
      let current: any = configObj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }
      const lastKey = keys[keys.length - 1];
      current[lastKey] = newValue;
    };

    // Get current value from merged config
    const getConfigValue = (keyPath: string): any => {
      return getValueFromConfig(mergedConfig, keyPath);
    };

    // Update a setting value in both merged and source configs
    const updateSetting = (keyPath: string, newValue: any): void => {
      // Update mergedConfig for display
      setValueInConfig(mergedConfig, keyPath, newValue);

      // Update the appropriate source config (local or global)
      if (isGlobal) {
        setValueInConfig(globalConfig, keyPath, newValue);
      } else {
        setValueInConfig(localConfig, keyPath, newValue);
      }
    };

    // Determine the source of a setting value
    const getSettingSource = (keyPath: string, defaultValue: any): string => {
      const localValue = getValueFromConfig(localConfig, keyPath);
      const globalValue = getValueFromConfig(globalConfig, keyPath);

      if (localValue !== undefined) {
        return chalk.blue('[local]');
      } else if (globalValue !== undefined) {
        return chalk.magenta('[global]');
      } else {
        return chalk.dim('[default]');
      }
    };

    // Build config items grouped by category
    const allSettings = settingsRegistry.getAll();
    const categories = new Map<string, any[]>();

    allSettings.forEach(setting => {
      const category = setting.category || 'general';
      if (!categories.has(category)) {
        categories.set(category, []);
      }

      const currentValue = getConfigValue(setting.key);
      const keys = setting.key.split('.');
      const shortKey = keys[keys.length - 1];
      const source = getSettingSource(setting.key, setting.defaultValue);

      let displayValue = '';
      if (setting.type === 'boolean') {
        displayValue = formatBoolValue(currentValue);
      } else {
        displayValue = formatValue(currentValue);
      }

      // Create a more readable display name
      const displayName = `${displayValue} ${chalk.bold(shortKey.padEnd(25))} ${source.padEnd(12)} ${chalk.dim(setting.description)}`;

      categories.get(category)!.push({
        name: displayName,
        value: setting.key,
        type: setting.type,
        options: setting.options,
        current: currentValue,
        settingDef: setting,
        category: category
      });
    });

    // Build config items with category separators
    const configItems: any[] = [];
    const sortedCategories = Array.from(categories.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    sortedCategories.forEach(([categoryName, items], index) => {
      if (index > 0) {
        configItems.push({
          name: chalk.gray('─'.repeat(80)),
          value: `separator-${index}`,
          type: 'separator',
          disabled: true
        });
      }

      const categoryTitle = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);
      configItems.push({
        name: chalk.cyan.bold(`\n${categoryTitle} Settings`),
        value: `category-${categoryName}`,
        type: 'separator',
        disabled: true
      });

      configItems.push(...items);
    });

    // Add action items
    configItems.push(
      {
        name: chalk.gray('\n' + '─'.repeat(80)),
        value: 'final-separator',
        type: 'separator',
        disabled: true
      },
      {
        name: chalk.green.bold('💾 Save and Exit'),
        value: "save",
        type: "action"
      },
      {
        name: chalk.yellow.bold('❌ Exit without saving'),
        value: "exit",
        type: "action"
      }
    );

    let editing = true;
    while (editing) {
      // Update display names with current values
      configItems.forEach(item => {
        if (item.type === "separator" || item.type === "action" || item.disabled) {
          return;
        }

        const currentValue = getConfigValue(item.value);
        const keys = item.value.split(".");
        const shortKey = keys[keys.length - 1];
        const source = getSettingSource(item.value, item.settingDef.defaultValue);

        let displayValue = '';
        if (item.type === "boolean") {
          displayValue = formatBoolValue(currentValue);
        } else {
          displayValue = formatValue(currentValue);
        }

        // Update the display name
        item.name = `${displayValue} ${chalk.bold(shortKey.padEnd(25))} ${source.padEnd(12)} ${chalk.dim(item.settingDef.description)}`;
        item.current = currentValue;
      });

      const scope = isGlobal ? "Global" : "Local";
      const { selectedItem } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedItem",
          message: chalk.bold(`Configure ${scope} Settings (↑↓ to navigate, Enter to select):`),
          choices: configItems.map(item => ({
            name: item.name,
            value: item.value,
            disabled: item.disabled
          })),
          pageSize: 20
        }
      ]);

      const item = configItems.find(i => i.value === selectedItem);
      if (!item) continue;

      if (item.type === "action") {
        if (selectedItem === "save") {
          if (isGlobal) {
            saveGlobalConfig(globalConfig);
            console.log(chalk.green("✓ Global configuration saved"));
          } else {
            saveLocalConfig(localConfig);
            console.log(chalk.green("✓ Local configuration saved"));
          }
          editing = false;
        } else if (selectedItem === "exit") {
          console.log(chalk.yellow("Configuration not saved"));
          editing = false;
        }
      } else if (item.type === "boolean") {
        // Toggle boolean value
        const currentValue = getConfigValue(item.value);
        const newValue = !currentValue;
        updateSetting(item.value, newValue);
        console.log(chalk.green(`✓ Toggled ${item.value} to ${newValue}`));
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
          updateSetting(item.value, newValue);
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
        updateSetting(item.value, newValue);
        console.log(chalk.green(`✓ Set ${item.value} to ${newValue}`));
      } else if (item.type === "string") {
        // Edit string value
        const { newValue } = await inquirer.prompt([
          {
            type: "input",
            name: "newValue",
            message: `Enter new value for ${item.value}:`,
            default: item.current
          }
        ]);
        if (newValue !== undefined && newValue !== "") {
          updateSetting(item.value, newValue);
          console.log(chalk.green(`✓ Set ${item.value} to ${newValue}`));
        }
      } else if (item.type === "array") {
        // Edit array value (comma-separated input)
        const currentArray = Array.isArray(item.current) ? item.current : [];
        const { newValue } = await inquirer.prompt([
          {
            type: "input",
            name: "newValue",
            message: `Enter comma-separated values for ${item.value}:`,
            default: currentArray.join(', ')
          }
        ]);
        if (newValue !== undefined) {
          const arrayValue = newValue.split(',').map((v: string) => v.trim()).filter((v: string) => v !== '');
          updateSetting(item.value, arrayValue);
          console.log(chalk.green(`✓ Set ${item.value} to [${arrayValue.join(', ')}]`));
        }
      }
    }
  }
}